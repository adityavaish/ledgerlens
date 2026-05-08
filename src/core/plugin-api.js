/**
 * Ledgerlens — Plugin API.
 * Public extensibility surface for third-party integrations.
 *
 * Usage (from a script loaded after Ledgerlens):
 *
 *   // Register a custom connector
 *   Ledgerlens.registerConnector(new MyCustomConnector());
 *
 *   // Register a custom action handler
 *   Ledgerlens.registerAction("my_action", async (params) => { ... });
 *
 *   // Execute a command programmatically
 *   const result = await Ledgerlens.execute("Generate a table of products");
 *
 *   // Access services
 *   const token = await Ledgerlens.auth.getToken(["User.Read"]);
 */

import aiEngine from "../core/ai-engine.js";
import aiService from "../services/ai-service.js";
import authService from "../services/auth.js";
import connectorRegistry from "../connectors/connector-registry.js";
import excelOps from "../core/excel-ops.js";
import mcpClient from "../services/mcp-client.js";
import BaseConnector from "../connectors/base-connector.js";

const _customActions = new Map();

const PivotAPI = {
  /**
   * Register a custom data-source connector.
   * Must extend BaseConnector (or at minimum have id, name, connect, fetchData).
   */
  registerConnector(connector) {
    if (!connector.id || !connector.name) {
      throw new Error("Connector must have id and name properties.");
    }
    connectorRegistry.register(connector);
  },

  /** Unregister a connector by id. */
  unregisterConnector(id) {
    connectorRegistry.unregister(id);
  },

  /** List all registered connectors. */
  getConnectors() {
    return connectorRegistry.getNames();
  },

  /**
   * Register a custom action handler.
   * When the AI returns this action name, your handler will be called.
   * @param {string} name - action name (e.g. "my_custom_action")
   * @param {(params: object) => Promise<void>} handler
   */
  registerAction(name, handler) {
    if (typeof handler !== "function") throw new Error("Handler must be a function.");
    _customActions.set(name, handler);
  },

  /** Execute a natural-language command programmatically. */
  async execute(command) {
    return aiEngine.execute(command);
  },

  /** Get command history. */
  getHistory() {
    return aiEngine.history;
  },

  /** Configure the AI service endpoint / model / key. */
  configureAI(opts) {
    aiService.configure(opts);
  },

  /** Direct access to auth service for token acquisition. */
  auth: authService,

  /** Direct access to Excel operations. */
  excel: excelOps,

  /** The base connector class for extending. */
  BaseConnector,

  /**
   * MCP server management.
   * Connect to any MCP server to extend Ledgerlens with external tools.
   */
  mcp: {
    /** Connect to an MCP server. Returns the session with discovered tools. */
    async connect(id, url, opts) {
      return mcpClient.connect(id, url, opts);
    },
    /** Disconnect from an MCP server. */
    async disconnect(id) {
      return mcpClient.disconnect(id);
    },
    /** List all connected server IDs. */
    getServerIds() {
      return mcpClient.serverIds;
    },
    /** Get all available tools across all connected MCP servers. */
    getTools() {
      return mcpClient.getAllTools();
    },
    /** Call a tool on a specific MCP server. */
    async callTool(serverId, toolName, args) {
      return mcpClient.callTool(serverId, toolName, args);
    },
    /** Get all available resources across all connected MCP servers. */
    getResources() {
      return mcpClient.getAllResources();
    },
    /** Read a resource from a specific MCP server. */
    async readResource(serverId, uri) {
      return mcpClient.readResource(serverId, uri);
    },
    /** Get all available prompts across all connected MCP servers. */
    getPrompts() {
      return mcpClient.getAllPrompts();
    },
    /** Get a prompt from a specific MCP server with arguments. */
    async getPrompt(serverId, promptName, args) {
      return mcpClient.getPrompt(serverId, promptName, args);
    },
  },
};

/**
 * Look up custom action handlers from the plugin registry.
 * Called by the AI engine when it encounters an unknown action.
 */
export function getCustomAction(name) {
  return _customActions.get(name) || null;
}

// Expose on window for external scripts
if (typeof window !== "undefined") {
  window.Ledgerlens = PivotAPI;
}

export default PivotAPI;
