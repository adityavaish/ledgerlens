/**
 * Pivot — Connector Registry.
 * Central registry for all data-source connectors.
 * Supports runtime registration (pluggable architecture).
 */

class ConnectorRegistry {
  constructor() {
    /** @type {Map<string, import('./base-connector').default>} */
    this._connectors = new Map();
  }

  /** Register a connector instance. */
  register(connector) {
    if (!connector.id) throw new Error("Connector must have an id");
    this._connectors.set(connector.id, connector);
  }

  /** Unregister by id. */
  unregister(id) {
    const c = this._connectors.get(id);
    if (c?.isConnected) c.disconnect();
    this._connectors.delete(id);
  }

  /** Get connector by id. */
  get(id) {
    return this._connectors.get(id) || null;
  }

  /** List all registered connectors. */
  getAll() {
    return Array.from(this._connectors.values());
  }

  /** List ids of connected (active) connectors. */
  getActiveIds() {
    return this.getAll()
      .filter((c) => c.isConnected)
      .map((c) => c.id);
  }

  /** List connector names for AI context. */
  getNames() {
    return this.getAll().map((c) => ({ id: c.id, name: c.name }));
  }
}

const connectorRegistry = new ConnectorRegistry();
export default connectorRegistry;
