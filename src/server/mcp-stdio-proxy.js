/**
 * Ledgerlens — MCP Stdio Proxy.
 * Runs server-side inside webpack-dev-server.
 *
 * Spawns local MCP servers as child processes (stdio transport),
 * bridges JSON-RPC messages between HTTP endpoints and stdin/stdout,
 * and exposes REST routes for the browser-based McpClient to use.
 *
 * Routes:
 *   POST /api/mcp-stdio/spawn     — Start a local MCP server process
 *   POST /api/mcp-stdio/rpc/:id   — Send a JSON-RPC request to a running server
 *   POST /api/mcp-stdio/kill/:id  — Stop a running server process
 *   GET  /api/mcp-stdio/list      — List active stdio server processes
 */

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/** @type {Map<string, StdioProcess>} id → process wrapper */
const processes = new Map();

function getPathEntries(env) {
  const key = Object.keys(env).find((name) => name.toLowerCase() === "path") || "PATH";
  return String(env[key] || "").split(path.delimiter).filter(Boolean);
}

function resolveCommand(command, env) {
  if (process.platform !== "win32") {
    return command;
  }

  if (!command || command.includes("\\") || command.includes("/") || path.extname(command)) {
    return command;
  }

  const pathEntries = getPathEntries(env);
  const extensions = [".cmd", ".exe", ".bat", ".ps1", ""];

  for (const entry of pathEntries) {
    for (const extension of extensions) {
      const candidate = path.join(entry, `${command}${extension}`);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return command;
}

function requiresShell(commandPath) {
  if (process.platform !== "win32") {
    return false;
  }

  const ext = path.extname(commandPath || "").toLowerCase();
  return ext === ".cmd" || ext === ".bat";
}

function quoteForCmd(value) {
  const text = String(value ?? "");
  if (text.length === 0) {
    return '""';
  }
  if (!/[\s"]/u.test(text)) {
    return text;
  }
  return `"${text.replace(/"/g, '""')}"`;
}

function getSpawnSpec(commandPath, args) {
  const baseName = path.basename(commandPath || "").toLowerCase();
  if (process.platform === "win32" && ["npx", "npx.cmd", "npx.ps1"].includes(baseName)) {
    const nodeDir = path.dirname(process.execPath);
    const npxCli = path.join(nodeDir, "node_modules", "npm", "bin", "npx-cli.js");
    if (fs.existsSync(npxCli)) {
      return {
        command: process.execPath,
        args: [npxCli, ...args],
        shell: false,
      };
    }
  }

  if (!requiresShell(commandPath)) {
    return {
      command: commandPath,
      args,
      shell: false,
    };
  }

  const comspec = process.env.ComSpec || "cmd.exe";
  const commandLine = [quoteForCmd(commandPath), ...args.map((arg) => quoteForCmd(arg))].join(" ");
  return {
    command: comspec,
    args: ["/d", "/s", "/c", commandLine],
    shell: false,
  };
}

class StdioProcess {
  constructor(id, command, args, options) {
    this.id = id;
    this.command = command;
    this.args = args;
    this._requestId = 0;
    this._pending = new Map();
    this._buffer = "";
    this._alive = false;

    const env = { ...process.env, ...(options.env || {}) };
    const cwd = options.cwd || process.cwd();
    const resolvedCommand = resolveCommand(command, env);
    const spawnSpec = getSpawnSpec(resolvedCommand, args);
    this.command = resolvedCommand;

    // Validate command — only allow executables, not shell scripts
    this._child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      shell: spawnSpec.shell,
      windowsHide: true,
    });

    this._alive = true;

    this._child.stdout.on("data", (chunk) => this._onData(chunk));
    this._child.stderr.on("data", (chunk) => {
      // Log stderr for debugging but don't process as JSON-RPC
      const text = chunk.toString().trim();
      if (text) console.error(`[MCP stdio:${id}] stderr:`, text);
    });
    this._child.on("error", (err) => {
      console.error(`[MCP stdio:${id}] process error:`, err.message);
      this._alive = false;
      this._rejectAll(new Error(`MCP process error: ${err.message}`));
    });
    this._child.on("close", (code) => {
      console.log(`[MCP stdio:${id}] process exited with code ${code}`);
      this._alive = false;
      this._rejectAll(new Error(`MCP process exited (code ${code})`));
    });
  }

  get alive() {
    return this._alive;
  }

  /**
   * Send a JSON-RPC request and wait for the response.
   * @param {string} method
   * @param {object} params
   * @param {number} timeout  Timeout in ms (default 30s)
   * @returns {Promise<object>} The JSON-RPC result
   */
  sendRequest(method, params = {}, timeout = 30000) {
    return new Promise((resolve, reject) => {
      if (!this._alive) {
        reject(new Error(`MCP stdio process "${this.id}" is not running`));
        return;
      }

      this._requestId++;
      const id = this._requestId;

      const message = JSON.stringify({
        jsonrpc: "2.0",
        id,
        method,
        params,
      });

      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`MCP stdio request "${method}" timed out after ${timeout}ms`));
      }, timeout);

      this._pending.set(id, { resolve, reject, timer });

      this._child.stdin.write(message + "\n", (err) => {
        if (err) {
          clearTimeout(timer);
          this._pending.delete(id);
          reject(new Error(`Failed to write to MCP process stdin: ${err.message}`));
        }
      });
    });
  }

  /**
   * Send a JSON-RPC notification (no response expected).
   */
  sendNotification(method, params = {}) {
    if (!this._alive) return;

    const message = JSON.stringify({
      jsonrpc: "2.0",
      method,
      params,
    });

    this._child.stdin.write(message + "\n", () => {});
  }

  /** Parse incoming stdout data as newline-delimited JSON-RPC messages. */
  _onData(chunk) {
    this._buffer += chunk.toString();

    // Process complete lines
    let newlineIdx;
    while ((newlineIdx = this._buffer.indexOf("\n")) !== -1) {
      const line = this._buffer.slice(0, newlineIdx).trim();
      this._buffer = this._buffer.slice(newlineIdx + 1);

      if (!line) continue;

      try {
        const msg = JSON.parse(line);
        this._handleMessage(msg);
      } catch {
        // Not valid JSON — might be a log line, skip
      }
    }
  }

  _handleMessage(msg) {
    // Response to a request we sent
    if (msg.id !== undefined && msg.id !== null && this._pending.has(msg.id)) {
      const { resolve, reject, timer } = this._pending.get(msg.id);
      clearTimeout(timer);
      this._pending.delete(msg.id);

      if (msg.error) {
        reject(new Error(`MCP error [${msg.error.code}]: ${msg.error.message}`));
      } else {
        resolve(msg.result);
      }
      return;
    }

    // Server-initiated notification — log for now
    if (!msg.id && msg.method) {
      console.log(`[MCP stdio:${this.id}] notification:`, msg.method);
    }
  }

  _rejectAll(err) {
    for (const [id, entry] of this._pending) {
      clearTimeout(entry.timer);
      entry.reject(err);
    }
    this._pending.clear();
  }

  kill() {
    this._alive = false;
    this._rejectAll(new Error("Process killed"));
    try {
      this._child.stdin.end();
      this._child.kill("SIGTERM");
    } catch { /* ignore */ }
  }
}


// ── Body parser helper ──────────────────────────────────────────────────

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}


// ── Middleware ───────────────────────────────────────────────────────────

function createStdioProxyMiddleware() {
  const routes = {
    /**
     * POST /api/mcp-stdio/spawn
     * Body: { id, command, args?: [], env?: {}, cwd?: string }
     * Spawns a child process and performs MCP initialize handshake.
     * Returns: { id, serverInfo, capabilities, tools, resources, prompts }
     */
    "POST /api/mcp-stdio/spawn": async (req, res) => {
      try {
        const body = await parseBody(req);
        const { id, command, args, env, cwd } = body;

        if (!id || !command) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing required fields: id, command" }));
          return;
        }

        // Validate id format — alphanumeric, dashes, underscores only
        if (!/^[a-zA-Z0-9_-]+$/.test(id)) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Invalid id format. Use alphanumeric, dashes, underscores only." }));
          return;
        }

        // Kill existing process with same id
        if (processes.has(id)) {
          processes.get(id).kill();
          processes.delete(id);
        }

        const proc = new StdioProcess(id, command, args || [], { env, cwd });
        processes.set(id, proc);

        // Perform MCP initialize handshake. Use a longer timeout (90s)
        // because some stdio servers do package-fetch / cold-start work on
        // first invocation (e.g. `npx` resolving + extracting a package).
        const initResult = await proc.sendRequest("initialize", {
          protocolVersion: "2025-03-26",
          capabilities: {},
          clientInfo: { name: "ledgerlens-excel-addin", version: "1.0.0" },
        }, 90000);

        proc.sendNotification("notifications/initialized");

        const capabilities = initResult.capabilities || {};
        const serverInfo = initResult.serverInfo || {};

        // Discover tools, resources, prompts
        let tools = [];
        let resources = [];
        let prompts = [];

        if (capabilities.tools) {
          try {
            const r = await proc.sendRequest("tools/list");
            tools = r.tools || [];
          } catch { /* ignore */ }
        }
        if (capabilities.resources) {
          try {
            const r = await proc.sendRequest("resources/list");
            resources = r.resources || [];
          } catch { /* ignore */ }
        }
        if (capabilities.prompts) {
          try {
            const r = await proc.sendRequest("prompts/list");
            prompts = r.prompts || [];
          } catch { /* ignore */ }
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ id, serverInfo, capabilities, tools, resources, prompts }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: `Failed to spawn MCP server: ${err.message}` }));
      }
    },

    /**
     * POST /api/mcp-stdio/rpc/:id
     * Body: { method, params? }
     * Forwards a JSON-RPC call to the stdio process.
     * Returns: the JSON-RPC result.
     */
    "POST /api/mcp-stdio/rpc": async (req, res) => {
      try {
        const body = await parseBody(req);
        const { id, method, params } = body;

        if (!id || !method) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: "Missing required fields: id, method" }));
          return;
        }

        const proc = processes.get(id);
        if (!proc || !proc.alive) {
          res.statusCode = 404;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ error: `MCP stdio process "${id}" not found or not running` }));
          return;
        }

        const result = await proc.sendRequest(method, params || {});
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ result }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
    },

    /**
     * POST /api/mcp-stdio/kill
     * Body: { id }
     * Stops a running stdio MCP server process.
     */
    "POST /api/mcp-stdio/kill": async (req, res) => {
      try {
        const body = await parseBody(req);
        const { id } = body;

        const proc = processes.get(id);
        if (proc) {
          proc.kill();
          processes.delete(id);
        }

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ error: err.message }));
      }
    },

    /**
     * GET /api/mcp-stdio/list
     * Returns list of active stdio MCP server processes.
     */
    "GET /api/mcp-stdio/list": (_req, res) => {
      const list = [];
      for (const [id, proc] of processes) {
        list.push({
          id,
          command: proc.command,
          args: proc.args,
          alive: proc.alive,
        });
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ servers: list }));
    },
  };

  console.log("[Ledgerlens] MCP stdio proxy endpoints registered: /api/mcp-stdio/*");

  return function mcpStdioProxy(req, res, next) {
    // Match exact routes or routes with a path parameter pattern
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (handler) {
      handler(req, res);
    } else {
      next();
    }
  };
}

// Clean up all child processes on exit
process.on("exit", () => {
  for (const proc of processes.values()) {
    try { proc.kill(); } catch { /* ignore */ }
  }
});

module.exports = { createStdioProxyMiddleware, StdioProcess };
