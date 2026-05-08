/**
 * Ledgerlens — Kusto Proxy (server-side).
 * Runs inside webpack-dev-server. Handles Kusto authentication using
 * InteractiveBrowserCredential (opens browser for user auth, like the Kusto MCP server).
 * No app registration needed.
 *
 * Routes:
 *   POST /api/kusto/query   — Run a KQL query (body: { clusterUrl, database, query })
 *   POST /api/kusto/connect — Test connection + list databases (body: { clusterUrl })
 */

const KustoClient = require("azure-kusto-data").Client;
const KustoConnectionStringBuilder = require("azure-kusto-data").KustoConnectionStringBuilder;

let credential = null;
let kustoClients = new Map(); // clusterUrl -> KustoClient

function isManagementCommand(command) {
  return typeof command === "string" && command.trim().startsWith(".");
}

function formatKustoError(err, mode, command) {
  const detail = err.response?.data || err.message || String(err);
  const raw = typeof detail === "string" ? detail : JSON.stringify(detail);
  const compact = raw.slice(0, 300);
  const status = err.statusCode || err.response?.status || err.response?.statusCode || null;

  if (status === 403 || /status code 403/i.test(raw) || /forbidden/i.test(raw)) {
    if (mode === "mgmt") {
      return [
        "Kusto management command denied (403).",
        "The connector is authenticated, but this identity does not have permission to run Kusto management commands such as .show tables or .show external tables on this database.",
        `Command: ${command.trim().slice(0, 120)}`,
        "If you know a table name, try querying it directly instead of listing metadata. For external tables, use external_table('TableName').",
      ].join(" ");
    }

    return [
      "Kusto query denied (403).",
      "The connector is authenticated, but this identity does not have permission to read from the requested database object or run this query.",
      `Query: ${command.trim().slice(0, 120)}`,
    ].join(" ");
  }

  return mode === "mgmt"
    ? `Kusto management error: ${compact}`
    : `KQL query error: ${compact}`;
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString())); }
      catch (e) { reject(new Error("Invalid JSON body")); }
    });
    req.on("error", reject);
  });
}

function getUserKustoToken(req) {
  const header = req.headers?.["x-kusto-access-token"] || req.headers?.["X-Kusto-Access-Token"] || "";
  return typeof header === "string" ? header.trim() : "";
}

async function getCredential() {
  if (credential) return credential;

  const identity = await import("@azure/identity");

  // In a server/cloud environment (no desktop), use DefaultAzureCredential
  // which supports managed identity, Azure CLI, env vars, etc.
  // On a desktop dev machine, use InteractiveBrowserCredential with WAM broker.
  const isServer = !process.env.USERPROFILE && !process.env.HOME?.startsWith("/Users");

  if (isServer) {
    console.log("[Kusto Proxy] Server environment detected — using DefaultAzureCredential");
    credential = new identity.DefaultAzureCredential();
    return credential;
  }

  // Desktop: try WAM broker for interactive auth
  try {
    const { nativeBrokerPlugin } = await import("@azure/identity-broker");
    identity.useIdentityPlugin(nativeBrokerPlugin);
    console.log("[Kusto Proxy] WAM broker plugin loaded ✓");
    credential = new identity.InteractiveBrowserCredential({
      brokerOptions: {
        enabled: true,
        parentWindowHandle: new Uint8Array(0),
        useDefaultBrokerAccount: false,
        legacyEnableMsaPassthrough: true,
      },
    });
  } catch {
    console.log("[Kusto Proxy] WAM broker not available, falling back to InteractiveBrowserCredential");
    credential = new identity.InteractiveBrowserCredential();
  }

  return credential;
}

async function getKustoClient(clusterUrl, accessToken = "") {
  // Ensure HTTPS
  const url = clusterUrl.replace(/^http:\/\//i, "https://");

  if (accessToken) {
    const connectionString = KustoConnectionStringBuilder.withAccessToken(url, accessToken);
    return new KustoClient(connectionString);
  }

  if (kustoClients.has(url)) {
    return kustoClients.get(url);
  }

  const cred = await getCredential();

  // Trigger auth by getting a token first
  const scope = "https://kusto.kusto.windows.net/.default";
  console.log(`[Kusto Proxy] Authenticating for ${url}…`);
  await cred.getToken(scope);
  console.log("[Kusto Proxy] Authentication successful ✓");

  const connectionString = KustoConnectionStringBuilder.withTokenCredential(url, cred);
  const client = new KustoClient(connectionString);
  kustoClients.set(url, client);
  return client;
}

async function kustoQuery(clusterUrl, database, kql, accessToken = "") {
  const client = await getKustoClient(clusterUrl, accessToken);
  console.log(`[Kusto Proxy] Executing query on ${database}: ${kql.slice(0, 100)}…`);

  try {
    const response = await client.execute(database, kql);
    const primaryResults = response.primaryResults[0];

    if (!primaryResults) {
      return { headers: ["Result"], rows: [["No data returned"]] };
    }

    const result = primaryResults.toJSON();
    const headers = (result.columns || primaryResults.columns || []).map((c) => c.name || c.ColumnName || c);
    const rows = (result.data || []).map((row) => {
      if (Array.isArray(row)) return row;
      return headers.map((h) => row[h] ?? "");
    });

    return { headers, rows };
  } catch (err) {
    // Extract detailed Kusto error message for better debugging
    const detail = err.response?.data || err.message || String(err);
    console.error(`[Kusto Proxy] Query error detail:`, typeof detail === 'string' ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500));
    throw new Error(formatKustoError(err, "query", kql));
  }
}

async function kustoMgmt(clusterUrl, database, csl, accessToken = "") {
  const client = await getKustoClient(clusterUrl, accessToken);
  console.log(`[Kusto Proxy] Executing mgmt: ${csl.slice(0, 100)}…`);

  try {
    const response = await client.executeMgmt(database || "", csl);
    const primaryResults = response.primaryResults[0];

    if (!primaryResults) {
      return { headers: ["Result"], rows: [["No data returned"]] };
    }

    const result = primaryResults.toJSON();
    const headers = (result.columns || primaryResults.columns || []).map((c) => c.name || c.ColumnName || c);
    const rows = (result.data || []).map((row) => {
      if (Array.isArray(row)) return row;
      return headers.map((h) => row[h] ?? "");
    });

    return { headers, rows };
  } catch (err) {
    const detail = err.response?.data || err.message || String(err);
    console.error(`[Kusto Proxy] Mgmt error detail:`, typeof detail === "string" ? detail.slice(0, 500) : JSON.stringify(detail).slice(0, 500));
    throw new Error(formatKustoError(err, "mgmt", csl));
  }
}

function createKustoProxyMiddleware() {
  const routes = {
    "POST /api/kusto/connect": async (req, res) => {
      try {
        const { clusterUrl } = await parseBody(req);
        const accessToken = getUserKustoToken(req);
        if (!clusterUrl) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "clusterUrl is required" }));
          return;
        }

        const cleanUrl = clusterUrl.replace(/\/+$/, "").replace(/^http:\/\//i, "https://");

        // Test auth by listing databases (opens browser auth if first time)
  const result = await kustoMgmt(cleanUrl, "", ".show databases", accessToken);
        const databases = (result.rows || []).map((row) => {
          // Find DatabaseName column
          const idx = (result.headers || []).indexOf("DatabaseName");
          return idx >= 0 ? row[idx] : row[0];
        }).filter(Boolean);

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ connected: true, databases }));
      } catch (err) {
        console.error("[Kusto Proxy] Connect error:", err.message);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
    },

    "POST /api/kusto/query": async (req, res) => {
      try {
        const { clusterUrl, database, query } = await parseBody(req);
        const accessToken = getUserKustoToken(req);
        if (!clusterUrl || !database || !query) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "clusterUrl, database, and query are required" }));
          return;
        }

        const cleanUrl = clusterUrl.replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
        const result = isManagementCommand(query)
          ? await kustoMgmt(cleanUrl, database, query, accessToken)
          : await kustoQuery(cleanUrl, database, query, accessToken);

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(result));
      } catch (err) {
        console.error("[Kusto Proxy] Query error:", err.message);
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
    },
  };

  console.log("[Ledgerlens] Kusto proxy endpoints registered: /api/kusto/connect, /api/kusto/query");

  return function kustoProxy(req, res, next) {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (handler) {
      handler(req, res);
    } else {
      next();
    }
  };
}

module.exports = { createKustoProxyMiddleware };
