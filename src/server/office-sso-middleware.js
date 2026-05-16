const PROTECTED_PATHS = new Set([
  "/api/chat",
  "/api/chat-stream",
  "/api/configure",
  "/api/kusto/connect",
  "/api/kusto/query",
  "/api/reset",
  "/api/status",
]);

let joseModulePromise = null;
let jwksCache = new Map();

function getNaaConfig() {
  const clientId = process.env.PIVOT_CLIENT_ID || "";
  const appIdUri = process.env.PIVOT_APP_ID_URI || (clientId ? `api://${clientId}` : "");
  return {
    enabled: process.env.PIVOT_ENABLE_NAA === "true",
    clientId,
    tenantId: process.env.PIVOT_TENANT_ID || "",
    appIdUri,
  };
}

function getPath(req) {
  if (req.path) return req.path;
  return (req.url || "").split("?")[0];
}

function writeJson(res, statusCode, body) {
  if (typeof res.status === "function" && typeof res.json === "function") {
    res.status(statusCode).json(body);
    return;
  }

  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

async function loadJose() {
  if (!joseModulePromise) {
    joseModulePromise = import("jose");
  }
  return joseModulePromise;
}

async function getJwks(tenantId) {
  if (!jwksCache.has(tenantId)) {
    const { createRemoteJWKSet } = await loadJose();
    jwksCache.set(tenantId, createRemoteJWKSet(new URL(`https://login.microsoftonline.com/${tenantId}/discovery/v2.0/keys`)));
  }
  return jwksCache.get(tenantId);
}

function getBearerToken(req) {
  const header = req.headers?.authorization || req.headers?.Authorization || "";
  if (!header.toLowerCase().startsWith("bearer ")) {
    return "";
  }
  return header.slice(7).trim();
}

async function validateToken(token, config) {
  const { jwtVerify } = await loadJose();
  const jwks = await getJwks(config.tenantId);
  return jwtVerify(token, jwks, {
    audience: [config.appIdUri, config.clientId],
    issuer: [
      `https://login.microsoftonline.com/${config.tenantId}/v2.0`,
      `https://sts.windows.net/${config.tenantId}/`,
    ],
  });
}

function createOfficeSsoMiddleware() {
  return async function officeSsoMiddleware(req, res, next) {
    const config = getNaaConfig();
    if (!config.enabled || !PROTECTED_PATHS.has(getPath(req))) {
      next();
      return;
    }

    if (!config.clientId || !config.tenantId || !config.appIdUri) {
      writeJson(res, 503, {
        error: "naa_not_configured",
        message: "NAA is enabled, but the server is missing PIVOT_CLIENT_ID, PIVOT_TENANT_ID, or PIVOT_APP_ID_URI.",
      });
      return;
    }

    const token = getBearerToken(req);
    if (!token) {
      writeJson(res, 401, {
        error: "missing_bearer_token",
        message: "This endpoint requires a Nested App Authentication bearer token.",
      });
      return;
    }

    try {
      const { payload } = await validateToken(token, config);
      req.user = {
        id: payload.oid || payload.sub || "",
        name: payload.name || "",
        email: payload.preferred_username || payload.upn || payload.email || "",
        claims: payload,
      };
      next();
    } catch (_err) {
      writeJson(res, 401, {
        error: "invalid_bearer_token",
        message: "The Office SSO bearer token is invalid or expired.",
      });
    }
  };
}

module.exports = { createOfficeSsoMiddleware };