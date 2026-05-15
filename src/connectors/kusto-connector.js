/**
 * Ledgerlens — Azure Data Explorer (Kusto) Connector.
 *
 * Talks to a local @mcp-apps/kusto-mcp-server spawned over stdio via the
 * generic MCP stdio bridge (`/api/mcp-stdio/*`). The server is launched with
 * `npx -y @mcp-apps/kusto-mcp-server`, so the package does not need to be
 * bundled in this app's `node_modules`.
 *
 * Auth: the MCP server uses ChainedTokenCredential server-side
 * (AzureCli → ...). We forward the signed-in user's Kusto access token on
 * every call as `X-Pinned-Token`; the stdio proxy writes it to a per-process
 * file, and our `az` shim returns it to `AzureCliCredential`. This makes
 * queries run with the user's RBAC instead of the App Service managed
 * identity.
 */

import BaseConnector from "./base-connector.js";
import mcpClient from "../services/mcp-client.js";

const MCP_SERVER_ID = "kusto-mcp";
const MCP_COMMAND = "npx";
const MCP_ARGS = ["-y", "@mcp-apps/kusto-mcp-server"];

export default class KustoConnector extends BaseConnector {
  constructor() {
    super({ id: "kusto", name: "Azure Data Explorer", icon: "📊" });
    this._clusterUrl = "";
    this._database = "";
    this._authService = null;
  }

  get requiredScopes() {
    return ["https://kusto.kusto.windows.net/user_impersonation"];
  }

  get configSchema() {
    return [
      { key: "clusterUrl", label: "Cluster URL", type: "url", required: true, placeholder: "https://mycluster.westus.kusto.windows.net" },
      { key: "database",   label: "Database",    type: "text", required: true, placeholder: "MyDatabase" },
    ];
  }

  async connect(config, authService) {
    const clusterUrl = (config.clusterUrl || "").trim().replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
    const database = (config.database || "").trim();
    if (!clusterUrl) throw new Error("Cluster URL is required.");
    if (!database)   throw new Error("Database is required.");
    if (!authService) throw new Error("Kusto connector requires the authentication service.");

    this._authService = authService;

    let session = mcpClient.getSession(MCP_SERVER_ID);
    if (!session) {
      session = await mcpClient.connectStdio(MCP_SERVER_ID, MCP_COMMAND, MCP_ARGS, { hidden: true });
    }

    // Smoke-test the connection by running a trivial query. We deliberately
    // use execute_query (not list_tables) because the kusto-mcp-server's
    // list_tables swallows errors and returns []; execute_query propagates
    // errors as "Error: ..." text we can detect. `print` runs against the
    // database without touching any tables, so a successful response proves
    // both auth and database-existence — without giving false positives when
    // RBAC lets the user list metadata but not query data.
    const probe = await this._callTool(session, "execute_query", {
      clusterUrl,
      database,
      query: "print _ledgerlens_probe = 1",
      maxRows: 1,
    });
    const probeText = extractText(probe);
    if (/^Error/i.test(probeText)) {
      throw new Error(probeText.replace(/^Error[^:]*:\s*/i, "").trim() || "Kusto connection failed.");
    }

    this._clusterUrl = clusterUrl;
    this._database = database;
    this._connected = true;
  }

  async disconnect() {
    this._clusterUrl = "";
    this._database = "";
    this._authService = null;
    this._connected = false;
    // We intentionally do not kill the shared MCP server process here — other
    // connector instances or future reconnects can reuse it. The taskpane is
    // responsible for tearing it down on full sign-out.
  }

  async fetchData(query) {
    const trimmed = (query || "").trim();
    if (!trimmed) throw new Error("Empty query.");

    const session = mcpClient.getSession(MCP_SERVER_ID);
    if (!session) throw new Error("Kusto MCP server is not running. Reconnect the connector.");

    if (/^\.show\s+tables$/i.test(trimmed) || /^list\s+tables$/i.test(trimmed)) {
      const result = await this._callTool(session, "list_tables", {
        clusterUrl: this._clusterUrl,
        database: this._database,
      });
      return parseListTables(extractText(result));
    }

    const result = await this._callTool(session, "execute_query", {
      clusterUrl: this._clusterUrl,
      database: this._database,
      query: trimmed,
    });

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

  /**
   * Call a tool on the kusto-mcp-server, refreshing the user's Kusto token
   * just-in-time and forwarding it via headers. If we can't acquire a user
   * token (e.g. sign-in isn't configured) we make the call unauthenticated
   * and let the server-side managed identity take over.
   */
  async _callTool(session, name, args) {
    let headers;
    try {
      const tok = await this._authService?.getKustoToken();
      if (tok && tok.accessToken) {
        headers = { "X-Pinned-Token": tok.accessToken };
        if (tok.expiresOn) headers["X-Pinned-Token-Expires"] = tok.expiresOn;
      }
    } catch {
      // fall through — server will use MI if pinned token isn't available
    }
    return session.callTool(name, args, headers ? { headers } : undefined);
  }

  async describeData() {
    return `Azure Data Explorer at ${this._clusterUrl} (database "${this._database}"). Queries run as the signed-in user via the local @mcp-apps/kusto-mcp-server (stdio).`;
  }
}

// ── Helpers ───────────────────────────────────────────────────────────────

function extractText(toolResult) {
  if (!toolResult || !Array.isArray(toolResult.content)) return "";
  return toolResult.content
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

function parseListTables(text) {
  const parsed = parseEmbeddedJson(text);
  let names = [];

  if (Array.isArray(parsed)) {
    names = parsed.map((row) => (typeof row === "string" ? row : row?.TableName || row?.name)).filter(Boolean);
  } else if (parsed && Array.isArray(parsed.data)) {
    names = parsed.data.map((row) => row?.TableName || row?.name || row?.[0]).filter(Boolean);
  } else if (typeof text === "string") {
    // Fallback: server may return a CSV-ish string.
    names = text
      .replace(/^Result:\s*/i, "")
      .split(/[\s,]+/)
      .map((s) => s.trim())
      .filter(Boolean);
  }

  if (names.length === 0) {
    return { headers: ["Table"], rows: [["No tables found"]] };
  }
  return { headers: ["Table"], rows: names.map((name) => [name]) };
}

function formatTabular(parsed) {
  if (!parsed || typeof parsed !== "object") {
    return { headers: ["Result"], rows: [["No data returned"]] };
  }

  const rawColumns = Array.isArray(parsed.columns) ? parsed.columns : [];
  let headers = rawColumns
    .map((col) => col && (col.name || col.ColumnName || col))
    .filter(Boolean);

  const data = Array.isArray(parsed.data) ? parsed.data : Array.isArray(parsed) ? parsed : [];

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
