# Error Design Reference API

A working Express API that demonstrates production-ready error response patterns. Built as a companion to a workshop / blog post on designing errors that developers (and AI agents) can actually use.

## Quick Start

```bash
npm install
npm start
```

The server starts on `http://localhost:3000` (override with `PORT` env var).

## What This Demonstrates

| Pattern | Endpoint | What You'll See |
|---|---|---|
| Error catalog | `GET /errors` | Machine-readable list of every error code |
| Auth errors | `POST /webhooks` (no key) | Distinct codes for missing vs invalid keys |
| Field-level validation | `POST /webhooks` (bad body) | Per-field errors with rejected values and hints |
| Optimistic locking | `PATCH /configs/:id` | Version conflict with change history |
| Downstream failure | `POST /documents/verify` | Transient upstream timeout with retry guidance |
| Partial batch failure | `POST /messages/batch` | HTTP 207 with per-item success/failure |
| Rate limiting | Any authed route (11+ calls) | 429 with machine-readable retry fields |

## API Key

Use either of the demo keys:

```
Authorization: Bearer sk-live-demo
Authorization: Bearer sk-test-demo
```

## Example Requests

**Browse the error catalog:**

```bash
curl -s http://localhost:3000/errors | jq
```

**Missing auth (401 with `AUTH_MISSING` code):**

```bash
curl -s http://localhost:3000/webhooks -X POST | jq
```

**Validation errors with per-field detail:**

```bash
curl -s http://localhost:3000/webhooks -X POST \
  -H "Authorization: Bearer sk-live-demo" \
  -H "Content-Type: application/json" \
  -d '{"url":"http://myapp.com/hook","events":["fake.event"]}' | jq
```

**Version conflict (optimistic locking):**

```bash
# First, GET the current config to see the real ETag
curl -s http://localhost:3000/configs/cfg_001 \
  -H "Authorization: Bearer sk-live-demo" | jq

# Then PATCH with a stale ETag to trigger a 412 conflict
curl -s http://localhost:3000/configs/cfg_001 -X PATCH \
  -H "Authorization: Bearer sk-live-demo" \
  -H "Content-Type: application/json" \
  -H 'If-Match: "etag-v2"' \
  -d '{"theme":"dark"}' | jq
```

**Downstream timeout (70% chance, for demo purposes):**

```bash
curl -s http://localhost:3000/documents/verify -X POST \
  -H "Authorization: Bearer sk-live-demo" | jq
```

**Partial batch failure (HTTP 207):**

```bash
curl -s http://localhost:3000/messages/batch -X POST \
  -H "Authorization: Bearer sk-live-demo" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"to":"+44700000001","body":"Hello"},{"to":"not-a-number","body":"Hi"}]}' | jq
```

**Rate limiting (send 11+ requests quickly):**

```bash
for i in $(seq 1 12); do
  curl -s http://localhost:3000/webhooks -X POST \
    -H "Authorization: Bearer sk-live-demo" \
    -H "Content-Type: application/json" \
    -d '{"url":"https://example.com/hook","events":["order.created"]}' | jq .error.code
done
```

## Error Response Shape

Every error follows the same structure:

```json
{
  "error": {
    "code": "VALIDATION_FAILED",
    "message": "Request body failed validation.",
    "hint": "Check the 'errors' array for specific fields that need fixing.",
    "docs_url": "http://localhost:3000/errors/VALIDATION_FAILED"
  },
  "request_id": "req_a1b2c3d4e5f6g7h8"
}
```

Key properties:
- **`code`** -- Stable, machine-readable string (never changes)
- **`message`** -- Human-readable explanation of what went wrong
- **`hint`** -- Actionable next step to fix the problem
- **`docs_url`** -- Link to full documentation for this error code
- **`request_id`** -- Unique ID for log correlation and support tickets

Endpoints may add extra fields in the error object (e.g. `errors[]` for validation, `retry_after_seconds` for rate limits) -- the shape is always additive, never breaking.

## Project Structure

```
server.js    -- The entire API in one file, heavily commented
```

Sections in `server.js`:
1. **Error Catalog** -- Single source of truth for all error codes
2. **ApiError Class** -- Structured error that flows from origin to response
3. **Request ID Middleware** -- Assigns `X-Request-Id` to every request
4. **Auth Middleware** -- Demonstrates missing vs invalid key errors
5. **Rate Limiter** -- In-memory limiter with machine-readable headers
6. **Routes** -- Five endpoints showcasing different error patterns
7. **Error Handler** -- Formats `ApiError` instances, catches unexpected errors

## License

MIT
