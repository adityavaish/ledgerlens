/**
 * Ledgerlens — Kusto Proxy (MCP-backed).
 *
 * Spawns the @mcp-apps/kusto-mcp-server as a long-running child process and
 * brokers JSON-RPC over stdio. Express routes /api/kusto/connect and
 * /api/kusto/query are translated into MCP `tools/call` requests so the
 * Kusto data path goes through the canonical MCP server end-to-end.
 *
 * Auth: the MCP server uses ChainedTokenCredential (AzureCli → AzDev →
 * VSCode → DeviceCode). On a developer machine this picks up `az login`.
 * Inside the App Service container, scripts/az-imds-shim.js is installed at
 * /usr/local/bin/az so `AzureCliCredential` transparently uses the user-
 * assigned managed identity via IMDS.
 */

const { spawn } = require("child_process");
const path = require("path");
const fs = require("fs");

const MCP_PROTOCOL_VERSION = "2024-11-05";
const RESPONSE_TIMEOUT_MS = 120_000;
const SPAWN_TIMEOUT_MS = 30_000;

let mcpProcess = null;
let nextRequestId = 1;
let stdoutBuffer = "";
const pendingRequests = new Map();
let initializePromise = null;

function resolveMcpEntry() {
  // Prefer the installed package's actual entrypoint to avoid PATH issues
  // (especially on Windows where npm shims are .cmd files).
  const pkgRoot = path.join(__dirname, "..", "..", "node_modules", "@mcp-apps", "kusto-mcp-server");
  const entry = path.join(pkgRoot, "dist", "index.js");
  if (!fs.existsSync(entry)) {
    throw new Error(
      `Kusto MCP server entrypoint not found at ${entry}. Run 'npm install' to fetch @mcp-apps/kusto-mcp-server.`
    );
  }
  return entry;
}

function processStdoutChunk(chunk) {
  stdoutBuffer += chunk.toString("utf8");

  let newlineIndex;
  while ((newlineIndex = stdoutBuffer.indexOf("\n")) >= 0) {
    const line = stdoutBuffer.slice(0, newlineIndex).trim();
    stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1);

    if (!line) continue;

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      // MCP server may emit non-JSON banner messages on stdout; ignore.
      continue;
    }

    if (message.id !== undefined && pendingRequests.has(message.id)) {
      const { resolve, reject, timer } = pendingRequests.get(message.id);
      pendingRequests.delete(message.id);
      clearTimeout(timer);
      if (message.error) {
        reject(new Error(message.error.message || "MCP error"));
      } else {
        resolve(message.result);
      }
    }
  }
}

function handleProcessExit(code, signal) {
  console.error(`[Kusto MCP] server process exited (code=${code}, signal=${signal})`);
  for (const [, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error("Kusto MCP server process exited"));
  }
  pendingRequests.clear();
  mcpProcess = null;
  initializePromise = null;
}

function spawnMcpServer() {
  if (mcpProcess) return mcpProcess;

  const entry = resolveMcpEntry();
  console.log(`[Kusto MCP] Spawning server: node ${entry}`);

  const child = spawn(process.execPath, [entry], {
    cwd: path.dirname(entry),
    env: { ...process.env },
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });

  child.stdout.on("data", processStdoutChunk);
  child.stderr.on("data", (chunk) => {
    const text = chunk.toString("utf8").trim();
    if (text) console.error("[Kusto MCP][stderr]", text);
  });
  child.on("exit", handleProcessExit);
  child.on("error", (err) => {
    console.error("[Kusto MCP] spawn error:", err);
    handleProcessExit(-1, null);
  });

  mcpProcess = child;
  return child;
}

function sendRpc(method, params) {
  const child = spawnMcpServer();
  const id = nextRequestId++;
  const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n";

  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error(`Kusto MCP request '${method}' timed out after ${RESPONSE_TIMEOUT_MS}ms`));
    }, RESPONSE_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });

    if (!child.stdin.writable) {
      pendingRequests.delete(id);
      clearTimeout(timer);
      reject(new Error("Kusto MCP server stdin is not writable"));
      return;
    }
    child.stdin.write(payload);
  });
}

function sendNotification(method, params) {
  const child = spawnMcpServer();
  const payload = JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n";
  if (child.stdin.writable) {
    child.stdin.write(payload);
  }
}

async function ensureInitialized() {
  if (initializePromise) return initializePromise;

  initializePromise = (async () => {
    const result = await sendRpc("initialize", {
      protocolVersion: MCP_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: { name: "ledgerlens-kusto-bridge", version: "1.0.0" },
    });
    sendNotification("notifications/initialized", {});
    return result;
  })().catch((err) => {
    initializePromise = null;
    throw err;
  });

  // Race against a spawn-level timeout so a stuck server never blocks forever.
  return Promise.race([
    initializePromise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error("Kusto MCP server failed to initialize")), SPAWN_TIMEOUT_MS)
    ),
  ]);
}

async function callTool(name, args) {
  await ensureInitialized();
  const result = await sendRpc("tools/call", { name, arguments: args });
  return result;
}

function extractText(result) {
  if (!result || !Array.isArray(result.content)) return "";
  return result.content
    .filter((part) => part && part.type === "text" && typeof part.text === "string")
    .map((part) => part.text)
    .join("\n");
}

function parseEmbeddedJson(text) {
  if (!text) return null;
  const trimmed = text.replace(/^Query results:\s*/i, "").replace(/^Result:\s*/i, "").trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

function formatTabular(parsed) {
  // The MCP server returns the raw response of azure-kusto-data which is
  // shaped like { data: [...], columns?: [...] } (a primary result table).
  if (!parsed || typeof parsed !== "object") {
    return { headers: ["Result"], rows: [["No data returned"]] };
  }

  const rawColumns = Array.isArray(parsed.columns) ? parsed.columns : [];
  let headers = rawColumns
    .map((col) => col && (col.name || col.ColumnName || col))
    .filter(Boolean);

  const data = Array.isArray(parsed.data) ? parsed.data : [];

  if (headers.length === 0 && data.length > 0 && typeof data[0] === "object" && !Array.isArray(data[0])) {
    headers = Object.keys(data[0]);
  }

  const rows = data.map((row) => {
    if (Array.isArray(row)) return row;
    if (row && typeof row === "object") {
      return headers.map((h) => (row[h] !== undefined ? row[h] : ""));
    }
    return [row];
  });

  if (headers.length === 0 && rows.length === 0) {
    return { headers: ["Result"], rows: [["No data returned"]] };
  }

  return { headers, rows };
}

async function listDatabases(clusterUrl) {
  // The MCP server has no dedicated list-databases tool. `.show databases` is
  // a management command that Kusto accepts via the query path; it is not on
  // the MCP server's forbidden list. We pipe through summarize so the trailing
  // `| take N` injected by execute_query is syntactically valid.
  const result = await callTool("execute_query", {
    clusterUrl,
    database: "",
    query: ".show databases | project DatabaseName | summarize by DatabaseName",
    maxRows: 1000,
  });

  const parsed = parseEmbeddedJson(extractText(result));
  if (!parsed || !Array.isArray(parsed.data)) return [];

  return parsed.data
    .map((row) => row && (row.DatabaseName || row[0] || row.databaseName))
    .filter(Boolean);
}

async function runQuery(clusterUrl, database, query, maxRows) {
  const args = {
    clusterUrl,
    database,
    query,
    ...(typeof maxRows === "number" ? { maxRows } : {}),
  };

  const result = await callTool("execute_query", args);
  const text = extractText(result);

  if (/^Error/i.test(text)) {
    throw new Error(text);
  }

  const parsed = parseEmbeddedJson(text);
  if (!parsed) {
    return { headers: ["Result"], rows: [[text || "No data returned"]] };
  }

  return formatTabular(parsed);
}

async function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 5_000_000) reject(new Error("Request body too large"));
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch (err) {
        reject(err);
      }
    });
    req.on("error", reject);
  });
}

function sanitizeClusterUrl(input) {
  if (!input) return "";
  return String(input).trim().replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
}

function sendJson(res, status, body) {
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}

function createKustoProxyMiddleware() {
  const routes = {
    "POST /api/kusto/connect": async (req, res) => {
      try {
        const body = await parseBody(req);
        const clusterUrl = sanitizeClusterUrl(body.clusterUrl);
        if (!clusterUrl) {
          sendJson(res, 400, { error: "clusterUrl is required" });
          return;
        }

        let databases = [];
        try {
          databases = await listDatabases(clusterUrl);
        } catch (err) {
          // If listing databases fails (e.g. cluster denies management
          // commands for this principal) we still consider the connection
          // up — the user can supply the database name manually.
          console.warn("[Kusto MCP] listDatabases failed:", err.message);
        }

        sendJson(res, 200, { connected: true, databases });
      } catch (err) {
        console.error("[Kusto MCP] connect error:", err.message);
        sendJson(res, 500, { error: err.message });
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
        console.error("[Kusto MCP] query error:", err.message);
        sendJson(res, 500, { error: err.message });
      }
    },
  };

  console.log(
    "[Ledgerlens] Kusto MCP bridge endpoints registered: /api/kusto/connect, /api/kusto/query"
  );

  return function kustoProxy(req, res, next) {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (handler) {
      handler(req, res).catch((err) => {
        console.error("[Kusto MCP] unhandled error:", err);
        sendJson(res, 500, { error: err.message || "Internal error" });
      });
    } else {
      next();
    }
  };
}

function shutdown() {
  if (mcpProcess) {
    try {
      mcpProcess.kill();
    } catch {
      /* ignore */
    }
    mcpProcess = null;
  }
}

process.once("SIGINT", shutdown);
process.once("SIGTERM", shutdown);

module.exports = { createKustoProxyMiddleware };
