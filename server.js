/**
 * Ledgerlens — Production server.
 * Serves the built static front-end and mounts the API proxy middlewares
 * that were previously embedded in webpack-dev-server.
 */
const express = require("express");
const path = require("path");

const { createOfficeSsoMiddleware } = require("./src/server/office-sso-middleware.js");
const { createCopilotMiddleware } = require("./src/server/copilot-proxy.js");
const { createStdioProxyMiddleware } = require("./src/server/mcp-stdio-proxy.js");
const { createKustoProxyMiddleware } = require("./src/server/kusto-proxy.js");

const app = express();
const PORT = process.env.PORT || 3002;

function getRuntimeConfig() {
  const clientId = process.env.LEDGERLENS_CLIENT_ID || "";
  const appIdUri = process.env.LEDGERLENS_APP_ID_URI || (clientId ? `api://${clientId}` : "");
  return {
    clientId,
    tenantId: process.env.LEDGERLENS_TENANT_ID || "common",
    redirectUri: process.env.LEDGERLENS_REDIRECT_URI || `http://localhost:${PORT}/taskpane.html`,
    appIdUri,
    apiScope: appIdUri ? `${appIdUri}/access_as_user` : "",
    naaEnabled: process.env.LEDGERLENS_ENABLE_NAA === "true",
  };
}

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.get("/api/runtime-config", (_req, res) => {
  res.status(200).json(getRuntimeConfig());
});

app.use(createOfficeSsoMiddleware());

// API proxy middlewares
app.use(createCopilotMiddleware());
app.use(createStdioProxyMiddleware());
app.use(createKustoProxyMiddleware());

// Serve built static assets
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback — serve taskpane.html for unmatched routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "taskpane.html"));
});

app.listen(PORT, () => {
  console.log(`Ledgerlens server listening on port ${PORT}`);
});
