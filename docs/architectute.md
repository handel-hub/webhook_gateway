# Centralized Webhook Ingestion and Delivery Service

## Architecture, Technical Design and Implementation Specification

**Document type:** Software Architecture and Implementation Specification  
**Version:** 1.0 — Initial implementation baseline  
**Status:** Ready for architecture review and phased implementation  
**Primary stack:** Node.js, Express, PostgreSQL, `pg`, PM2  
**Initial provider:** Flutterwave  
**Future providers:** Paystack and other webhook-capable providers

---

# 1. Executive Summary

## 1.1 Purpose

The Centralized Webhook Ingestion and Delivery Service (CWIDS) is an independently deployable application responsible for receiving webhook events from external providers, persisting them durably, routing them to the correct registered application, and delivering them asynchronously with retry and recovery capabilities.

The service is intended to support multiple applications owned or operated by the same organization. Each application may have its own business logic, payment flows, and internal endpoints, while the webhook infrastructure is shared.

Instead of configuring every application with a separate public webhook endpoint, external providers send events to a centralized endpoint managed by CWIDS.

CWIDS then determines which application should receive each event, records the event and its delivery obligations in PostgreSQL, acknowledges the provider, and delivers the event independently of the provider's request lifecycle.

## 1.2 Core architectural principle

**An inbound webhook is accepted only when the system has durably recorded the event and the work required to process it.**

The service must never depend on an in-memory task, timer, promise, or queue entry as the sole record that an event needs to be delivered.

PostgreSQL is the authoritative record of:

- Registered applications and provider connections.
- Incoming webhook events.
- Event-to-application routing decisions.
- Pending, active, completed, and failed deliveries.
- Delivery attempts and their outcomes.
- Administrative operations and configuration changes.

Process memory is used only for temporary execution state, caches that can safely be rebuilt, and bounded concurrency management.

## 1.3 Goals

CWIDS must:

1. Provide a single, stable webhook endpoint per provider integration and environment.
2. Support multiple registered applications without creating a separate physical database table for each application.
3. Verify inbound provider authenticity before accepting events as trusted.
4. Preserve the original webhook body and relevant verification evidence.
5. Commit the event and its initial delivery work atomically.
6. Return a successful acknowledgement only after durable persistence succeeds.
7. Deliver events asynchronously to the appropriate application.
8. Support retries, deduplication, concurrency control, crash recovery, and controlled replay.
9. Authenticate outbound deliveries so receiving applications can verify their origin and integrity.
10. Provide operational visibility into queue health, failures, latency, and delivery history.
11. Support provider-specific integrations behind a common internal interface.
12. Remain maintainable and deployable on modest infrastructure.

## 1.4 Non-goals

The initial system will not:

- Replace Flutterwave or Paystack's payment processing infrastructure.
- Become a payment processor or financial ledger.
- Independently declare payments successful based solely on a webhook.
- Guarantee exactly-once HTTP delivery.
- Execute application business logic inside the gateway.
- Become a general-purpose message broker.
- Introduce a distributed microservices architecture.
- Require Redis, Kafka, RabbitMQ, Kubernetes, or an ORM.
- Guarantee high availability from a single server.
- Provide a public self-service application marketplace in the first release.

CWIDS transports and records events. The application responsible for a transaction remains responsible for applying its business rules, while the payment-owning system remains responsible for verifying and reconciling payment state.

---

# 2. Terminology and Domain Model

The implementation must distinguish between the following entities.

| Term                | Definition                                                                                               |
| ------------------- | -------------------------------------------------------------------------------------------------------- |
| Application         | A registered destination that is authorized to receive particular events.                                |
| Provider            | An external event source, such as Flutterwave or Paystack.                                               |
| Provider connection | A specific provider account or merchant integration associated with an environment and configuration.    |
| Webhook request     | One HTTP request received from an external provider.                                                     |
| Webhook event       | The durable internal representation of a received event.                                                 |
| Delivery            | The obligation to send an event to one registered application.                                           |
| Delivery attempt    | One outbound HTTP attempt for a delivery.                                                                |
| Delivery lease      | A temporary database-backed claim held by a worker.                                                      |
| Idempotency key     | A stable identifier used to prevent duplicate logical operations.                                        |
| Dead-letter state   | A terminal or manually recoverable state reached after the automatic retry policy is exhausted.          |
| Reconciliation      | A separate process that compares local transaction records against the authoritative provider's records. |
| Replay              | A deliberate attempt to deliver an existing event again, with an auditable reason.                       |

These entities must not be conflated.

A provider can send the same event multiple times. One event can have one delivery or multiple deliveries, depending on routing policy. One delivery can have multiple attempts.

For example:

```text
Provider connection
    |
    +---- Webhook event E-100
                |
                +---- Delivery to Application A
                |         +---- Attempt 1: timeout
                |         +---- Attempt 2: HTTP 503
                |         +---- Attempt 3: HTTP 200
                |
                +---- Delivery to Application B (optional routing)
                          +---- Attempt 1: HTTP 200
```

The example illustrates the data model. The initial payment integration should normally resolve each payment event to its single intended application unless a deliberately configured fan-out use case requires multiple destinations.

---

# 3. System Architecture

## 3.1 High-level architecture

```text
             EXTERNAL PROVIDERS
          +----------------------+
          | Flutterwave          |
          | Paystack             |
          | Future providers     |
          +----------+-----------+
                     |
                     | HTTPS POST
                     v
          +----------------------+
          | Inbound HTTP Gateway |
          |                      |
          | Raw body capture     |
          | Signature validation |
          | Connection lookup    |
          | Event classification |
          | Correlation/routing  |
          +----------+-----------+
                     |
                     v
          +----------------------+
          | PostgreSQL           |
          |                      |
          | Provider connections |
          | Applications         |
          | Webhook events       |
          | Deliveries           |
          | Attempts             |
          | Audit records        |
          +----------+-----------+
                     |
                     | Durable pending work
                     v
          +----------------------+
          | Delivery Workers     |
          |                      |
          | Atomic work claiming |
          | Lease management     |
          | Outbound signing     |
          | HTTP delivery        |
          | Retry scheduling     |
          +----------+-----------+
                     |
                     | HTTPS POST
                     v
          +----------------------+
          | Registered Apps      |
          |                      |
          | App A                |
          | App B                |
          | App C                |
          +----------------------+

          Additional components:
          - Administrative API
          - Monitoring and health checks
          - Recovery and retry sweeper
          - Payment reconciliation integration
```

## 3.2 Deployment model

The initial deployment consists of one codebase and one PostgreSQL database.

The codebase exposes distinct execution roles:

1. **Gateway process:** Receives inbound webhooks and serves operational HTTP endpoints.
2. **Worker process:** Claims and delivers pending events.
3. **Maintenance tasks:** Recover expired leases, identify exhausted work, perform cleanup, and collect operational metrics.

The gateway and worker can run as separate PM2-managed processes using the same application code and configuration.

This is a logical separation, not a requirement to create separate microservices or repositories.

Separating the processes prevents slow outbound HTTP requests from consuming the inbound server's entire request-handling capacity.

## 3.3 Trust boundaries

There are three major trust boundaries.

**Boundary A — External provider to gateway**

The gateway accepts requests from the public internet. It must authenticate the provider, enforce request limits, and reject invalid or malformed traffic.

**Boundary B — Gateway to PostgreSQL**

Only the application service should have database credentials. Database access must use parameterized SQL and least-privilege permissions.

**Boundary C — Gateway to destination applications**

The gateway must authenticate its outbound deliveries, restrict registered destinations, and prevent arbitrary URL routing. The destination must verify the gateway's signature and process deliveries idempotently.

A valid inbound provider signature does not automatically authorize the destination application to perform a financial operation. The application must still validate the event against its own transaction records.

---

# 4. Provider Integration and Routing

## 4.1 One endpoint per provider integration

A proposed initial endpoint structure is:

```text
POST /v1/webhooks/flutterwave/{connectionId}
POST /v1/webhooks/paystack/{connectionId}
```

The `connectionId` identifies a pre-registered provider connection, not an application-supplied destination.

The connection determines:

- Provider type.
- Environment, such as test or live.
- Provider account or merchant identity, where available.
- Secret reference and signature-verification configuration.
- Permitted event categories.
- Routing policy.
- Whether the connection is active.

The identifier should be a non-secret, high-entropy identifier where practical. It is not an authentication mechanism.

For providers whose webhook configuration expects one fixed URL, the identifier can be embedded in the configured URL if supported. Otherwise, use a fixed provider endpoint and resolve the connection through trusted configuration and provider account context.

Do not assume that a provider can always send an arbitrary application identifier in its URL or metadata.

## 4.2 Application registration

Every destination application must be registered before receiving events.

Registration records should contain:

- Internal application ID.
- Human-readable name.
- Unique slug or reference.
- Environment.
- Status.
- Authorized event categories.
- Destination endpoint configuration.
- Outbound signing-key reference.
- Creation and modification timestamps.

Applications should have explicit lifecycle states:

```text
pending -> active -> suspended -> retired
```

Only active applications may receive new deliveries.

Suspension must not delete existing events or deliveries. Existing work should remain durable and be handled according to an explicit suspension policy.

## 4.3 Provider connection mapping

A provider connection and an application are different entities.

A provider connection represents the provider account and configuration through which events arrive. An application represents a destination.

The relationship should allow one provider connection to serve multiple applications, provided the routing rules can reliably distinguish their events.

For payment events, routing should preferably follow this process:

1. Verify the provider's signature.
2. Extract the provider transaction reference and relevant identifiers.
3. Resolve the transaction against a trusted payment-intent or transaction record.
4. Confirm that the transaction belongs to an application and provider connection consistent with the event.
5. Create the delivery for that application.
6. Quarantine or flag events that cannot be resolved safely.

The gateway may store a correlation reference in the event payload's metadata, but it must not blindly trust metadata to redirect an event.

An attacker or misconfigured integration must not be able to choose an arbitrary destination simply by supplying an application ID.

## 4.4 Provider-agnostic interface

Implement a provider adapter interface conceptually equivalent to:

```text
ProviderAdapter
    verifyRequest(rawBody, headers, connectionConfig)
    parseEvent(rawBody, headers)
    identifyEvent(parsedEvent)
    identifyTransaction(parsedEvent)
    classifyEvent(parsedEvent)
    validateProviderAccount(parsedEvent, connectionConfig)
```

The adapter returns a normalized representation for internal routing while preserving the original body separately.

The common ingestion service must not contain provider-specific signature algorithms, header names, or payload assumptions.

### Initial Flutterwave adapter

Flutterwave's current documentation describes HMAC-SHA256 verification through the `flutterwave-signature` header for the documented integration. Older integrations may use the `verif-hash` secret-hash mechanism.

Reference: https://developer.flutterwave.com/docs/webhooks

Implementation requirements:

- Confirm the exact Flutterwave API/integration version being used.
- Configure the matching signature-verification method.
- Capture the raw body before JSON parsing or transformation.
- Use the appropriate secret and signature encoding.
- Compare signatures safely.
- Reject invalid signatures.
- Never treat a missing signature as a valid event.

Do not silently accept both signature formats without knowing which configuration applies to the connection.

### Future Paystack adapter

Paystack documents an `x-paystack-signature` header containing an HMAC-SHA512 signature of the event payload, using the applicable secret key.

Reference: https://paystack.com/docs/payments/webhooks/

The Paystack adapter should implement that verification scheme separately from Flutterwave's.

Provider-specific event identifiers, retry behaviour, payload formats, and transaction-verification APIs must be documented and tested independently.

---

# 5. Inbound Event Processing

## 5.1 Required request lifecycle

The inbound handler should execute the following steps:

1. Validate HTTP method, path, content type and request-size limit.
2. Resolve the provider connection from trusted configuration.
3. Capture the raw request body.
4. Verify the provider signature.
5. Parse the payload using the provider adapter.
6. Validate the payload structure and supported event category.
7. Resolve the intended application or determine that routing requires review.
8. Construct the event record and delivery record.
9. Begin a PostgreSQL transaction.
10. Insert or identify an existing event using the deduplication policy.
11. Insert the initial delivery if required.
12. Commit the transaction.
13. Return the provider's expected successful acknowledgement.

No outbound HTTP request to a destination application should be performed in the inbound request path.

No payment verification API call should be required before acknowledging an otherwise authentic event, unless the integration specifically requires that check to establish the authenticity or validity of the inbound request. Transaction verification can be performed asynchronously before granting value.

## 5.2 HTTP acknowledgement policy

Return HTTP 200 only after durable acceptance.

A practical response policy is:

| Situation                                    | Response policy                                                                                                  |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- |
| Valid new event, committed successfully      | HTTP 200                                                                                                         |
| Authentic duplicate already recorded         | HTTP 200                                                                                                         |
| Invalid signature                            | Reject with an appropriate non-success response                                                                  |
| Invalid or oversized request                 | Reject according to request-validation policy                                                                    |
| PostgreSQL unavailable or transaction failed | Return a non-success response so provider retry mechanisms can operate                                           |
| Unknown routing target                       | Persist a quarantine record if safely identifiable, then acknowledge according to the explicit quarantine policy |
| Internal failure before durable acceptance   | Non-success response                                                                                             |

For unknown routing targets, the policy must be deliberate. If the event has passed authenticity verification and can be safely persisted, quarantine it and acknowledge it rather than allowing repeated provider retries to create an uncontrolled storm. Alert operators and provide a controlled resolution mechanism.

If the service cannot durably record the request, it must not claim successful acceptance.

The precise HTTP response and retry behaviour must be tested against each provider's documentation and environment.

## 5.3 Preserve raw payloads

The gateway should store the original raw body as a PostgreSQL `bytea` value or an equivalent exact-byte representation.

A parsed JSONB representation may also be stored for searching and diagnostics, but it is not a replacement for the raw body.

Store only allowlisted request headers that are relevant to authentication and debugging. For example, preserve the provider signature header or an appropriately protected verification record.

Do not store arbitrary headers, cookies, authorization credentials or unrelated secrets.

Calculate a SHA-256 digest of the raw body for integrity verification and investigation. The digest is not a substitute for provider signature verification or a provider event ID.

## 5.4 Deduplication

Use the strongest stable event identity available.

Preferred order:

1. Provider-issued event ID, scoped to the provider connection.
2. A documented, stable provider event identity derived from the resource identifier and event type.
3. A carefully defined fallback deduplication key for providers that do not expose a stable event ID.

A raw-body hash should not be the sole deduplication key. Two legitimate notifications can have identical bodies, while a repeated logical event may have different timestamps or other fields.

Where a provider lacks a unique event ID, the adapter must document the deduplication assumptions and limitations.

A unique database constraint must enforce the chosen deduplication identity. Application-level "check, then insert" logic alone is insufficient under concurrent requests.

---

# 6. PostgreSQL Data Model

The following schema is an initial implementation baseline. It deliberately separates application registration, provider configuration, immutable event records, delivery state, attempt history and administrative audit records.

Use UUID identifiers generated by the application or PostgreSQL. Store monetary values as integer minor units or validated exact decimal values in the payment-owning application's transaction model; do not use floating-point arithmetic for financial decisions.

## 6.1 `applications`

Purpose: Registered destination applications.

Suggested fields:

- `id UUID PRIMARY KEY`
- `slug TEXT NOT NULL UNIQUE`
- `name TEXT NOT NULL`
- `environment TEXT NOT NULL`
- `status TEXT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`

Constraints:

- Environment must be one of the defined values, such as `test` or `live`.
- Status must be one of the supported lifecycle states.
- A slug must not be reused in a way that causes historical events to be misattributed.

## 6.2 `provider_connections`

Purpose: Provider-account configuration and inbound authentication.

Suggested fields:

- `id UUID PRIMARY KEY`
- `provider TEXT NOT NULL`
- `environment TEXT NOT NULL`
- `provider_account_ref TEXT`
- `status TEXT NOT NULL`
- `verification_scheme TEXT NOT NULL`
- `secret_reference TEXT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`

The secret reference should identify a secret held in protected configuration or a secret-management mechanism. Do not store plaintext provider secrets in ordinary application configuration rows.

If a secret is stored in the database, use an appropriate encryption design with key material managed separately.

## 6.3 `application_provider_routes`

Purpose: Explicit routing configuration between provider connections and applications.

Suggested fields:

- `id UUID PRIMARY KEY`
- `provider_connection_id UUID NOT NULL`
- `application_id UUID NOT NULL`
- `route_key TEXT`
- `event_type TEXT`
- `status TEXT NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`

Use foreign keys to the provider connection and application tables.

Enforce uniqueness for the applicable routing key and event scope. The exact constraint depends on whether one event category can be routed to one or several applications.

Do not permit ambiguous routing. If multiple routes match and fan-out is not explicitly configured, quarantine the event rather than choosing an arbitrary destination.

## 6.4 `webhook_events`

Purpose: Immutable record of accepted provider events.

Suggested fields:

- `id UUID PRIMARY KEY`
- `provider_connection_id UUID NOT NULL`
- `provider_event_id TEXT`
- `event_type TEXT`
- `provider_resource_ref TEXT`
- `dedupe_key TEXT NOT NULL`
- `raw_body BYTEA NOT NULL`
- `payload_json JSONB`
- `body_sha256 BYTEA NOT NULL`
- `relevant_headers JSONB NOT NULL`
- `signature_verified BOOLEAN NOT NULL`
- `verification_scheme TEXT NOT NULL`
- `received_at TIMESTAMPTZ NOT NULL`
- `correlation_status TEXT NOT NULL`
- `correlation_reference TEXT`
- `created_at TIMESTAMPTZ NOT NULL`

Important constraints:

- `dedupe_key` must be unique within the appropriate provider-connection scope.
- `body_sha256` must have the expected digest length.
- `signature_verified` must be true for events entering the trusted processing path.
- Foreign keys must prevent dangling provider-connection references.

For a fallback identity strategy, define a separate uniqueness policy rather than allowing nullable provider event IDs to undermine deduplication.

Avoid unrestricted updates to original payload and verification fields. Operational state belongs in the delivery and audit tables.

## 6.5 `event_deliveries`

Purpose: Durable delivery obligations.

Suggested fields:

- `id UUID PRIMARY KEY`
- `event_id UUID NOT NULL`
- `application_id UUID NOT NULL`
- `destination_config_version TEXT NOT NULL`
- `status TEXT NOT NULL`
- `attempt_count INTEGER NOT NULL DEFAULT 0`
- `max_attempts INTEGER`
- `next_attempt_at TIMESTAMPTZ`
- `lease_owner TEXT`
- `lease_token UUID`
- `lease_expires_at TIMESTAMPTZ`
- `last_http_status INTEGER`
- `last_error_code TEXT`
- `last_error_summary TEXT`
- `created_at TIMESTAMPTZ NOT NULL`
- `updated_at TIMESTAMPTZ NOT NULL`
- `delivered_at TIMESTAMPTZ`

Initial states:

- `pending`
- `in_flight`
- `retry_scheduled`
- `delivered`
- `dead_letter`
- `cancelled`

The initial release should normally enforce one delivery per event and application using a unique constraint on `(event_id, application_id)`. If controlled replay is needed, record replay operations explicitly rather than bypassing that constraint.

## 6.6 `delivery_attempts`

Purpose: Append-only history of outbound attempts.

Suggested fields:

- `id UUID PRIMARY KEY`
- `delivery_id UUID NOT NULL`
- `attempt_number INTEGER NOT NULL`
- `lease_token UUID`
- `started_at TIMESTAMPTZ NOT NULL`
- `finished_at TIMESTAMPTZ`
- `outcome TEXT`
- `http_status INTEGER`
- `duration_ms BIGINT`
- `error_code TEXT`
- `response_summary TEXT`
- `created_at TIMESTAMPTZ NOT NULL`

Enforce uniqueness on `(delivery_id, attempt_number)`.

Response bodies should be truncated and sanitized. Do not store unbounded responses or sensitive destination data unnecessarily.

## 6.7 `administrative_audit_events`

Purpose: Record important control-plane operations.

Suggested fields:

- `id UUID PRIMARY KEY`
- `actor_type TEXT NOT NULL`
- `actor_id TEXT`
- `action TEXT NOT NULL`
- `target_type TEXT NOT NULL`
- `target_id TEXT`
- `reason TEXT`
- `metadata JSONB NOT NULL`
- `created_at TIMESTAMPTZ NOT NULL`

Record application registration, suspension, endpoint changes, key rotation, manual replay, delivery cancellation and other privileged changes.

## 6.8 Indexes

Create indexes for actual access patterns, including:

- Pending deliveries ordered by `next_attempt_at`.
- Expired in-flight delivery leases.
- Delivery history by application and creation time.
- Delivery attempts by delivery ID and attempt number.
- Events by provider connection and received time.
- Events by provider resource reference.
- Events by correlation status.
- Administrative audit history by target and timestamp.

Use partial indexes for pending and retryable states where beneficial. Validate query plans with realistic data before adding excessive indexes.

## 6.9 Data retention

Define separate retention policies for:

- Raw webhook bodies.
- Parsed event data.
- Delivery attempts.
- Administrative audit history.
- Operational logs.

Retention must account for payment disputes, reconciliation, security investigations and applicable privacy requirements.

Do not delete events merely because they were delivered. Apply retention rules only after the relevant audit and recovery requirements have been satisfied.

---

# 7. Transaction Boundaries and Idempotency

## 7.1 Atomic ingestion transaction

The following operations must occur in one PostgreSQL transaction:

1. Insert the accepted webhook event, or detect that it already exists.
2. Determine whether a delivery is required.
3. Insert the delivery record or records.
4. Record any durable quarantine or correlation state required by the ingestion policy.
5. Commit.

If any required insertion fails, roll back the transaction.

Conceptual SQL:

```sql
BEGIN;

-- Insert the event using the provider-scoped dedupe key.
-- A uniqueness conflict means the logical event already exists.

-- If the event is new and safely routable:
-- Insert the initial delivery record.

-- If it is authentic but cannot be routed safely:
-- Persist an explicit quarantine state.

COMMIT;
```

The production implementation must define what happens when a uniqueness conflict occurs. It must not create a duplicate delivery merely because the provider resent an event.

If the event already exists but its delivery record is unexpectedly missing, use a controlled recovery or repair procedure rather than silently treating the database as consistent.

## 7.2 Idempotency at three levels

**Level 1: Inbound idempotency**

The same logical provider event must not create duplicate event records.

**Level 2: Delivery idempotency**

Repeated delivery attempts must retain the same logical event and delivery identity.

**Level 3: Destination business idempotency**

The destination application must prevent the same payment notification from applying its business effect twice.

CWIDS cannot guarantee exactly-once execution of arbitrary external application code. It can provide durable, at-least-once delivery attempts and stable identifiers that make idempotent processing possible.

## 7.3 Destination processing contract

Each registered application should implement a receiver that:

1. Captures the raw body.
2. Verifies the gateway's outbound signature.
3. Validates the delivery ID and timestamp.
4. Starts a local database transaction.
5. Inserts the delivery ID into an inbox or processed-events table with a unique constraint.
6. Applies the required business operation in that same transaction.
7. Commits.
8. Returns HTTP 2xx only after the durable operation succeeds.

If the delivery ID already exists, the application should return a successful response without repeating the business operation.

If the application cannot persist or process the event safely, it should return a retryable failure.

This receiver-side inbox is essential when a delivery may cause financial or subscription-related effects.

---

# 8. Delivery Worker Architecture

## 8.1 Worker lifecycle

Each worker follows this lifecycle:

```text
START
  |
  v
Claim eligible delivery
  |
  v
Create attempt record
  |
  v
Load event and destination configuration
  |
  v
Build and sign outbound request
  |
  v
Send request with timeout
  |
  v
Classify result
  |
  +---- Success ----> Mark delivered
  |
  +---- Retryable --> Schedule retry
  |
  +---- Permanent --> Dead-letter or suspend
  |
  v
Release/expire lease safely
  |
  v
Claim next delivery
```

The worker must not keep a database transaction open while waiting for the destination's HTTP response.

## 8.2 Atomic claiming

Use PostgreSQL row locking to coordinate workers.

A typical approach uses `FOR UPDATE SKIP LOCKED` to claim work without multiple workers ordinarily selecting the same row.

The claim operation should:

- Select eligible pending or retry-scheduled deliveries.
- Ensure `next_attempt_at` is due.
- Lock selected rows.
- Set status to `in_flight`.
- Assign a unique lease token.
- Set a lease expiration time.
- Increment or reserve the attempt number according to a consistent policy.
- Commit quickly.

Use a transaction for the claim and commit it before outbound network activity.

Every subsequent status update must verify that the worker still owns the relevant lease token. A worker whose lease expired must not overwrite the state written by a newer worker.

## 8.3 Lease recovery

A worker may crash after claiming a delivery.

A maintenance process must periodically find expired in-flight leases and return the affected deliveries to an eligible state, subject to the retry policy.

The lease duration must account for the outbound timeout and expected scheduling delays. If delivery may take longer, use an explicit lease-extension mechanism.

Lease expiry alone cannot prove that the destination did not process the request. The old request may still complete after a new attempt starts. This is another reason receiver-side idempotency is mandatory.

## 8.4 Retry policy

Retry policy should be configurable and bounded by a clear operational objective.

Use exponential backoff with jitter:

```text
delay = min(max_delay, base_delay * 2^retry_index)
actual_delay = randomized value within the configured backoff window
```

For illustration only, a policy might begin around a few seconds and grow to several minutes, with a configurable upper bound. The actual values should be chosen based on the importance of the event, destination capacity and operational requirements.

Retryable conditions typically include:

- Connection refused.
- Connection timeout.
- DNS or temporary network failure.
- HTTP 408.
- HTTP 429, respecting a valid `Retry-After` where applicable.
- HTTP 500, 502, 503 or 504.

Permanent or configuration-related conditions may include:

- Invalid destination configuration.
- An unsupported endpoint.
- HTTP 400 or 422 when the request itself is invalid.
- Authentication failures that persist after a bounded retry policy.

Do not treat every HTTP response identically. Make the classifier configurable and record the classification reason.

For a critical payment event, exhausted automatic retries should move the delivery into a durable dead-letter state and generate an alert. The record must remain available for investigation and deliberate replay.

## 8.5 Bounded concurrency

Set a configurable maximum number of simultaneous outbound requests per worker process.

Also implement per-application concurrency limits to prevent one destination from monopolizing the gateway.

A worker should not create an unbounded number of promises or HTTP connections merely because the pending queue grows.

Start conservatively, measure CPU, memory, database connection usage and destination latency, then tune concurrency.

## 8.6 Outbound request contract

A proposed request format:

```http
POST /registered-endpoint
Content-Type: application/json
X-CWIDS-Delivery-Id: <delivery-uuid>
X-CWIDS-Event-Id: <event-uuid>
X-CWIDS-Timestamp: <unix-timestamp>
X-CWIDS-Signature: <signature>
```

The JSON body should contain a versioned envelope:

```json
{
  "schema_version": 1,
  "delivery_id": "delivery-uuid",
  "event_id": "event-uuid",
  "provider": "flutterwave",
  "event_type": "provider.event.type",
  "occurred_at": null,
  "received_at": "ISO-8601 timestamp",
  "data": {},
  "delivery": {
    "attempt": 1
  }
}
```

The example is illustrative. The actual `data` field must be defined by the provider adapter and must not invent fields absent from the source event.

The original provider payload should remain separately available in the gateway's event record. A destination can receive either the original payload or a documented normalized envelope, but that choice must be consistent and versioned.

Sign a canonical representation of the request, including the delivery ID, timestamp and body digest. Define the encoding, field order, separators, hash algorithm and signature encoding precisely.

For example, HMAC-SHA256 can be used for the outbound envelope if implemented consistently by both sides.

The receiving application must compare signatures safely and reject stale timestamps outside the permitted window. The stable delivery ID remains the idempotency key.

---

# 9. Destination Registration and SSRF Protection

Destination registration is a security-sensitive operation.

If an attacker can register an arbitrary destination, they may use the gateway to send requests to internal services, cloud metadata endpoints or other protected network resources.

Required controls:

- Only authenticated, authorized administrators may register or modify destinations.
- Permit HTTPS destinations in production.
- Reject loopback, private, link-local, multicast and otherwise prohibited address ranges.
- Validate DNS resolution and protect against DNS rebinding.
- Revalidate destination addresses when establishing connections.
- Disable redirects by default.
- Apply outbound connection and response timeouts.
- Limit response-body size.
- Never forward provider credentials to destination applications.
- Keep destination signing keys scoped to their registered application.
- Record destination changes in the administrative audit log.

If destinations are intended to be owned by the same organization, an allowlist of approved domains may be simpler and safer than unrestricted URL registration.

Store a version of the destination configuration on each delivery. This helps explain which endpoint was used historically.

For security-sensitive endpoint changes, define whether pending deliveries use the configuration active at receipt or the currently active configuration. A sensible initial policy is to snapshot a configuration version for auditability and allow controlled migration or replay when an endpoint must change.

---

# 10. Administrative API

The first release should provide a small, private administrative API rather than a public application-registration portal.

Suggested endpoint inventory:

| Method | Endpoint                             | Purpose                             |
| ------ | ------------------------------------ | ----------------------------------- |
| POST   | `/v1/admin/applications`             | Register an application             |
| GET    | `/v1/admin/applications`             | List registered applications        |
| GET    | `/v1/admin/applications/:id`         | Retrieve application configuration  |
| PATCH  | `/v1/admin/applications/:id`         | Modify permitted configuration      |
| POST   | `/v1/admin/applications/:id/suspend` | Suspend a destination               |
| POST   | `/v1/admin/provider-connections`     | Register a provider connection      |
| GET    | `/v1/admin/events`                   | Search events                       |
| GET    | `/v1/admin/events/:id`               | Inspect an event                    |
| GET    | `/v1/admin/deliveries`               | Search deliveries                   |
| GET    | `/v1/admin/deliveries/:id`           | Inspect delivery state and attempts |
| POST   | `/v1/admin/deliveries/:id/replay`    | Request controlled replay           |
| POST   | `/v1/admin/deliveries/:id/cancel`    | Cancel eligible pending work        |
| GET    | `/v1/admin/health`                   | Operational health summary          |

All administrative endpoints must be protected by authentication and role-based authorization.

The initial implementation can use a private operator credential or an existing administrative authentication system, provided credentials are handled securely. Do not expose administrative endpoints without authentication merely because the service is intended for internal use.

Replay must require a reason and produce an audit record. It must not silently delete previous attempts or rewrite the original event.

---

# 11. Internal Module Structure

A modular monolith is the recommended initial design.

Suggested directory layout:

```text
cwids/
├── package.json
├── .env.example
├── README.md
├── migrations/
│   ├── 001_initial_schema.sql
│   ├── 002_indexes.sql
│   └── 003_constraints.sql
├── src/
│   ├── main/
│   │   ├── gateway-entry.js
│   │   ├── worker-entry.js
│   │   └── composition-root.js
│   ├── config/
│   │   ├── load-config.js
│   │   └── validate-config.js
│   ├── http/
│   │   ├── app.js
│   │   ├── middleware/
│   │   ├── routes/
│   │   └── controllers/
│   ├── providers/
│   │   ├── provider-registry.js
│   │   ├── flutterwave/
│   │   │   ├── adapter.js
│   │   │   ├── signature.js
│   │   │   └── parser.js
│   │   └── paystack/
│   │       ├── adapter.js
│   │       ├── signature.js
│   │       └── parser.js
│   ├── applications/
│   │   ├── application-service.js
│   │   └── route-resolver.js
│   ├── ingestion/
│   │   ├── ingestion-service.js
│   │   ├── deduplication-service.js
│   │   └── quarantine-service.js
│   ├── deliveries/
│   │   ├── delivery-service.js
│   │   ├── delivery-worker.js
│   │   ├── delivery-claimer.js
│   │   ├── lease-manager.js
│   │   ├── retry-policy.js
│   │   ├── request-signer.js
│   │   └── response-classifier.js
│   ├── persistence/
│   │   ├── postgres.js
│   │   ├── repositories/
│   │   └── transaction.js
│   ├── admin/
│   │   ├── admin-service.js
│   │   └── audit-service.js
│   ├── maintenance/
│   │   ├── lease-recovery.js
│   │   ├── queue-monitor.js
│   │   └── retention.js
│   ├── security/
│   │   ├── secret-provider.js
│   │   ├── destination-policy.js
│   │   └── authentication.js
│   ├── observability/
│   │   ├── logger.js
│   │   ├── metrics.js
│   │   └── health.js
│   └── shared/
│       ├── errors.js
│       ├── constants.js
│       └── identifiers.js
└── test/
    ├── unit/
    ├── integration/
    ├── fault-injection/
    └── end-to-end/
```

The exact filenames can change during implementation. The important architectural constraints are:

- Controllers should not contain business logic or raw SQL.
- Provider adapters should not perform database writes.
- Repositories should not make HTTP requests.
- Delivery workers should not implement provider-specific signature verification.
- Administrative services should enforce authorization and audit privileged operations.
- The composition root should construct dependencies explicitly.

Avoid introducing a dependency-injection framework solely for this project. Simple constructors and explicit dependency passing are sufficient.

---

# 12. Database Access and Concurrency

Use the PostgreSQL client `pg` with parameterized SQL.

The repository layer should expose operations such as:

- `insertOrFindEvent`
- `createDelivery`
- `claimPendingDeliveries`
- `markDeliveryDelivered`
- `scheduleDeliveryRetry`
- `recoverExpiredLeases`
- `recordDeliveryAttempt`
- `findEvents`
- `findDeliveryHistory`

Repositories should not make decisions about payment validity or destination authorization. Those decisions belong in the appropriate service layer.

Important rules:

1. Never concatenate untrusted input into SQL.
2. Use database transactions for multi-record invariants.
3. Keep transactions short.
4. Never hold a database transaction open during outbound HTTP delivery.
5. Use unique constraints to enforce deduplication.
6. Use row locking to coordinate workers.
7. Use lease tokens to fence stale workers.
8. Define a consistent ordering for operations that lock multiple records.
9. Use connection-pool limits appropriate for the server's memory.
10. Apply database statement timeouts and connection timeouts where appropriate.

The service must handle deadlocks and transient database failures deliberately. A transaction that is aborted must not be treated as committed.

---

# 13. Reliability and Recovery

## 13.1 Failure matrix

| Failure                                          | Required behaviour                                                 |
| ------------------------------------------------ | ------------------------------------------------------------------ |
| Invalid provider signature                       | Reject without creating a trusted delivery                         |
| Database unavailable before commit               | Do not acknowledge successful acceptance                           |
| Database commit succeeds but response is lost    | Provider retry must be deduplicated                                |
| Gateway crashes after commit                     | Restarted workers discover pending deliveries                      |
| Worker crashes after claiming                    | Expired lease is recovered                                         |
| Destination times out                            | Retry using the same delivery identity                             |
| Destination processes event but response is lost | Retry; destination idempotency prevents duplicate business effects |
| Destination returns HTTP 503                     | Schedule a retry                                                   |
| Destination remains unavailable                  | Retain durable state, alert and apply retry policy                 |
| Invalid destination                              | Dead-letter or suspend according to policy                         |
| Unknown routing target                           | Persist quarantine state and alert                                 |
| PostgreSQL disk fills                            | Fail safely, alert, and avoid false acknowledgements               |
| Duplicate provider notification                  | Do not create a duplicate logical event                            |
| Secret rotation                                  | Support controlled overlap or coordinated cutover                  |
| Server reboot                                    | PM2 restores processes; workers recover database-backed work       |
| Provider never delivers an event                 | Reconciliation detects discrepancies where possible                |

## 13.2 Graceful shutdown

On shutdown, the process should:

1. Stop accepting new work.
2. Stop claiming new deliveries.
3. Allow active HTTP requests to finish within a defined deadline.
4. Allow in-flight worker operations to finish or abort safely.
5. Ensure unresolved work remains recoverable through database state and lease expiry.
6. Close database pools and HTTP clients.
7. Exit within the configured shutdown window.

Do not mark a delivery as delivered merely because a process is shutting down.

## 13.3 Backup and recovery

Define:

- PostgreSQL backup frequency.
- Backup storage location.
- Retention policy.
- Recovery objectives.
- Restore-testing frequency.
- Secret recovery procedure.
- Procedure for rebuilding the application on a replacement host.

A backup is not considered reliable until a restore has been tested.

A single PostgreSQL instance remains a single point of failure even when PM2 restarts the Node.js processes.

---

# 14. Monitoring and Operational Health

The service should expose separate liveness and readiness checks.

**Liveness** answers whether the process is running and able to make progress.

**Readiness** answers whether the process can safely accept the relevant work, including whether required dependencies are available.

Recommended metrics:

- Inbound request count by provider and response status.
- Signature-verification failures.
- Ingestion latency.
- PostgreSQL transaction failures.
- Duplicate event count.
- Pending delivery count.
- Age of the oldest pending delivery.
- Delivery success and failure counts.
- Delivery latency.
- Retry count.
- Expired lease count.
- Dead-letter count.
- Quarantined event count.
- Outbound HTTP timeouts.
- Per-application failure rate.
- Database pool saturation.
- Process memory and CPU usage.
- Disk capacity and PostgreSQL storage growth.

Avoid logging raw payloads by default. Logs should contain event IDs, delivery IDs, provider connection IDs, application IDs and sanitized error information.

Alert on conditions that indicate loss of progress, such as an increasing age of pending events, repeated database failures, a growing dead-letter queue or an exhausted disk.

---

# 15. Deployment and PM2 Configuration

## 15.1 Initial deployment

The initial environment may run on a single VPS with:

- Node.js runtime.
- PostgreSQL.
- Reverse proxy with HTTPS.
- Gateway process.
- Worker process.
- PM2.
- Database backups.
- Persistent logs and monitoring.

The deployment should not require Docker or a container orchestration system.

## 15.2 PM2 responsibilities

PM2 should:

- Restart crashed Node.js processes.
- Start the configured processes after machine reboot.
- Capture process output.
- Provide basic process status and resource monitoring.
- Support controlled restarts during deployment.

PM2 is not a database recovery mechanism and does not make a single machine highly available.

## 15.3 Process separation

Run the gateway and workers as separate processes.

The gateway should have bounded inbound request handling and database access. Workers should have bounded delivery concurrency and separate operational limits.

Do not start multiple copies of a worker without verifying that the database claiming and lease protocols are safe under concurrency.

## 15.4 Configuration

Configuration must be validated at startup.

Typical environment variables include:

```text
NODE_ENV
PORT
DATABASE_URL
DATABASE_POOL_MAX
DATABASE_CONNECT_TIMEOUT_MS
HTTP_REQUEST_TIMEOUT_MS
OUTBOUND_REQUEST_TIMEOUT_MS
WORKER_CONCURRENCY
DELIVERY_LEASE_SECONDS
RETRY_BASE_DELAY_MS
RETRY_MAX_DELAY_MS
LOG_LEVEL
```

Provider credentials and destination signing keys should be supplied through a protected secret mechanism. The actual variable names depend on the selected secret provider and deployment arrangement.

Never commit production credentials to source control.

---

# 16. Security Requirements

Security must be enforced in the implementation, not merely described in documentation.

## 16.1 Inbound security

- HTTPS for production.
- Correct provider signature verification.
- Raw-body preservation.
- Constant-time comparison where appropriate.
- Request-size limits.
- JSON parsing limits and validation.
- Rate limiting and abuse monitoring.
- No trust in caller-supplied routing destinations.
- No secret values in logs or error messages.

## 16.2 Database security

- Dedicated PostgreSQL role for the service.
- Least-privilege grants.
- Parameterized SQL.
- Restricted network access.
- Protected backups.
- Explicit retention policies.
- No unrestricted database access from registered applications.
- Separate credentials for administrative operations where appropriate.

## 16.3 Outbound security

- Per-application signing credentials.
- Destination URL validation.
- SSRF protection.
- No automatic redirects by default.
- Request and response size limits.
- Timeouts.
- TLS certificate verification.
- Per-application rate and concurrency limits.

## 16.4 Administrative security

- Authenticated operator access.
- Role-based permissions.
- Audited configuration changes.
- Controlled secret rotation.
- Explicit reasons for replay and cancellation.
- No unrestricted event deletion.
- No public endpoint that exposes arbitrary event payloads.

## 16.5 Threat model

The implementation should explicitly consider:

- Forged provider requests.
- Replayed requests.
- Duplicate notifications.
- Malicious registered destinations.
- Compromised application credentials.
- Database credential compromise.
- Denial-of-service traffic.
- Secret leakage through logs.
- Race conditions between workers.
- Stale workers updating delivery state.
- Unauthorized event replay.
- Misrouting between applications.
- Provider account/environment confusion.

Security tests should attempt to falsify the assumption that an event can only reach its intended authorized destination.

---

# 17. Payment Verification and Reconciliation

CWIDS must not become the authority for whether money has actually been received.

For a successful payment notification, the payment-owning application should verify the provider transaction using the provider's supported transaction-verification API when required by its payment flow.

Verify the fields relevant to the transaction, including:

- Provider transaction identity.
- Transaction reference.
- Final status.
- Expected amount.
- Currency.
- Provider account or merchant identity.
- Expected application or order.
- Whether the transaction has already been applied.

The exact fields and rules must match the selected provider and payment product.

Official references:

- Flutterwave webhooks: https://developer.flutterwave.com/docs/webhooks
- Paystack webhooks: https://paystack.com/docs/payments/webhooks/

In addition, payment-owning applications should periodically reconcile unresolved transactions with the provider. Reconciliation should be idempotent and must not blindly apply value a second time.

CWIDS may transport reconciliation-related events, but it should not assume ownership of application-specific payment ledgers.

---

# 18. Testing Strategy

The system is not ready for production merely because a webhook can be received and forwarded successfully.

## 18.1 Unit tests

Test:

- Provider signature verification.
- Invalid and missing signatures.
- Raw-body handling.
- Payload parsing.
- Event identity generation.
- Deduplication rules.
- Route resolution.
- Retry scheduling.
- HTTP response classification.
- Outbound request signing.
- Destination validation.
- Configuration validation.

## 18.2 Database integration tests

Test:

- Event and delivery insertion in one transaction.
- Rollback when delivery insertion fails.
- Duplicate event insertion under concurrency.
- Unique constraints.
- Concurrent worker claims.
- Lease expiration and recovery.
- Stale lease-token rejection.
- Delivery-state transitions.
- Attempt-history persistence.
- Administrative audit records.

## 18.3 Fault-injection tests

Intentionally simulate:

1. PostgreSQL unavailable before ingestion.
2. Database connection loss during commit.
3. Process termination immediately after commit.
4. Process termination immediately after claiming a delivery.
5. Destination processes the event but the response is lost.
6. Destination returns HTTP 500 repeatedly.
7. Destination never responds.
8. Worker lease expires while a request is active.
9. Two workers claim work simultaneously.
10. Secret rotation during active delivery.
11. Invalid destination registration.
12. Full disk or database capacity exhaustion.
13. Malformed and oversized requests.
14. Duplicate provider events arriving concurrently.

For each test, assert the resulting database state rather than relying only on logs or HTTP responses.

## 18.4 End-to-end tests

Verify that:

- Flutterwave test events reach the correct application.
- Paystack test events use the correct signature scheme.
- Duplicate events do not create duplicate logical deliveries.
- Failed destinations recover without manual database edits.
- Events remain pending across process restarts.
- Dead-lettered deliveries can be replayed with an audit trail.
- A suspended application cannot receive new unauthorized deliveries.
- Payment-owning applications do not apply a financial effect twice.

## 18.5 Acceptance criteria

The initial release should not be accepted until all of the following hold:

- No event is acknowledged as durably accepted before its transaction commits.
- Every accepted, routable event has a durable delivery record.
- Duplicate inbound events cannot create duplicate logical event records.
- Worker crashes do not permanently strand claimed deliveries.
- Concurrent workers do not ordinarily claim the same active lease.
- A stale worker cannot overwrite newer delivery state.
- Every attempt is traceable to its event and delivery.
- Destination applications can authenticate requests and deduplicate them.
- Retry exhaustion is visible and recoverable.
- Administrative replay and configuration changes are audited.
- Provider signature verification has automated tests.
- Database backups have been restored successfully in a test.
- Operational alerts identify failures that threaten event delivery.

---

# 19. Phased Implementation Plan

Implement the service in the following order. Each phase should have its own completion criteria.

## Phase 1 — Project foundation

- Create the Node.js project.
- Establish module boundaries and the composition root.
- Configure validated environment variables.
- Set up PostgreSQL connectivity through `pg`.
- Add database migration tooling.
- Add structured logging and graceful shutdown.
- Configure the gateway and worker entry points.

**Exit criterion:** The application starts reliably, validates configuration, connects to PostgreSQL and shuts down cleanly.

## Phase 2 — Database schema and invariants

- Implement application and provider-connection tables.
- Implement event, delivery and attempt tables.
- Implement administrative audit records.
- Add foreign keys, uniqueness constraints and indexes.
- Test transaction rollback and concurrent deduplication.

**Exit criterion:** Database constraints enforce the core invariants independently of application-level checks.

## Phase 3 — Flutterwave ingestion

- Implement the applicable Flutterwave signature-verification scheme.
- Capture raw request bodies.
- Parse and classify supported event types.
- Resolve provider connections and application routes.
- Persist events and deliveries atomically.
- Implement correct acknowledgement behaviour.

**Exit criterion:** Authentic events are durably accepted; invalid requests are rejected; duplicates do not create duplicate logical events.

## Phase 4 — Delivery worker

- Implement atomic work claiming.
- Add leases and stale-worker fencing.
- Implement outbound request signing.
- Add bounded HTTP delivery.
- Persist every delivery attempt.
- Implement success and failure transitions.

**Exit criterion:** The worker delivers events and recovers safely from process termination and destination failure.

## Phase 5 — Retry and recovery

- Implement backoff and jitter.
- Add lease-recovery maintenance.
- Add dead-letter handling.
- Add manual replay with audit logging.
- Test duplicate processing and uncertain HTTP outcomes.

**Exit criterion:** No delivery depends solely on in-memory state, and failed work can be recovered through documented procedures.

## Phase 6 — Administrative operations and security

- Add application registration and suspension.
- Add provider-connection management.
- Secure administrative routes.
- Implement destination validation and SSRF protections.
- Add secret rotation procedures.
- Implement operational inspection and replay endpoints.

**Exit criterion:** Only authorized operators can change routing or destination configuration, and sensitive operations are auditable.

## Phase 7 — Observability and deployment

- Add health checks and operational metrics.
- Configure PM2 startup and recovery.
- Configure HTTPS and reverse-proxy limits.
- Establish PostgreSQL backups.
- Configure alerts.
- Test machine restart and database recovery.

**Exit criterion:** The service can be operated and diagnosed without relying on manual inspection of process memory.

## Phase 8 — Production-hardening review

- Execute fault-injection tests.
- Review database invariants.
- Verify payment reconciliation responsibilities.
- Test application-side idempotency.
- Conduct a security review.
- Document operational runbooks and retention policies.

**Exit criterion:** The system satisfies the acceptance criteria in Section 18.

---

# 20. Decisions to Freeze Before Implementation

The following decisions should be recorded explicitly in the project README or architecture decision records.

| Decision                   | Initial recommendation                                           |
| -------------------------- | ---------------------------------------------------------------- |
| Architecture               | Modular monolith                                                 |
| Runtime                    | Node.js                                                          |
| HTTP framework             | Express                                                          |
| Database                   | PostgreSQL                                                       |
| Database access            | `pg` and parameterized SQL                                       |
| Process management         | PM2                                                              |
| Durable queue              | PostgreSQL delivery table                                        |
| Initial provider           | Flutterwave                                                      |
| Future provider            | Paystack adapter                                                 |
| Inbound acknowledgement    | After durable transaction commit                                 |
| Event identity             | Provider-scoped unique identity                                  |
| Delivery semantics         | At-least-once attempts                                           |
| Destination semantics      | Idempotent processing                                            |
| Concurrency coordination   | PostgreSQL row locks and leases                                  |
| Retry policy               | Exponential backoff with jitter                                  |
| Failed delivery handling   | Dead-letter state and controlled replay                          |
| Raw event preservation     | PostgreSQL `bytea` plus SHA-256 digest                           |
| Destination authentication | Per-application request signing                                  |
| Administrative access      | Authenticated and audited                                        |
| Payment authority          | Payment-owning application and provider verification             |
| Initial deployment         | Single server, with explicit single-point-of-failure limitations |

Any departure from these choices should be documented with the reason and the consequences for reliability, complexity or security.

---

# 21. Final Architectural Position

CWIDS should be treated as durable event infrastructure, not merely a proxy that forwards HTTP requests.

Its central responsibilities are:

1. Authenticate incoming provider events.
2. Persist the event and its delivery obligations atomically.
3. Resolve the authorized destination.
4. Acknowledge only after durable acceptance.
5. Deliver asynchronously with bounded concurrency.
6. Preserve delivery history.
7. Retry safely.
8. Recover abandoned work.
9. Prevent unauthorized routing and replay.
10. Make failures observable and recoverable.

PostgreSQL provides the durable source of truth. Node.js implements ingestion and delivery logic. PM2 supervises the processes. Provider adapters isolate external webhook differences. Destination applications retain responsibility for their own business rules and idempotent processing.

This is sufficient for a serious first implementation without requiring a dedicated message broker or a distributed microservices deployment.

**The first coding milestone should be the database schema, transaction invariants and failure tests—not the HTTP forwarding endpoint.** Once those foundations are correct, the gateway and worker become much easier to implement without introducing reliability defects that are difficult to discover later.
