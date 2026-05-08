const fs = require("fs");
const path = require("path");

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

function getCandidateConfigFiles() {
  const appData = process.env.APPDATA || "";
  const userProfile = process.env.USERPROFILE || process.env.HOME || "";

  return [
    { source: "vscode", filePath: path.join(appData, "Code", "User", "mcp.json") },
    { source: "claude", filePath: path.join(appData, "Claude", "claude_desktop_config.json") },
    { source: "claude", filePath: path.join(appData, "Claude", "config.json") },
    { source: "claude", filePath: path.join(userProfile, ".claude.json") },
    { source: "claude", filePath: path.join(userProfile, ".claude", "mcp.json") },
    { source: "claude", filePath: path.join(userProfile, ".config", "claude-desktop", "claude_desktop_config.json") },
  ];
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
    };
  }

  return null;
}

function discoverLocalMcpConfigs() {
  const discovered = [];

  for (const candidate of getCandidateConfigFiles()) {
    const payload = readJsonIfExists(candidate.filePath);
    if (!payload) {
      continue;
    }

    const servers = payload.servers || payload.mcpServers || {};
    for (const [id, config] of Object.entries(servers)) {
      const normalized = normalizeServer(candidate.source, candidate.filePath, id, config);
      if (normalized) {
        discovered.push(normalized);
      }
    }
  }

  return discovered;
}

function createMcpConfigDiscoveryMiddleware() {
  const routes = {
    "GET /api/mcp-config/discover": (_req, res) => {
      const servers = discoverLocalMcpConfigs();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ servers }));
    },
  };

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