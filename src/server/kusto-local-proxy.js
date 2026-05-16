/**
 * Pivot — Local Kusto proxy.
 *
 * Designed for the local-runner scenario: the Node server runs on the
 * user's machine, so it can drive azure-kusto-data's `withUserPrompt` flow
 * end-to-end. InteractiveBrowserCredential (used under the hood) launches
 * the user's default browser, listens on a random http://localhost:<port>,
 * and exchanges the auth code for a Kusto token — all with Azure CLI's
 * pre-admin-consented public-client app id (`04b07795-…`), so no Entra app
 * registration of our own is required.
 *
 * The connection string + cached token credential are kept warm per-cluster
 * for the lifetime of the server process, so repeated queries don't re-pop
 * a browser window after the initial sign-in.
 *
 * Routes (mounted before static):
 *   POST /api/kusto/connect   body: { clusterUrl, database? } → { connected, databases }
 *   POST /api/kusto/query     body: { clusterUrl, database, query, maxRows? } → { headers, rows }
 */

const { KustoConnectionStringBuilder, Client: KustoClient } = require("azure-kusto-data");

const KUSTO_SCOPE = "https://kusto.kusto.windows.net/.default";

/** @type {Map<string, KustoClient>} clusterUrl → cached client */
const clientCache = new Map();

function sanitizeClusterUrl(input) {
  if (!input) return "";
  return String(input).trim().replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
}

function pickLoopbackHostname() {
  // InteractiveBrowserCredential listens on http://localhost:<port> by
  // default; explicitly setting `redirectUri` lets us be deliberate, but
  // letting it pick is fine — Azure CLI's app id allows any localhost port.
  return undefined;
}

async function getKustoClient(clusterUrl) {
  const cached = clientCache.get(clusterUrl);
  if (cached) return cached;

  const kcsb = KustoConnectionStringBuilder.withUserPrompt(clusterUrl, {
    redirectUri: pickLoopbackHostname(),
    // No clientId override → uses Azure CLI's pre-consented public-client id
    // (`04b07795-8ddb-461a-bbee-02f9e1bf7b46`). Same app az login uses.
    tenantId: process.env.AZURE_TENANT_ID || process.env.PIVOT_TENANT_ID,
    additionallyAllowedTenants: ["*"],
  });

  const client = new KustoClient(kcsb);
  clientCache.set(clusterUrl, client);
  return client;
}

async function listDatabases(clusterUrl) {
  // `.show databases` is a management command — runs against the empty
  // database name (cluster-level management endpoint).
  const client = await getKustoClient(clusterUrl);
  try {
    const response = await client.executeMgmt("", ".show databases | project DatabaseName");
    const table = response.primaryResults?.[0];
    if (!table) return [];
    const json = table.toJSON ? table.toJSON() : table;
    const rows = (json.data || json.rows || []);
    return rows
      .map((r) => (Array.isArray(r) ? r[0] : (r.DatabaseName || r.databaseName)))
      .filter(Boolean);
  } catch (err) {
    // Some clusters disallow management commands for end users; we don't
    // fail the connect on this — the user can supply the database manually.
    console.warn("[kusto] listDatabases failed:", err.message || err);
    return [];
  }
}

async function runQuery(clusterUrl, database, query, maxRows) {
  const client = await getKustoClient(clusterUrl);
  const trimmed = String(query || "").trim();
  if (!trimmed) throw new Error("Empty query");

  const looksLikeMgmt = trimmed.startsWith(".");
  const response = looksLikeMgmt
    ? await client.executeMgmt(database, trimmed)
    : await client.execute(database, trimmed);

  const table = response.primaryResults?.[0];
  if (!table) {
    return { headers: ["Result"], rows: [["No data returned"]] };
  }

  const json = typeof table.toJSON === "function" ? table.toJSON() : table;
  const cols = Array.isArray(json.columns) ? json.columns : [];
  let headers = cols.map((c) => (c && (c.name || c.ColumnName)) || "").filter(Boolean);
  const data = Array.isArray(json.data) ? json.data : Array.isArray(json.rows) ? json.rows : [];

  if (headers.length === 0 && data.length > 0 && typeof data[0] === "object" && !Array.isArray(data[0])) {
    headers = Object.keys(data[0]);
  }

  const limited = typeof maxRows === "number" && maxRows > 0 ? data.slice(0, maxRows) : data;
  const rows = limited.map((row) => {
    if (Array.isArray(row)) return row;
    if (row && typeof row === "object") return headers.map((h) => (row[h] !== undefined ? row[h] : ""));
    return [row];
  });

  if (headers.length === 0 && rows.length === 0) {
    return { headers: ["Result"], rows: [["No data returned"]] };
  }
  return { headers, rows };
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (c) => {
      raw += c;
      if (raw.length > 5_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try { resolve(raw ? JSON.parse(raw) : {}); } catch (err) { reject(err); }
    });
    req.on("error", reject);
  });
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function createKustoLocalMiddleware() {
  const routes = {
    "POST /api/kusto/connect": async (req, res) => {
      try {
        const body = await parseBody(req);
        const clusterUrl = sanitizeClusterUrl(body.clusterUrl);
        if (!clusterUrl) {
          sendJson(res, 400, { error: "clusterUrl is required" });
          return;
        }
        // Force-prime the credential — this is what triggers the very first
        // browser sign-in popup. We do it here (not lazily on first query)
        // so the user knows up-front whether auth works.
        const client = await getKustoClient(clusterUrl);
        try {
          await client.aadHelper?.refreshAuth?.();
        } catch { /* best-effort */ }

        const databases = await listDatabases(clusterUrl);
        sendJson(res, 200, { connected: true, databases });
      } catch (err) {
        console.error("[kusto] connect error:", err.message || err);
        sendJson(res, 500, { error: (err.message || String(err)) });
      }
    },

    "POST /api/kusto/query": async (req, res) => {
      try {
        const body = await parseBody(req);
        const clusterUrl = sanitizeClusterUrl(body.clusterUrl);
        const database = (body.database || "").trim();
        const query = (body.query || "").trim();
        const maxRows = typeof body.maxRows === "number" ? body.maxRows : undefined;

        if (!clusterUrl || !database || !query) {
          sendJson(res, 400, { error: "clusterUrl, database, and query are required" });
          return;
        }

        const result = await runQuery(clusterUrl, database, query, maxRows);
        sendJson(res, 200, result);
      } catch (err) {
        console.error("[kusto] query error:", err.message || err);
        sendJson(res, 500, { error: (err.message || String(err)) });
      }
    },
  };

  console.log("[Pivot] Local Kusto endpoints registered: /api/kusto/connect, /api/kusto/query");

  return function kustoLocalProxy(req, res, next) {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (handler) {
      handler(req, res).catch((err) => {
        console.error("[kusto] unhandled:", err);
        sendJson(res, 500, { error: err.message || "Internal error" });
      });
    } else {
      next();
    }
  };
}

module.exports = { createKustoLocalMiddleware, KUSTO_SCOPE };
