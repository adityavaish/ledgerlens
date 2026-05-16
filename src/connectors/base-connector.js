/**
 * Pivot — Base Connector.
 * All data-source connectors extend this class.
 * Provides the contract that the connector registry and AI engine rely on.
 */

export default class BaseConnector {
  /**
   * @param {object} opts
   * @param {string} opts.id    - Unique connector id (e.g. "rest", "sql")
   * @param {string} opts.name  - Human-readable label
   * @param {string} opts.icon  - SVG string or emoji for UI
   */
  constructor({ id, name, icon = "🔌" }) {
    this.id = id;
    this.name = name;
    this.icon = icon;
    this._connected = false;
  }

  /** Override: return the scopes/permissions this connector needs. */
  get requiredScopes() {
    return [];
  }

  /** Override: return a schema describing the config fields the user must fill. */
  get configSchema() {
    return [];
    // e.g. [{ key: "baseUrl", label: "Base URL", type: "text", required: true }]
  }

  /** Override: connect to the data source. Throw on failure. */
  async connect(_config, _authService) {
    this._connected = true;
  }

  /** Override: disconnect / clean up. */
  async disconnect() {
    this._connected = false;
  }

  get isConnected() {
    return this._connected;
  }

  /**
   * Override: execute a query against the data source.
   * @param {string} query - natural-language or structured query from the AI
   * @returns {Promise<{ headers: string[], rows: any[][] }>}
   */
  async fetchData(_query) {
    throw new Error(`fetchData() not implemented for connector "${this.id}"`);
  }

  /** Override: return a short description of available data for AI context. */
  async describeData() {
    return `Connector "${this.name}" is available.`;
  }
}
