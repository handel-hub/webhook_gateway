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

| Component           | Technology                     |
| ------------------- | ------------------------------ |
| Runtime             | Node.js                        |
| HTTP framework      | Express                        |
| Database            | PostgreSQL                     |
| Database client     | `pg`                           |
| Process supervision | PM2                            |
| Inbound transport   | HTTPS                          |
| Outbound delivery   | HTTP over HTTPS                |
| Durable work queue  | PostgreSQL                     |
| Database access     | Parameterized SQL              |
| Logging             | Structured application logging |

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

The initial PostgreSQL schema contains the following logical entities:

| Entity                        | Responsibility                                                  |
| ----------------------------- | --------------------------------------------------------------- |
| `applications`                | Registered destinations and lifecycle state                     |
| `provider_connections`        | Provider accounts, environments, and verification configuration |
| `application_provider_routes` | Explicit application-routing rules                              |
| `webhook_events`              | Immutable records of accepted provider events                   |
| `event_deliveries`            | Durable delivery state and retry scheduling                     |
| `delivery_attempts`           | Append-only history of outbound attempts                        |
| `administrative_audit_events` | Audit trail for privileged operations                           |

Events and deliveries are separate records. One event may have multiple delivery attempts without creating additional logical events.

The initial routing policy should normally create one delivery per event and authorized application. Fan-out can be supported explicitly where required.

## Event processing lifecycle

### Inbound ingestion

1. Receive the provider's HTTP request.
2. Validate request size, content type, and structure.
3. Resolve the configured provider connection.
4. Capture the original request body.
5. Verify the provider signature using the applicable integration scheme.
6. Parse and classify the event.
7. Resolve the intended application using trusted routing information.
8. Insert the event and initial delivery in one database transaction.
9. Commit the transaction.
10. Return the provider's expected successful acknowledgement.

Duplicate notifications must be recognized through a provider-scoped deduplication key enforced by a database uniqueness constraint.

Authentic events that cannot be safely routed should follow an explicit quarantine policy rather than being silently discarded.

### Asynchronous delivery

1. A worker claims an eligible delivery using database locking.
2. The worker assigns a lease token and expiration time.
3. An attempt record is created.
4. The worker builds and signs the outbound request.
5. The request is sent with bounded timeouts.
6. The response or failure is classified.
7. The delivery is marked successful, scheduled for retry, or moved to a dead-letter state.
8. Expired leases are recovered automatically.

Database transactions must not remain open while waiting for destination HTTP responses.

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
               |
               v
           in_flight
               |
               v
           dead_letter
```

A delivery may also be cancelled where permitted by the administrative policy.

Workers must verify their lease token before updating delivery state. Expired or stale workers must not overwrite state established by a newer worker.

## Retry and recovery

The service uses configurable exponential backoff with jitter.

Retryable failures may include connection errors, timeouts, HTTP 429 responses, and transient server errors. Permanent failures and configuration errors require separate classification and handling.

The retry policy must define:

- Base delay and maximum delay.
- Maximum automatic attempts or retry horizon.
- Request timeout.
- Lease duration.
- Lease-recovery interval.
- Per-application concurrency limits.
- Dead-letter and alerting behaviour.

Exhausted deliveries remain persisted and inspectable. Authorized operators may replay them through an audited administrative operation.

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

The intended module layout is:

```text
src/
├── main/
│   ├── gateway-entry.js
│   ├── worker-entry.js
│   └── composition-root.js
├── config/
├── http/
├── providers/
│   ├── flutterwave/
│   └── paystack/
├── applications/
├── ingestion/
├── deliveries/
├── persistence/
│   └── repositories/
├── admin/
├── security/
├── maintenance/
├── observability/
└── shared/

migrations/
test/
├── unit/
├── integration/
├── fault-injection/
└── end-to-end/
```

The final filenames may evolve during implementation. The architectural boundaries should remain stable.

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
