// ─────────────────────────────────────────────────────────────
// Error Design Reference API
//
// A working Express API that demonstrates production-ready
// error responses. Clone it, run it, hit it with curl.
//
// Setup:
//   npm install
//   npm start
//
// Try these:
//   curl -s http://localhost:3000/errors | jq
//   curl -s http://localhost:3000/webhooks -X POST | jq
//   curl -s http://localhost:3000/webhooks -X POST \
//     -H "Authorization: Bearer sk-live-demo" \
//     -H "Content-Type: application/json" \
//     -d '{"url":"http://myapp.com/hook","events":[]}' | jq
//   curl -s http://localhost:3000/configs/cfg_001 -X PATCH \
//     -H "Authorization: Bearer sk-live-demo" \
//     -H "Content-Type: application/json" \
//     -H 'If-Match: "etag-v2"' \
//     -d '{"theme":"dark"}' | jq
//   curl -s http://localhost:3000/documents/verify -X POST \
//     -H "Authorization: Bearer sk-live-demo" | jq
//   curl -s http://localhost:3000/messages/batch -X POST \
//     -H "Authorization: Bearer sk-live-demo" \
//     -H "Content-Type: application/json" \
//     -d '{"messages":[{"to":"+44700000001","body":"Hello"},{"to":"not-a-number","body":"Hi"}]}' | jq
//
// ─────────────────────────────────────────────────────────────
const express = require("express");
const crypto = require("crypto");
const app = express();
app.use(express.json());

// ═════════════════════════════════════════════════════════════
// 1. ERROR CATALOG
//
// Every error code lives here. One file, one source of truth.
// Exposed as GET /errors so developers and SDKs can fetch it.
// ═════════════════════════════════════════════════════════════
const ERROR_CATALOG = {
  AUTH_MISSING: {
    status: 401,
    message: "API key is missing from the request.",
    hint: "Include your key in the Authorization header: Authorization: Bearer sk-your-key",
  },
  AUTH_INVALID: {
    status: 401,
    message: "API key is invalid or has been revoked.",
    hint: "Check that you copied the full key including the sk- prefix. Generate a new one at /dashboard.",
  },
  VALIDATION_FAILED: {
    status: 422,
    message: "Request body failed validation.",
    hint: "Check the 'errors' array for specific fields that need fixing.",
  },
  RATE_LIMIT_EXCEEDED: {
    status: 429,
    message: "Rate limit exceeded.",
    hint: "Wait for the duration in retry_after_seconds before retrying.",
  },
  VERSION_CONFLICT: {
    status: 412,
    message: "This resource was modified since you last read it.",
    hint: "Fetch the latest version, re-apply your changes, and retry with the new ETag.",
  },
  RESOURCE_NOT_FOUND: {
    status: 404,
    message: "The requested resource was not found.",
    hint: "Check the resource ID. Use GET on the collection endpoint to list available resources.",
  },
  DOWNSTREAM_TIMEOUT: {
    status: 502,
    message: "An upstream service did not respond in time.",
    hint: "This is a transient issue, not a problem with your request. Check retry_safe before retrying.",
  },
  INTERNAL_ERROR: {
    status: 500,
    message: "An unexpected internal error occurred.",
    hint: "If this persists, contact support with the request_id from this response.",
  },
};

// ═════════════════════════════════════════════════════════════
// 2. ERROR CLASS
//
// Carries structured context from the point of origin all the
// way through to the response. Middleware formats it, never
// replaces it.
// ═════════════════════════════════════════════════════════════
class ApiError extends Error {
  constructor(code, overrides = {}) {
    const catalog = ERROR_CATALOG[code];
    if (!catalog) throw new Error(`Unknown error code: ${code}`);
    const message = overrides.message || catalog.message;
    super(message);
    this.code = code;
    this.status = overrides.status || catalog.status;
    this.hint = overrides.hint || catalog.hint;
    this.meta = overrides.meta || {};
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        hint: this.hint,
        ...this.meta,
        docs_url: `http://localhost:3000/errors/${this.code}`,
      },
    };
  }
}

// ═════════════════════════════════════════════════════════════
// 3. REQUEST ID MIDDLEWARE
//
// Every request gets a unique ID. Returned in every response
// (success or error) for log correlation and support tickets.
// ═════════════════════════════════════════════════════════════
app.use((req, res, next) => {
  req.id = `req_${crypto.randomBytes(8).toString("hex")}`;
  res.set("X-Request-Id", req.id);
  next();
});

// ═════════════════════════════════════════════════════════════
// 4. AUTH MIDDLEWARE
//
// Demonstrates two distinct auth errors: missing key vs
// invalid key. Both return 401 but with different codes.
// ═════════════════════════════════════════════════════════════
const VALID_KEYS = ["sk-live-demo", "sk-test-demo"];

function requireAuth(req, res, next) {
  const header = req.headers.authorization;
  if (!header) {
    return next(new ApiError("AUTH_MISSING"));
  }
  const key = header.replace("Bearer ", "");
  if (!VALID_KEYS.includes(key)) {
    return next(
      new ApiError("AUTH_INVALID", {
        meta: { provided_key_prefix: key.slice(0, 6) + "..." },
      })
    );
  }
  req.apiKey = key;
  next();
}

// ═════════════════════════════════════════════════════════════
// 5. RATE LIMITER MIDDLEWARE
//
// Simple in-memory rate limiter. Returns machine-readable
// fields so SDKs and agents can auto-recover.
// ═════════════════════════════════════════════════════════════
const rateBuckets = {};
const RATE_LIMIT = 10;
const RATE_WINDOW_MS = 60_000;

function rateLimit(req, res, next) {
  const key = req.apiKey || "anonymous";
  const now = Date.now();
  if (!rateBuckets[key] || now - rateBuckets[key].start > RATE_WINDOW_MS) {
    rateBuckets[key] = { start: now, count: 0 };
  }
  rateBuckets[key].count++;
  const bucket = rateBuckets[key];
  const remaining = Math.max(0, RATE_LIMIT - bucket.count);
  const resetsIn = Math.ceil((bucket.start + RATE_WINDOW_MS - now) / 1000);

  res.set("X-RateLimit-Limit", String(RATE_LIMIT));
  res.set("X-RateLimit-Remaining", String(remaining));
  res.set(
    "X-RateLimit-Reset",
    String(Math.ceil((bucket.start + RATE_WINDOW_MS) / 1000))
  );

  if (bucket.count > RATE_LIMIT) {
    return next(
      new ApiError("RATE_LIMIT_EXCEEDED", {
        message: `Rate limit exceeded. ${bucket.count} requests in the last 60s (limit: ${RATE_LIMIT}).`,
        meta: {
          limit: RATE_LIMIT,
          used: bucket.count,
          remaining: 0,
          retry_after_seconds: resetsIn,
          reset_at: new Date(bucket.start + RATE_WINDOW_MS).toISOString(),
        },
      })
    );
  }
  next();
}

// ═════════════════════════════════════════════════════════════
// 6. ROUTES
// ═════════════════════════════════════════════════════════════

// --- GET /errors --- Error catalog endpoint -------------------
app.get("/errors", (req, res) => {
  const catalog = Object.entries(ERROR_CATALOG).map(([code, info]) => ({
    code,
    status: info.status,
    message: info.message,
    hint: info.hint,
    docs_url: `http://localhost:3000/errors/${code}`,
  }));
  res.json({ errors: catalog, total: catalog.length });
});

app.get("/errors/:code", (req, res, next) => {
  const info = ERROR_CATALOG[req.params.code];
  if (!info) {
    return next(
      new ApiError("RESOURCE_NOT_FOUND", {
        message: `Error code '${req.params.code}' does not exist in the catalog.`,
        hint: "Use GET /errors to list all available error codes.",
      })
    );
  }
  res.json({
    code: req.params.code,
    status: info.status,
    message: info.message,
    hint: info.hint,
    docs_url: `http://localhost:3000/errors/${req.params.code}`,
  });
});

// --- POST /webhooks --- Validation with per-field errors ------
const VALID_EVENTS = [
  "order.created",
  "order.updated",
  "order.cancelled",
  "payment.completed",
  "payment.failed",
  "user.created",
  "user.deleted",
];

app.post("/webhooks", requireAuth, rateLimit, (req, res, next) => {
  const { url, events, secret } = req.body || {};
  const errors = [];

  if (!url) {
    errors.push({ field: "url", message: "Required." });
  } else if (typeof url !== "string") {
    errors.push({ field: "url", message: "Must be a string." });
  } else if (!url.startsWith("https://")) {
    errors.push({
      field: "url",
      message: "Must use HTTPS.",
      rejected_value: url,
      hint: "Webhook endpoints must be served over TLS. Change http:// to https://.",
    });
  }

  if (!events) {
    errors.push({ field: "events", message: "Required." });
  } else if (!Array.isArray(events) || events.length === 0) {
    errors.push({
      field: "events",
      message: "Must be a non-empty array of event types.",
      available_events: VALID_EVENTS,
    });
  } else {
    const invalid = events.filter((e) => !VALID_EVENTS.includes(e));
    if (invalid.length > 0) {
      errors.push({
        field: "events",
        message: `Unknown event types: ${invalid.join(", ")}`,
        rejected_values: invalid,
        available_events: VALID_EVENTS,
      });
    }
  }

  if (errors.length > 0) {
    return next(new ApiError("VALIDATION_FAILED", { meta: { errors } }));
  }

  const id = `wh_${crypto.randomBytes(6).toString("hex")}`;
  const signingSecret = `whsec_${crypto.randomBytes(16).toString("hex")}`;

  res.status(201).json({
    id,
    url,
    events,
    signing_secret: signingSecret,
    status: "active",
    created_at: new Date().toISOString(),
  });
});

// --- PATCH /configs/:id --- Optimistic locking ----------------
const configs = {
  cfg_001: {
    id: "cfg_001",
    version: 4,
    etag: '"etag-v4"',
    theme: "light",
    language: "en",
    updated_by: "deploy-pipeline@ci",
    updated_at: new Date(Date.now() - 120_000).toISOString(),
    history: [
      {
        version: 3,
        changed_fields: ["theme"],
        changed_by: "jane@company.com",
        changed_at: new Date(Date.now() - 300_000).toISOString(),
      },
      {
        version: 4,
        changed_fields: ["language", "theme"],
        changed_by: "deploy-pipeline@ci",
        changed_at: new Date(Date.now() - 120_000).toISOString(),
      },
    ],
  },
};

app.get("/configs/:id", requireAuth, rateLimit, (req, res, next) => {
  const config = configs[req.params.id];
  if (!config) {
    return next(
      new ApiError("RESOURCE_NOT_FOUND", {
        message: `Config '${req.params.id}' was not found.`,
        hint: "Available config IDs: " + Object.keys(configs).join(", "),
      })
    );
  }
  res.set("ETag", config.etag);
  res.json(config);
});

app.patch("/configs/:id", requireAuth, rateLimit, (req, res, next) => {
  const config = configs[req.params.id];
  if (!config) {
    return next(
      new ApiError("RESOURCE_NOT_FOUND", {
        message: `Config '${req.params.id}' was not found.`,
      })
    );
  }

  const clientEtag = req.headers["if-match"];
  if (!clientEtag) {
    return next(
      new ApiError("VALIDATION_FAILED", {
        message: "Missing If-Match header.",
        hint: 'Include the ETag from your last GET request in the If-Match header to prevent accidental overwrites. Example: If-Match: "etag-v4"',
        meta: { current_etag: config.etag },
      })
    );
  }

  if (clientEtag !== config.etag) {
    const clientVersion =
      parseInt(clientEtag.replace(/[^0-9]/g, ""), 10) || 0;
    const changesSince = config.history.filter(
      (h) => h.version > clientVersion
    );
    return next(
      new ApiError("VERSION_CONFLICT", {
        hint: `Your request was based on version ${clientVersion} but the current version is ${config.version}. Fetch the latest with GET /configs/${config.id}, re-apply your changes, and retry.`,
        meta: {
          your_version: clientVersion,
          current_version: config.version,
          current_etag: config.etag,
          changes_since_your_version: changesSince,
        },
      })
    );
  }

  // Apply the update
  const changedFields = Object.keys(req.body || {});
  Object.assign(config, req.body);
  config.version++;
  config.etag = `"etag-v${config.version}"`;
  config.updated_by = "api-user";
  config.updated_at = new Date().toISOString();
  config.history.push({
    version: config.version,
    changed_fields: changedFields,
    changed_by: "api-user",
    changed_at: config.updated_at,
  });
  res.set("ETag", config.etag);
  res.json(config);
});

// --- POST /documents/verify --- Downstream timeout ------------
app.post("/documents/verify", requireAuth, rateLimit, (req, res, next) => {
  // Simulate a downstream timeout
  const shouldTimeout = Math.random() > 0.3; // 70% chance of timeout for demo
  if (shouldTimeout) {
    return next(
      new ApiError("DOWNSTREAM_TIMEOUT", {
        message:
          "Document verification timed out. Our provider did not respond within 30s.",
        hint: "This is a transient upstream issue, not a problem with your request. Safe to retry with backoff.",
        meta: {
          retry_safe: true,
          retry_after_seconds: 5,
          provider: "document-verification",
          provider_status: "degraded",
          status_page: "https://status.example.com",
        },
      })
    );
  }
  res.json({
    id: `ver_${crypto.randomBytes(6).toString("hex")}`,
    status: "verified",
    confidence: 0.97,
    verified_at: new Date().toISOString(),
  });
});

// --- POST /messages/batch --- Partial batch failure ------------
app.post("/messages/batch", requireAuth, rateLimit, (req, res, next) => {
  const { messages } = req.body || {};
  if (!messages || !Array.isArray(messages)) {
    return next(
      new ApiError("VALIDATION_FAILED", {
        meta: {
          errors: [
            { field: "messages", message: "Must be a non-empty array." },
          ],
        },
      })
    );
  }

  if (messages.length > 100) {
    return next(
      new ApiError("VALIDATION_FAILED", {
        meta: {
          errors: [
            {
              field: "messages",
              message: `Batch size ${messages.length} exceeds maximum of 100.`,
              max_batch_size: 100,
            },
          ],
        },
      })
    );
  }

  const E164_REGEX = /^\+[1-9]\d{6,14}$/;
  const results = messages.map((msg, index) => {
    const itemErrors = [];
    if (!msg.to) {
      itemErrors.push({ field: "to", message: "Required." });
    } else if (!E164_REGEX.test(msg.to)) {
      itemErrors.push({
        field: "to",
        message: `'${msg.to}' is not a valid E.164 phone number.`,
        hint: "Phone numbers must include country code, e.g. +44700900000",
        rejected_value: msg.to,
      });
    }

    if (!msg.body) {
      itemErrors.push({ field: "body", message: "Required." });
    } else if (msg.body.length > 1600) {
      itemErrors.push({
        field: "body",
        message: `Body length ${msg.body.length} exceeds maximum of 1600 characters.`,
        max_length: 1600,
      });
    }

    if (itemErrors.length > 0) {
      return {
        index,
        status: "failed",
        error: { code: "VALIDATION_FAILED", errors: itemErrors },
      };
    }
    return {
      index,
      status: "sent",
      message_id: `msg_${crypto.randomBytes(4).toString("hex")}`,
      to: msg.to,
    };
  });

  const succeeded = results.filter((r) => r.status === "sent").length;
  const failed = results.filter((r) => r.status === "failed").length;

  // Use 207 for partial failure, 200 for all success, 422 for all failure
  let statusCode = 200;
  if (failed > 0 && succeeded > 0) statusCode = 207;
  if (failed > 0 && succeeded === 0) statusCode = 422;

  res.status(statusCode).json({
    summary: { total: messages.length, succeeded, failed },
    results,
  });
});

// ═════════════════════════════════════════════════════════════
// 7. ERROR HANDLER MIDDLEWARE
//
// Formats ApiErrors cleanly. Catches unexpected errors safely.
// Never swallows context. Always includes request_id.
// ═════════════════════════════════════════════════════════════
app.use((err, req, res, _next) => {
  if (err instanceof ApiError) {
    return res.status(err.status).json({
      ...err.toJSON(),
      request_id: req.id,
    });
  }

  // Unexpected error: log full trace, return safe response
  console.error(`[${req.id}] Unhandled error:`, err);
  res.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "An unexpected internal error occurred.",
      hint: "If this persists, contact support with the request_id.",
      request_id: req.id,
      docs_url: "http://localhost:3000/errors/INTERNAL_ERROR",
    },
  });
});

// ═════════════════════════════════════════════════════════════
// 8. START
// ═════════════════════════════════════════════════════════════
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`
  Error Design Reference API running on http://localhost:${PORT}

  Try these requests:

  # Browse the error catalog
  curl -s http://localhost:${PORT}/errors | jq

  # Missing auth
  curl -s http://localhost:${PORT}/webhooks -X POST | jq

  # Validation errors (per-field detail)
  curl -s http://localhost:${PORT}/webhooks -X POST \\
    -H "Authorization: Bearer sk-live-demo" \\
    -H "Content-Type: application/json" \\
    -d '{"url":"http://myapp.com/hook","events":["fake.event"]}' | jq

  # Version conflict (optimistic locking)
  curl -s http://localhost:${PORT}/configs/cfg_001 -X PATCH \\
    -H "Authorization: Bearer sk-live-demo" \\
    -H "Content-Type: application/json" \\
    -H 'If-Match: "etag-v2"' \\
    -d '{"theme":"dark"}' | jq

  # Downstream timeout
  curl -s http://localhost:${PORT}/documents/verify -X POST \\
    -H "Authorization: Bearer sk-live-demo" | jq

  # Partial batch failure (HTTP 207)
  curl -s http://localhost:${PORT}/messages/batch -X POST \\
    -H "Authorization: Bearer sk-live-demo" \\
    -H "Content-Type: application/json" \\
    -d '{"messages":[{"to":"+44700000001","body":"Hello"},{"to":"bad","body":"Hi"}]}' | jq

  # Rate limiting (send 11+ requests quickly)
  for i in $(seq 1 12); do
    curl -s http://localhost:${PORT}/webhooks -X POST \\
      -H "Authorization: Bearer sk-live-demo" \\
      -H "Content-Type: application/json" \\
      -d '{"url":"https://example.com/hook","events":["order.created"]}' | jq .error.code
  done
  `);
});
