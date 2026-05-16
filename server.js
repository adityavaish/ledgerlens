/**
 * Ledgerlens — Production server.
 * Serves the built static front-end and mounts the API proxy middlewares
 * that were previously embedded in webpack-dev-server.
 */
const express = require("express");
const fs = require("fs");
const http = require("http");
const https = require("https");
const path = require("path");

const { createOfficeSsoMiddleware } = require("./src/server/office-sso-middleware.js");
const { createCopilotMiddleware } = require("./src/server/copilot-proxy.js");
const { createStdioProxyMiddleware } = require("./src/server/mcp-stdio-proxy.js");
const { createKustoLocalMiddleware } = require("./src/server/kusto-local-proxy.js");
const { createMcpConfigDiscoveryMiddleware } = require("./src/server/mcp-config-discovery.js");

const app = express();
const PORT = process.env.PORT || 3002;

/**
 * Load the office-addin-dev-certs key/cert directly off disk so the server
 * can speak HTTPS. Excel only loads add-in manifests whose `SourceLocation`
 * is https://, so this is required for a successful sideload. Falls back
 * to HTTP for non-Excel callers (browser preview, `curl /health`).
 *
 * The cert files are laid down at ~/.office-addin-dev-certs/ by the
 * launcher's ensureCertificatesAreInstalled() call. We don't go back through
 * `office-addin-dev-certs.getHttpsServerOptions` because it's async — calling
 * it synchronously yields a Promise that https.createServer cheerfully
 * accepts as "options" but then has no key/cert, leading to silent TLS
 * handshake failures with no observable cert error.
 */
function tryGetHttpsOptions() {
  if (process.env.LEDGERLENS_FORCE_HTTP === "1") return null;
  const certsDir = path.join(process.env.USERPROFILE || process.env.HOME || ".", ".office-addin-dev-certs");
  const keyPath = path.join(certsDir, "localhost.key");
  const crtPath = path.join(certsDir, "localhost.crt");
  const caPath  = path.join(certsDir, "ca.crt");
  if (fs.existsSync(keyPath) && fs.existsSync(crtPath)) {
    return {
      key: fs.readFileSync(keyPath),
      cert: fs.readFileSync(crtPath),
      ca: fs.existsSync(caPath) ? fs.readFileSync(caPath) : undefined,
    };
  }
  return null;
}

// MSAL.js popup auth needs the page to be able to read `window.closed` on
// the popup it just opened. Modern browsers default to a strict COOP that
// blocks this — the symptom is a flood of "Cross-Origin-Opener-Policy
// policy would block the window.closed call" warnings and the popup never
// completing. `same-origin-allow-popups` keeps the page isolated from
// other top-level windows while permitting it to interact with windows it
// opened (i.e. the MSAL sign-in popup). COEP/CORP we leave alone.
app.use((_req, res, next) => {
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin-allow-popups");
  next();
});

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

// Manifest hosting — serves manifest.xml at a stable URL so admins can
// reference it from M365 Centralized Deployment, users can sideload via
// "Upload My Add-in" → URL in Office on the web, and CI can publish updates
// without re-distributing the file.
const MANIFEST_PATHS = ["/manifest.xml", "/manifest", "/ledgerlens.xml"];
app.get(MANIFEST_PATHS, (_req, res) => {
  const manifestPath = path.join(__dirname, "manifest.xml");
  fs.stat(manifestPath, (err, stat) => {
    if (err) {
      res.status(404).type("text/plain").send("manifest.xml not found");
      return;
    }
    res.setHeader("Content-Type", "application/xml; charset=utf-8");
    res.setHeader("Cache-Control", "no-cache, must-revalidate");
    res.setHeader("Last-Modified", stat.mtime.toUTCString());
    res.setHeader(
      "Content-Disposition",
      'inline; filename="ledgerlens-manifest.xml"'
    );
    fs.createReadStream(manifestPath).pipe(res);
  });
});

app.get("/api/runtime-config", (_req, res) => {
  res.status(200).json(getRuntimeConfig());
});

app.use(createOfficeSsoMiddleware());

// API proxy middlewares
app.use(createCopilotMiddleware());
app.use(createStdioProxyMiddleware());
app.use(createKustoLocalMiddleware());
app.use(createMcpConfigDiscoveryMiddleware());

// Serve built static assets
app.use(express.static(path.join(__dirname, "dist")));

// SPA fallback — serve taskpane.html for unmatched routes
app.get("*", (_req, res) => {
  res.sendFile(path.join(__dirname, "dist", "taskpane.html"));
});

const httpsOpts = tryGetHttpsOptions();
if (httpsOpts) {
  https.createServer(httpsOpts, app).listen(PORT, () => {
    console.log(`Ledgerlens server listening on https://localhost:${PORT}`);
  });
} else {
  http.createServer(app).listen(PORT, () => {
    console.log(`Ledgerlens server listening on http://localhost:${PORT} (HTTPS disabled — Office sideload will be unavailable)`);
  });
}
