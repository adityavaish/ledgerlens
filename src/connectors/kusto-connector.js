/**
 * Pivot — Azure Data Explorer (Kusto) Connector.
 *
 * Posts to the local /api/kusto/* endpoints. The server runs on the user's
 * machine (started by `bin/pivot.js`) and uses azure-kusto-data's
 * `withUserPrompt` to authenticate the user via their default browser —
 * no Entra app registration, no admin consent, no managed identity.
 */

import BaseConnector from "./base-connector.js";

export default class KustoConnector extends BaseConnector {
  constructor() {
    super({ id: "kusto", name: "Azure Data Explorer", icon: "📊" });
    this._clusterUrl = "";
    this._database = "";
    this._databases = [];
  }

  get configSchema() {
    return [
      { key: "clusterUrl", label: "Cluster URL", type: "url", required: true, placeholder: "https://mycluster.westus.kusto.windows.net" },
      { key: "database",   label: "Database",    type: "text", required: true, placeholder: "MyDatabase" },
    ];
  }

  async connect(config) {
    const clusterUrl = (config.clusterUrl || "").trim().replace(/\/+$/, "").replace(/^http:\/\//i, "https://");
    const database = (config.database || "").trim();
    if (!clusterUrl) throw new Error("Cluster URL is required.");
    if (!database)   throw new Error("Database is required.");

    // POST /api/kusto/connect — first call will open the user's default
    // browser for sign-in (interactive). Subsequent calls reuse the cached
    // credential silently.
    const res = await fetch("/api/kusto/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterUrl }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Connection failed (${res.status})`);

    this._clusterUrl = clusterUrl;
    this._database = database;
    this._databases = data.databases || [];
    this._connected = true;
  }

  async disconnect() {
    this._clusterUrl = "";
    this._database = "";
    this._databases = [];
    this._connected = false;
  }

  async fetchData(query) {
    const trimmed = (query || "").trim();
    if (!trimmed) throw new Error("Empty query.");
    if (!this._database) throw new Error("No database set. Configure a database in connector settings.");

    if (/^\.show\s+databases$/i.test(trimmed) || /^list\s+databases$/i.test(trimmed)) {
      return this._formatDatabases();
    }

    const res = await fetch("/api/kusto/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterUrl: this._clusterUrl, database: this._database, query: trimmed }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || `Query failed (${res.status})`);
    return data;
  }

  _formatDatabases() {
    if (this._databases.length === 0) {
      return { headers: ["Database"], rows: [["No databases enumerable — supply the name in connector settings."]] };
    }
    return { headers: ["Database"], rows: this._databases.map((db) => [db]) };
  }

  async describeData() {
    const dbInfo = this._database ? `database "${this._database}"` : `${this._databases.length} databases available`;
    return `Azure Data Explorer at ${this._clusterUrl} (${dbInfo}). Queries run as the signed-in user via the local server's azure-kusto-data SDK.`;
  }
}