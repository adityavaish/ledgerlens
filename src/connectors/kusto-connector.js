/**
 * Ledgerlens — Azure Data Explorer (Kusto) Connector.
 * Connects via server-side proxy using the signed-in user's Entra token.
 */

import BaseConnector from "./base-connector.js";

export default class KustoConnector extends BaseConnector {
  constructor() {
    super({ id: "kusto", name: "Azure Data Explorer", icon: "📊" });
    this._clusterUrl = "";
    this._database = "";
    this._databases = [];
    this._authService = null;
  }

  get requiredScopes() {
    return ["https://kusto.kusto.windows.net/user_impersonation"];
  }

  get configSchema() {
    return [
      { key: "clusterUrl", label: "Cluster URL", type: "url", required: true, placeholder: "https://mycluster.westus.kusto.windows.net" },
      { key: "database", label: "Database (optional)", type: "text", required: false, placeholder: "MyDatabase" },
    ];
  }

  async connect(config, authService) {
    this._clusterUrl = (config.clusterUrl || "").replace(/\/+$/, "");
    if (!this._clusterUrl) throw new Error("Cluster URL is required.");
    this._authService = authService;

    if (!this._authService?.fetchKustoApi) {
      throw new Error("Kusto connector requires the authentication service.");
    }

    const res = await this._authService.fetchKustoApi("/api/kusto/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterUrl: this._clusterUrl }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Connection failed");

    this._databases = data.databases || [];
    this._database = config.database || "";
    this._connected = true;
  }

  async disconnect() {
    this._databases = [];
    this._authService = null;
    this._connected = false;
  }

  async fetchData(query) {
    const trimmed = query.trim();
    if (/^\.show\s+databases$/i.test(trimmed)) {
      return this._formatDatabases();
    }

    const db = this._database;
    if (!db) throw new Error("No database set. Configure a database in connector settings.");

    if (!this._authService?.fetchKustoApi) {
      throw new Error("Kusto connector is missing the signed-in user context. Reconnect the connector.");
    }

    const res = await this._authService.fetchKustoApi("/api/kusto/query", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clusterUrl: this._clusterUrl, database: db, query: trimmed }),
    });

    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Query failed");
    return data;
  }

  _formatDatabases() {
    if (this._databases.length === 0) {
      return { headers: ["Database"], rows: [["No databases found"]] };
    }
    return { headers: ["Database"], rows: this._databases.map((db) => [db]) };
  }

  async describeData() {
    const dbInfo = this._database
      ? "database \"" + this._database + "\""
      : this._databases.length + " databases available";
    return "Azure Data Explorer at " + this._clusterUrl + " (" + dbInfo + "). Queries run with the signed-in user's identity.";
  }
}
