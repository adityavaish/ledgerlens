/**
 * Ledgerlens — MCP Client.
 * Implements the Model Context Protocol (MCP) client with support for:
 *   - Streamable HTTP transport (current spec)
 *   - Legacy SSE transport (older servers)
 *   - Auto-reconnection with exponential backoff
 *   - Tools, Resources, and Prompts discovery
 *
 * Protocol: JSON-RPC 2.0 over HTTP POST (with optional SSE streaming).
 * Spec: https://modelcontextprotocol.io/specification
 */

const MCP_VERSION = "2025-03-26";
const CLIENT_INFO = { name: "ledgerlens-excel-addin", version: "1.0.0" };
const MAX_RECONNECT_ATTEMPTS = 5;
const RECONNECT_BASE_DELAY_MS = 1000;

class McpClient {
  constructor() {
    /** @type {Map<string, McpSession>} server-id → session */
    this._sessions = new Map();
    /** @type {Map<string, {url: string, opts: object}>} saved configs for reconnection */
    this._configs = new Map();
    /** @type {((event: {type: string, serverId: string, detail?: any}) => void)|null} */
    this.onStatusChange = null;
  }

  /** List all registered server ids (excluding hidden / connector-owned ones). */
  get serverIds() {
    const ids = [];
    for (const [id, session] of this._sessions) {
      if (!session.hidden) ids.push(id);
    }
    return ids;
  }

  /** Get a session by server id. */
  getSession(serverId) {
    return this._sessions.get(serverId) || null;
  }

  /**
   * Connect to an MCP server.
   * @param {string} id        Unique identifier for this server
   * @param {string} url       The MCP server HTTP endpoint (e.g. http://localhost:3001/mcp)
   * @param {object} [opts]    Optional: { headers, apiKey, transport: "auto"|"streamable-http"|"sse" }
   * @returns {Promise<McpSession>}
   */
  async connect(id, url, opts = {}) {
    if (this._sessions.has(id)) {
      await this.disconnect(id);
    }

    this._configs.set(id, { url, opts });
    const session = new McpSession(id, url, opts);
    session._client = this;
    await session.initialize();
    this._sessions.set(id, session);
    this._emit("connected", id, { transport: "http", tools: session.tools.length, resources: session.resources.length, prompts: session.prompts.length });
    return session;
  }

  /**
   * Connect to a local MCP server via stdio transport.
   * The server process is spawned by the server-side proxy and communicated
   * with over stdin/stdout. The browser client talks to the proxy via HTTP.
   *
   * @param {string} id         Unique identifier for this server
   * @param {string} command    The command to spawn (e.g. "node", "python", "npx")
   * @param {string[]} [args]   Command arguments (e.g. ["my-mcp-server"])
   * @param {object}  [opts]    Optional: { env: {}, cwd: string, proxyBaseUrl: string }
   * @returns {Promise<StdioSession>}
   */
  async connectStdio(id, command, args = [], opts = {}) {
    if (this._sessions.has(id)) {
      await this.disconnect(id);
    }

    this._configs.set(id, { command, args, opts, transport: "stdio" });
    const session = new StdioSession(id, command, args, opts);
    session._client = this;
    await session.initialize();
    this._sessions.set(id, session);
    this._emit("connected", id, { transport: "stdio", tools: session.tools.length, resources: session.resources.length, prompts: session.prompts.length });
    return session;
  }

  /** Disconnect and remove a server session. */
  async disconnect(id) {
    const session = this._sessions.get(id);
    if (session) {
      session._reconnectEnabled = false;
      await session.close();
      this._sessions.delete(id);
    }
    this._configs.delete(id);
    this._emit("disconnected", id);
  }

  /** Disconnect all sessions. */
  async disconnectAll() {
    for (const id of this._sessions.keys()) {
      await this.disconnect(id);
    }
  }

  /**
   * List tools across all connected MCP servers.
   * Returns [{ serverId, tool }] where tool has name, description, inputSchema.
   * Sessions flagged `hidden` (e.g. connector-owned) are excluded so the AI
   * engine doesn't try to call tools whose arguments only the owning
   * connector knows.
   */
  getAllTools() {
    const result = [];
    for (const [serverId, session] of this._sessions) {
      if (session.hidden) continue;
      for (const tool of session.tools) {
        result.push({ serverId, tool });
      }
    }
    return result;
  }

  /**
   * Call a tool on a specific server.
   * @param {string} serverId
   * @param {string} toolName
   * @param {object} args
   * @returns {Promise<object>} The tool result content
   */
  async callTool(serverId, toolName, args = {}) {
    const session = this._sessions.get(serverId);
    if (!session) throw new Error(`MCP server "${serverId}" not connected.`);
    return session.callTool(toolName, args);
  }

  /**
   * List resources across all connected MCP servers (excluding hidden sessions).
   */
  getAllResources() {
    const result = [];
    for (const [serverId, session] of this._sessions) {
      if (session.hidden) continue;
      for (const resource of session.resources) {
        result.push({ serverId, resource });
      }
    }
    return result;
  }

  /**
   * Read a resource from a specific server.
   */
  async readResource(serverId, uri) {
    const session = this._sessions.get(serverId);
    if (!session) throw new Error(`MCP server "${serverId}" not connected.`);
    return session.readResource(uri);
  }

  /**
   * List prompts across all connected MCP servers (excluding hidden sessions).
   * Returns [{ serverId, prompt }] where prompt has name, description, arguments.
   */
  getAllPrompts() {
    const result = [];
    for (const [serverId, session] of this._sessions) {
      if (session.hidden) continue;
      for (const prompt of session.prompts) {
        result.push({ serverId, prompt });
      }
    }
    return result;
  }

  /**
   * Get a prompt from a specific server with arguments filled in.
   * @param {string} serverId
   * @param {string} promptName
   * @param {object} args
   * @returns {Promise<{messages: Array}>}
   */
  async getPrompt(serverId, promptName, args = {}) {
    const session = this._sessions.get(serverId);
    if (!session) throw new Error(`MCP server "${serverId}" not connected.`);
    return session.getPrompt(promptName, args);
  }

  /** Attempt reconnection for a dropped session. */
  async _reconnect(id) {
    const config = this._configs.get(id);
    if (!config) return;

    for (let attempt = 1; attempt <= MAX_RECONNECT_ATTEMPTS; attempt++) {
      const delay = RECONNECT_BASE_DELAY_MS * Math.pow(2, attempt - 1);
      this._emit("reconnecting", id, { attempt, maxAttempts: MAX_RECONNECT_ATTEMPTS, delay });
      await new Promise((r) => setTimeout(r, delay));

      try {
        let session;
        if (config.transport === "stdio") {
          session = new StdioSession(id, config.command, config.args, config.opts);
        } else {
          session = new McpSession(id, config.url, config.opts);
        }
        session._client = this;
        await session.initialize();
        this._sessions.set(id, session);
        this._emit("connected", id, { reconnected: true, attempt });
        return;
      } catch {
        // continue retrying
      }
    }

    this._configs.delete(id);
    this._emit("reconnect_failed", id);
  }

  _emit(type, serverId, detail) {
    if (this.onStatusChange) {
      try { this.onStatusChange({ type, serverId, detail }); } catch { /* ignore listener errors */ }
    }
  }
}


/**
 * Represents a single connection/session to one MCP server.
 * Supports both Streamable HTTP and legacy SSE transports.
 */
class McpSession {
  constructor(id, url, opts = {}) {
    this.id = id;
    this.url = url.replace(/\/+$/, "");
    this._headers = opts.headers || {};
    if (opts.apiKey) {
      this._headers["Authorization"] = `Bearer ${opts.apiKey}`;
    }
    this._transport = opts.transport || "auto"; // "auto" | "streamable-http" | "sse"
    this._sessionId = null;
    this._requestId = 0;
    this._sseEndpoint = null; // For legacy SSE: the endpoint returned by the SSE stream
    this._reconnectEnabled = true;
    /** @type {McpClient|null} back-reference for reconnection */
    this._client = null;

    /** @type {Array<{name: string, description: string, inputSchema: object}>} */
    this.tools = [];
    /** @type {Array<{uri: string, name: string, description: string, mimeType: string}>} */
    this.resources = [];
    /** @type {Array<{name: string, description: string, arguments: Array}>} */
    this.prompts = [];
    /** Server capabilities after initialize */
    this.capabilities = {};
    this.serverInfo = {};
  }

  /** Send a JSON-RPC request to the MCP server via Streamable HTTP. */
  async _rpc(method, params = {}) {
    // Route to legacy SSE transport if detected or forced
    if (this._transport === "sse" || this._sseEndpoint) {
      return this._rpcLegacy(method, params);
    }

    this._requestId++;
    const body = {
      jsonrpc: "2.0",
      id: this._requestId,
      method,
      params,
    };

    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...this._headers,
    };

    if (this._sessionId) {
      headers["Mcp-Session-Id"] = this._sessionId;
    }

    let res;
    try {
      res = await fetch(this.url, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      this._handleConnectionError(err);
      throw err;
    }

    // Capture session id from response
    const sessionId = res.headers.get("Mcp-Session-Id");
    if (sessionId) {
      this._sessionId = sessionId;
    }

    if (!res.ok) {
      // If server returns 405, try falling back to legacy SSE transport
      if (res.status === 405 && this._transport === "auto") {
        this._transport = "sse";
        return this._rpc(method, params);
      }
      const text = await res.text();
      throw new Error(`MCP request "${method}" failed (${res.status}): ${text}`);
    }

    const contentType = res.headers.get("Content-Type") || "";

    // Handle SSE streaming response
    if (contentType.includes("text/event-stream")) {
      return this._parseSSE(res);
    }

    // Standard JSON response
    const json = await res.json();
    if (json.error) {
      throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
    }
    return json.result;
  }

  /**
   * Legacy SSE transport: connect via GET for SSE stream, POST for messages.
   * Some older MCP servers use a GET endpoint that returns an SSE stream,
   * and include an "endpoint" event with the URL to POST messages to.
   */
  async _initLegacySSE() {
    return new Promise((resolve, reject) => {
      const headers = { ...this._headers };
      const eventSource = new EventSource(this.url);

      const timeout = setTimeout(() => {
        eventSource.close();
        reject(new Error("Legacy SSE connection timed out"));
      }, 15000);

      eventSource.addEventListener("endpoint", (event) => {
        clearTimeout(timeout);
        // The endpoint may be relative or absolute
        try {
          this._sseEndpoint = new URL(event.data, this.url).toString();
        } catch {
          this._sseEndpoint = event.data;
        }
        this._sseSource = eventSource;
        resolve();
      });

      eventSource.onerror = () => {
        clearTimeout(timeout);
        eventSource.close();
        reject(new Error("Legacy SSE connection failed"));
      };
    });
  }

  /** Send JSON-RPC via the legacy SSE POST endpoint. */
  async _rpcLegacy(method, params = {}) {
    if (!this._sseEndpoint) {
      await this._initLegacySSE();
    }

    this._requestId++;
    const body = {
      jsonrpc: "2.0",
      id: this._requestId,
      method,
      params,
    };

    const headers = {
      "Content-Type": "application/json",
      ...this._headers,
    };

    let res;
    try {
      res = await fetch(this._sseEndpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch (err) {
      this._handleConnectionError(err);
      throw err;
    }

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`MCP request "${method}" failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    if (json.error) {
      throw new Error(`MCP error [${json.error.code}]: ${json.error.message}`);
    }
    return json.result;
  }

  /** Parse an SSE response and return the final JSON-RPC result. */
  async _parseSSE(res) {
    const text = await res.text();
    const lines = text.split("\n");
    let lastData = null;

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        lastData = line.slice(6);
      }
    }

    if (lastData) {
      try {
        const parsed = JSON.parse(lastData);
        if (parsed.error) {
          throw new Error(`MCP error [${parsed.error.code}]: ${parsed.error.message}`);
        }
        return parsed.result !== undefined ? parsed.result : parsed;
      } catch (e) {
        if (e.message.startsWith("MCP error")) throw e;
        return lastData;
      }
    }

    return null;
  }

  /** Send JSON-RPC notification (no id, no response expected). */
  async _notify(method, params = {}) {
    const body = {
      jsonrpc: "2.0",
      method,
      params,
    };

    const endpoint = this._sseEndpoint || this.url;

    const headers = {
      "Content-Type": "application/json",
      ...this._headers,
    };

    if (this._sessionId) {
      headers["Mcp-Session-Id"] = this._sessionId;
    }

    try {
      await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
      });
    } catch {
      // Notifications are fire-and-forget
    }
  }

  /** Initialize the MCP session (handshake). */
  async initialize() {
    // For explicitly legacy SSE transport, establish SSE first
    if (this._transport === "sse") {
      await this._initLegacySSE();
    }

    const result = await this._rpc("initialize", {
      protocolVersion: MCP_VERSION,
      capabilities: {},
      clientInfo: CLIENT_INFO,
    });

    this.capabilities = result.capabilities || {};
    this.serverInfo = result.serverInfo || {};

    // Send initialized notification
    await this._notify("notifications/initialized");

    // Discover tools, resources, and prompts
    await this._discoverTools();
    await this._discoverResources();
    await this._discoverPrompts();
  }

  /** Discover available tools from the server. */
  async _discoverTools() {
    if (!this.capabilities.tools) {
      this.tools = [];
      return;
    }

    try {
      const result = await this._rpc("tools/list");
      this.tools = result.tools || [];
    } catch {
      this.tools = [];
    }
  }

  /** Discover available resources from the server. */
  async _discoverResources() {
    if (!this.capabilities.resources) {
      this.resources = [];
      return;
    }

    try {
      const result = await this._rpc("resources/list");
      this.resources = result.resources || [];
    } catch {
      this.resources = [];
    }
  }

  /** Discover available prompts from the server. */
  async _discoverPrompts() {
    if (!this.capabilities.prompts) {
      this.prompts = [];
      return;
    }

    try {
      const result = await this._rpc("prompts/list");
      this.prompts = result.prompts || [];
    } catch {
      this.prompts = [];
    }
  }

  /**
   * Call a tool on this server.
   * @param {string} name - Tool name
   * @param {object} args - Tool arguments
   * @returns {Promise<{content: Array}>} The tool result
   */
  async callTool(name, args = {}) {
    const result = await this._rpc("tools/call", { name, arguments: args });
    return result;
  }

  /**
   * Read a resource by URI.
   * @param {string} uri
   * @returns {Promise<{contents: Array}>}
   */
  async readResource(uri) {
    const result = await this._rpc("resources/read", { uri });
    return result;
  }

  /**
   * Get a prompt by name with arguments.
   * @param {string} name
   * @param {object} args
   * @returns {Promise<{messages: Array}>}
   */
  async getPrompt(name, args = {}) {
    const result = await this._rpc("prompts/get", { name, arguments: args });
    return result;
  }

  /** Refresh the list of tools (e.g. after server notifies a change). */
  async refreshTools() {
    await this._discoverTools();
  }

  /** Refresh the list of resources. */
  async refreshResources() {
    await this._discoverResources();
  }

  /** Refresh the list of prompts. */
  async refreshPrompts() {
    await this._discoverPrompts();
  }

  /** Handle connection errors — trigger auto-reconnection. */
  _handleConnectionError(_err) {
    if (!this._reconnectEnabled || !this._client) return;
    this._reconnectEnabled = false;
    this._client._sessions.delete(this.id);
    this._client._reconnect(this.id);
  }

  /** Close the session. */
  close() {
    this._reconnectEnabled = false;
    this._sessionId = null;
    this.tools = [];
    this.resources = [];
    this.prompts = [];
    if (this._sseSource) {
      try { this._sseSource.close(); } catch { /* ignore */ }
      this._sseSource = null;
    }
    this._sseEndpoint = null;
  }
}


// Singleton
const mcpClient = new McpClient();
export default mcpClient;
export { McpSession, StdioSession };


/**
 * Represents a session to a local MCP server via stdio transport.
 * All communication is proxied through the server-side mcp-stdio-proxy.
 */
class StdioSession {
  constructor(id, command, args = [], opts = {}) {
    this.id = id;
    this.command = command;
    this.args = args;
    this._proxyBaseUrl = opts.proxyBaseUrl || "";
    this._env = opts.env || {};
    this._cwd = opts.cwd || "";
    this._reconnectEnabled = true;
    this._client = null;
    this.transport = "stdio";
    // Sessions flagged hidden are owned by an internal subsystem (e.g. the
    // Kusto connector) and must not appear in the user-facing MCP server list
    // nor be advertised to the AI engine as callable tools.
    this.hidden = !!opts.hidden;

    /** @type {Array<{name: string, description: string, inputSchema: object}>} */
    this.tools = [];
    /** @type {Array<{uri: string, name: string, description: string, mimeType: string}>} */
    this.resources = [];
    /** @type {Array<{name: string, description: string, arguments: Array}>} */
    this.prompts = [];
    /** Server capabilities after initialize */
    this.capabilities = {};
    this.serverInfo = {};
  }

  /**
   * Initialize: spawn the process via the proxy and perform MCP handshake.
   * The proxy handles the initialize handshake and returns capabilities + discovered tools.
   */
  async initialize() {
    const res = await fetch(`${this._proxyBaseUrl}/api/mcp-stdio/spawn`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        id: this.id,
        command: this.command,
        args: this.args,
        env: this._env,
        cwd: this._cwd,
      }),
    });

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `Failed to spawn MCP stdio server (${res.status})`);
    }

    const data = await res.json();
    this.capabilities = data.capabilities || {};
    this.serverInfo = data.serverInfo || {};
    this.tools = data.tools || [];
    this.resources = data.resources || [];
    this.prompts = data.prompts || [];
  }

  /**
   * Send a JSON-RPC request through the stdio proxy.
   * @param {string} method
   * @param {object} params
   * @param {object} [opts]    Optional: { headers: {...} } extra HTTP headers
   * @returns {Promise<object>}
   */
  async _rpc(method, params = {}, opts = {}) {
    let res;
    try {
      res = await fetch(`${this._proxyBaseUrl}/api/mcp-stdio/rpc`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...(opts.headers || {}) },
        body: JSON.stringify({ id: this.id, method, params }),
      });
    } catch (err) {
      this._handleConnectionError(err);
      throw err;
    }

    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw new Error(data.error || `MCP stdio request "${method}" failed (${res.status})`);
    }

    const data = await res.json();
    return data.result;
  }

  /**
   * Call a tool on this server.
   * @param {string} name
   * @param {object} args
   * @param {object} [opts]  Optional: { headers: {...} } extra HTTP headers
   *                          (used by the Kusto connector to forward an
   *                          X-Pinned-Token so queries run as the user).
   */
  async callTool(name, args = {}, opts = {}) {
    return this._rpc("tools/call", { name, arguments: args }, opts);
  }

  /** Read a resource by URI. */
  async readResource(uri) {
    return this._rpc("resources/read", { uri });
  }

  /** Get a prompt by name with arguments. */
  async getPrompt(name, args = {}) {
    return this._rpc("prompts/get", { name, arguments: args });
  }

  /** Refresh tools from the server. */
  async refreshTools() {
    if (!this.capabilities.tools) return;
    try {
      const result = await this._rpc("tools/list");
      this.tools = result.tools || [];
    } catch { this.tools = []; }
  }

  /** Refresh resources from the server. */
  async refreshResources() {
    if (!this.capabilities.resources) return;
    try {
      const result = await this._rpc("resources/list");
      this.resources = result.resources || [];
    } catch { this.resources = []; }
  }

  /** Refresh prompts from the server. */
  async refreshPrompts() {
    if (!this.capabilities.prompts) return;
    try {
      const result = await this._rpc("prompts/list");
      this.prompts = result.prompts || [];
    } catch { this.prompts = []; }
  }

  /** Handle connection errors — trigger auto-reconnection. */
  _handleConnectionError(_err) {
    if (!this._reconnectEnabled || !this._client) return;
    this._reconnectEnabled = false;
    this._client._sessions.delete(this.id);
    this._client._reconnect(this.id);
  }

  /** Close the session and kill the server process. */
  async close() {
    this._reconnectEnabled = false;
    this.tools = [];
    this.resources = [];
    this.prompts = [];

    try {
      await fetch(`${this._proxyBaseUrl}/api/mcp-stdio/kill`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: this.id }),
      });
    } catch { /* ignore cleanup errors */ }
  }
}
