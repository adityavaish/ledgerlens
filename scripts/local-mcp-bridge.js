const express = require("express");

const { createStdioProxyMiddleware } = require("../src/server/mcp-stdio-proxy.js");
const { createMcpConfigDiscoveryMiddleware } = require("../src/server/mcp-config-discovery.js");

const app = express();
const port = Number(process.env.LEDGERLENS_LOCAL_MCP_PORT || 3011);

app.use((req, res, next) => {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");

  if (req.method === "OPTIONS") {
    res.status(204).end();
    return;
  }

  next();
});

app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true });
});

app.use(createMcpConfigDiscoveryMiddleware());
app.use(createStdioProxyMiddleware());

app.listen(port, "127.0.0.1", () => {
  console.log(`Ledgerlens local MCP bridge listening on http://127.0.0.1:${port}`);
});