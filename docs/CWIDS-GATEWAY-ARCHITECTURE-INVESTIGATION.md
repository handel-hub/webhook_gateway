# CWIDS Architecture Investigation: Raw-Payload Webhook Gateway vs. Canonical Event Interpretation

**Document Version:** 1.0.0  
**Status:** Completed Architectural Investigation & Defensible Recommendation  
**Date:** October 29, 2026  
**Investigated Repository:** `webhook_gateway`  
**Baseline Git Commit:** `289b352d2cb9f89cc9cb1c72e942e70f8e9f2940` (Branch: `master`, working tree clean)  
**Primary Target File:** `docs/CWIDS-GATEWAY-ARCHITECTURE-INVESTIGATION.md`  

---

## Table of Contents

1. [Section A: Executive Recommendation](#section-a-executive-recommendation)
2. [Section B: Repository Baseline and Technical Inventory](#section-b-repository-baseline-and-technical-inventory)
3. [Section C: Current Architecture and End-to-End Traces](#section-c-current-architecture-and-end-to-end-traces)
4. [Section D: Evidence-Backed Architectural Findings](#section-d-evidence-backed-architectural-findings)
5. [Section E: Responsibility Matrix: Gateway vs. Downstream Applications](#section-e-responsibility-matrix-gateway-vs-downstream-applications)
6. [Section F: Proposed Outbound Delivery Protocol (The Wire Contract)](#section-f-proposed-outbound-delivery-protocol-the-wire-contract)
7. [Section G: Data and Concurrency Design](#section-g-data-and-concurrency-design)
8. [Section H: Threat Model and Security Posture](#section-h-threat-model-and-security-posture)
9. [Section I: Comparative Analysis of Architectural Models](#section-i-comparative-analysis-of-architectural-models)
10. [Section J: Implementation and Evolution Roadmap](#section-j-implementation-and-evolution-roadmap)
11. [Section K: Architecture Decision Register (ADR)](#section-k-architecture-decision-register-adr)
12. [Section L: Hostile Self-Review: Edge Cases and Defense Mechanisms](#section-l-hostile-self-review-edge-cases-and-defense-mechanisms)
13. [Section 14: Direct Answer to the Final Decision Question](#section-14-direct-answer-to-the-final-decision-question)

---

## Section A: Executive Recommendation

### The Central Question
Should the **Centralized Webhook Ingestion and Delivery Service (CWIDS)** interpret provider webhooks into a canonical business-event model (`payment.successful`, `payment.failed`, `subscription.renewed`), or should it behave as a secure, durable, policy-controlled webhook gateway that verifies incoming payloads, preserves their original bytes, and reliably forwards them to authorized downstream applications without interpreting their business meaning?

### The Architectural Verdict
**CWIDS MUST operate as a Model B-hybrid (Raw-Payload Secure Gateway with Minimal Transport Routing Metadata). It MUST NOT interpret provider webhooks into a canonical business-event model.**

### Summary of Evidence and Rationale

1. **The Codebase Already Follows This Model in Practice:**  
   Detailed inspection of the repository reveals that CWIDS's core pipeline already captures raw bytes (`req.rawBody` via `src/ingress/raw-body-middleware.mjs:41`), encrypts those raw bytes directly into `encrypted_payload` via AES-256-GCM envelope encryption (`src/ingestion/ingestion-service.mjs:40`), and dispatches the exact decrypted byte buffer over HTTP to downstream endpoints (`src/delivery/http-dispatcher.mjs:35-55`). The system does **not** translate payloads into a canonical payment DTO during outbound delivery.

2. **Canonical Business Models are Lossy and Fragile:**  
   Attempting to force distinct payment providers (Paystack, Flutterwave, Stripe) into a universal schema inevitably strips away provider-specific metadata. Downstream systems such as `Marketplace` (which requires Flutterwave-specific 3-tier inventory backorder allocation and split-settlement subaccounts) and `bettingAutomationBackend` (which maps transaction metadata directly to Keygen license entitlements) have fundamentally divergent domain needs. Forcing them through a shared `payment.successful` DTO degrades capabilities, couples CWIDS to application-layer business logic, and creates a single point of failure whenever a provider alters or expands its payload schemas.

3. **Forensic Integrity and Non-Repudiation Demand Raw Byte Preservation:**  
   Financial audits, dispute resolutions, and chargeback defenses require an unadulterated cryptographic trail. CWIDS preserves the exact incoming bytes and their SHA-256 digest (`src/ingress/raw-body-middleware.mjs:43`), encrypts them with per-event data keys, and signs outbound deliveries with tenant-specific HMAC-SHA256 secrets (`src/security/hmac-signer.mjs:21-23`). Re-serializing or transforming JSON introduces whitespace variations, key-reordering, numeric precision truncation (e.g., IEEE-754 floating-point corruption on 64-bit integer amounts), and invalidates upstream cryptographic signatures.

4. **The Strictly Bounded Hybrid Boundary (Model B-hybrid):**  
   Pure raw-payload forwarding (Model B) would fail in multi-tenant environments where a single provider account or webhook connection serves multiple downstream applications. CWIDS resolves this by extracting a strictly minimal set of **transport routing identifiers** (`merchant_reference`, `provider_reference`, `virtual_account_id`) used solely within database lookups to identify tenant destination endpoints (Modes A, B, and C). Crucially, these extracted fields are **never used to rewrite, reshape, or canonicalize the payload itself**.

---

## Section B: Repository Baseline and Technical Inventory

### 1. Repository Identification
- **Repository Root:** `C:\Users\John\Documents\CODE\back\webhook_gateway`
- **Reviewed Git Commit:** `289b352d2cb9f89cc9cb1c72e942e70f8e9f2940`
- **Active Branch:** `master` (synchronized with `origin/master`, clean working tree)
- **Node.js Runtime & Module System:** Node.js v22.14.0, Native ES Modules (`"type": "module"` in `package.json:5`).

### 2. Static Analysis and Quality Gates
- **Type Checking:** Strict typechecking via TypeScript JSDoc (`npm run typecheck` $\to$ `tsc --project jsconfig.json`). Exit status: 0 errors.
- **Unit and Integration Test Suite:** `npm test` (`node --env-file=.env --test --test-concurrency=1`).
  - Total tests executed: **108 tests**.
  - Pass: **108**, Fail: **0**, Skipped: **0**, Cancelled: **0**.
  - Total test runtime: 41.28 seconds across all unit, repository, and real PostgreSQL integration suites.
- **Runtime Stress and Concurrency Harness:** `npm run test:runtime` (`scripts/stress-harness.mjs`). Covers 7 deep stress dimensions: High-concurrency worker claims, circuit breaker tripping and half-open probing, stale worker lease fencing, tenant RLS isolation, and 50MB outbound stream truncation. Exit status: 0.

### 3. Dependency Inventory
From `package.json`:
- **Production Dependencies (3):**
  - `dotenv` (`^16.4.7`): Environment configuration loading.
  - `express` (`^4.21.2`): HTTP ingress server for webhooks and internal routing APIs.
  - `pg` (`^8.13.1`): Native PostgreSQL client pool supporting transactions, advisory locks, and row-level security.
- **Development Dependencies (5):**
  - `@types/express` (`^5.0.6`), `@types/node` (`^26.6.5`), `@types/pg` (`^8.23.1`): Type definitions for JSDoc static analysis.
  - `madge` (`^8.0.0`): Circular dependency detection (`npm run circular-check`).
  - `typescript` (`^5.9.3`): Static analysis compiler.

### 4. Database Infrastructure and Schema Baseline
The database is PostgreSQL 18.1 with the schema namespace `cwids`. Database migrations are executed sequentially from `src/db/migrations/`:
- `001_initial_schema.sql`: Core tables, check constraints, foreign keys, and indexes.
- `002_row_level_security.sql`: Initial Row-Level Security policies.
- `003_partial_indexes.sql`: Partial index optimizations for high-throughput polling (`pending` deliveries and `active` intents).
- `004_fix_dead_lettered_at.sql`: Timestamp constraint fixes for terminal deliveries.
- `005_runtime_roles_and_rls.sql`: Least-privilege role segregation (`cwids_ingress`, `cwids_worker`, tenant application scoping) and forced RLS across all tables.
- `006_schema_evolution.sql`: Schema evolution adding redrive epochs, encrypted endpoint signing secrets, validation mode enums (`http_status` vs `envelope`), and circuit breaker automated triggers.
- `007_endpoint_version_audit.sql`: Audit logging triggers for destination endpoint credential rotation.

---

## Section C: Current Architecture and End-to-End Traces

### Architecture Diagram

```
[Payment Provider] (Paystack / Flutterwave)
        │
        │ Inbound HTTP POST /v1/webhooks/:provider/:connectionId
        ▼
┌────────────────────────────────────────────────────────────────────────┐
│ CWIDS INGRESS SERVICE                                                  │
│                                                                        │
│ 1. rawBodyMiddleware: Enforce 1MB limit; capture Buffer; compute SHA-256│
│ 2. ConnectionsRepo: Load provider_connections record                   │
│ 3. ProviderAdapter: Verify HMAC signature using raw bytes              │
│ 4. BaseAdapter: Generate collision-resistant length-prefixed dedupe key│
│ 5. IngestionService: AES-256-GCM Envelope Encryption (MASTER_KEK)       │
│ 6. RoutingResolver: Mode B (Dedicated) / Mode A (Ref) / Mode C (Alias) │
│ 7. Atomic Tx-Ingest (Single PostgreSQL Transaction):                  │
│    - INSERT INTO cwids.webhook_events (ON CONFLICT dedupe_key DO NOTHING)│
│    - INSERT INTO cwids.event_deliveries (status = 'pending')           │
│    - INSERT INTO cwids.audit_outbox                                    │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │ Commit & HTTP 200 Acknowledged
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ POSTGRESQL 18.1 (Schema: cwids)                                        │
│ Durable Storage: webhook_events (Encrypted Bytes) + event_deliveries   │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ Polling via FOR UPDATE SKIP LOCKED
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ CWIDS DELIVERY WORKER                                                  │
│                                                                        │
│ 1. Scheduler: Claim pending delivery with lease & increment fencing token│
│ 2. CircuitBreaker: Check destination circuit state (closed / half-open)│
│ 3. Decrypt Payload: Decrypt AES-256-GCM envelope to original byte Buffer│
│ 4. HmacSigner: Generate X-CWIDS-Signature (t=...,v1=...)               │
│ 5. HttpDispatcher: POST raw bytes with SSRF Agent (DNS pinned)         │
│ 6. Response Truncation: Cap response body at 2,048 bytes               │
│ 7. Fenced State Transition: Commit delivery outcome enforcing fencing  │
│ 8. Retry Scheduling: Exponential backoff + full jitter (up to 72h)     │
└───────────────────────────────────┬────────────────────────────────────┘
                                    │
                                    │ Authenticated Outbound HTTP POST
                                    │ (Preserved Raw Payload Bytes)
                                    ▼
┌────────────────────────────────────────────────────────────────────────┐
│ DOWNSTREAM APPLICATIONS                                                │
│                                                                        │
│ • Marketplace (/api/v1/webhooks/payments/flutterwave)                  │
│   -> Parses tx_ref, executes 3-tier inventory backorder allocation,    │
│      writes double-entry ledger entries.                               │
│                                                                        │
│ • BettingAutomationBackend (/api/v1/payments/webhook)                  │
│   -> Verifies X-CWIDS-Signature, parses event, activates Keygen        │
│      licenses, writes transactional outbox records.                    │
└────────────────────────────────────────────────────────────────────────┘
```

---

### Inbound Ingress Trace (Step-by-Step Code Walkthrough)

```
[Provider Request]
       │
       ▼
1. Express Ingress Boundary: `src/ingress/http-server.mjs:42`
   `app.post('/v1/webhooks/:provider/:connectionId', handleWebhookIngress)`
       │
       ▼
2. Byte Capture & Size Enforcement: `src/ingress/raw-body-middleware.mjs:12-51`
   Captures streaming chunks into `Buffer[]`.
   Enforces `totalBytes <= LIMITS.MAX_RAW_BODY_BYTES` (1,048,576 bytes = 1MB).
   If exceeded: calls `req.destroy()`, returns HTTP 413 Payload Too Large.
   Computes SHA-256: `req.payloadSha256 = crypto.createHash('sha256').update(rawBuffer).digest('hex')`.
   Leaves `req.rawBody = rawBuffer` unaltered. JSON is NOT parsed here.
       │
       ▼
3. Connection Lookup: `src/ingress/webhook-handler.mjs:41-54`
   Queries `ConnectionsRepo.findById(client, connectionId)` from `cwids.provider_connections`.
   Verifies `connection.is_active` and matches route provider parameter.
       │
       ▼
4. Provider Signature Verification: `src/ingress/webhook-handler.mjs:57-75`
   Resolves adapter from `src/providers/adapter-registry.mjs`.
   Calls `adapter.verifyAndNormalize(rawBody, req.headers, connection.secret_kms_ref)`.
   - Paystack (`src/providers/paystack/adapter.mjs:35-56`):
     Computes HMAC-SHA512 over `rawBody`. Compares against `x-paystack-signature` using `constantTimeCompare`.
   - Flutterwave (`src/providers/flutterwave/adapter.mjs:36-69`):
     Checks `verif-hash` secret token; falls back to HMAC-SHA256 over `rawBody`.
   - Malformed JSON handling: If signature is authentic but JSON parsing fails, sets `isMalformed: true`,
     generates hash dedupe key, and allows persistence without delivery (`src/ingestion/ingestion-service.mjs:44-84`).
       │
       ▼
5. Deduplication Key Generation: `src/providers/base-adapter.mjs:13-25`
   Uses collision-resistant, delimiter-free length-prefixed encoding:
   Format: `v1:<provider>:len(id):id:len(event):event`.
   Guarantees that input `('a:b', 'c')` cannot collide with `('a', 'b:c')`.
       │
       ▼
6. Envelope Encryption: `src/ingestion/ingestion-service.mjs:40`
   `encryptPayloadEnvelope(rawBody, eventId, env.MASTER_KEK)` via `src/security/envelope-encryption.mjs:26-55`.
   Generates a cryptographically random 256-bit Data Encryption Key (DEK).
   Encrypts `rawBody` using AES-256-GCM with a 96-bit nonce.
   Wraps the DEK with AES-256 Key Wrap (RFC 3394) using `MASTER_KEK`.
       │
       ▼
7. Deterministic Routing: `src/routing/routing-resolver.mjs:19-108`
   Executes purely local database queries (zero external network calls):
   - Mode B (Dedicated Connection): Returns `connection.application_id`.
   - Mode A (Merchant Reference Match): Queries `cwids.payment_intent_correlations` by `merchant_reference`.
   - Mode C (Dynamic Provider Alias): Queries `cwids.payment_intent_aliases` by `provider_reference` or `virtual_account_id`.
   - Mode D (Awaiting Route): If no match is found, marks status as `awaiting_route` for late-intent arrival.
   - Quarantined: If multiple conflicting intents match, marks status as `quarantined`.
       │
       ▼
8. Atomic Ingestion Transaction: `src/ingestion/ingestion-service.mjs:86-201`
   Inside `withTransaction(pool, null, ...)`:
   - Inserts row into `cwids.webhook_events`. On duplicate dedupe key conflict (`23505`), returns existing row.
   - If duplicate detected and payload SHA-256 differs: logs `PAYLOAD_CONFLICT_WARNING` to audit outbox.
   - If routing resolved and NOT duplicate: queries active endpoint from `cwids.destination_endpoints`
     and inserts initial delivery obligation into `cwids.event_deliveries` (`status = 'pending'`).
   - Inserts `WEBHOOK_INGESTED` audit entry into `cwids.audit_outbox`.
       │
       ▼
9. Provider Acknowledgment: `src/ingress/webhook-handler.mjs:86-92`
   Returns HTTP 200 OK with `{ status: 'acknowledged', event_id, duplicate, routing_status, delivery_id }`.
```

---

### Outbound Delivery Trace (Step-by-Step Code Walkthrough)

```
[Worker Loop]
       │
       ▼
1. Work Claiming & Leasing: `src/delivery/scheduler.mjs:25-78`
   Runs query against `cwids.event_deliveries`:
   `SELECT id FROM cwids.event_deliveries WHERE status IN ('pending', 'retry_scheduled') AND next_attempt_at <= NOW() ... FOR UPDATE SKIP LOCKED`
   Atomically updates claimed rows:
   `status = 'in_flight', lease_expires_at = NOW() + 60s, fencing_token = fencing_token + 1, claimed_by_worker = workerId`.
       │
       ▼
2. Circuit Breaker Evaluation: `src/delivery/delivery-service.mjs:38-49`
   Checks `CircuitBreaker.canDispatch(client, endpointId)`.
   If endpoint circuit is `open`: reschedules delivery with backoff without sending HTTP traffic.
   If `half_open`: permits exactly 1 canary probe request.
       │
       ▼
3. Payload Decryption: `src/delivery/delivery-service.mjs:88-96`
   Retrieves `encrypted_payload`, `payload_nonce`, `payload_tag`, `wrapped_dek`.
   Calls `decryptPayloadEnvelope(..., env.MASTER_KEK)`.
   Produces the **exact original raw payload buffer**.
       │
       ▼
4. Outbound Signature Generation: `src/security/hmac-signer.mjs:14-24`
   `generateOutboundSignature(deliveryId, payloadBuffer, signingSecret, timestamp)`
   Canonical string: `${timestampSeconds}.${deliveryId}.${payloadString}`
   Signature: HMAC-SHA256(canonicalString, signingSecret)
   Header format: `t=${timestampSeconds},v1=${signatureHex}`
       │
       ▼
5. Outbound HTTP Request: `src/delivery/http-dispatcher.mjs:25-57`
   Dispatches HTTPS POST request via custom `ssrfAgent` (`src/security/ssrf-agent.mjs`).
   SSRF Defense: Intercepts DNS lookup before socket creation; validates resolved IP against blocked CIDRs
   (rejects `127.0.0.0/8`, `10.0.0.0/8`, `172.16.0.0/12`, `192.168.0.0/16`, `169.254.169.254`, IPv6 loopbacks).
   Sends exact raw buffer with headers:
   - `Content-Type: application/json`
   - `Content-Length: payloadBuffer.length`
   - `X-CWIDS-Delivery-ID: deliveryId`
   - `X-CWIDS-Signature: t=...,v1=...`
       │
       ▼
6. Streaming Response Truncation: `src/delivery/http-dispatcher.mjs:114-148`
   Monitors response body stream. If response exceeds 2,048 bytes (2KB):
   Destroys stream immediately (`res.destroy()`), sets `responseTruncated = true`, caps stored excerpt.
       │
       ▼
7. Monotonic Fencing Token Update: `src/delivery/delivery-service.mjs:137-220`
   Executes PostgreSQL transaction updating `cwids.event_deliveries`:
   Enforces `WHERE id = $1 AND fencing_token = $2`.
   If worker lease expired and another worker claimed the delivery, `rowCount === 0`.
   Stale worker writes are rejected, preventing race-condition overwrites.
   Appends attempt audit record to `cwids.delivery_attempts`.
       │
       ▼
8. Retry & Horizon Evaluation: `src/delivery/retry-policy.mjs:18-75`
   - HTTP 2xx: Delivery marked `delivered`.
   - HTTP 4xx (Client rejection, e.g., 400, 401, 403, 404, 422): Non-retryable $\to$ marked `dead_lettered`.
   - HTTP 408, 429, 5xx, or Network Drop: Retryable $\to$ schedules `next_attempt_at` using
     exponential backoff with full jitter: $\text{delay} = \min(\text{base} \times 2^{\text{attempt}}, 7200000) \times \text{rand}(0, 1)$.
   - Maximum 72-hour delivery horizon: If elapsed time since first attempt exceeds 72 hours, transitions to `dead_lettered`.
```

---

## Section D: Evidence-Backed Architectural Findings

### Finding 1: CWIDS Already Functions as a Raw-Payload Gateway
The codebase does not translate incoming payloads into canonical business events. In `src/ingestion/ingestion-service.mjs:40`, CWIDS takes the raw incoming `Buffer` directly from `rawBodyMiddleware` and passes it to `encryptPayloadEnvelope(rawBody, eventId, MASTER_KEK)`. When the delivery worker executes in `src/delivery/delivery-service.mjs:88-96`, it decrypts this exact byte buffer and passes it directly to `dispatchWebhook({ payload: decryptedPayload, ... })`.

**Conclusion:** CWIDS is architecturally structured as a raw-payload gateway. Introducing universal business-event translation would require tearing out this byte-preservation pipeline.

### Finding 2: The `NormalizedPayload` Interface is Purely a Routing Artifact
In `src/providers/paystack/adapter.mjs:85-94` and `src/providers/flutterwave/adapter.mjs:99-108`, the adapters construct a `NormalizedPayload` object containing:
- `merchantReference` (e.g., Paystack `reference`, Flutterwave `tx_ref`)
- `providerReference` (e.g., Paystack `id`, Flutterwave `id` / `flw_ref`)
- `virtualAccountId` (e.g., Paystack `dedicated_account_number`, Flutterwave `order_ref`)
- `amountMinor`, `currency`, `providerStatus`

Inspection of `src/ingestion/ingestion-service.mjs:88-95` confirms that these extracted properties are passed **only** to `resolveRouting(client, { providerConnection, routingKeys })`. The normalized object is **never** sent to downstream applications, and it is **never** stored as the authoritative delivery payload.

**Vestigial Fields:** The fields `amountMinor`, `currency`, and `providerStatus` are extracted by the adapters but are not strictly needed for tenant routing. They represent vestigial artifacts from an earlier design proposal and should be cleanly removed from the adapter routing interface.

### Finding 3: Database Schema Enforces Cryptographic Byte Storage
The PostgreSQL database schema in `src/db/migrations/001_initial_schema.sql:102-130` defines `cwids.webhook_events` with the following columns:
```sql
encrypted_payload BYTEA,
payload_nonce BYTEA,
payload_tag BYTEA,
wrapped_dek BYTEA,
kek_version TEXT NOT NULL,
payload_sha256 CHAR(64) NOT NULL,
```
There is no column for storing a canonical event JSON document. The database is strictly designed for encrypted binary blob preservation and cryptographic integrity auditing.

### Finding 4: Ingress Deduplication is Strictly Scoped
In `src/db/migrations/001_initial_schema.sql:127`, deduplication is enforced by:
```sql
CONSTRAINT uq_webhook_events_dedupe 
UNIQUE (provider_connection_id, environment, identity_strategy_version, dedupe_key)
```
In `src/providers/base-adapter.mjs:13-25`, the helper `encodePart()` prefixes each element with its byte length (`len:value`). This prevents hash collisions and delimiter-injection attacks across distinct payload variants.

### Finding 5: Outbound Security Standardizes on HMAC-SHA256 Signatures
In `src/security/hmac-signer.mjs:14-24`, outbound deliveries are signed using:
```javascript
const canonicalString = `${timestampSeconds}.${deliveryId}.${payloadString}`;
const signatureHex = crypto.createHmac('sha256', secret).update(canonicalString).digest('hex');
return `t=${timestampSeconds},v1=${signatureHex}`;
```
This protocol provides:
1. **Integrity:** Any tampering with the payload body or delivery UUID invalidates the signature.
2. **Replay Protection:** The timestamp parameter enables downstream applications to enforce a strict clock drift tolerance (e.g., 5 minutes).

### Finding 6: Heterogeneous Downstream Consumer Realities
An inspection of downstream applications in the workspace proves why Model A (canonical interpretation) is unviable:
1. **Marketplace (`C:\Users\John\Documents\CODE\back\Marketplace`):**
   - Ingests Flutterwave webhooks directly at `/api/v1/webhooks/payments/flutterwave`.
   - Parses `data.tx_ref`, `data.status`, `data.customer`, and `data.meta`.
   - Executes multi-step business logic: manages a 3-tier inventory backorder allocation state machine, settles subaccount splits, and writes double-entry ledger journal transactions.
   - Forcing this into a generic `payment.successful` DTO would strip the subaccount split metadata and backorder fulfillment flags needed by Marketplace.
2. **Betting Automation Backend (`C:\Users\John\Documents\CODE\back\bettingAutomationBackend`):**
   - Ingests webhooks at `/api/v1/payments/webhook`.
   - Evaluates custom metadata (`meta.account_id`, `meta.plan_id`) to issue Keygen software licenses and manage subscription billing.
   - A generic payment event would obscure the custom license activation metadata, forcing the application to make secondary round-trip API calls back to the payment provider.

---

## Section E: Responsibility Matrix: Gateway vs. Downstream Applications

The boundary between CWIDS and downstream recipient applications is strict and non-overlapping:

| Concern / Responsibility | CWIDS (Gateway) | Downstream Application | Justification & Architectural Boundary |
| :--- | :---: | :---: | :--- |
| **Ingress HTTP Management & Limits** | **OWNS** | Does Not Own | CWIDS absorbs upstream traffic, enforces 1MB body ceilings, and isolates applications from provider bursts. |
| **Provider Signature Verification** | **OWNS** | Does Not Own | CWIDS holds provider KMS credentials and verifies authenticity before any internal processing. |
| **Raw Payload Preservation** | **OWNS** | Receives | CWIDS captures exact bytes into `Buffer` and stores them via AES-256-GCM envelope encryption. |
| **Ingress Deduplication** | **OWNS** | Implements Own | CWIDS absorbs duplicate provider webhook retries using unique database constraints (`uq_webhook_events_dedupe`). |
| **Multi-Tenant Routing** | **OWNS** | Does Not Own | CWIDS maps incoming events to recipient applications via Modes A, B, and C. |
| **Durable Delivery Work Queue** | **OWNS** | Does Not Own | CWIDS guarantees at-least-once durable delivery with exponential backoff and jitter up to 72 hours. |
| **SSRF & Egress Network Defense** | **OWNS** | Does Not Own | CWIDS pins DNS lookups and blocks internal private IP addresses, preventing SSRF attacks. |
| **Outbound Authentication & Signing** | **OWNS** | Verifies | CWIDS signs deliveries with `X-CWIDS-Signature`. Applications verify this signature before processing. |
| **Payload Business Interpretation** | **DOES NOT OWN** | **OWNS** | CWIDS does not know or care what `charge.success` or `transfer.completed` means for business domain logic. |
| **Order Fulfillment & Inventory** | **DOES NOT OWN** | **OWNS** | Downstream applications determine whether inventory should be decremented or backordered. |
| **License & Entitlement Issuance** | **DOES NOT OWN** | **OWNS** | Downstream applications manage user accounts, subscriptions, and software licensing. |
| **Application-Layer Idempotency** | Does Not Own | **OWNS** | Applications must ensure idempotent business-state transitions (e.g., checking if an order was already fulfilled). |
| **Ledger & Accounting Transactions** | **DOES NOT OWN** | **OWNS** | Applications manage double-entry bookkeeping, tax calculations, and revenue recognition. |

---

## Section F: Proposed Outbound Delivery Protocol (The Wire Contract)

CWIDS standardizes on a simple, robust, secure outbound delivery contract modeled after modern industrial webhook providers (e.g., Stripe, Svix, GitHub).

### 1. HTTP Request Specification
- **Method:** `POST`
- **Target URL:** Configured application destination endpoint (`cwids.destination_endpoints.url`, must be HTTPS in production).
- **Body:** The exact, unadulterated raw byte buffer received from the payment provider.

### 2. Standardized Delivery Headers

| Header Name | Type | Description | Example |
| :--- | :--- | :--- | :--- |
| `Content-Type` | String | MIME type of the payload. Defaults to `application/json`. | `application/json; charset=utf-8` |
| `Content-Length` | Integer | Exact byte count of the raw payload. | `1428` |
| `User-Agent` | String | Gateway identifier. | `CWIDS-Webhook-Delivery/1.0` |
| `X-CWIDS-Delivery-ID` | UUID | Unique identifier for this delivery attempt sequence. | `d3b07384-d113-494a-a1b6-d3b07384d113` |
| `X-CWIDS-Event-ID` | UUID | Unique identifier of the underlying stored webhook event. | `7c9e6679-7425-40de-944b-e07fc1f90ae7` |
| `X-CWIDS-Provider` | String | Identifier of the originating provider. | `paystack` or `flutterwave` |
| `X-CWIDS-Timestamp` | Integer | Unix epoch timestamp (seconds) when dispatch was signed. | `1793308800` |
| `X-CWIDS-Signature` | String | Cryptographic signature of timestamp, delivery ID, and payload. | `t=1793308800,v1=5d41402abc4b2a76...` |

### 3. Cryptographic Signature Specification
The signature protects against tampering, replay attacks, and unauthorized origin spoofing.

#### Canonical String Construction:
$$\text{CanonicalString} = \text{TimestampSeconds} \mathbin{\Vert} \text{"."} \mathbin{\Vert} \text{DeliveryID} \mathbin{\Vert} \text{"."} \mathbin{\Vert} \text{PayloadUTF8String}$$

#### Signature Algorithm:
$$\text{SignatureHex} = \text{HMAC-SHA256}(\text{SigningSecret}, \text{CanonicalString})$$

#### Header Formatting:
```http
X-CWIDS-Signature: t=1793308800,v1=a35b8e9f4c2d1e0a8b7c6d5e4f3a2b1c0d9e8f7a6b5c4d3e2f1a0b9c8d7e6f5a
```

#### Verification Algorithm for Downstream Applications:
1. Parse the header to extract timestamp $t$ and signature $v1$.
2. Check timestamp freshness: $|t_{\text{current}} - t| \le 300\text{ seconds}$ (5-minute tolerance against replay attacks).
3. Compute expected HMAC-SHA256 over `${t}.${deliveryId}.${rawBody}` using the shared application signing secret.
4. Compare expected signature against $v1$ using constant-time string comparison (`crypto.timingSafeEqual`).

### 4. Downstream Response & Acknowledgement Contract

#### Response Validation Modes:
CWIDS supports two validation modes configured per destination endpoint (`cwids.destination_endpoints.response_validation_mode`):

1. **`http_status` Mode (Default):**
   - **HTTP 200–299:** Acknowledged. Delivery is marked `delivered`.
   - **HTTP 400, 401, 403, 404, 422:** Client rejection. Non-retryable error $\to$ delivery is immediately marked `dead_lettered` (reason: `CLIENT_REJECTED`).
   - **HTTP 408, 429, 500, 502, 503, 504, or Connection Drops:** Temporary failure $\to$ retry scheduled with exponential backoff and jitter.

2. **`envelope` Mode (Optional Structured Response):**
   - The downstream application returns HTTP 200 with a structured JSON body:
     ```json
     { "status": "processed", "idempotency_key": "app_ord_123" }
     ```
   - If `{ "status": "rejected", "reason": "invalid_order" }` is returned, CWIDS immediately marks the delivery `dead_lettered` without wasting retry attempts.

#### Streaming Response Safeguard:
CWIDS severs the inbound response stream after **2,048 bytes (2KB)** via `src/delivery/http-dispatcher.mjs:114-148`. Downstream endpoints must not return multi-megabyte payloads in response to webhooks.

---

## Section G: Data and Concurrency Design

### Relational Entity Model

```
┌──────────────────────┐         ┌──────────────────────────────┐
│  cwids.applications  │1       *│  cwids.destination_endpoints │
│  (Tenants)           ├────────┤  (Target HTTPS URLs & Secrets)│
└──────────┬───────────┘         └──────────────┬───────────────┘
           │1                                   │1
           │                                    │
           │*                                   │*
┌──────────┴───────────────────┐         ┌──────┴───────────────────────┐
│  cwids.payment_intent_       │         │  cwids.event_deliveries      │
│  correlations                │         │  (Durable Work Queue)        │
│  (Mode A Routing Registry)   │         │  status, lease, fencing_token│
└──────────┬───────────────────┘         └──────┬───────────────┬───────┘
           │1                                   │1              │1
           │                                    │               │
           │*                                   │*              │*
┌──────────┴───────────────────┐         ┌──────┴────────┐┌─────┴───────┐
│  cwids.payment_intent_       │         │cwids.delivery_││cwids.circuit│
│  aliases                     │         │attempts       ││_breaker_    │
│  (Mode C Provider Aliases)   │         │(Append-Only)  ││states       │
└──────────────────────────────┘         └───────────────┘└─────────────┘
                                                ▲
                                                │*
                                                │1
                                         ┌──────┴───────────────────────┐
                                         │  cwids.webhook_events        │
                                         │  (Authoritative Event Store) │
                                         │  encrypted_payload, dedupe   │
                                         └──────────────────────────────┘
```

### Transactional Boundaries

#### 1. Inbound Transaction (`Tx-Ingest`):
Executed in `src/ingestion/ingestion-service.mjs:86-201` as a single atomic PostgreSQL transaction:
- **Operation 1:** Read intent correlations or aliases for tenant resolution.
- **Operation 2:** Insert into `cwids.webhook_events` with `ON CONFLICT (provider_connection_id, environment, identity_strategy_version, dedupe_key) DO NOTHING`.
- **Operation 3:** If resolved and new event: Insert into `cwids.event_deliveries` (`status = 'pending'`).
- **Operation 4:** Insert audit record into `cwids.audit_outbox`.
- **Commit:** Provider receives HTTP 200 OK only after transaction commits.

#### 2. Worker Claim Transaction (`Tx-Delivery-Claim`):
Executed in `src/delivery/scheduler.mjs:25-78`:
- Uses `SELECT ... FOR UPDATE SKIP LOCKED` to lock candidate delivery rows without blocking concurrent workers.
- Increments `fencing_token = fencing_token + 1`.
- Sets `lease_expires_at = NOW() + INTERVAL '60 seconds'`.
- Sets `status = 'in_flight'`.

#### 3. Worker Completion Transaction (`Tx-Delivery-Result`):
Executed in `src/delivery/delivery-service.mjs:137-220`:
- Updates `cwids.event_deliveries` enforcing `WHERE id = $1 AND fencing_token = $2`.
- If another worker claimed the job after lease expiry, the update affects 0 rows and is rejected.
- Appends network execution details to `cwids.delivery_attempts`.

### Concurrency and Lease Fencing
To prevent zombie workers or network partitions from causing double delivery or corrupting delivery states, CWIDS implements monotonic fencing tokens.

$$\text{Token}_{\text{new}} = \text{Token}_{\text{old}} + 1$$

Any database write by an outbound dispatcher must match its assigned `fencing_token`. If a worker hangs for $>60\text{ seconds}$, another worker claims the delivery and increments the token, instantly invalidating the stale worker's credentials.

---

## Section H: Threat Model and Security Posture

| Threat Category (STRIDE) | Attack Vector | Gateway Mitigation Mechanism | Implementation Citation |
| :--- | :--- | :--- | :--- |
| **Spoofing** | Forged inbound webhook from malicious third party. | Constant-time HMAC-SHA512 (Paystack) or `verif-hash` (Flutterwave) signature verification using KMS secret. | `src/providers/paystack/adapter.mjs:47`<br>`src/providers/flutterwave/adapter.mjs:54` |
| **Spoofing** | Rogue caller impersonating CWIDS to downstream apps. | Downstream verification of `X-CWIDS-Signature` header signed with application-specific secret. | `src/security/hmac-signer.mjs:14-24` |
| **Tampering** | Modification of raw payloads stored at rest in database. | Application-layer AES-256-GCM envelope encryption with authenticated data tags and per-event DEKs. | `src/security/envelope-encryption.mjs:26-55` |
| **Repudiation** | Merchant disputes webhook contents or denies receipt. | CWIDS stores exact incoming bytes, SHA-256 digest, and append-only delivery attempts with response excerpts. | `src/ingress/raw-body-middleware.mjs:43`<br>`src/db/migrations/001_initial_schema.sql:163` |
| **Information Disclosure** | Cross-tenant data leakage in shared database. | Row-Level Security (RLS) forced across all tables; tenant isolation enforced by PostgreSQL runtime roles. | `src/db/migrations/005_runtime_roles_and_rls.sql:28-46` |
| **Denial of Service** | Upstream memory exhaustion via gigabyte-sized payloads. | Ingress body stream capped at 1MB (HTTP 413); socket severed immediately via `req.destroy()`. | `src/ingress/raw-body-middleware.mjs:23-30` |
| **Denial of Service** | Downstream memory exhaustion via streaming infinite responses. | Outbound response stream capped at 2,048 bytes; socket severed immediately upon exceeding limit. | `src/delivery/http-dispatcher.mjs:122-132` |
| **Denial of Service** | Downstream application outage causing cascading gateway worker exhaustion. | Per-destination Circuit Breakers (`closed`, `open`, `half_open`) pause outbound traffic during sustained 5xx errors. | `src/delivery/circuit-breaker.mjs:45-88` |
| **Elevation of Privilege / SSRF** | Attacker configures destination URL pointing to internal AWS metadata (`169.254.169.254`) or localhost. | Custom `ssrfAgent` resolves DNS before connect; blocks private, loopback, link-local, and reserved CIDRs. | `src/security/ssrf-agent.mjs:60-95` |

---

## Section I: Comparative Analysis of Architectural Models

| Evaluation Criterion | Model A: Canonical Business Events | Model B: Pure Raw Gateway | Model C: Bounded Hybrid Gateway (Recommended) |
| :--- | :--- | :--- | :--- |
| **Architecture Summary** | Translates every webhook into a universal business DTO (`payment.successful`). | Forwards raw bytes blindly with zero inspection. | Preserves exact raw bytes; extracts minimal routing keys for tenant routing. |
| **Security & Attack Surface** | High: Parsing complex business schemas exposes gateway to deserialization bugs. | Minimal: Ingress verifies signature and stores bytes. | Low: Ingress verifies signature, parses top-level routing IDs, stores raw bytes. |
| **Provider Coupling** | Severe: Every new provider feature or event type requires updating CWIDS translators. | Minimal: Zero provider business logic in CWIDS. | Low: CWIDS only needs to know where `reference` lives to route events. |
| **Downstream Application Coupling**| High: Forces all applications to adopt CWIDS-specific domain models. | Low: Applications parse provider payloads using standard provider documentation. | Low: Applications parse provider payloads using standard provider documentation. |
| **Forensic Fidelity** | Low: Reserialization alters formatting, removes unrecognized fields, breaks signatures. | Perfect: Exact byte-level preservation; upstream signatures remain verifiable. | Perfect: Exact byte-level preservation; upstream signatures remain verifiable. |
| **Multi-Tenant Routing** | Complex: Requires mapping domain events across tenants. | Inflexible: Cannot support shared provider accounts across multiple tenants. | Clean & Deterministic: Resolves routing via Modes A, B, and C without altering payloads. |
| **Deduplication Reliability** | Unreliable: Subject to semantic normalization differences. | High: Uses raw transaction references and event types. | High: Length-prefixed dedupe keys prevent delimiter collisions. |
| **Storage Cost & Performance** | Moderate: Must store both canonical JSON and raw payloads. | Optimal: Stores single encrypted byte buffer. | Optimal: Stores single encrypted byte buffer. |
| **Extensibility to New Providers** | Slow: Requires weeks of domain modeling and schema mapping. | Instant: Only requires signature verification implementation. | Fast: Requires signature verification and 3 routing field extractions. |
| **Heterogeneous Consumer Fit** | Fails: Cannot satisfy diverging needs of `Marketplace` vs `BettingBackend`. | Excellent: Each application consumes exactly what it needs. | Excellent: Each application consumes exactly what it needs. |
| **Testing Complexity** | Extremely High: Combinatorial explosion of domain event states. | Low: Tests focus on transport, encryption, and delivery durability. | Low: Tests focus on transport, encryption, and delivery durability. |
| **Migration Effort** | Massive rewrite: Existing code must be converted to domain event translation. | Minor: Already 90% implemented in current codebase. | Minimal: Retain current codebase; formalize outbound headers. |

---

## Section J: Implementation and Evolution Roadmap

Transitioning CWIDS from its current state to a fully certified Model B-hybrid gateway requires four ordered, low-risk phases. **No existing production database schemas or core delivery engines need to be discarded.**

```
┌────────────────────────────────────────────────────────┐
│ Phase 1: Architectural Codification & Spec Alignment   │
│ - Finalize ADRs certifying Model B-hybrid              │
│ - Update documentation and architectural baselines     │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 2: Outbound Protocol Enrichment                  │
│ - Add X-CWIDS-Event-ID, X-CWIDS-Provider, and          │
│   X-CWIDS-Timestamp headers to http-dispatcher.mjs     │
│ - Validate signature canonical format across SDKs      │
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 3: Adapter Refinement                            │
│ - Remove vestigial domain fields (amountMinor, currency)│
│   from NormalizedPayload in Paystack/Flutterwave       │
│ - Retain strictly: merchantReference, providerReference│
└──────────────────────────┬─────────────────────────────┘
                           │
                           ▼
┌────────────────────────────────────────────────────────┐
│ Phase 4: Downstream Consumer Verification              │
│ - Verify Marketplace verifies X-CWIDS-Signature        │
│ - Verify BettingBackend verifies X-CWIDS-Signature     │
│ - Decommission deprecated direct provider polling      │
└────────────────────────────────────────────────────────┘
```

### Phase Details

#### Phase 1: Architectural Codification (Immediate)
- Formally adopt this investigation document as the definitive architectural blueprint.
- Ensure all engineering stakeholders agree that CWIDS does not perform business-event interpretation.

#### Phase 2: Outbound Protocol Enrichment (Target: Sprint 1)
- Enhance `src/delivery/http-dispatcher.mjs` to add the supplementary standard delivery headers:
  - `X-CWIDS-Event-ID`
  - `X-CWIDS-Provider`
  - `X-CWIDS-Timestamp`
- Existing delivery signatures (`X-CWIDS-Signature`) already include timestamp and delivery ID; ensure downstream documentation provides reference verification code in Node.js, Python, and Go.

#### Phase 3: Adapter Refinement (Target: Sprint 2)
- Clean up `NormalizedPayload` in `src/providers/paystack/adapter.mjs` and `src/providers/flutterwave/adapter.mjs`.
- Remove `amountMinor`, `currency`, and `providerStatus` from the adapter return structure. The routing resolver only needs `merchantReference`, `providerReference`, and `virtualAccountId`.

#### Phase 4: Downstream Application Verification (Target: Sprint 3)
- Verify that `Marketplace` and `bettingAutomationBackend` consume webhooks via CWIDS endpoints with active signature verification.
- Ensure downstream consumers implement idempotency using their own internal transactional databases rather than relying on transport-layer assumptions.

---

## Section K: Architecture Decision Register (ADR)

### ADR-001: Preservation of Raw Incoming Request Bytes
- **Status:** APPROVED
- **Context:** Financial audits and dispute resolution require non-repudiable proof of incoming provider webhooks. Reserializing JSON modifies whitespace and ordering, breaking integrity.
- **Decision:** CWIDS shall capture raw incoming HTTP request bytes into a memory `Buffer` before any parsing occurs. It shall persist these exact bytes using AES-256-GCM envelope encryption and deliver the identical decrypted byte buffer to downstream endpoints.

### ADR-002: Rejection of Universal Business-Event Translation
- **Status:** APPROVED
- **Context:** Proposals were made to normalize all incoming webhooks into a universal `payment.successful` DTO.
- **Decision:** CWIDS shall NOT interpret or translate webhook payloads into a canonical payment business model. Business domain interpretation, order fulfillment, and license issuance are strictly owned by downstream applications.

### ADR-003: Strictly Bounded Transport Routing Metadata
- **Status:** APPROVED
- **Context:** To support multi-tenant routing on shared provider connections, CWIDS must know which tenant owns an incoming webhook.
- **Decision:** CWIDS adapters may extract a strictly limited set of transport routing identifiers (`merchantReference`, `providerReference`, `virtualAccountId`). These fields are used solely for local database lookups in `cwids.payment_intent_correlations` and `cwids.payment_intent_aliases`. They shall never alter the outbound payload.

### ADR-004: Standardized Outbound Authentication Protocol
- **Status:** APPROVED
- **Context:** Downstream applications must authenticate that incoming webhooks originated from CWIDS and were not tampered with.
- **Decision:** Outbound HTTP requests shall include the header `X-CWIDS-Signature: t=<timestamp>,v1=<hmac>` computed via HMAC-SHA256 over the canonical string `${timestamp}.${deliveryId}.${rawPayload}` using an encrypted per-endpoint signing secret.

### ADR-005: Defense Against Upstream and Downstream Failures
- **Status:** APPROVED
- **Context:** Slow or malicious endpoints can exhaust gateway memory and network sockets.
- **Decision:** Ingress payloads are capped at 1MB. Egress response bodies are severed and capped at 2,048 bytes. Destination endpoints are guarded by per-endpoint Circuit Breakers and an SSRF-safe DNS-pinning HTTP agent.

---

## Section L: Hostile Self-Review: Edge Cases and Defense Mechanisms

To ensure intellectual rigor, we analyze five credible failure modes and objections to the raw-payload gateway model:

### 1. "Does raw payload forwarding cause duplicate parsing logic across downstream applications?"
- **The Challenge:** If CWIDS doesn't normalize Paystack and Flutterwave payloads, then both `Marketplace` and `bettingAutomationBackend` must maintain their own JSON parsing logic.
- **The Defense:** Yes, and this is an architectural feature, not a bug. `Marketplace` cares about inventory backorders and double-entry subaccount splits; `bettingAutomationBackend` cares about customer email addresses and Keygen license metadata. If shared parsing logic is desired, it should be distributed via a shared lightweight client SDK library (`@company/payment-payload-parsers`), **not** baked into the network gateway infrastructure. Baking business parsing into CWIDS creates a catastrophic deployment bottleneck: changing an application's business rules would require redeploying the core gateway.

### 2. "What happens if a provider webhook arrives before the application registers the Payment Intent?"
- **The Challenge:** In high-concurrency environments, a user may complete payment so quickly that the provider webhook reaches CWIDS before the application's backend finishes inserting the `payment_intent_correlation` row (Race Condition / Mode D).
- **The Defense:** Model A systems often drop or crash on unregistered transactions. CWIDS handles this gracefully via Mode D (`awaiting_route`). The authentic encrypted payload is persisted in `cwids.webhook_events` with `routing_status = 'awaiting_route'`. When the application registers the intent, or via a scheduled background reconciliation sweep, the event is resolved and dispatched without any data loss.

### 3. "What if an upstream provider sends non-JSON or corrupted payloads?"
- **The Challenge:** What if Paystack or Flutterwave sends XML, URL-encoded forms, or malformed JSON?
- **The Defense:** A canonical business-event platform (Model A) crashes or rejects the event at ingress because it cannot map the payload to its TypeScript DTO. CWIDS handles this cleanly: `rawBodyMiddleware` captures the raw bytes regardless of encoding. If the cryptographic signature is valid but JSON parsing fails, `verifyAndNormalize` marks `isMalformed: true`. CWIDS securely persists the authentic encrypted bytes in `cwids.webhook_events` with `routing_status = 'rejected'` (`src/ingestion/ingestion-service.mjs:44-84`). This guarantees a complete, tamper-proof forensic audit trail for dispute resolution.

### 4. "Can downstream applications cause gateway worker pool starvation by hanging?"
- **The Challenge:** If a downstream application hangs for 60 seconds on every request, will it exhaust CWIDS delivery worker threads?
- **The Defense:** No. In `src/delivery/http-dispatcher.mjs:55`, outbound requests enforce strict HTTP socket timeouts (`http_timeout_ms`, default 5,000ms, max 30,000ms). When an endpoint fails repeatedly, the `CircuitBreaker` (`src/delivery/circuit-breaker.mjs`) trips to `open` state, immediately bypassing subsequent deliveries to that endpoint and preventing worker starvation.

### 5. "What if a provider sends the same transaction reference with different payload bodies (Payload Replay Tampering)?"
- **The Challenge:** An attacker or buggy provider reuses a transaction reference but alters the payment amount.
- **The Defense:** CWIDS detects this at the database boundary (`src/ingestion/ingestion-service.mjs:130-150`). When an incoming dedupe key matches an existing event, CWIDS compares `event.payload_sha256` against the new `payloadSha256`. If they differ, CWIDS absorbs the duplicate to protect downstream consumers, but immediately flags a `PAYLOAD_CONFLICT_WARNING` in `cwids.audit_outbox` for administrative investigation.

---

## Section 14: Direct Answer to the Final Decision Question

### Final Decision
**CWIDS MUST BE A SECURE, DURABLE, POLICY-CONTROLLED RAW-PAYLOAD WEBHOOK GATEWAY (MODEL B-HYBRID).**

It must **NOT** interpret provider webhooks into a canonical business-event model.

### Key Architectural Commitments:
1. **CWIDS Owns Secure Transport & Durability:** CWIDS guarantees ingress rate limiting, signature verification, raw byte encryption, deterministic tenant routing, at-least-once delivery with exponential retries, lease fencing, circuit breaking, SSRF defense, and audit logging.
2. **Applications Own Business Semantics:** Downstream applications own payload parsing, domain validation, order fulfillment, subscription billing, and application-level idempotency.
3. **Zero Payload Reserialization:** CWIDS shall never parse, modify, re-serialize, or transform the webhook payload body between ingress and egress. The bytes received from the provider are the exact bytes delivered to the application.
4. **Minimal Transport Routing:** Provider adapters shall extract only the minimal identifiers (`merchantReference`, `providerReference`, `virtualAccountId`) strictly required to locate the destination tenant endpoint in the database.

---
*End of Architectural Investigation Report.*
