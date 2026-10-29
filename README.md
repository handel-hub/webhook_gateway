# Centralized Webhook Ingestion and Delivery Service (CWIDS)

A durable, centralized webhook infrastructure service for receiving, persisting, routing, and delivering events from external providers to multiple registered applications.

## Overview

CWIDS provides a single, reliable webhook ingestion layer for multiple applications. Instead of exposing a separate public webhook endpoint for every application, external providers send events to CWIDS, which authenticates and persists them before acknowledging receipt.

Once an event has been durably recorded, background workers deliver it to its authorized destination independently of the provider's request lifecycle.

The service is designed around **durable persistence, explicit routing, at-least-once delivery attempts, idempotent processing, and recoverable failures**.

### Key capabilities

- Centralized webhook ingestion for multiple applications.
- Provider-specific authentication and signature verification.
- Flutterwave integration, with an extensible architecture for Paystack and future providers.
- Durable event storage using PostgreSQL.
- Atomic persistence of events and delivery obligations.
- Asynchronous delivery using PostgreSQL as the durable work queue.
- Database-backed worker leases and crash recovery.
- Retry scheduling with exponential backoff and jitter.
- Deduplication of repeated provider notifications.
- Per-application delivery configuration and request signing.
- Delivery history, dead-letter handling, and controlled replay.
- Administrative auditing, health checks, and operational monitoring.

## Architecture

```text
External Providers
    |
    | HTTPS webhooks
    v
Inbound Gateway
    |
    | Verify signature
    | Parse and classify event
    | Resolve authorized destination
    v
PostgreSQL
    |
    | Atomic transaction
    | - Webhook event
    | - Delivery obligation
    v
Background Workers
    |
    | Claim work
    | Sign outbound request
    | Retry failures
    v
Registered Applications
```

The service is implemented as a modular monolith with independently managed gateway and worker processes. Both processes share the same codebase and PostgreSQL database.

### Technology stack

| Component           | Technology                                      |
| ------------------- | ----------------------------------------------- |
| Runtime             | Node.js 20+ (Pure Native ESM `.mjs`)           |
| Static Typing       | TypeScript JSDoc (`checkJs: true`, `noImplicitAny: true`) |
| HTTP framework      | Express 4.x                                     |
| Database            | PostgreSQL 15+                                  |
| Database client     | `pg` (Parameterized SQL only, zero ORM)         |
| Database Security   | PostgreSQL Row-Level Security (RLS) + Runtime Roles (`cwids_ingress`, `cwids_worker`, `cwids_admin`) |
| Payload Encryption  | AES-256-GCM Envelope Encryption (per-event DEK + KEK) |
| Process supervision | PM2                                             |
| Inbound transport   | HTTPS                                           |
| Outbound delivery   | HTTP/HTTPS via SSRF-Guarded Agent              |
| Durable work queue  | PostgreSQL `FOR UPDATE SKIP LOCKED`             |
| Logging             | Structured JSON logging (Secrets & PII Redacted)|

Redis, Kafka, RabbitMQ, an ORM, and container orchestration are not required for the initial implementation.

## Core design principles

### 1. Durable acknowledgement

An inbound event is acknowledged successfully only after PostgreSQL has committed both the event record and the corresponding delivery obligation.

```text
Receive
  -> Authenticate
  -> Resolve destination
  -> Persist event and delivery atomically
  -> Commit
  -> Acknowledge provider
```

If durable acceptance fails, the service must not falsely acknowledge successful persistence.

### 2. PostgreSQL is the source of truth

In-memory queues, timers, and promises must never be the sole record of pending work.

Workers discover pending deliveries from PostgreSQL. After a process restart, persisted work remains available for recovery.

### 3. At-least-once delivery attempts

CWIDS does not promise exactly-once HTTP delivery. A destination may process a request successfully even when the gateway fails to receive its response.

Consequently, deliveries may be repeated. Every delivery has a stable identifier, and receiving applications must implement idempotent processing.

### 4. Explicit application routing

Registered applications have independent identities, destination configurations, and signing credentials.

Routing must use trusted, persisted configuration and transaction correlation. Provider-supplied metadata may assist correlation but must not independently authorize arbitrary destinations.

### 5. Separation of responsibilities

CWIDS manages webhook transport, persistence, routing, delivery, and recovery.

Destination applications remain responsible for their business logic. Payment-owning applications must independently validate transaction status, amount, currency, references, and other applicable payment requirements.

## Data model

The PostgreSQL schema contains the following core relational entities:

| Entity                        | Responsibility                                                  |
| ----------------------------- | --------------------------------------------------------------- |
| `applications`                | Registered tenant applications and lifecycle state (`pending`, `active`, `suspended`, `decommissioned`) |
| `destination_endpoints`       | Versioned delivery endpoints with signing secrets, timeouts, and `response_validation_mode` (`loose` vs `strict`) |
| `provider_connections`        | Provider accounts, environments (`live`, `test`), and verification secrets |
| `payment_intent_correlations` | Pre-registered checkout intents for Mode A routing (`active`, `consumed`, `expired`, `cancelled`) |
| `payment_intent_aliases`      | Dynamic aliases (virtual accounts, provider refs) for Mode C routing |
| `webhook_events`              | Immutable records of accepted provider events, raw payload ciphertext, DEK/KEK metadata, and `routing_status` (`resolved`, `awaiting_route`, `quarantined`, `rejected`) |
| `event_deliveries`            | Durable delivery state, monotonic `attempt_count`, fencing tokens, and epoch fields (`epoch_id`, `epoch_attempt_count`, `redrive_count`, `horizon_started_at`) |
| `delivery_attempts`           | Append-only history recording `destination_endpoint_id`, `endpoint_version`, attempt numbers, fencing tokens, HTTP status, and duration |
| `circuit_breaker_states`      | Per-destination breaker tracking (`closed`, `half_open`, `open`) with probe concurrency locking |
| `administrative_audit_events` | Append-only audit trail for privileged operations with legal hold and audit classification (`operational`, `security`, `compliance`) |
| `audit_outbox`                | Transactional outbox for guaranteed export of administrative audit events to external sinks |

Events and deliveries are strictly decoupled. One event may have multiple delivery attempts across retries and redrives without duplicating logical event records.

### Database security & least privilege

All database operations enforce PostgreSQL Row-Level Security (`ENABLE` and `FORCE ROW LEVEL SECURITY`) across all tenant-scoped tables. Zero application or worker code runs as a superuser or database owner.

Three dedicated runtime roles operate under least privilege:
- **`cwids_ingress`**: Ingestion-only role. Inserts into `webhook_events` (including unrouted events where tenant is null), `event_deliveries`, and `audit_outbox`. Reads active provider connections and payment intent correlations. Denied access to attempt history.
- **`cwids_worker`**: Delivery execution role. Claims deliveries across tenant queues via fair-share partitioning when unauthenticated; sets `app.current_tenant` to read decrypted event payloads, query active endpoints, and record attempts under strict tenant isolation.
- **`cwids_admin`**: Administrative role. Authorizes privileged application registration, manual delivery redrives, endpoint versioning, and retention management.

## Event processing lifecycle

### Inbound ingestion

1. Receive the provider's HTTP request on `POST /v1/webhooks/:provider/:connectionId`.
2. Capture original raw request body Buffer before any JSON parsing.
3. If database connection pool is exhausted or unavailable, immediately return **HTTP 503 Service Unavailable with `Retry-After: 30`** to signal infrastructure backpressure.
4. Resolve configured provider connection and verify cryptographic HMAC signature.
5. If signature is authentic but payload JSON is malformed or unsupported, persist event with AES-256-GCM encrypted payload, set `routing_status = 'rejected'`, and return **HTTP 200 `{ "status": "acknowledged", "routing_status": "rejected" }`** to absorb bad events without triggering provider retry storms.
6. Extract routing keys (merchant reference, provider reference, virtual account ID).
7. Execute deterministic routing:
   - **Mode B (Dedicated):** Connection pre-assigned to a specific tenant application.
   - **Mode A (Merchant Reference):** Match against active or consumed payment intent within expiry + 7-day grace period. On shared connections, enforce server-controlled namespacing `${app.code}_${reference}` to prevent cross-tenant reference squatting.
   - **Mode C (Dynamic Alias):** Match against registered dynamic alias using `SELECT DISTINCT` to avoid spurious quarantine when multiple aliases point to the same intent.
   - **Mode D (Unresolved):** Mark event as `awaiting_route` and quarantine safely. When tenant registers the dynamic alias later, CWIDS automatically re-evaluates `awaiting_route` events and creates delivery obligations.
8. Persist event record, encryption metadata, and initial delivery in one atomic database transaction.
9. Commit transaction.
10. Return HTTP 200 OK provider acknowledgement.

### Asynchronous delivery

1. Delivery workers claim eligible deliveries using in-SQL tenant fair-share partitioning (`DENSE_RANK() OVER (PARTITION BY ed.application_id ORDER BY ed.next_attempt_at ASC)`), dynamic lease sizing (`CEIL(http_timeout_ms / 1000) + 30s`), and circuit breaker probe exclusion.
2. The claim query atomically increments `fencing_token`, sets `status = 'in_flight'`, and assigns `lease_expires_at`.
3. Worker dynamically resolves the latest active destination endpoint (`ORDER BY version DESC LIMIT 1`) for the tenant application, allowing seamless URL and key rotation for queued retries.
4. Worker verifies destination IP address using SSRF-Guarded HTTP Client (blocks DNS rebinding, loopback, private RFC-1918, link-local, cloud metadata services).
5. Worker constructs signed outbound request (`t=...,v1=...` HMAC-SHA256 signature header).
6. Outbound request is dispatched with bounded timeout. Response stream is bounded: if response body exceeds 2KB, socket is destroyed immediately via `res.destroy()` and settled cleanly without memory bloat.
7. Destination response is verified:
   - **`loose` mode:** Any HTTP 2xx is considered acknowledged.
   - **`strict` mode:** Destination must return HTTP 200/202 with a valid JSON envelope (`{ "received": true }` or `{ "status": "acknowledged" }` or `{ "success": true }`).
8. Worker writes delivery completion or retry schedule using **strict fenced write**: if `fencing_token` does not match, transaction rolls back immediately with `StaleFencingTokenError` before recording any attempt.
9. On successful fenced update, attempt history is appended with `destination_endpoint_id` and `endpoint_version`.
10. Expired worker leases are automatically recovered by background sweeper; jobs exceeding max retries during lease recovery are poisoned-pill dead-lettered with `EXPIRED_LEASE_POISON_PILL`.

## Delivery states

```text
pending
   |
   v
in_flight
   |
   +----> delivered
   |
   +----> retry_scheduled
   |           |
   |           v
   |       in_flight
   |           |
   v           v
dead_lettered (terminal)
   |
   +-- [Admin Redrive: new epoch] --> pending
```

## Retry policy & 72-hour horizon

- **72-Hour Maximum Automatic Retry Horizon:** Measured from `horizon_started_at` (the first failure of the current epoch), not event receipt.
- **Exponential Backoff with Full Jitter:** Base delay 10s, max delay 7,200s (2 hours), jitter interval `[0.5*delay, 1.5*delay]` with a 5s floor. All delays are scheduled using database time (`CURRENT_TIMESTAMP + interval`) to eliminate server clock drift.
- **Emergency Ceiling:** Hard limit of `max_retries = 50`.
- **Classification Taxonomy:**
  - *Transient Network & Server Errors:* Connection errors, timeouts, HTTP 500, 502, 503, 504, 408 (Request Timeout), and 425 (Too Early) are retryable.
  - *Rate Limiting:* HTTP 429 schedules retry respecting bounded `Retry-After` (5s to 2h).
  - *Permanent Client Errors:* HTTP 4xx (400, 401, 403, 404, 422) dead-letter immediately as `CLIENT_REJECTED`.
  - *Not Implemented:* HTTP 501 dead-letters immediately as `NOT_IMPLEMENTED`.
- **Redrive Epochs:** Operators can redrive `dead_lettered` deliveries via `POST /v1/admin/deliveries/:id/redrive`. Redrive preserves monotonic `attempt_count` history, assigns a new `epoch_id`, resets `epoch_attempt_count = 0`, sets `horizon_started_at = CURRENT_TIMESTAMP`, and increments `redrive_count` and `fencing_token`.

## Retention and data lifecycle

- **Encrypted Raw Payloads:** Pruned after 30 days (`ENCRYPTED_PAYLOAD = NULL`, `PAYLOAD_DELETED_AT = CURRENT_TIMESTAMP`) unless flagged with `legal_hold = TRUE`.
- **Normalized Event Metadata:** Purged after 90 days if deliveries are terminal and `legal_hold = FALSE`.
- **Forensic Retention Guards:** Unrouted events (`awaiting_route`) and quarantined events (`quarantined`) are strictly excluded from automated payload pruning and metadata purging.
- **Unrouted Operational Alerting:** Retention worker scans for and alerts on unrouted/quarantined events older than 90 days (`OPERATIONAL_ALERT`).
- **Administrative Audits:** Retained according to purpose: 365 days for `operational` audits; 7 years (2,555 days) for `security` and `compliance` audits.

## Provider integrations

### Flutterwave

Flutterwave is the initial provider.

The adapter must implement the signature-verification scheme applicable to the configured integration. Flutterwave documentation describes HMAC-SHA256 verification through `flutterwave-signature` for the documented integration; older integrations may use `verif-hash`.

Official documentation: https://developer.flutterwave.com/docs/webhooks

### Paystack

Paystack is a planned provider adapter.

The adapter must implement Paystack's applicable signature-verification mechanism, event identity, parsing, and retry assumptions independently of Flutterwave's implementation.

Official documentation: https://paystack.com/docs/payments/webhooks/

Provider-specific behaviour must remain isolated behind the internal provider-adapter interface.

## Security requirements

Production deployments must enforce:

- HTTPS for inbound and outbound communication.
- Provider signature verification before accepting trusted events.
- Raw-body preservation for signature verification.
- Protected provider secrets and destination signing keys.
- Authenticated administrative operations.
- Parameterized database queries and least-privilege database access.
- Strict destination validation and SSRF protection.
- Outbound request signing.
- Request and response size limits.
- Bounded HTTP timeouts and concurrency.
- Safe logging that excludes secrets and unnecessary sensitive payload data.
- Audited application registration, destination changes, secret rotation, replay, and cancellation.

Destination registration must not permit arbitrary requests to loopback, private, link-local, or otherwise prohibited addresses. Redirects should be disabled by default.

## Project structure

The CWIDS implementation is organized as a modular Node.js native ESM (`.mjs`) architecture:

```text
src/
├── index.mjs                     # Ingress HTTP gateway entry point
├── worker.mjs                    # Asynchronous delivery worker entry point
├── config.mjs                    # Environment validation and configuration loader
├── errors.mjs                    # Typed domain and infrastructure error hierarchy
├── logger.mjs                    # Structured JSON logger with sensitive data redaction
├── types/                        # JSDoc type definitions
│   ├── config.mjs
│   ├── delivery.mjs
│   ├── domain.mjs
│   └── errors.mjs
├── db/                           # Persistence layer
│   ├── pool.mjs                  # pg connection pool management
│   ├── transaction.mjs           # Transaction helper with tenant context
│   ├── migrator.mjs              # Transactional schema migrator with advisory locking
│   ├── migrations/               # Forward-only SQL migrations (001-007)
│   └── repositories/             # Parameterized SQL repositories (events, deliveries, etc.)
├── ingress/                      # Inbound webhook ingestion
│   ├── app.mjs                   # Express application and route setup
│   ├── webhook-handler.mjs       # Webhook ingestion controller with 503 backpressure
│   └── raw-body.mjs              # Raw-body preservation middleware
├── providers/                    # Provider adapters
│   ├── base.mjs                  # Provider adapter abstract interface
│   ├── flutterwave.mjs           # Flutterwave adapter (HMAC-SHA256 / verif-hash)
│   ├── paystack.mjs              # Paystack adapter (HMAC-SHA512)
│   └── registry.mjs              # Provider registry
├── routing/                      # Deterministic routing engine
│   └── routing-resolver.mjs      # Modes A, B, C, D deterministic routing
├── ingestion/                    # Ingestion transaction service
│   └── ingestion-service.mjs     # Atomic event & delivery creation
├── delivery/                     # Outbound delivery engine
│   ├── scheduler.mjs             # Work poller and fair-share claim coordinator
│   ├── delivery-service.mjs      # Delivery execution with dynamic active endpoint resolution
│   ├── http-dispatcher.mjs       # HTTP dispatch with 2KB stream safety & envelope verification
│   ├── retry-policy.mjs          # 72h horizon, exponential backoff, jitter, classifications
│   ├── circuit-breaker.mjs       # Per-destination circuit breaker with half-open probe lock
│   └── signer.mjs                # HMAC-SHA256 outbound request signing (t=...,v1=...)
├── security/                     # Security controls
│   ├── crypto.mjs                # AES-256-GCM envelope encryption & KEK wrapping
│   ├── ssrf-agent.mjs            # SSRF-guarded HTTP Agent with DNS pin & IP validation
│   └── ip-validator.mjs          # Subnet checker (IPv4 & IPv6 private/link-local/metadata)
├── admin/                        # Administrative and internal API
│   ├── internal-api.mjs          # Payment intent & dynamic alias registration
│   └── admin-server.mjs          # Privileged admin routes (redrive, app registration)
├── maintenance/                  # Background maintenance workers
│   ├── intent-cleanup-worker.mjs # Expired intent pruning
│   ├── retention-worker.mjs      # 30d payload pruning, 90d purge, unrouted alerting
│   └── audit-exporter.mjs        # Audit outbox exporter
└── observability/                # Telemetry & operational endpoints
    ├── health.mjs                # /live and /ready probes
    └── metrics.mjs               # Prometheus metrics server (/metrics)

tests/
├── unit/                         # Unit tests
├── integration/                  # Integration tests (retention, intent cleanup, etc.)
│   └── audit-promotions/         # Promoted audit tests (RLS roles, stream truncation, etc.)
└── fault-injection/              # Concurrency and failure injection tests
```

## Getting started

### Prerequisites

- A supported Node.js release.
- PostgreSQL.
- npm.
- PM2 for deployment process supervision.
- A publicly reachable HTTPS endpoint for production provider webhooks.

### Installation

Clone the repository and install the project dependencies:

```bash
git clone <repository-url>
cd <repository-directory>
npm install
```

Create a local environment configuration based on `.env.example`.

Configure the database connection, request limits, worker concurrency, retry policy, and required secret references.

### Database setup

Apply the versioned SQL migrations in order using the project's migration procedure.

The database must include the required foreign keys, uniqueness constraints, delivery indexes, and transactional invariants before webhook ingestion is enabled.

Do not enable production ingestion against an incomplete schema.

### Development

The project should provide separate commands for running the gateway and worker:

```bash
npm run dev:gateway
npm run dev:worker
```

These commands are the intended interface; their exact implementation must match the repository's package scripts.

### Production process management

Use PM2 to manage the gateway and worker as separate processes.

The deployment configuration must support:

- Process restarts after crashes.
- Startup after machine reboot.
- Graceful shutdown.
- Structured logs.
- Independent worker and gateway configuration.
- Health monitoring and alerting.

PM2 supervises Node.js processes but does not provide database high availability or eliminate single-server failure.

## Configuration

The configuration layer should validate all required values at startup.

Representative settings include:

| Variable                      | Purpose                                         |
| ----------------------------- | ----------------------------------------------- |
| `NODE_ENV`                    | Runtime environment                             |
| `PORT`                        | Gateway listening port                          |
| `DATABASE_URL`                | PostgreSQL connection configuration             |
| `DATABASE_POOL_MAX`           | Database connection-pool limit                  |
| `HTTP_REQUEST_TIMEOUT_MS`     | Inbound request timeout                         |
| `OUTBOUND_REQUEST_TIMEOUT_MS` | Destination delivery timeout                    |
| `WORKER_CONCURRENCY`          | Maximum concurrent delivery requests per worker |
| `DELIVERY_LEASE_SECONDS`      | Delivery claim lease duration                   |
| `RETRY_BASE_DELAY_MS`         | Initial retry delay                             |
| `RETRY_MAX_DELAY_MS`          | Maximum retry delay                             |
| `LOG_LEVEL`                   | Structured logging level                        |

Provider secrets, administrative credentials, and destination signing keys must be supplied through protected configuration or a secret-management mechanism.

These names describe the intended configuration interface and should be aligned with the implemented configuration loader.

## Administrative operations

The service should provide a private administrative API for:

- Registering and suspending applications.
- Registering provider connections.
- Inspecting events and deliveries.
- Viewing delivery attempts and errors.
- Investigating quarantined events.
- Replaying eligible deliveries.
- Cancelling eligible pending work.
- Monitoring operational health.

Administrative routes must require authentication and authorization. Privileged actions must generate audit records.

## Monitoring

Operational monitoring should cover:

- Inbound request counts and latency.
- Signature-verification failures.
- PostgreSQL errors and pool saturation.
- Pending delivery count.
- Age of the oldest pending delivery.
- Delivery success and failure rates.
- Retry counts and expired leases.
- Dead-letter and quarantine counts.
- Outbound timeouts.
- Per-application delivery failures.
- CPU, memory, and disk capacity.

Health checks should distinguish process liveness from readiness to accept work.

## Testing strategy

Testing must include:

### Unit tests

- Signature verification.
- Payload parsing.
- Event identity and deduplication.
- Routing rules.
- Retry classification.
- Outbound signing.
- Destination validation.

### Database integration tests

- Atomic event and delivery persistence.
- Transaction rollback.
- Concurrent duplicate ingestion.
- Worker claiming and lease recovery.
- Stale lease-token rejection.
- Delivery-state transitions.

### Fault-injection tests

- PostgreSQL unavailable.
- Process termination after commit.
- Process termination after claiming work.
- Destination timeout.
- Destination success followed by lost response.
- Multiple concurrent workers.
- Retry exhaustion.
- Invalid destination configuration.

### End-to-end tests

- Provider test events reach the correct application.
- Duplicate events do not duplicate business effects.
- Failed destinations recover.
- Pending deliveries survive restarts.
- Replay is auditable.
- Receiving applications authenticate and deduplicate deliveries.

## Payment reconciliation

Webhook delivery is not proof that a payment is valid or settled.

Payment-owning applications must verify transactions with the provider when required and reconcile unresolved transactions periodically.

Transaction verification should confirm the provider reference, final status, expected amount, currency, merchant/account context, and other applicable business requirements.

CWIDS is responsible for event transport and recovery, not for replacing the payment provider's transaction records or the application's financial ledger.

## Implementation roadmap

1. **Foundation:** Project structure, configuration, database connectivity, logging, and migrations.
2. **Persistence:** Schema, constraints, transaction boundaries, and deduplication.
3. **Ingestion:** Flutterwave signature verification, parsing, routing, and acknowledgement.
4. **Delivery:** Worker claiming, outbound signing, HTTP delivery, and attempt tracking.
5. **Recovery:** Leases, retries, dead-letter handling, and controlled replay.
6. **Administration:** Application registration, provider connections, authorization, and auditing.
7. **Operations:** PM2 deployment, health checks, monitoring, backups, and alerts.
8. **Hardening:** Fault injection, security review, reconciliation, and end-to-end acceptance testing.

## Production acceptance criteria

The first production release must demonstrate that:

- Successful acknowledgement occurs only after durable acceptance.
- Every accepted, routable event has a durable delivery obligation.
- Duplicate inbound requests do not create duplicate logical events.
- Worker crashes do not permanently strand deliveries.
- Stale workers cannot overwrite newer delivery state.
- Receiving applications can authenticate and deduplicate deliveries.
- Retries and exhausted deliveries are visible and recoverable.
- Administrative changes and replay operations are audited.
- Provider verification has automated tests.
- PostgreSQL backup restoration has been tested.
- Payment-owning applications independently validate transactions.

## Design status

This README describes the intended architecture and implementation contract. It does not imply that every listed module, endpoint, migration, or operational feature has already been implemented.

The first implementation milestone is the PostgreSQL schema and its transaction invariants, followed by the inbound ingestion path and durable delivery worker.

The guiding principle is simple:

**Persist first. Acknowledge second. Deliver asynchronously. Recover from durable state.**
