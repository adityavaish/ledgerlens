const fs = require("fs");
fs.writeFileSync("src/connectors/kusto-connector.js", `/**
 * Ledgerlens \u2014 Azure Data Explorer (Kusto) Connector.
 * Connects via server-side proxy (Azure CLI auth). No app registration needed.
 */

import BaseConnector from "./base-connector.js";

export default class KustoConnector extends BaseConnector {
  constructor() {
    super({ id: "kusto", name: "Azure Data Explorer", icon: "\uD83D\uDCCA" });
    this._clusterUrl = "";
    this._database = "";
    this._databases = [];
  }

  get configSchema() {
    return [
      { key: "clusterUrl", label: "Cluster URL", type: "url", required: true, placeholder: "https://mycluster.westus.kusto.windows.net" },
      { key: "database", label: "Database (optional)", type: "text", required: false, placeholder: "MyDatabase" },
    ];
  }

  async connect(config) {
    this._clusterUrl = (config.clusterUrl || "").replace(/\\/+$/, "");
    if (!this._clusterUrl) throw new Error("Cluster URL is required.");

    const res = await fetch("/api/kusto/connect", {
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
    this._connected = false;
  }

  async fetchData(query) {
    const trimmed = query.trim();
    if (/^\\.show\\s+databases$/i.test(trimmed)) {
      return this._formatDatabases();
    }

    const db = this._database;
    if (!db) throw new Error("No database set. Configure a database in connector settings.");

    const res = await fetch("/api/kusto/query", {
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
      ? "database \\"" + this._database + "\\""
      : this._databases.length + " databases available";
    return "Azure Data Explorer at " + this._clusterUrl + " (" + dbInfo + "). Auth via Azure CLI.";
  }
}
`);
console.log("Written kusto-connector.js");
