# Downstream Application Webhook Integration Guide

**Document Version:** 1.0.0  
**Target Audience:** Engineering teams building downstream recipient services (e.g., `Marketplace`, `bettingAutomationBackend`).  
**Gateway Service:** Centralized Webhook Ingestion and Delivery Service (CWIDS)  

---

## 1. Architectural Overview

CWIDS operates as a **secure, durable, policy-controlled raw-payload webhook gateway**. 

- **Exact Raw Bytes:** CWIDS delivers the exact, unaltered incoming request bytes received from payment providers (Paystack, Flutterwave, Stripe) directly to your application's HTTPS webhook endpoint.
- **No Canonical Interpretation:** CWIDS does **not** translate provider payloads into generic events (`payment.successful`, etc.). Your application retains full control over domain parsing, inventory reservation, order fulfillment, subscription provisioning, and double-entry bookkeeping.
- **Provider Secrets Kept Secure:** Downstream applications never hold payment provider webhook secret tokens (`verif-hash` or provider secret keys). Instead, CWIDS verifies the provider at ingress, and authenticates deliveries to your application using a dedicated, rotating endpoint signing secret.
- **Durable Delivery Guarantees:** CWIDS guarantees at-least-once delivery with exponential backoff and jitter over a 72-hour delivery horizon. If your service experiences temporary downtime, CWIDS buffers events and retries reliably.

---

## 2. Inbound HTTP Delivery Contract

CWIDS dispatches authenticated HTTP `POST` requests to your configured endpoint URL.

### Request Headers

| Header Name | Type | Description |
| :--- | :--- | :--- |
| `Content-Type` | `string` | MIME type of the payload (typically `application/json`). |
| `Content-Length` | `integer` | Byte length of the raw payload. |
| `User-Agent` | `string` | Gateway agent string (`CWIDS-Webhook-Delivery/1.0`). |
| `X-CWIDS-Delivery-ID` | `UUID` | Unique identifier for this delivery attempt sequence. |
| `X-CWIDS-Event-ID` | `UUID` | Unique identifier of the underlying stored webhook event. |
| `X-CWIDS-Provider` | `string` | Originating provider name (`paystack` or `flutterwave`). |
| `X-CWIDS-Timestamp` | `integer` | Unix epoch timestamp (seconds) when the request was dispatched. |
| `X-CWIDS-Signature` | `string` | Cryptographic signature formatted as `t=<timestamp>,v1=<hmac_sha256>`. |

---

## 3. Webhook Signature Verification Algorithm

Every delivery includes the `X-CWIDS-Signature` header to protect against tampering, origin impersonation, and replay attacks:

$$\text{CanonicalString} = \text{TimestampSeconds} \mathbin{\Vert} \text{"."} \mathbin{\Vert} \text{DeliveryID} \mathbin{\Vert} \text{"."} \mathbin{\Vert} \text{RawBodyUTF8}$$

$$\text{ExpectedSignature} = \text{HMAC-SHA256}(\text{SigningSecret}, \text{CanonicalString})$$

### Verification Steps
1. Extract `X-CWIDS-Delivery-ID`, `X-CWIDS-Signature`, and `X-CWIDS-Timestamp`.
2. Parse `t` and `v1` from the signature header (`t=1793308800,v1=a35b8e9...`).
3. Verify timestamp freshness: Reject requests if $|t_{\text{current}} - t| > 300\text{ seconds}$ (5-minute replay window).
4. Recompute the expected HMAC-SHA256 over `${t}.${deliveryId}.${rawBody}` using your endpoint's shared signing secret.
5. Compare the signature using constant-time string comparison (`crypto.timingSafeEqual`) to prevent timing side-channel attacks.

---

## 4. Node.js / Express Integration Recipe

### Step 1: Capture Raw Request Bytes
In Express, middleware like `express.json()` parses the request into an object and alters raw whitespace. To verify cryptographic signatures, you **must** preserve the raw body buffer.

```javascript
import express from 'express';

const app = express();

// Capture raw byte buffer on webhook routes
app.use('/api/v1/webhooks', express.raw({ type: 'application/json' }));
```

### Step 2: Verify Signature Using `verifyCwidsWebhook`

```javascript
import { verifyCwidsWebhook } from 'webhook_gateway'; // or use the embedded utility function below

app.post('/api/v1/webhooks', async (req, res) => {
  const signingSecret = process.env.CWIDS_SIGNING_SECRET;
  const rawBody = req.body; // Buffer from express.raw()

  const verification = verifyCwidsWebhook({
    headers: req.headers,
    rawBody,
    signingSecret,
    toleranceSeconds: 300,
  });

  if (!verification.isValid) {
    console.warn('Rejected unauthorized webhook:', verification.failureReason);
    return res.status(401).json({ error: 'Unauthorized', message: verification.failureReason });
  }

  // Parse raw JSON into domain object
  let payload;
  try {
    payload = JSON.parse(rawBody.toString('utf8'));
  } catch (err) {
    return res.status(400).json({ error: 'Bad Request', message: 'Malformed JSON payload.' });
  }

  const { provider, deliveryId, eventId } = verification;

  // Execute downstream business domain logic...
  if (provider === 'flutterwave') {
    await handleFlutterwaveEvent(payload);
  } else if (provider === 'paystack') {
    await handlePaystackEvent(payload);
  }

  return res.status(200).json({ status: 'acknowledged', deliveryId });
});
```

---

## 5. Downstream HTTP Response & Acknowledgement Rules

CWIDS tracks downstream HTTP response status codes to manage its retry schedule:

| HTTP Status Code | Gateway Disposition | Gateway Action |
| :--- | :--- | :--- |
| **`200` – `299`** | **Delivered** | Successfully delivered. Obligation fulfilled; no further attempts. |
| **`400`, `401`, `403`, `404`, `422`** | **Client Rejection** | Non-retryable error. Marked `dead_lettered` immediately. CWIDS will **not** retry. |
| **`408`, `429`** | **Transient Failure** | Rate-limited or timed out. Retry scheduled with exponential backoff and jitter. |
| **`500`, `502`, `503`, `504`** | **Server Error** | Downstream failure. Retry scheduled with exponential backoff and jitter up to 72 hours. |
| **Connection Timeout** | **Network Drop** | Socket closed or hung. Retry scheduled with backoff. |

> [!WARNING]
> **2,048-Byte Response Excerpt Limit:**  
> CWIDS caps response stream ingestion at **2,048 bytes (2KB)**. If your application returns a response exceeding 2KB, CWIDS immediately severs the socket to prevent memory exhaustion. Return concise JSON acknowledgements (e.g. `{ "status": "ok" }`).

---

## 6. Downstream Idempotency & Concurrency Guidance

Because CWIDS guarantees **at-least-once delivery**, downstream applications must ensure their business operations are idempotent:

1. **Use Database Unique Constraints:**  
   Store transaction references or event IDs in your database with unique constraints (e.g., `UNIQUE(provider_tx_ref)` or `UNIQUE(order_id)`).
2. **Atomic State Transitions:**  
   Execute order updates inside transactions checking for expected prior state:
   ```sql
   UPDATE orders SET status = 'paid' WHERE id = $1 AND status = 'pending';
   ```
3. **Do Not Rely Exclusively on Gateway Deduplication:**  
   While CWIDS absorbs duplicate provider webhooks at ingress, network drops during delivery may cause CWIDS to retry an event that your application partially processed. Your application must guard its own state transitions.
