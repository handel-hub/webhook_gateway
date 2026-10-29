# CWIDS Architecture Update --- Post-Hostile-Review Revision

**Document type:** Architecture amendment and implementation gate\
**System:** Centralized Webhook Ingestion and Delivery Service (CWIDS)\
**Status:** Proposed revision --- decisions below must be accepted
before implementation\
**Supersedes:** Conflicting statements in the current architecture
specification and README\
**Review basis:** Hostile architecture review supplied on 2026-10-28\
**Important limitation:** The hostile review assessed the written
architecture and scaffold, not a functioning implementation. The source
files were described as stubs. Findings therefore identify design
defects and unproven claims; they do not prove that runtime
vulnerabilities already exist.

------------------------------------------------------------------------

## 1. Purpose and decision

The hostile review's verdict is **REVISE**. The architecture should not
proceed to production implementation until the P0 decisions in this
document are resolved and recorded. The existing stack is retained:
Node.js, Express, PostgreSQL, raw SQL through `pg`, a public ingestion
gateway, and background delivery workers. Kafka, Redis, Kubernetes, and
a second database are not introduced by this revision.

The core design principle remains:

> Authenticate the provider request, persist the accepted event and its
> routing/delivery disposition atomically, acknowledge only after the
> database transaction commits, and perform destination delivery
> asynchronously from durable state.

That principle is necessary but not sufficient. This revision defines
the identity, routing, transaction, delivery, tenant-isolation, and
recovery mechanics required to make the principle meaningful.

### 1.1 Guarantees the service can make

Subject to the documented database durability configuration and tested
implementation, CWIDS can aim to guarantee:

1.  A provider request is not acknowledged as durably accepted until the
    required event record and initial disposition have committed.
2.  Duplicate inbound requests recognized by the provider-specific
    identity policy do not create duplicate logical event records.
3.  Every accepted event has an explicit disposition: routed, awaiting
    route resolution, rejected/quarantined, or otherwise terminal
    according to policy.
4.  Delivery work is recoverable from PostgreSQL after worker/process
    failure.
5.  A stale worker cannot overwrite a newer worker's database state.
6.  Callback destinations are subject to outbound network controls at
    connection time, not merely at registration time.
7.  One application's delivery failures are bounded so they cannot
    consume all shared delivery capacity.
8.  Administrative replay and routing changes are authenticated,
    authorized, and audited.

### 1.2 Guarantees CWIDS cannot make alone

CWIDS cannot promise exactly-once business effects at a destination
merely by sending an event once, using a lease, or receiving HTTP 200. A
destination may commit its business effect and lose the response. The
central service may then retry.

CWIDS therefore provides **at-least-once delivery attempts**, while
exactly-once business effects require destination cooperation: a stable
event identity and an atomic destination-side inbox/idempotency record
in the same database transaction as the business mutation. Payment truth
may additionally require a provider transaction-verification API and
reconciliation.

CWIDS cannot promise zero data loss after acknowledging events unless
the chosen PostgreSQL and infrastructure configuration meets a stated
failure model. A single local PostgreSQL instance is not equivalent to
multi-zone disaster recovery.

------------------------------------------------------------------------

## 2. Architecture overview

### 2.1 Logical components

1.  **Provider ingress gateway**
    -   Accepts provider-specific webhook endpoints.
    -   Enforces request-size, content-type, connection, and timeout
        limits.
    -   Captures the exact request bytes required for signature
        verification.
    -   Delegates authentication to a provider-specific adapter.
    -   Performs no synchronous HTTP call to a registered destination.
    -   Performs no synchronous call to an application backend to
        discover event ownership.
2.  **Provider adapters**
    -   One adapter per provider and supported webhook/API version.
    -   Own signature/header semantics, raw-body requirements,
        event-type normalization, and provider-specific identity
        extraction.
    -   Return a typed verification result and normalized metadata
        without silently changing the original payload.
    -   Fail closed when the required secret or supported signature
        configuration is missing.
    -   Never share assumptions about signature algorithm, encoding,
        event ID, or retry semantics across providers unless each
        provider's official documentation establishes equivalence.
3.  **Event persistence and routing resolver**
    -   Persists the authenticated event, its provider connection,
        payload digest, identity strategy/version, and routing
        disposition.
    -   Resolves application ownership only from locally available
        trusted registration/payment-intent records or a provider
        connection configured for exactly one application.
    -   Does not infer tenant ownership from an untrusted callback URL,
        arbitrary payload field, or ambiguous reference prefix.
    -   Stores ambiguous or unmatched authenticated events as
        `awaiting_route`/quarantined and raises an actionable alert. It
        does not silently discard them.
4.  **PostgreSQL**
    -   Authoritative store for provider connections, application
        registrations, payment-intent/routing correlations, webhook
        events, delivery jobs, attempt history, replay requests, and
        administrative audit events.
    -   Enforces uniqueness and relational invariants with constraints.
    -   Stores delivery work in the same transaction as the event's
        initial disposition.
    -   Is not treated as a financial ledger or a replacement for
        provider transaction verification.
5.  **Delivery scheduler and workers**
    -   Claim eligible jobs in short database transactions using row
        locking (for example, `FOR UPDATE SKIP LOCKED`) and leases.
    -   Release the transaction before outbound network I/O.
    -   Apply per-application concurrency and rate limits, global
        concurrency limits, timeouts, retry classification, circuit
        breaking, and connection-time SSRF protections.
    -   Use a claim token/fencing value to prevent stale database
        updates.
    -   Assume an external request may have succeeded even when the
        worker did not receive a response.
6.  **Reconciliation and recovery process**
    -   Detect unresolved routing, old pending deliveries, exhausted
        retries, dead-letter growth, missing event correlations, and
        payment-state discrepancies.
    -   Reconcile against provider APIs where available and permitted.
    -   Supports operator-controlled redrive with authorization and
        audit history.
7.  **Administrative interface/API**
    -   Not part of the public provider ingress surface.
    -   Requires explicit authentication and role-based authorization.
    -   Does not expose secrets or unredacted payloads by default.
    -   Every route, endpoint, credential, replay, redrive, suspension,
        and retention change is audited.

### 2.2 Process topology

The gateway and workers may run as separate processes on one host for
the initial implementation. They must use separate PostgreSQL connection
pools and must not rely on shared in-memory state.

A production deployment may run multiple gateway and worker instances,
provided all shared coordination is implemented through PostgreSQL
constraints/transactions and the documented network controls. Scaling to
multiple processes must not change event identity or routing semantics.

**No high-availability claim is permitted merely because multiple
Node.js processes are running.** Availability and recovery guarantees
are defined by the database and infrastructure deployment profile in
Section 12.

------------------------------------------------------------------------

## 3. P0 decision: deterministic, local routing

### 3.1 Prohibited routing behavior

The ingress path MUST NOT make synchronous outbound HTTP requests to a
destination application to discover which application owns a webhook.
This creates a circular dependency: the service cannot accept the event
until the destination is available, even though the purpose of the
service is to persist events during destination outages.

Routing MUST NOT rely solely on: - An application-supplied field whose
authenticity/ownership is not established. - A transaction ID assumed to
be globally unique across applications. - A non-delimited reference
prefix (for example, `app` matching `app_store`). - A destination URL
supplied in the webhook payload. - A cache with no authoritative durable
record or expiry/recovery policy.

### 3.2 Supported routing modes

CWIDS supports the following routing modes, in this order of preference:

**Mode A --- Registered payment-intent correlation**

Before checkout or payment initiation, the application (or its trusted
backend) registers a payment intent with CWIDS. CWIDS stores a locally
queryable correlation record containing at least: - `application_id` -
`provider_connection_id` - `environment` -
`internal_payment_intent_id` - `provider_transaction_reference` when
known - `merchant/reference identifiers` that the provider is documented
to return - creation/expiry timestamps - correlation status and schema
version

The application chooses or receives a unique reference under an explicit
namespace. The exact reference format is a contract, not a guess made by
the receiver. The mapping is committed before the provider event can
reasonably arrive.

**Mode B --- Provider connection bound to one application**

If a provider account/credential set is exclusively associated with one
application, the verified provider connection may identify that
application directly. This is allowed only if the provider account is
not shared ambiguously among multiple applications.

**Mode C --- Unresolved quarantine**

If neither Mode A nor Mode B identifies exactly one owner, persist the
authenticated event as `awaiting_route` (or `quarantined` for a
policy/security reason), create no normal application delivery, and emit
a high-priority metric/alert. Preserve enough metadata for controlled
resolution and reconciliation. Do not silently drop the event.

### 3.3 Routing invariants

-   A routing decision must resolve to exactly one application or
    explicitly remain unresolved.
-   The event's routing decision is stored and auditable.
-   Routing resolution does not call external application endpoints.
-   Routing configuration changes do not silently rewrite the owner of
    historical events.
-   A manual reassignment requires an authorized, audited operation and
    must record old owner, new owner, reason, actor, and timestamp.
-   Prefix matching is not authoritative unless a formally specified,
    unambiguous, collision-resistant namespace is validated at
    registration and exact delimiter rules are enforced. Prefer stored
    correlation records instead.

### 3.4 Required tests

-   Ingest while every destination application is offline; accepted
    events still persist.
-   Submit unknown and ambiguous references; they are retained as
    unresolved and alert.
-   Register overlapping application references; registration is
    rejected or exact lookup remains unambiguous.
-   Change routing configuration while an event is pending; the
    historical decision remains explainable.
-   Attempt to route using attacker-controlled metadata; no
    cross-application delivery occurs.

------------------------------------------------------------------------

## 4. P0 decision: provider-specific verification and event identity

### 4.1 Verification contract

Each provider adapter MUST document and test: - Supported provider and
webhook/API version. - Exact signature header(s) and verification
method. - Whether verification uses raw request bytes, a shared secret
comparison, or another documented mechanism. - Expected signature
encoding and exact byte length/format. - Secret source, rotation
behavior, and test/live environment separation. - Supported event types
and event fields used for routing and identity. - Provider
acknowledgement semantics and documented retry behavior. - Official
documentation URL and the date/version last verified.

Do not implement one generic signature algorithm for every provider. Do
not select an algorithm from untrusted request data. Missing secrets,
unsupported versions, malformed signatures, and verification exceptions
fail closed.

If `crypto.timingSafeEqual` is used, validate the input format and equal
buffer lengths before calling it. Malformed input must produce a
controlled authentication failure, not an uncaught exception or process
crash. Do not log secrets or full signature values.

The exact Flutterwave and Paystack verification procedures MUST be
verified against current official documentation for the specific
account/product and payload version before implementation. Do not treat
claims in the hostile review about a particular provider version as
final proof without that check.

### 4.2 Preserve raw payload and normalized representation separately

The gateway MUST retain the exact request bytes required for
verification until verification completes. The reverse proxy and Express
middleware must not silently decompress, re-encode, parse and
reserialize, or otherwise alter those bytes before the adapter verifies
them.

Persist: - Original payload bytes (or an explicitly approved encrypted
payload representation). - SHA-256 digest of the original bytes. -
Content type and relevant non-secret transport metadata. - Normalized
provider name/version and event metadata. - Verification result and
adapter version.

Do not assume JSON parse/stringify round-tripping preserves the signed
bytes. Do not use the normalized JSON representation to verify a
signature that is defined over the raw body.

Apply a conservative request-body limit (initial proposed default: 256
KiB, configurable only within a reviewed upper bound) at the reverse
proxy and application layers. Confirm the actual maximum against
provider documentation and legitimate payload samples before freezing
the limit. Reject unsupported encodings explicitly rather than
accidentally verifying an empty or transformed body.

### 4.3 Event identity is not necessarily a provider event ID

The system MUST NOT assume every provider sends a stable, globally
unique event ID. A transaction/resource ID is not automatically an event
ID: a single transaction may legitimately produce success, refund,
reversal, dispute, or other event types.

Each adapter must provide a documented **identity strategy** for each
supported event type. The strategy must state: - Which provider
connection and environment scope the identity. - Whether the provider
supplies an immutable event ID. - Which event type and resource
identifiers distinguish separate logical events. - How legitimate
follow-up events remain distinct. - How retries of the same logical
event are recognized. - What happens when identity fields are missing or
contradictory. - Whether the policy uses an exact raw-payload digest, a
provider-defined event ID, or a versioned composite fingerprint.

The database uniqueness boundary should generally be scoped to the
provider connection and environment, for example:

`UNIQUE (provider_connection_id, environment, identity_strategy_version, dedupe_key)`

This is a design pattern, not a substitute for a provider-specific
identity analysis. Do not use `transaction_id` alone as `dedupe_key`. Do
not assume a payload hash alone is sufficient for all event types:
semantically identical events may be serialized differently, while
distinct event types may concern the same resource.

For providers that do not expose a unique event ID, use a documented
composite identity policy derived from stable provider fields and event
type; use a payload digest as supporting evidence or a fallback only
where its limitations are explicit. If a safe identity cannot be
derived, retain the event for review rather than collapsing it into an
unrelated event.

### 4.4 Duplicate payload conflict

If the same derived identity arrives with a different payload digest: -
Do not silently overwrite the original payload. - Record a
duplicate/conflict observation with both digests and receipt times. -
Apply a provider-specific policy: ignore an equivalent retry, quarantine
a material conflict, or request provider-side verification. - Alert on
repeated or financially significant conflicts.

### 4.5 Required tests

-   Same event retried with identical bytes.
-   Same logical event retried with harmless serialization differences
    where provider behavior permits.
-   Success and refund/dispute events sharing the same transaction ID.
-   Missing identity fields.
-   Same identity with materially different payload.
-   Empty, malformed, wrong-length, and oversized signatures.
-   Middleware/proxy body transformation.
-   Secret rotation with overlapping old/new credentials according to a
    documented rotation window.

------------------------------------------------------------------------

## 5. P0 decision: atomic ingestion and acknowledgement

### 5.1 Ingestion transaction

After successful provider verification and local routing evaluation, the
gateway executes one database transaction that: 1. Inserts the provider
event or resolves a recognized duplicate using the enforced uniqueness
constraint. 2. Persists payload digest, identity metadata, provider
connection, environment, receipt time, verification metadata, and
normalized event fields. 3. Persists the initial routing disposition. 4.
If exactly one application is resolved and the event is eligible for
delivery, inserts the initial delivery obligation. 5. Writes any
required durable audit/outbox records for subsequent internal work.

The transaction commits before the gateway returns the provider's
success acknowledgement.

**The event and its initial delivery obligation must not be committed in
separate transactions.** If an event is intentionally unresolved, its
unresolved disposition must be committed with the event; a normal
delivery job is not fabricated.

### 5.2 Acknowledgement policy

-   Invalid signature or invalid request: return the
    provider-appropriate rejection response, without treating the event
    as trusted.
-   Database unavailable or transaction not committed: do not return a
    success acknowledgement. Return a retryable failure according to
    provider contract.
-   Commit confirmed and event durably recorded: return the
    provider-appropriate success acknowledgement, including for a
    recognized duplicate.
-   Commit outcome ambiguous because the connection drops during/after
    `COMMIT`: do not assume either success or failure. On provider
    retry, the uniqueness constraint and identity strategy must safely
    resolve the outcome. Emit an operational signal for repeated
    ambiguous commit errors.
-   Authenticated but unresolved event: acknowledge only after the event
    and unresolved disposition are durably committed, and only if the
    unresolved queue has active monitoring, alerting, retention, and
    recovery procedures. Otherwise the service risks silently accepting
    an event that no application will ever receive.

The HTTP response must conform to each provider's documented contract;
do not assume all providers require the same status/body semantics.

### 5.3 No in-memory queue as the source of truth

In-memory queues may be used only as performance hints. A process
restart must not destroy the only record that work remains. The database
is authoritative for pending delivery work.

### 5.4 Database roles and pool isolation

-   Gateway and worker use separate connection pools with explicit upper
    bounds.
-   Gateway and worker use separate least-privilege database roles where
    feasible.
-   The gateway role can insert/read the minimum required ingestion data
    but cannot arbitrarily update/delete all event history.
-   The worker role can claim/update delivery work but cannot change
    provider secrets, application ownership, or routing configuration.
-   Administrative migrations use a separate privileged role, not the
    runtime application role.
-   Pool sizes must be derived from the PostgreSQL connection budget,
    number of process instances, and reserved maintenance/administrative
    capacity; example values are not production guarantees.
-   Set bounded connection acquisition, statement, lock, and transaction
    timeouts appropriate to the measured provider acknowledgement
    window. Avoid one unreviewed global timeout as the only protection.

PgBouncer is optional, not an architectural prerequisite. Add it only
when measured connection fan-out or connection overhead warrants it.

------------------------------------------------------------------------

## 6. Revised persistence model and invariants

The following is the minimum logical model. Names may be adapted to the
final schema, but the invariants are mandatory.

### 6.1 `applications`

Represents a registered destination-owning application.

Key fields: - `id` - `status` (`active`, `suspended`, `disabled`,
`deleted/retired`) - `created_at`, `updated_at` - non-secret
configuration metadata

Do not physically cascade-delete events, delivery attempts, or audit
records when an application is suspended or retired.

### 6.2 `provider_connections`

Represents a provider account/configuration bound to an environment and,
where applicable, an application.

Key fields: - `id` - `provider` - `environment` (`test`/`live` or
provider-defined equivalent) - `application_id` only when the connection
is unambiguously single-application - `credential_reference` or
secret-manager key, not plaintext secret in ordinary application rows -
`status` - adapter/version metadata - secret rotation metadata

Enforce valid provider/environment combinations and prevent accidental
test/live cross-routing.

### 6.3 `payment_intent_correlations`

Provides local deterministic routing when one provider connection serves
multiple applications.

Key fields: - `id` - `application_id` - `provider_connection_id` -
`environment` - `internal_payment_intent_id` - `provider_reference` or
other provider-documented correlation fields - `created_at`,
`expires_at` - `status` - optional schema/version metadata

Unique constraints must match the actual provider/account/environment
namespace. Do not impose a global uniqueness constraint on a provider
reference unless the provider contract guarantees it.

### 6.4 `webhook_events`

Represents one recognized logical provider event.

Key fields: - `id` (internal immutable ID) - `provider_connection_id` -
`provider` - `environment` - `provider_event_id` nullable -
`identity_strategy_version` - `dedupe_key` - `event_type` -
`resource_type` and `resource_reference` where available -
`application_id` nullable until routing resolves - `routing_status`
(`resolved`, `awaiting_route`, `quarantined`, `rejected` as
appropriate) - `verification_status` - `raw_payload` or encrypted
payload reference - `payload_sha256` - `received_at` -
`schema_version` - `created_at`

Enforce uniqueness with a provider-appropriate composite key. The exact
index must be validated against the identity strategy and PostgreSQL's
treatment of nullable columns. Do not rely on nullable uniqueness
semantics accidentally. If a partial unique index or separate identity
table is needed, document why.

The internal `webhook_events.id` is not interchangeable with the
provider event ID or delivery ID.

### 6.5 `event_deliveries`

Represents a delivery obligation for one event to one application
endpoint/configuration.

Key fields: - `id` (immutable delivery ID) - `event_id` -
`application_id` - `destination_config_version_id` or immutable endpoint
snapshot reference - `status` - `attempt_count` - `next_attempt_at` -
`lease_token` / claim generation - `lease_expires_at` -
`last_attempt_at` - `delivered_at` - `last_http_status` -
bounded/redacted `last_error_code` - `created_at`, `updated_at`

Enforce one normal delivery obligation per logical
event/application/endpoint policy unless the product explicitly supports
multiple subscriptions. Do not allow a replay action to accidentally
create a second normal obligation without an audit record and a defined
identity policy.

Endpoint configuration changes must not silently mutate the meaning of
an already queued delivery. The architecture must define whether pending
deliveries use the immutable endpoint version captured at enqueue time
or a controlled current-endpoint policy. Default recommendation:
snapshot the destination configuration version and make endpoint
migration an explicit operation.

### 6.6 `delivery_attempts`

Append-only record for each network attempt: - `id` - `delivery_id` -
`attempt_number` - `claim_generation` - `started_at`, `finished_at` -
request/response timing - HTTP status when available - normalized
outcome class - response digest or bounded/redacted response excerpt, if
permitted - error code - correlation/trace ID

Do not store arbitrary unbounded response bodies. Keep attempt history
separate from the mutable current delivery state.

### 6.7 `administrative_audit_events`

Append-only record of privileged changes: - actor identity - action and
target - before/after references or redacted diffs - reason/ticket -
timestamp - request/correlation ID - outcome

The runtime application role must not be able to rewrite audit history.
A hash chain can provide tamper evidence but does not protect against a
database superuser; state the trust boundary honestly.

### 6.8 Constraints and retention

Use foreign keys, check constraints, uniqueness constraints, and indexes
for invariants that must survive concurrency. Do not rely on
application-level pre-checks for uniqueness.

Define separate retention periods for raw payloads, event metadata,
attempt history, audit records, and deduplication identities. Retention
must not remove identity records so early that a delayed provider retry
creates a duplicate logical event. Payload deletion may be separated
from retaining a minimal identity/audit tombstone. Legal, privacy, and
provider requirements must be confirmed before finalizing durations.

Do not partition tables or add complex index maintenance solely from
speculative row-count thresholds. Measure write rate, row churn, query
plans, WAL volume, autovacuum behavior, and restore time first. Keep
schema/index design partition-ready where inexpensive, and introduce
partitioning only with an explicit retention/scale trigger and tested
migration plan.

------------------------------------------------------------------------

## 7. Delivery state machine and concurrency protocol

### 7.1 Event routing state

Suggested states:

-   `received_verified`
-   `resolved`
-   `awaiting_route`
-   `quarantined`
-   `rejected` (only where a trusted event record is intentionally
    retained for audit)
-   `closed` / `archived` according to retention policy

An event's routing state is distinct from its delivery state. One event
may have no delivery yet because it is unresolved; a resolved event may
have a delivery that is pending, retrying, delivered, or dead-lettered.

### 7.2 Delivery state

Suggested states:

-   `pending`
-   `in_flight`
-   `retry_scheduled`
-   `delivered`
-   `dead_lettered`
-   `cancelled` (with reason and audit where applicable)
-   `paused` only if the pause semantics and resumption behavior are
    defined

Legal transitions must be enforced in application logic and tested: -
`pending -> in_flight` - `retry_scheduled -> in_flight` -
`in_flight -> delivered` - `in_flight -> retry_scheduled` -
`in_flight -> dead_lettered` - `pending/retry_scheduled -> cancelled`
only under an explicit policy - expired `in_flight -> retry_scheduled`
after lease recovery, subject to fencing

A delivered delivery must not return to pending merely because an
operator clicks replay. Replay semantics are defined in Section 9.

### 7.3 Claim protocol

1.  In a short transaction, select eligible deliveries, respecting
    per-application concurrency/fairness limits, using row locks such as
    `FOR UPDATE SKIP LOCKED`.
2.  Atomically set `status = 'in_flight'`, a new unpredictable claim
    token or monotonically increasing claim generation, and
    `lease_expires_at`.
3.  Commit before making the network request.
4.  Perform outbound I/O outside the database transaction.
5.  Record the attempt and transition the delivery only if the
    completion update still matches the current claim token/generation.
6.  If the worker loses its lease or another worker has reclaimed the
    delivery, its stale completion update must affect zero rows and must
    not overwrite newer state.

Do not hold row locks or database transactions open while waiting for
destination network I/O.

### 7.4 Lease timing and stale workers

Lease duration must be derived from the maximum request timeout plus
scheduling/recording margin and measured runtime behavior. Renew leases
only under a documented protocol. Use database time for database lease
comparisons where possible; do not make correctness depend solely on a
process wall clock that may step.

A lease token fences database writes; it cannot retract an HTTP request
already sent. If a worker's request is still in flight after its lease
expires, two requests may reach the destination. Therefore: - Set a
bounded outbound request deadline. - Abort the local request when its
deadline is exceeded where possible. - Keep the lease protocol
conservative enough to reduce overlapping attempts. - Require
destination-side idempotency for business-effect safety. - Record the
ambiguity when a request may have reached the destination but the
response is unknown.

No statement may claim that database fencing alone prevents duplicate
external delivery.

------------------------------------------------------------------------

## 8. Retry, backpressure, fairness, and poison events

### 8.1 Outcome classification

Classify outcomes into at least: - **Transient:** connection failure,
bounded timeout, selected 5xx responses, 429/rate limit. -
**Permanent/configuration:** invalid endpoint, TLS/configuration error,
unsupported protocol, repeated authorization failure where retrying
unchanged credentials cannot help. - **Ambiguous:** request may have
been processed but no definitive response was received. - **Success
according to transport contract:** accepted response as defined by the
destination contract; not proof of business correctness.

The exact HTTP status classification is configurable and documented.
Honor `Retry-After` where valid and bounded. Do not retry every error
forever.

### 8.2 Backoff and limits

Use exponential backoff with jitter, a maximum per-attempt timeout,
maximum attempt policy, and maximum elapsed retry age. The concrete
numbers must be configuration values selected from provider/application
requirements and tested load behavior, not copied blindly from an
example.

A terminal delivery failure must become visible and recoverable, not
disappear. A dead-letter transition records the reason and preserves
attempt history.

### 8.3 Fairness and noisy-neighbor isolation

A shared `SKIP LOCKED` queue is not sufficient to guarantee fairness.
Implement: - A global worker concurrency cap. - A per-application
in-flight limit. - Per-application rate limits where needed. -
Endpoint-specific circuit breaking or cooldowns. - A fair claim strategy
that prevents one tenant's retry backlog from monopolizing all slots. -
Reserved capacity or weighted scheduling for new eligible work, where
measurements justify it. - Metrics for oldest queue age and
per-application backlog.

Do not claim fairness until a noisy-neighbor test proves it. One failing
endpoint must not occupy every worker slot for the duration of long
timeouts.

### 8.4 Poison events

A repeated event-specific failure must not crash a worker or monopolize
capacity indefinitely. Bound response-body capture, catch per-delivery
failures, persist the outcome, and move exhausted or poison work to
dead-letter handling. Worker process supervision is a secondary recovery
mechanism, not a substitute for handling the delivery failure.

### 8.5 Backpressure

When PostgreSQL is approaching connection, storage, or write-capacity
limits, ingress must fail predictably rather than consume unbounded
memory. Enforce request-size limits, bounded pools, bounded concurrency,
and admission timeouts. Alert before disk exhaustion. Never return
success for an event that was only held in memory.

------------------------------------------------------------------------

## 9. Replay and destination idempotency contract

### 9.1 Distinguish retry, redrive, and business reprocessing

-   **Retry:** automatic repeat of an unsuccessful or ambiguous network
    attempt for the same delivery obligation.
-   **Redrive:** an authorized operator re-enables delivery for a
    failed/dead-lettered obligation, preserving the same logical event
    identity and recording why it was redriven.
-   **Business reprocessing:** a destination intentionally re-evaluates
    a business operation. This is a separate application-level workflow
    and must not be implemented as a generic transport replay that
    bypasses idempotency.

Do not add a generic `Force-Replay` header that bypasses the destination
inbox. That would turn a safety mechanism off precisely when an operator
is most likely to repeat an uncertain operation.

### 9.2 Stable identities

Include distinct immutable identifiers in the delivery contract: -
`event_id`: CWIDS logical event ID. - `delivery_id`: delivery obligation
ID. - `attempt_id` or attempt number: one network attempt. -
`schema_version`: version of the destination-facing envelope. - provider
and event type metadata, where appropriate.

The destination's business idempotency key should be stable across
ordinary retries and redrives. Attempt IDs must not be used as the
business idempotency key.

### 9.3 Signed outbound envelope

If destinations must authenticate CWIDS deliveries, define a versioned
HMAC signing contract covering a canonical byte representation or
explicitly specified fields. Include a timestamp/nonce only if the
receiver's replay policy and clock tolerance are defined. Specify key
rotation, key IDs, canonicalization, encoding, and signature
verification test vectors. Do not improvise canonicalization
independently in each destination.

Outbound signature authentication does not itself provide idempotency.

### 9.4 Destination transactional inbox

Provide a documented reference receiver or SDK contract requiring the
destination to: 1. Verify the CWIDS signature and schema. 2. Begin a
local database transaction. 3. Insert a unique inbox row keyed by stable
event/business idempotency identity. 4. If the key already exists,
return the previously defined idempotent outcome without applying the
business mutation again. 5. Apply the business-state/ledger mutation in
the same transaction as the inbox insert. 6. Commit and then respond. 7.
If the operation is asynchronous, persist its own outbox/work item
transactionally and return an acknowledgement only according to the
documented contract.

This pattern allows repeated transport requests without repeating the
business effect. If the destination cannot implement a transactional
inbox, the residual duplicate-effect risk must be disclosed and accepted
explicitly.

### 9.5 Replay audit

Every redrive records actor, reason, prior status, new status,
event/delivery IDs, attempt history reference, and timestamp. Redrive
must not erase prior failures or rewrite the original event payload.
Operators must be warned when the previous outcome is ambiguous and the
destination may already have processed it.

------------------------------------------------------------------------

## 10. Outbound SSRF and callback security

### 10.1 Registration-time checks are insufficient

Callback URL validation must occur both when a URL is registered/updated
and when a connection is established. DNS can change between validation
and delivery; redirects can bypass validation.

### 10.2 Required connection-time controls

The outbound HTTP client must: - Allow only explicitly supported schemes
(prefer HTTPS in production; any HTTP exception must be a documented
environment-specific policy). - Resolve DNS at connection time. -
Validate every resolved address against IPv4 and IPv6 special-use,
loopback, link-local, private, multicast, unspecified, and other
prohibited ranges. - Prevent DNS rebinding/time-of-check-to-time-of-use
gaps by ensuring the actual socket connects to a validated address,
while preserving correct TLS hostname verification and HTTP Host/SNI
behavior. - Reject redirects by default. If redirects are ever allowed,
every hop must repeat the complete validation and must not carry secrets
across origins. - Apply connection, TLS handshake, header, body, and
total request timeouts. - Limit response-body size and never execute
response content. - Avoid forwarding provider credentials, internal
headers, or environment secrets to destinations. - Use safe connection
pooling that cannot accidentally reuse a connection for a different
security context. - Prevent access to cloud metadata endpoints and
internal control planes.

Do not assume a simplistic private-IP blacklist is complete. Use a
maintained IP-address classification approach, test IPv4 and IPv6 edge
cases, and review the implementation against DNS rebinding. If the
chosen Node.js HTTP client cannot enforce address pinning and TLS
hostname validation safely, use a well-reviewed egress proxy/network
policy rather than an incomplete custom agent.

### 10.3 Callback destination lifecycle

-   Verify ownership of destination URLs where feasible before
    activation.
-   Version endpoint configurations.
-   Require authorization to change a destination.
-   Define how pending deliveries behave after URL rotation or
    application suspension.
-   Reject URLs pointing to the CWIDS ingress/admin endpoints to prevent
    accidental reflection loops.
-   Never expose internal DNS names, resolved addresses, or detailed
    network errors to untrusted callers.

### 10.4 Database and application isolation

Use separate least-privilege credentials for gateway, worker,
migrations, and administration. Avoid a shared superuser credential in
runtime processes. Secrets should be stored in an appropriate secret
store or protected configuration mechanism, never logged or placed in
ordinary API responses.

------------------------------------------------------------------------

## 11. Payment integrity and reconciliation

CWIDS is a webhook transport and routing system, not the authoritative
financial ledger. A valid provider signature establishes the
authenticity of a message under that provider's signing scheme; it does
not automatically prove that an application should credit a user or that
settlement is final.

### 11.1 Destination-side payment validation

The receiving application must validate the event against its own
expected payment intent/order and, where required, independently verify
the transaction with the provider. Relevant checks may include: -
Provider and merchant/account identity. - Test/live environment. -
Transaction reference. - Expected amount and currency. -
Successful/required status. - Order/payment-intent association. -
Whether the event represents a refund, reversal, dispute, or other
post-payment adjustment. - Whether the transition is legal under the
application's payment state machine.

Use integer minor units or exact decimal representations for monetary
values. Do not rely on JavaScript binary floating-point for financial
comparisons. Preserve the original payload bytes and avoid mutating
numeric fields during normalization.

### 11.2 Monotonic business state

The destination must not implement payment state as naive
last-write-wins. A delayed `pending` event must not overwrite a
confirmed success; a refund or dispute must be represented as a distinct
lifecycle event rather than erasing the original charge.

The provider-specific adapter may normalize event names, but CWIDS
should not silently impose financial business rules that belong to the
application or provider verification logic.

### 11.3 Reconciliation

Define scheduled reconciliation for: - Authenticated but unresolved
events. - Events that were accepted but have no delivery obligation
because of policy/configuration. - Long-pending and dead-lettered
deliveries. - Payments known to the application but missing expected
notifications. - Notifications that conflict with provider transaction
verification. - Refunds, reversals, and disputes. - Provider/API outages
that create uncertainty.

Reconciliation should be idempotent, rate-limited, audited, and based on
provider-supported APIs. If an event was acknowledged and later lost due
to disaster recovery, reconciliation must be capable of detecting and
repairing the discrepancy when the provider exposes sufficient data.

------------------------------------------------------------------------

## 12. Durability, backups, and deployment profiles

A database `COMMIT` guarantee depends on PostgreSQL configuration,
storage, and failover design. Document the actual durability profile
instead of using the word "durable" without a failure model.

### 12.1 Development/prototype profile

May use one host and one PostgreSQL instance. It is suitable for
controlled development and low-risk testing only. It must be labelled as
having a single infrastructure failure domain. A backup is not the same
as a continuously available standby, and a local commit cannot protect
against destruction of the only storage device.

No production payment webhook should be enabled under this profile
unless the business owner explicitly accepts the documented RPO/RTO and
loss risks.

### 12.2 Production profile

Before production, choose and document: - Target RPO and RTO. -
PostgreSQL primary/standby topology, if used. - Whether failover
replication is asynchronous or synchronous and what that implies for
acknowledged commits. - Continuous WAL archiving and point-in-time
recovery. - Backup encryption and access control. - Backup retention and
off-host/off-account storage. - Restore and failover runbooks. -
Monitoring for replication lag, WAL archive failure, disk capacity, and
backup age. - Periodic restore drills with integrity verification.

A target such as RPO below 60 seconds is a requirement to test, not a
promise created by installing a backup tool. If zero loss of
acknowledged events is required, the architecture must use a durability
configuration that supports that guarantee and must account for
availability trade-offs during replication failure.

### 12.3 Database and process operation

-   Monitor free disk space, WAL growth, autovacuum, long-running
    transactions, connection use, query latency, replication lag, and
    backup health.
-   Test graceful shutdown and in-flight request handling.
-   Ensure worker leases recover after process restarts.
-   Apply schema migrations with backward-compatible expand/contract
    sequencing where rolling deployment is required.
-   Do not route operationally critical reads to a lagging replica
    without exposing freshness. Decisions about cancelling payments,
    replaying, or declaring events missing must use an authoritative
    read or explicitly account for replication lag.
-   Do not add table partitioning, PgBouncer, multi-zone replication, or
    extra infrastructure solely because a hostile review lists them.
    Select them from the required RPO/RTO, measured load, and
    operational budget.

------------------------------------------------------------------------

## 13. Observability and alerting requirements

The service must make silent failure difficult. At minimum, expose
metrics by provider, environment, and application (with
bounded-cardinality labels):

### Ingress

-   Request count by outcome.
-   Signature failures and malformed requests.
-   Ingestion latency, transaction latency, and acknowledgement latency.
-   Database pool wait and timeout counts.
-   Duplicate recognition rate.
-   Conflicting-identity count.
-   Accepted unresolved/quarantined event count and oldest age.

### Delivery

-   Pending queue count and oldest eligible age.
-   In-flight count and expired lease count.
-   Attempt outcomes and retry rate.
-   Delivery latency by tenant/endpoint.
-   Dead-letter count and age.
-   Per-application concurrency saturation.
-   Circuit-breaker state.
-   Timeout and ambiguous-outcome count.

### Database and recovery

-   Connection utilization, disk free space, WAL growth/archive status,
    replication lag, backup age, restore-drill status, autovacuum
    health, and long-running transactions.
-   Reconciliation mismatches and age of oldest unresolved mismatch.
-   Admin replay/redrive and routing changes.

### Required alerts

-   Any authenticated event remains unresolved beyond its configured
    service-level threshold.
-   Oldest eligible delivery exceeds threshold.
-   Dead-letter or retry backlog grows unusually.
-   A provider's authentication failures spike.
-   Database storage, pool, or latency approaches a limit.
-   WAL archiving/backup/replication falls behind policy.
-   One application consumes its maximum share of delivery capacity for
    a sustained interval.
-   Reconciliation finds a financially material mismatch.

Logs must be structured and correlate by event ID, delivery ID, attempt
ID, provider connection ID, and request ID. Do not log secrets, complete
authorization headers, or unrestricted payment payloads. Metrics and
alerts must be tested, not merely documented.

------------------------------------------------------------------------

## 14. Capacity and schema-evolution policy

Do not declare a throughput target such as hundreds of deliveries per
second without a benchmark on the actual schema, payload size, hardware,
database settings, worker concurrency, and destination latency
distribution.

Before a production load target is approved, measure: - Peak and burst
ingress rate. - Payload size distribution. - Insert and claim
transaction latency. - PostgreSQL connection and write capacity. -
Worker concurrency and outbound socket use. - Retry amplification during
destination outages. - WAL and table/index growth. - Queue age and
recovery drain rate after an outage. - Backup and restore duration.

Use partial indexes for active work only where query plans demonstrate
benefit. Review hot-update behavior and autovacuum with representative
churn. Introduce partitioning when measured retention/query requirements
justify it and a migration/maintenance plan is tested. Ensure network
clients use bounded connection pools/keep-alive appropriately and do not
create unbounded sockets.

### Versioning

-   Preserve the original provider payload separately from normalized
    internal metadata.
-   Version the normalized event and destination envelope.
-   Include a `schema_version` in the destination contract from the
    first release.
-   Make new optional fields backward-compatible where possible.
-   Define handling for unknown event types: retain and mark
    unsupported/quarantined according to policy; do not silently
    misinterpret them.
-   Keep old event processing and schema readers available for queued
    events during deployment.
-   Treat identity-strategy changes as migrations requiring explicit
    compatibility and duplicate-analysis, not a casual code refactor.

------------------------------------------------------------------------

## 15. Security and authorization requirements

### 15.1 Trust boundaries

The architecture distinguishes: - Public provider ingress. - Provider
credentials/secrets. - PostgreSQL and internal persistence. - Outbound
delivery to untrusted application endpoints. - Administrative APIs and
operators. - Destination applications. - Backup and observability
systems.

Compromise of a registered destination must not grant database access or
access to another application's payloads or secrets. Compromise of a
worker must not grant unrestricted administrative or schema privileges.
A provider secret must not be usable to authenticate events for another
provider connection or environment.

### 15.2 Authorization

Every administrative action must check both identity and scope: -
Register/update/suspend an application. - Create or rotate a provider
connection. - Change endpoint URLs. - Inspect payloads. - Resolve
routing. - Replay/redrive/cancel a delivery. - Change retention or retry
policy. - Export audit or event data.

Use deny-by-default authorization and verify ownership from trusted
database records. Do not rely on hidden UI controls as authorization.

### 15.3 Payload privacy and integrity

Classify fields retained in raw payloads. Encrypt sensitive payload
storage/backups where required; restrict access; redact logs; define
retention/deletion policy. Store a digest to detect accidental changes,
but do not mistake a digest stored beside mutable data for a defense
against a database administrator who can modify both.

### 15.4 Incident containment

Document procedures for: - Provider secret compromise. - CWIDS
signing-key compromise. - Database credential compromise. - Malicious
destination registration. - Cross-tenant routing incident. -
Unauthorized replay. - Data loss or restore from backup.

Include credential revocation/rotation, delivery pausing, evidence
preservation, reconciliation, and tenant notification decisions.

------------------------------------------------------------------------

## 16. Failure handling matrix

  ------------------------------------------------------------------------
  Failure                  Required behavior       Durable evidence /
                                                   recovery
  ------------------------ ----------------------- -----------------------
  Invalid signature        Reject; do not create a Redacted security log
                           trusted delivery        and metric

  Database unavailable     Return retryable        No success
  before commit            provider failure        acknowledgement;
                                                   provider retry if
                                                   supported

  Commit result ambiguous  Do not assume; allow    Database logs, identity
                           safe retry via identity constraint,
                           constraint              ambiguous-commit metric

  Event committed,         Provider retry maps to  Duplicate observation;
  response lost            same logical event      no duplicate normal
                           where identity policy   obligation
                           supports it             

  No route match           Persist                 Alert, reconciliation,
                           `awaiting_route`; do    authorized resolution
                           not call destination    
                           synchronously           

  Worker crashes before    Lease expires and work  Attempt/claim history
  send                     becomes eligible again  

  Destination processes    Retry may occur         Stable event
  but response is lost                             idempotency key;
                                                   destination
                                                   transactional inbox

  Lease expires during     Stale worker cannot     Claim generation and
  slow request             overwrite current DB    attempt history;
                           state; duplicate HTTP   destination inbox
                           request remains         protects business
                           possible                effect

  Destination returns      Classified bounded      Attempt history and
  429/5xx                  retry with jitter and   queue metrics
                           per-tenant limits       

  Permanent                Cooldown/dead-letter    Audited configuration
  endpoint/configuration   according to policy;    correction/redrive
  error                    alert                   

  Application              Stop new deliveries per Explicit status and
  suspended/deleted        policy; preserve old    audit record
                           obligations and history 

  Operator redrive         Authorized, audited     New attempt history,
                           redrive preserving      same business
                           logical event identity  idempotency key

  Database host lost       Recover according to    Backups/WAL
                           tested RPO/RTO;         archive/restore
                           reconcile accepted      evidence
                           events                  

  SSRF attempt             Block at                Security metric without
                           connection-time         leaking internal
                           validation; no redirect topology
                           bypass                  

  One tenant floods        Per-tenant limits and   Per-tenant
  retries                  fair scheduling protect queue/latency metrics
                           other tenants           

  Unsupported event type   Persist and             Alert and adapter
                           quarantine/mark         update path
                           unsupported under       
                           policy                  

  Payload conflicts with   Do not overwrite        Both digests, receipt
  same identity            silently; quarantine or times, audit trail
                           provider-specific       
                           conflict policy         
  ------------------------------------------------------------------------

------------------------------------------------------------------------

## 17. P0/P1/P2/P3 remediation plan

### P0 --- Resolve before implementation is frozen

**P0-01 --- Deterministic routing** - Define payment-intent correlation
records and the single-application provider-connection rule. - Define
unresolved routing behavior, alert threshold, and manual resolution
policy. - Acceptance: ingress completes with destinations offline;
ambiguous events persist and alert; no event is silently routed by a
prefix collision.

**P0-02 --- Provider-specific verification** - Freeze adapter contracts
only after checking current official provider documentation and
representative payloads for the exact versions in use. - Implement
raw-body handling, fail-closed secret configuration, safe
malformed-signature handling, and test vectors. - Acceptance:
invalid/malformed signatures never crash the process or create trusted
delivery work.

**P0-03 --- Event identity and deduplication** - Document identity
policy for every supported event type and provider version. - Add
database-enforced uniqueness and conflict handling. - Acceptance:
repeated success event is deduplicated, while a refund/dispute for the
same transaction remains a distinct logical event.

**P0-04 --- Atomic event/disposition persistence** - Commit event plus
initial delivery obligation or unresolved disposition in one
transaction. - Acceptance: fault injection around every transaction
boundary yields no success acknowledgement for an uncommitted event and
no committed resolved event without its required delivery obligation.

**P0-05 --- Worker fencing and delivery semantics** - Implement short
claim transaction, lease token/generation, conditional completion
updates, and explicit ambiguous-outcome handling. - Acceptance: stale
workers cannot overwrite newer state; duplicate HTTP attempts are shown
to be possible and destination idempotency is tested.

**P0-06 --- Versioned destination contract** - Define event ID, delivery
ID, attempt ID, schema version, outbound signature, stable idempotency
semantics, and transactional inbox reference receiver. - Acceptance:
duplicate transport attempts produce one business mutation in the
reference receiver.

### P1 --- Required before production payment traffic

**P1-01 --- Connection-time SSRF defenses** - Implement/test DNS
validation and pinning, IPv4/IPv6 special-use blocking, redirect policy,
timeouts, response limits, and callback lifecycle. - Acceptance:
private/internal/metadata targets and DNS-rebinding cases are blocked
before application data is sent.

**P1-02 --- Tenant fairness and backpressure** - Implement
per-application concurrency/rate limits, fair scheduling, circuit
breaking, bounded retries, and ingress pool isolation. - Acceptance: a
failing tenant cannot occupy all worker capacity or prevent healthy
tenants from making progress under the defined test load.

**P1-03 --- Durability profile** - Decide RPO/RTO; configure backups,
WAL archiving, and standby/failover as required by that decision. -
Acceptance: restore/failover drill meets the declared objectives and
verifies data integrity.

**P1-04 --- Monitoring and unresolved-event handling** - Implement
metrics and active alerts for unresolved events, old queue age, dead
letters, ambiguous outcomes, storage, and backup health. - Acceptance:
injected failures trigger alerts within stated thresholds.

**P1-05 --- Administrative security** - Enforce authentication, scoped
authorization, least-privilege database roles, append-only audit, secret
redaction, and controlled replay. - Acceptance: unauthorized
cross-tenant reads/replays/configuration changes are denied and audited.

**P1-06 --- Payment reconciliation** - Define provider API verification,
mismatch policy, scheduled reconciliation, and operator recovery. -
Acceptance: synthetic missing notification and conflicting status
scenarios are detected and resolved without duplicate financial effects.

### P2 --- Required before meaningful scale

-   Benchmark the real schema and queue under realistic payload sizes
    and retry churn.
-   Tune partial indexes, autovacuum, connection pools, and transaction
    limits based on measurements.
-   Introduce PgBouncer if measured connection fan-out warrants it.
-   Introduce table partitioning only after a measured threshold and
    tested maintenance/migration strategy.
-   Add load-shedding and per-provider ingress quotas if required by
    traffic patterns.

### P3 --- Optional later enhancements

-   Administrative replay dashboard.
-   Advanced analytics and trend reporting.
-   Automated provider adapter conformance harness across supported
    versions.
-   Optional external queue or broker only if PostgreSQL-backed delivery
    demonstrably cannot meet measured throughput or operational
    requirements.

------------------------------------------------------------------------

## 18. Mandatory verification plan

The following tests are release gates, not optional suggestions.

1.  **Atomic acceptance:** Terminate PostgreSQL connections before,
    during, and immediately after transaction commit. Verify that
    success acknowledgements correspond only to committed
    event/disposition state.
2.  **Ambiguous commit:** Drop the connection around commit and retry
    the same request. Verify one logical event and one normal delivery
    obligation.
3.  **Identity collision:** Deliver success and refund/dispute events
    for the same transaction reference. Verify they remain separate
    logical events.
4.  **Malformed signature fuzzing:** Test empty, wrong-length,
    malformed-encoding, and oversized signatures. Verify controlled
    rejection and no uncaught exception.
5.  **Raw-body integrity:** Test proxy/middleware behavior for supported
    content encodings. Verify the bytes used for signature verification
    are exactly those specified by the provider contract.
6.  **Destination outage:** Keep a destination offline while ingesting
    events. Verify ingestion remains independent of destination
    availability and the backlog remains durable.
7.  **Stale worker:** Pause a worker beyond lease expiry while another
    worker reclaims the job. Verify stale DB completion affects zero
    rows; separately verify duplicate external requests are handled
    idempotently by the receiver.
8.  **Transactional inbox:** Deliver the same event concurrently and
    after a lost response. Verify exactly one business mutation in the
    reference receiver.
9.  **Replay semantics:** Redrive a delivered/ambiguous/dead-lettered
    event. Verify stable event identity, audit records, and no generic
    inbox bypass.
10. **SSRF/DNS rebinding:** Test loopback, private, link-local, IPv6,
    metadata addresses, redirect chains, and DNS answers that change
    between validation and connect.
11. **Noisy-neighbor:** Saturate one tenant with long timeouts and
    retryable errors. Verify other tenants continue within the declared
    latency objective.
12. **Storage pressure:** Simulate low disk and database pool
    exhaustion. Verify bounded failure, no false acknowledgement, and
    timely alerts.
13. **Restore drill:** Restore from backup/WAL to a clean environment.
    Verify event identities, delivery state, and audit integrity against
    the declared RPO/RTO.
14. **Unresolved route:** Submit a valid event with unknown/ambiguous
    correlation. Verify durable quarantine, alert, operator resolution,
    and subsequent delivery.
15. **Schema evolution:** Deploy a new envelope/schema version while
    older events remain queued. Verify old events remain processable and
    destination compatibility is explicit.
16. **Numeric fidelity:** Use representative high-precision identifiers
    and monetary fields. Verify identifiers and amounts are not
    corrupted by JavaScript number conversion.
17. **Application lifecycle:** Suspend, rotate endpoint, and retire an
    application while deliveries are pending. Verify the chosen policy
    is deterministic and audited.
18. **Secret rotation:** Exercise provider and outbound signing-key
    rotation with the documented overlap period and old-key rejection
    behavior.
19. **Retry storm:** Simulate widespread destination failure and
    recovery. Verify jitter, fairness, bounded resource use, and
    controlled backlog drain.
20. **Reconciliation:** Remove a notification from the delivery path and
    create a provider/application state mismatch. Verify reconciliation
    detects and repairs or escalates it without duplicate financial
    effects.

A test report must include environment, versions, configuration, test
input, observed result, logs/metrics, and pass/fail criteria. Do not
describe a test as passed if it was only proposed.

------------------------------------------------------------------------

## 19. Production go/no-go checklist

Production payment webhooks remain disabled until each applicable item
has an evidence artifact.

-   [ ] Provider adapter contract verified against current official
    provider documentation for every supported version.
-   [ ] Raw-body signature verification and malformed-input tests pass.
-   [ ] Event identity policy is defined per provider/event type and
    enforced by PostgreSQL constraints.
-   [ ] Event persistence and initial delivery/disposition are atomic.
-   [ ] No success acknowledgement is sent for an event that has not
    committed.
-   [ ] Unresolved routing is durable, alerted, retained, and
    recoverable.
-   [ ] Ingress routing requires no synchronous destination HTTP call.
-   [ ] Worker claims use leases and fencing; stale writes are rejected.
-   [ ] Destination transactional inbox/reference receiver passes
    duplicate-attempt tests.
-   [ ] Replay/redrive preserves event identity and cannot bypass
    idempotency by default.
-   [ ] SSRF controls are validated at connection time, including DNS
    rebinding and IPv6 cases.
-   [ ] Per-application fairness and retry backpressure pass
    noisy-neighbor tests.
-   [ ] Gateway and worker connection pools/roles are isolated and
    bounded.
-   [ ] RPO/RTO are written down and a restore/failover drill meets
    them.
-   [ ] Metrics and alerts detect unresolved events, old deliveries,
    dead letters, database pressure, and backup failures.
-   [ ] Reconciliation policy and mismatch recovery are documented and
    tested.
-   [ ] Endpoint lifecycle, secret rotation, payload retention, and
    audit policies are approved.
-   [ ] Load target has been measured on the intended deployment
    profile.
-   [ ] Rollback and incident-response procedures have been rehearsed.

------------------------------------------------------------------------

## 20. Architecture decisions that must remain explicit

The following are decisions, not implementation details to be guessed
later:

1.  Whether a provider connection is single-application or shared.
2.  How a payment intent is correlated to an application for each
    provider.
3.  The identity strategy for every supported event type.
4.  The exact behavior for authenticated but unresolved events.
5.  The provider acknowledgement behavior for database and commit
    uncertainty.
6.  Whether pending deliveries use a snapshotted destination version or
    the current endpoint.
7.  Retry count, maximum retry age, and permanent/transient
    classification.
8.  Application suspension/deletion behavior for already accepted
    deliveries.
9.  The destination's required idempotency contract.
10. The replay/redrive policy and who can authorize it.
11. Raw-payload encryption, retention, and deletion.
12. RPO/RTO and the database failure model.
13. Fairness targets and per-tenant resource limits.
14. Reconciliation ownership and acceptable mismatch response time.
15. Which provider/API versions are supported and how deprecation is
    handled.

Every decision must have an owner, rationale, accepted residual risk,
and testable acceptance criteria.

------------------------------------------------------------------------

## 21. Recommended final architecture statement

CWIDS is a PostgreSQL-backed, multi-provider webhook ingestion and
delivery service with provider-specific authentication adapters,
deterministic local routing, transactional event/disposition
persistence, a durable delivery queue, leased and fenced workers,
tenant-aware scheduling, connection-time SSRF controls, versioned
outbound envelopes, destination-side idempotency requirements, audited
replay, and payment reconciliation.

Its delivery semantics are at-least-once. It does not claim exactly-once
destination business execution without an atomic destination inbox. It
does not treat a valid webhook signature as conclusive proof of
settlement. Its durability claim is limited to the tested
PostgreSQL/infrastructure failure model and declared RPO/RTO.

The first release should remain operationally simple: Node.js, Express,
PostgreSQL, separate gateway/worker processes, and a clear adapter
boundary. Additional infrastructure is introduced only when the required
recovery objective or measured workload justifies it. Correctness,
tenant isolation, recoverability, and observable failure handling are
release requirements---not future enhancements.

## 22. Implementation status template

Use this table during implementation. Do not mark an item complete based
only on a design statement.

  -------------------------------------------------------------------------------------
  ID          Requirement               Status      Evidence    Residual    Owner
                                                    link / test risk        
                                                    run                     
  ----------- ------------------------- ----------- ----------- ----------- -----------
  P0-01       Deterministic routing     Not started                         

  P0-02       Provider-specific         Not started                         
              verification                                                  

  P0-03       Event identity and        Not started                         
              deduplication                                                 

  P0-04       Atomic ingestion          Not started                         
              transaction                                                   

  P0-05       Lease/fencing protocol    Not started                         

  P0-06       Versioned                 Not started                         
              destination/idempotency                                       
              contract                                                      

  P1-01       Connection-time SSRF      Not started                         
              controls                                                      

  P1-02       Tenant                    Not started                         
              fairness/backpressure                                         

  P1-03       Durability profile and    Not started                         
              restore drill                                                 

  P1-04       Observability and alerts  Not started                         

  P1-05       Administrative            Not started                         
              authorization/audit                                           

  P1-06       Payment reconciliation    Not started                         
  -------------------------------------------------------------------------------------


---

## 23. Follow-up amendments from the consolidated gap audit

**Status:** This section closes the specification gaps identified in the follow-up audit. It supplements and, where stated, supersedes the earlier sections. It is an architecture contract, not evidence that the implementation or provider-specific assumptions have already been tested.

### 23.1 GAP-01 — Payment-intent registration API

Add an authenticated, application-scoped internal API. Destination applications must not write directly to CWIDS tables.

**Initial contract**

`POST /v1/internal/payment-intents`

Required headers:
- `Authorization: Bearer <application-scoped-secret>` over TLS, or mTLS where the deployment can operate a certificate lifecycle.
- `Idempotency-Key: <caller-generated-unique-value>`.

Example request:

```json
{
  "provider_connection_id": "uuid",
  "environment": "test",
  "merchant_reference": "order-or-payment-intent-reference",
  "provider_reference": null,
  "virtual_account_id": null,
  "amount_minor": 125000,
  "currency": "NGN",
  "expires_at": "2026-10-29T12:00:00Z",
  "metadata": {
    "order_reference": "opaque-reference"
  }
}
```

The exact amount representation must be integer minor units where the currency supports that model; currencies with different minor-unit rules must use currency metadata rather than assuming two decimal places. Do not accept card PAN, CVV, credentials, or unnecessary customer PII in `metadata`.

The authenticated principal determines `application_id`; the caller must not be allowed to choose an arbitrary tenant ID. The service verifies that `provider_connection_id` belongs to that application and that `environment` matches the connection. Validate required fields, maximum lengths, allowed currencies, expiry bounds, and references before writing.

Response contract:
- `201 Created` for a new correlation.
- `200 OK` for a repeated idempotent request with the same canonical request.
- `409 Conflict` when the same idempotency key or correlation identity is reused with conflicting data.
- `400`/`422` for invalid input; `401`/`403` for authentication/authorization failures; `429` for an application-level quota; `503` for a transient service/database failure.

Persist the intent and idempotency record in one database transaction. Add uniqueness constraints for the application's idempotency key and for the provider connection/environment/merchant reference combination where the business model guarantees uniqueness. The API must not return success before commit.

**Authentication choice:** for a small, single-VPS deployment, start with a high-entropy per-application secret stored as a hash, sent only over TLS, scoped to specific operations, and rotated with a short overlap period. Prefer mTLS when service-to-service certificate issuance, renewal, and revocation can be operated reliably. Do not invent a shared global secret for all applications.

**Rate limits:** make limits configurable per application and connection. Treat the initial values as capacity-test starting points, not universal provider facts: 20 requests/second sustained and 100-request burst per application, with a separate administrative override for known checkout bursts. Measure rejected requests and database latency before raising or lowering them. Client retries must reuse the same idempotency key.

### 23.2 GAP-02 — Intent expiry, retention, and cleanup

`expires_at` makes a row eligible for cleanup; it does not itself delete or archive it. Add a scheduled maintenance task to the worker process, guarded so only one instance performs each cleanup batch at a time.

Rules:
1. Do not delete an intent that is referenced by a received webhook, a delivery, a reconciliation case, or an unresolved routing decision.
2. Expired, unused intents become cleanup-eligible only after a configurable grace period. Start with **7 days after `expires_at`**, subject to the provider's late-settlement and reconciliation window.
3. Delete in small indexed batches, for example 500–2,000 rows per transaction, ordered by primary key, and commit between batches. Avoid a single giant delete.
4. Record aggregate cleanup counts and failures; do not log raw payloads or customer data.
5. Retain a minimal tombstone or separate idempotency record for a defined period if deletion would otherwise permit a late duplicate registration to recreate an ambiguous correlation.
6. Add an index supporting expiry scans, such as `(expires_at, id)`, and test the cleanup query with realistic row counts.

Do not introduce time partitioning in the first release solely to solve this problem. Revisit partitioning only when observed table size and cleanup cost justify the operational complexity.

### 23.3 GAP-03 — Safe routing for dynamic provider references

A provider-generated reference cannot be used to infer a destination unless CWIDS has a deterministic, previously verified mapping. Add optional correlation aliases with an explicit namespace and uniqueness scope, conceptually:

`(provider_connection_id, environment, alias_type, alias_value) -> payment_intent_id`

Permitted aliases may include a provider transaction reference, virtual-account identifier, or another provider-supported identifier **only after its uniqueness, stability, and semantics are verified against the provider's current documentation and test events**.

- Bind virtual-account aliases to the exact provider connection and environment, and to the application/customer or payment intent established by an authenticated registration or reconciliation workflow.
- Do not route solely by customer email, display name, amount, or an unscoped account number. These can be shared, changed, missing, or ambiguous.
- If a provider does not return a stable merchant reference and no safe alias exists, keep the event in `awaiting_route`/quarantine. Provide an authenticated reconciliation workflow that records the operator, reason, selected intent, and before/after routing decision in the audit trail.
- When more than one candidate matches, never select the first row. Treat the event as ambiguous and quarantine it.
- Confirm that the provider's webhook actually carries each proposed alias before implementing that route. This document does not assert that Flutterwave or Paystack always omit or always include any specific field.

### 23.4 GAP-04 — Adaptive worker polling

Replace fixed one-second idle polling with bounded adaptive polling. Work claiming remains database-authoritative and uses `FOR UPDATE SKIP LOCKED` within a short transaction.

Initial algorithm:
- If one or more deliveries are claimed, continue immediately or after a small configurable yield to avoid monopolizing the database.
- If zero rows are claimed, sleep for a randomized delay starting around 250–500 ms and increase it exponentially up to 5 seconds.
- Reset the delay immediately after a successful claim, a database notification, or another reliable indication that work arrived.
- Add jitter so worker instances do not wake simultaneously.
- Treat PostgreSQL `LISTEN/NOTIFY`, if later introduced, as a wake-up hint only; the durable table remains the source of truth, and periodic polling remains the recovery path.
- Do not claim that empty polling itself necessarily creates significant WAL: measure database CPU, query rate, lock waits, and transaction activity. The immediate goal is to avoid needless query churn without delaying work excessively.

### 23.5 GAP-05 — Payment-critical retry horizon

Use a configurable **72-hour maximum automatic retry horizon** for payment-critical deliveries as the initial policy, unless provider contract, application SLA, or legal/business requirements establish another value. The timer begins at the first failed delivery attempt, not at event receipt.

A capped exponential schedule must be designed to cover that horizon; simply choosing 12–15 attempts does not guarantee 72-hour coverage. Use exponential backoff with full jitter, a configurable cap (initially 2 hours), and a scheduled final attempt near the horizon. Persist `first_attempt_at`, `next_attempt_at`, `attempt_count`, and the terminal reason so restarts do not reset the horizon.

- Retry network errors, timeouts, `408`, `425`, `429` (respecting a bounded `Retry-After`), and destination `5xx` responses.
- Treat most other `4xx` responses as non-retryable configuration/payload failures unless a destination contract explicitly says otherwise.
- Do not retry sooner than a valid, bounded `Retry-After`; do not allow an untrusted endpoint to request an arbitrarily long delay.
- At horizon expiry, transition to `dead_lettered` with a visible reason and alert/operational workflow. Redrive is explicit and audited; it must not erase the original attempt history.
- This is CWIDS's destination-delivery horizon, not a claim that either provider retries for exactly 72 hours. Verify current provider retry behavior separately.

### 23.6 GAP-06 — Tamper-evident administrative audit export

Keep the database audit table append-only for normal application roles, but do not describe that alone as immutable. Add structured JSON audit emission for every security-sensitive administrative change and export those records to an independently administered log sink.

Required event fields: event ID, UTC timestamp, actor/service identity, action, target type/ID, application/tenant scope where applicable, request/correlation ID, outcome, reason code, and a redacted before/after summary. Never include secrets, authorization headers, raw payment payloads, or unnecessary PII.

- Emit to stdout/stderr as structured JSON so a host-level collector can forward events to a separate account/project or write-once retention destination.
- Configure retention and access controls at the external sink; test that ordinary CWIDS database credentials cannot modify or delete exported records.
- Decide the audit-failure policy by operation. For routing, credential, permission, or replay changes, fail closed if the durable audit record cannot be committed. The external export may be asynchronous if the local durable record is committed first, but monitor export lag and alert on delivery failure.
- Do not claim true atomic dual-write across PostgreSQL and an external log sink. If guaranteed export is required, use a transactional outbox row committed with the administrative change and an idempotent exporter that marks records exported only after sink acknowledgement.

### 23.7 GAP-07 — Redrive and destination duplicate acknowledgement

CWIDS cannot independently prove whether a destination applied a business effect merely from HTTP 200. Add a documented destination response envelope, while treating it as a destination assertion rather than cryptographic proof.

For compatible destinations, require a bounded JSON response such as:

```json
{
  "delivery_id": "stable-cwids-delivery-id",
  "status": "processed"
}
```

Allowed `status` values:
- `processed`: destination claims this request caused the first committed application of the business effect.
- `duplicate_acknowledged`: destination claims it had already committed the effect for this stable delivery ID and is acknowledging the duplicate.
- `rejected`: destination intentionally rejected the request; the response must include a bounded machine-readable reason.

Require the response `delivery_id` to match the request. Parse at most the configured response cap; malformed, oversized, or mismatched responses are protocol failures, not success. Keep HTTP status semantics explicit in the destination contract. Do not assume every existing endpoint can return this envelope; provide a compatibility mode in which HTTP success means only “HTTP endpoint acknowledged,” not “business effect was newly applied.”

In the operator UI and metrics, distinguish `delivered_processed`, `delivered_duplicate_acknowledged`, and `http_acknowledged_unverified` where supported. A duplicate acknowledgement may be the correct outcome after a response was lost; it does not by itself indicate failure. If the business effect is missing despite a duplicate response, the destination's transactional inbox and business record must be reconciled.

### 23.8 PARTIAL-01 — Versioned provider-specific deduplication identity

Do not hard-code the proposed Flutterwave and Paystack string formulas as universal truths without verifying provider payload semantics. The dedupe contract is **versioned and provider-adapter-specific**.

Identity selection order:
1. Use a provider-guaranteed unique event/delivery ID when the provider documents one and the signed payload contains it.
2. Otherwise use a provider-specific stable event identity assembled from documented fields.
3. If no unique event identity exists, use a documented fallback that distinguishes lifecycle notifications which CWIDS intentionally treats as separate events.

Store the canonical identity components separately where useful, then generate a deterministic `dedupe_key` with an unambiguous encoding (length-prefixed fields or canonical JSON with a fixed field order), not naive concatenation. Store `identity_strategy_version`. Avoid collisions caused by separators appearing in values.

A status field belongs in the identity only when provider semantics establish that different statuses are distinct notifications that must each be processed. A transaction ID alone may collapse legitimate lifecycle events; adding status indiscriminately may create duplicates. For each provider, add captured signed fixtures for success, duplicate delivery, status transitions, missing fields, and malformed identity data. Changing identity logic requires a migration/compatibility plan; do not silently re-key historical events.

### 23.9 PARTIAL-02 — Payload envelope encryption

Encrypt persisted raw webhook payloads at the application layer where they contain sensitive customer/payment information or where policy requires it. Do not assert that every webhook field is PCI cardholder data; determine the actual data elements and compliance scope with the applicable provider/security requirements. Never store CVV or full sensitive authentication data after authorization.

Initial envelope format:
- Generate a cryptographically secure random 256-bit data-encryption key (DEK) per event.
- Encrypt the original raw bytes using AES-256-GCM with a unique 96-bit nonce and an authentication tag.
- Wrap the DEK using a key-encryption key (KEK) held outside the database (KMS preferred; a protected secret manager/environment injection is a constrained initial deployment option).
- Persist ciphertext, nonce, authentication tag, wrapped DEK, key ID/version, and algorithm/version metadata. Use authenticated additional data to bind the ciphertext to the event ID and schema version.
- Never write plaintext payloads or keys to logs, traces, error messages, crash reports, or audit events.
- Define key rotation: new writes use the active KEK; old DEKs are rewrapped under the new KEK where supported, or decrypted/re-encrypted through a controlled migration. Keep old key versions available until all dependent data is migrated or expired.
- Encrypt backups and restrict decryption to the minimum service role. Test tampered ciphertext, unavailable key service, rotation, backup restore, and key-loss recovery.

### 23.10 PARTIAL-03 — Tenant isolation and PostgreSQL RLS

Add database-enforced Row-Level Security for tenant-owned rows as defense in depth, in addition to application authorization and explicit tenant predicates. Apply policies consistently to tenant-owned tables and test reads, updates, deletes, inserts, joins, and background jobs.

For request-scoped queries, set the tenant using `SET LOCAL app.current_tenant = '<validated-uuid>'` inside the same transaction that executes the query. Prefer parameterized `set_config('app.current_tenant', $1, true)` where appropriate. Never use session-level tenant state on pooled connections without guaranteed reset.

Critical limitations and controls:
- The runtime role must not own protected tables and must not have `BYPASSRLS`; use `FORCE ROW LEVEL SECURITY` where appropriate.
- Administrative and cross-tenant worker tasks need explicitly separate, tightly restricted roles or narrowly scoped procedures. They must not inherit arbitrary tenant context from a previous pooled request.
- RLS is not a substitute for correct authorization; a role that can set arbitrary tenant context can still access that tenant. The trusted service boundary must authenticate and authorize the tenant before setting context.
- Include negative cross-tenant tests in CI. A forgotten `WHERE application_id = ...` must not expose another application's rows through a tenant-scoped connection.

### 23.11 PARTIAL-04 — Exact Express raw-body middleware order

The webhook route must receive the original bytes for signature verification. Register it before any global JSON parser, or mount the JSON parser only on non-webhook routes.

```javascript
import express from "express";

const app = express();

app.post(
  "/v1/webhooks/:provider/:connectionId",
  express.raw({
    type: "application/json",
    limit: "1mb"
  }),
  inboundWebhookHandler
);

// Register JSON parsing only for routes that need parsed JSON.
// Do not place app.use(express.json()) before the raw webhook route.
app.use("/v1", express.json({ limit: "256kb" }));
```

The handler verifies the provider signature against the exact `Buffer` bytes, then parses JSON only after verification. Reject unexpected content types and oversized bodies. Provider adapters may require different signature headers or algorithms; this snippet specifies byte preservation, not a universal signature algorithm. Add integration tests that prove whitespace/key-order changes do not alter the bytes used for verification and that invalid signatures never reach routing or persistence.

### 23.12 PARTIAL-05 — Circuit-breaker policy

Maintain circuit state per destination endpoint (and, if endpoints can be independently configured per application, per endpoint configuration version), not as one global breaker for all applications.

Initial policy:
- Open after 5 consecutive qualifying failures within a rolling 60-second window.
- Qualifying failures: connection failures, timeouts, and `5xx`; treat `429` as rate limiting/backpressure, not as a generic endpoint-health failure. Do not trip on normal application `4xx` responses unless repeated protocol failures are separately configured.
- Cool down for 120 seconds, then enter half-open.
- Permit exactly one real delivery attempt as the half-open probe; do not send an invented `HEAD` or ping request unless the destination has a separately documented health endpoint.
- A successful, valid acknowledgement closes the breaker and resets the failure count. A qualifying failure reopens it and resets the cooldown.
- Persist or reconstruct state safely across worker restarts. Do not let several workers independently run multiple half-open probes; coordinate probe ownership in PostgreSQL.
- Expose open/half-open state, last transition, and time open to operators. These are initial defaults to validate under load, not immutable universal thresholds.

### 23.13 PARTIAL-06 — Bounded outbound response capture

Limit captured destination response bodies to **2,048 bytes** for the initial implementation. Enforce the cap while streaming/reading the response; do not first buffer an unbounded response and truncate it afterward. If the response exceeds the cap, stop retaining additional bytes and record `truncated=true` plus the observed/declared size when safely available.

Also:
- Apply a response timeout and maximum header size supported by the chosen HTTP client.
- Do not log response bodies by default; store a redacted excerpt only when operationally necessary.
- Do not treat response-body truncation alone as delivery failure if the required acknowledgement has already been parsed and validated within the limit. If the contract requires a complete envelope and it cannot be validated within the cap, treat it as a protocol failure.
- Test compressed responses and decompression limits to prevent a small compressed response from expanding into unbounded memory.

### 23.14 PARTIAL-07 — Explicit deduplication uniqueness DDL

Require PostgreSQL 15+ only if the migration actually depends on `NULLS NOT DISTINCT`. Prefer making all columns in the identity constraint `NOT NULL` where the identity model permits it; nullable optional provider IDs should not be part of the primary dedupe constraint.

Preferred shape:

```sql
provider_connection_id UUID NOT NULL,
environment TEXT NOT NULL,
identity_strategy_version INTEGER NOT NULL,
dedupe_key TEXT NOT NULL,
CONSTRAINT uq_webhook_identity UNIQUE (
  provider_connection_id,
  environment,
  identity_strategy_version,
  dedupe_key
)
```

If the schema genuinely requires nullable columns to compare as equal, PostgreSQL 15+ supports `UNIQUE NULLS NOT DISTINCT`; declare and test the minimum PostgreSQL version explicitly. Do not use a nullable `provider_event_id` as the only deduplication key. Add a migration test that attempts duplicate inserts and proves the database rejects them under the actual schema.

### 23.15 PARTIAL-08 — Ingress limits without rejecting legitimate provider bursts

Do not apply an indiscriminate low global rate limit to provider webhooks: provider retries can amplify outages, and a `429` is useful only if the provider retries it as expected. Configure limits by provider connection and/or verified source network where supported, and monitor before enforcement.

Initial capacity-test values may be 50 requests/second sustained with a 200-request burst per connection, but they are starting values only. Load-test representative payload sizes and burst patterns, then set limits above expected legitimate peaks with safety headroom. Confirm current provider IP-range guidance and signature verification behavior; IP allowlisting is defense in depth, not a replacement for signature verification.

- Apply a hard request-body size limit, content-type validation, connection/read timeouts, and bounded concurrency.
- If an authenticated internal registration API exceeds its quota, return `429` with `Retry-After`.
- For provider ingress, prefer a durable-queue/database backpressure policy that avoids acknowledging events that were not committed. Return a provider-compatible retryable error when the event cannot be durably accepted; use `429` only where the provider's retry semantics are known and tested.
- Add metrics for accepted, rejected, rate-limited, signature-failed, and database-unavailable requests per provider connection.

### 23.16 DEBT-01 — Implementation sequencing and specification drift

Treat the audit's statement that the codebase contains stubs as a point-in-time finding, not a permanent fact. Before coding, inspect the current repository and record commit, working-tree state, migration status, and executable test baseline.

Implement in dependency order:
1. Database schema and constraints, including tenant isolation and encryption metadata.
2. Provider fixtures, raw-byte signature verification, deduplication identity, and atomic ingress transaction.
3. Payment-intent API and safe routing/quarantine paths.
4. Delivery claim/lease/fencing protocol and bounded outbound HTTP client.
5. Retry, circuit breaker, redrive, audit export, and cleanup.
6. Reconciliation, backup/restore, metrics, and deployment runbooks.

Each milestone must include tests and a migration review. Do not write handlers first and retrofit database invariants afterward.

### 23.17 DEBT-02 — PostgreSQL queue churn and maintenance

PostgreSQL remains the initial durable queue because it reduces infrastructure and operational burden. This is an explicit scale trade-off, not an automatic defect.

- Add partial indexes for claimable states and ensure claim queries match those indexes.
- Tune autovacuum from observed dead-tuple growth, update frequency, table size, vacuum duration, and replication/WAL behavior. The audit's sample autovacuum values are candidates to test, not values to apply blindly to every environment.
- Keep attempt history append-oriented and avoid repeatedly updating large event rows when only delivery scheduling state changes.
- Monitor `n_dead_tup`, autovacuum/analyze timestamps, table/index growth, WAL volume, claim latency, lock waits, and oldest pending-delivery age.
- Load-test with realistic retry storms and a representative mixture of successful and failed deliveries. Define a measured migration trigger based on sustained throughput, p95/p99 claim latency, vacuum lag, WAL volume, and recovery objectives. **Do not use 500 events/second as a universal queue-migration threshold.**
- Consider a dedicated queue only when measurement shows PostgreSQL can no longer meet the required service levels. The database still remains the event and delivery system of record unless a separate durable architecture is explicitly designed.

### 23.18 DEBT-03 — Single-host failure and production availability

A single VPS with co-located PostgreSQL is a valid development/demo profile but is not high availability. Process supervision cannot protect against host, disk, database, or network failure.

Before accepting production payment-critical traffic, document:
- Required RPO and RTO, and who accepts them.
- Automated backups, retention, encryption, and a successful restore drill.
- Off-host backup storage and independent credentials.
- Database health/disk alerts and a tested recovery procedure.
- Provider-specific retry and reconciliation procedures for events arriving during downtime.

A managed database with automated failover is the preferred production option when affordable and operationally appropriate, but multi-zone failover is a deployment decision driven by availability requirements and budget, not an unconditional requirement for every prototype. If the service cannot meet the accepted RPO/RTO, label the deployment non-production and do not imply that webhooks are protected from prolonged outages.

### 23.19 DEBT-04 — Lease timing and fencing

Use PostgreSQL as the authority for lease creation and expiry. Set and compare lease timestamps in SQL using database time; do not use Node.js `Date.now()` to decide whether a lease has expired.

Every claim must increment or allocate a monotonically increasing fencing generation/token. A worker's completion update must include delivery ID, lease token/generation, and expected state. If the token no longer matches, the update affects zero rows and the stale worker must not overwrite newer database state.

This prevents stale database writes, but cannot retract an HTTP request already sent by a stale worker. Destination idempotency remains required to limit duplicate business effects. Test clock jumps, worker pauses beyond lease expiry, process restarts, and completion after a newer claim.

### 23.20 DEBT-05 — Gateway/worker resource isolation

Run gateway and worker as separate processes from the same codebase initially, with independent configuration and database pools. This provides process-crash isolation but not CPU, memory, disk, or host-failure isolation.

For a constrained prototype:
- Set explicit worker concurrency, request-body limits, response limits, and memory monitoring.
- Avoid CPU-heavy synchronous work on the ingress event loop.
- Reserve database connections for ingress so worker saturation cannot consume the entire pool.
- Monitor event-loop delay, process RSS, CPU, database pool wait time, and ingress acknowledgement latency.

For production, separate hosts/containers or enforce OS/container resource limits when load tests show contention or the accepted availability target requires it. Do not require separate VMs before the product has a measured need and budget, but do not describe separate PM2 processes as full resource isolation.

### 23.21 DEBT-06 — SSRF protection and vetted HTTP transport

Prefer a maintained HTTP client and a small, reviewed transport/agent layer over ad hoc socket code. The implementation must:
- Resolve destination hostnames at connection time and reject loopback, private, link-local, multicast, unspecified, reserved, and cloud-metadata destinations for both IPv4 and IPv6, according to an explicit allow/deny policy.
- Pin the validated resolved address for the actual connection while preserving the original hostname for TLS certificate verification, SNI, and the HTTP `Host` header.
- Revalidate on new connections and after DNS changes; do not assume an earlier registration-time lookup remains valid.
- Disable redirects by default. If redirects are allowed by a product requirement, revalidate every redirect target and cap redirect count.
- Keep TLS certificate and hostname verification enabled. Never solve certificate errors by disabling verification.
- Bound DNS lookup, connect, TLS handshake, header, and response times.
- Test IPv4/IPv6 private ranges, DNS rebinding, mixed public/private DNS answers, redirects to metadata addresses, TLS hostname mismatch, connection reuse, and connection-pool cleanup.

Do not claim SSRF protection is complete until those tests pass against the actual HTTP client/agent configuration.

### 23.22 Additional schema, operations, and acceptance gates

The following are now Phase 1/production acceptance requirements, not informal future considerations:

- **Migrations:** versioned, repeatable deployment process; transactional migrations where PostgreSQL permits; startup must not let every application replica race to run unsafe schema changes.
- **Database roles:** distinct least-privilege roles for migrations, ingress, worker, and administration. The runtime roles must not be superusers, table owners where RLS protection is expected, or `BYPASSRLS` roles.
- **Retention:** define separate retention periods for raw encrypted payloads, normalized event metadata, delivery attempts, audit events, idempotency records, and payment-intent correlations. Apply deletion only after legal/business retention and reconciliation needs are considered.
- **Secrets:** do not commit secrets; define provisioning, rotation, revocation, and incident response for provider signing secrets, internal API credentials, encryption keys, and outbound signing keys.
- **Recovery:** rehearse restore from backup, replay/reconciliation after an outage, and key recovery. A backup that has never been restored is not a verified recovery mechanism.
- **Capacity:** load-test ingress bursts, DB outage, destination outage, retry storms, slow response bodies, and a growing dead-letter queue. Set alert thresholds from the service's explicit SLO/RPO/RTO.
- **Provider correctness:** maintain signed, sanitized fixtures and provider contract tests for each configured provider/environment. Verify field semantics and retry behavior against current provider documentation before freezing adapter rules.
- **No false guarantee:** “durably accepted” means the database transaction committed; “delivered” means the destination met the configured acknowledgement contract; neither statement alone proves a payment was settled or a downstream business effect is correct.

### 23.23 Revised pre-coding gate

Do not freeze Phase 1 until these are complete:

1. Approve the payment-intent API, auth, idempotency, and quotas.
2. Approve provider-specific routing aliases and the quarantine/manual-reconciliation path.
3. Freeze versioned provider deduplication rules using real/sanitized signed fixtures.
4. Implement schema constraints, RLS policies, roles, and cross-tenant negative tests.
5. Implement raw-body preservation and provider signature tests.
6. Approve envelope encryption, key custody, rotation, and restore tests.
7. Implement atomic ingest/acknowledgement semantics and crash/commit-ambiguity tests.
8. Implement DB-time leases, fencing, adaptive polling, bounded response capture, and circuit-breaker coordination.
9. Freeze retry horizon and redrive/duplicate acknowledgement semantics.
10. Implement expiry cleanup, audit outbox/export, and retention rules.
11. Define deployment profile, RPO/RTO, backup/restore drill, metrics, and load-test acceptance thresholds.

The original sections remain valid where they do not conflict with this section. Where a previous section left a value configurable or deferred, this section provides the initial contract; values identified as capacity-test starting points must be validated against actual traffic before production.

### 23.24 Final Implementation & Remediation Reconciliation (Workstreams W0–W8)

The following definitive implementation contracts have been fully remediated, verified, and committed across Workstreams W0 through W8:

1. **Database Runtime Roles and Complete RLS Coverage (W1):**
   - Three dedicated least-privilege roles are established: `cwids_ingress`, `cwids_worker`, and `cwids_admin`. None possess `SUPERUSER` or `BYPASSRLS`.
   - Complete Row-Level Security (`ENABLE` and `FORCE ROW LEVEL SECURITY`) is enforced across all tenant tables: `applications`, `destination_endpoints`, `payment_intent_correlations`, `webhook_events`, `event_deliveries`, and `delivery_attempts`.
   - `cwids_ingress` can insert unrouted webhooks (`application_id IS NULL`) and query active payment intents across shared connections.
   - `cwids_worker` performs cross-tenant fair-share batch claims when `app.current_tenant` is unset; and under `app.current_tenant` can only read/mutate data for that tenant.

2. **Redrive Epochs and 72-Hour Retry Horizon (W4):**
   - The global `attempt_count` on `event_deliveries` and `delivery_attempts` is strictly monotonic and preserved across all attempts and manual redrives.
   - Redrive operations (`POST /v1/admin/deliveries/:id/redrive`) are restricted to `cwids_admin`. They assign a new `epoch_id`, reset `epoch_attempt_count = 0`, reset `horizon_started_at = CURRENT_TIMESTAMP`, and increment `redrive_count` and `fencing_token`.
   - The 72-hour retry horizon is measured from `horizon_started_at` (the first failure of the current epoch), not event receipt.
   - Next-attempt delays use database time (`CURRENT_TIMESTAMP + interval`), exponential backoff with full jitter `[0.5*delay, 1.5*delay]`, a 5-second floor, and an emergency ceiling of `max_retries = 50`.

3. **Anti-Squatting Reference Guards & Mode C Distinct (W6):**
   - On shared provider connections (`provider_connections.application_id IS NULL`), merchant references MUST be prefixed with the tenant's registered code: `${app.code}_<ref>`. Non-prefixed or mismatched references are rejected with HTTP 422 (`INVALID_MERCHANT_REFERENCE`).
   - Mode A and Mode C queries use `SELECT DISTINCT` with `status IN ('active', 'consumed') AND (expires_at IS NULL OR expires_at + INTERVAL '7 days' >= CURRENT_TIMESTAMP)` to eliminate false quarantines when multiple aliases point to the same intent.
   - Registering a dynamic alias (`POST /v1/internal/payment-intents/:id/aliases`) atomically searches for existing `awaiting_route` webhooks matching the new alias and routes them immediately to `resolved`, creating their initial delivery obligations.

4. **Dispatcher Safety, Envelope Verification, and Status Classifications (W5):**
   - Destination 4xx responses: Retried within 72h horizon with operational alerts; HTTP 408 (`Request Timeout`) and HTTP 425 (`Too Early`) are classified as transient retryable. HTTP 501 (`Not Implemented`) dead-letters immediately as `NOT_IMPLEMENTED`.
   - Destination response verification modes (`destination_endpoints.response_validation_mode`):
     - `loose`: Any HTTP 2xx is accepted as delivery success.
     - `strict`: Destination must return HTTP 200 or 202 with a valid JSON acceptance envelope (`{ "received": true }` or `{ "status": "acknowledged" }` or `{ "success": true }`).
   - Response streams exceeding 2KB (2,048 bytes) are severed immediately via `res.destroy()`, and settled cleanly on `'close'` without memory bloat or hung promises.

5. **Ingress Backpressure & Authentic Malformed Persistence (W7):**
   - Ingress returns HTTP 503 `Service Unavailable` with `Retry-After: 30` when database connection pool is exhausted or unavailable.
   - Authentic provider webhooks (valid HMAC signature) containing malformed JSON or unsupported schemas are persisted with AES-256-GCM encrypted payload, `routing_status = 'rejected'`, and return HTTP 200 `{ "status": "acknowledged", "routing_status": "rejected" }` to prevent provider retry floods.

6. **Retention Safety & Dynamic Active Endpoint Resolution (W8):**
   - Automated payload pruning (30 days) and metadata purging (90 days) strictly exclude `awaiting_route` and `quarantined` events to preserve forensic evidence.
   - The retention engine scans for and emits operational alerts for unrouted/quarantined events older than 90 days.
   - Delivery workers resolve the latest active destination endpoint (`ORDER BY version DESC LIMIT 1`) at dispatch time, ensuring URL rotations and key updates take effect immediately for pending retries.
   - Every delivery attempt records `destination_endpoint_id` and `endpoint_version` in `cwids.delivery_attempts`.

