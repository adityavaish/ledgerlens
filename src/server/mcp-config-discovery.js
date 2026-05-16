const fs = require("fs");
const path = require("path");
const os = require("os");

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Catalog of known MCP-aware client config locations. Each entry is a
 * tagged file path; we read whichever ones exist and treat their
 * `servers` / `mcpServers` map as a list to import.
 *
 * Covers (Windows + macOS + Linux paths combined):
 *   - VS Code stable / Insiders   ("Code" / "Code - Insiders")
 *   - GitHub Copilot CLI          (~/.copilot/mcp-config.json, env CLI dir)
 *   - Claude Desktop              (claude_desktop_config.json across platforms)
 *   - Claude Code (CLI)           (~/.claude/mcp.json, ~/.claude.json)
 *   - Cursor                      (~/.cursor/mcp.json)
 *   - Windsurf                    (~/.codeium/windsurf/mcp_config.json)
 *   - Continue.dev                (~/.continue/config.json)
 *   - Roo Code / Cline / Zed      common defaults
 *
 * Users can plug in extra absolute paths via PIVOT_MCP_CONFIGS
 * (semicolon- or comma-separated) for anything not covered here.
 */
function getCandidateConfigFiles() {
  const home = os.homedir();
  const appData = process.env.APPDATA || path.join(home, "AppData", "Roaming");
  const localAppData = process.env.LOCALAPPDATA || path.join(home, "AppData", "Local");
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config");

  const list = [
    // VS Code (stable + Insiders) — `mcp.json` was added in 1.95+.
    { source: "vscode",          filePath: path.join(appData, "Code", "User", "mcp.json") },
    { source: "vscode",          filePath: path.join(home, "Library", "Application Support", "Code", "User", "mcp.json") },
    { source: "vscode",          filePath: path.join(xdgConfig, "Code", "User", "mcp.json") },
    { source: "vscode-insiders", filePath: path.join(appData, "Code - Insiders", "User", "mcp.json") },
    { source: "vscode-insiders", filePath: path.join(home, "Library", "Application Support", "Code - Insiders", "User", "mcp.json") },
    { source: "vscode-insiders", filePath: path.join(xdgConfig, "Code - Insiders", "User", "mcp.json") },

    // GitHub Copilot CLI (`copilot`) and gh-copilot extension.
    { source: "ghc",             filePath: path.join(home, ".copilot", "mcp-config.json") },
    { source: "ghc",             filePath: path.join(home, ".copilot", "config.json") },
    { source: "ghc",             filePath: path.join(localAppData, "GitHub Copilot CLI", "mcp-config.json") },
    { source: "ghc",             filePath: path.join(home, ".config", "gh-copilot", "mcp.json") },

    // Claude Desktop.
    { source: "claude-desktop",  filePath: path.join(appData, "Claude", "claude_desktop_config.json") },
    { source: "claude-desktop",  filePath: path.join(home, "Library", "Application Support", "Claude", "claude_desktop_config.json") },
    { source: "claude-desktop",  filePath: path.join(xdgConfig, "Claude", "claude_desktop_config.json") },

    // Claude Code (CLI).
    { source: "claude-code",     filePath: path.join(home, ".claude.json") },
    { source: "claude-code",     filePath: path.join(home, ".claude", "mcp.json") },
    { source: "claude-code",     filePath: path.join(home, ".claude", "settings.json") },

    // Cursor.
    { source: "cursor",          filePath: path.join(home, ".cursor", "mcp.json") },
    { source: "cursor",          filePath: path.join(appData, "Cursor", "User", "mcp.json") },

    // Windsurf / Codeium.
    { source: "windsurf",        filePath: path.join(home, ".codeium", "windsurf", "mcp_config.json") },
    { source: "windsurf",        filePath: path.join(home, ".windsurf", "mcp.json") },

    // Continue.dev.
    { source: "continue",        filePath: path.join(home, ".continue", "config.json") },

    // Roo Code / Cline / Zed (common defaults).
    { source: "roo",             filePath: path.join(home, ".roo", "mcp.json") },
    { source: "cline",           filePath: path.join(home, ".cline", "mcp.json") },
    { source: "zed",             filePath: path.join(xdgConfig, "zed", "settings.json") },
  ];

  // Allow operators / power users to point at extra config files without
  // needing a code change. Accept either ";" or "," as separators.
  const extra = String(process.env.PIVOT_MCP_CONFIGS || "")
    .split(/[;,]/)
    .map((s) => s.trim())
    .filter(Boolean);
  for (const p of extra) {
    list.push({ source: "custom", filePath: p });
  }

  return list;
}

function normalizeServer(source, filePath, id, config) {
  if (!config || typeof config !== "object") {
    return null;
  }

  const type = config.type || "";
  const args = Array.isArray(config.args) ? config.args : [];
  const env = config.env && typeof config.env === "object" ? config.env : {};
  const cwd = typeof config.cwd === "string" ? config.cwd : "";

  if (type === "stdio" || config.command) {
    return {
      id,
      source,
      sourcePath: filePath,
      transport: "stdio",
      command: config.command || "",
      args,
      cwd,
      env,
    };
  }

  if (config.url) {
    return {
      id,
      source,
      sourcePath: filePath,
      transport: type === "sse" ? "sse" : (type === "streamable-http" ? "streamable-http" : "auto"),
      url: config.url,
      headers: config.headers && typeof config.headers === "object" ? config.headers : {},
    };
  }

  return null;
}

function discoverLocalMcpConfigs() {
  const discovered = [];
  const seenIds = new Set();

  for (const candidate of getCandidateConfigFiles()) {
    const payload = readJsonIfExists(candidate.filePath);
    if (!payload) {
      continue;
    }

    // The two common schemas — VS Code-style (`servers`) and Claude-style
    // (`mcpServers`) — are both flat id→config maps. Zed nests them under
    // `context_servers`; Continue under `experimental.modelContextProtocolServers`.
    const servers =
      payload.servers ||
      payload.mcpServers ||
      payload.context_servers ||
      (payload.experimental && payload.experimental.modelContextProtocolServers) ||
      {};

    for (const [rawId, config] of Object.entries(servers)) {
      const normalized = normalizeServer(candidate.source, candidate.filePath, rawId, config);
      if (!normalized) continue;
      // Disambiguate when the same logical server is declared in multiple
      // clients — prefix with source so the user can tell them apart.
      const dedupKey = `${candidate.source}::${rawId}`;
      if (seenIds.has(dedupKey)) continue;
      seenIds.add(dedupKey);
      discovered.push(normalized);
    }
  }

  return discovered;
}

function createMcpConfigDiscoveryMiddleware() {
  const routes = {
    "GET /api/mcp-config/discover": (_req, res) => {
      const servers = discoverLocalMcpConfigs();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ servers, scanned: getCandidateConfigFiles().map((c) => c.filePath) }));
    },
  };

  console.log("[Pivot] MCP config discovery endpoint registered: /api/mcp-config/discover");

  return function mcpConfigDiscovery(req, res, next) {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (handler) {
      handler(req, res);
    } else {
      next();
    }
  };
}

module.exports = { createMcpConfigDiscoveryMiddleware, discoverLocalMcpConfigs };