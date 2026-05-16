/**
 * Pivot — SQL Database Connector.
 * Sends SQL-like natural language queries to a REST proxy endpoint.
 * For security, the add-in does NOT connect directly to databases.
 * Instead it talks to a lightweight API proxy that you deploy alongside your DB.
 *
 * Expected proxy contract:
 *   POST {baseUrl}/query
 *   Body: { "sql": "SELECT ..." }
 *   Response: { "columns": ["col1", ...], "rows": [[val, ...], ...] }
 */

import BaseConnector from "./base-connector.js";

export default class SqlConnector extends BaseConnector {
  constructor() {
    super({ id: "sql", name: "SQL Database", icon: "🗄️" });
    this._baseUrl = "";
    this._token = null;
  }

  get configSchema() {
    return [
      { key: "baseUrl", label: "SQL Proxy URL", type: "url", required: true, placeholder: "https://your-sql-proxy.azurewebsites.net" },
      { key: "scopes", label: "OAuth Scopes (optional)", type: "text", required: false, placeholder: "api://app-id/.default" },
      { key: "database", label: "Database Name", type: "text", required: false, placeholder: "SalesDB" },
    ];
  }

  async connect(config, authService) {
    this._baseUrl = config.baseUrl.replace(/\/+$/, "");
    this._database = config.database || "";
    if (config.scopes) {
      const scopes = config.scopes.split(",").map((s) => s.trim());
      this._token = await authService.getToken(scopes);
    }
    this._connected = true;
  }

  async disconnect() {
    this._token = null;
    this._connected = false;
  }

  async fetchData(query) {
    const headers = {
      "Content-Type": "application/json",
      Accept: "application/json",
    };
    if (this._token) headers["Authorization"] = `Bearer ${this._token}`;

    const body = { sql: query };
    if (this._database) body.database = this._database;

    const res = await fetch(`${this._baseUrl}/query`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    if (!res.ok) {
      const text = await res.text();
      throw new Error(`SQL query failed (${res.status}): ${text}`);
    }

    const json = await res.json();
    return {
      headers: json.columns || [],
      rows: json.rows || [],
    };
  }

  async describeData() {
    const db = this._database ? ` (${this._database})` : "";
    return `SQL Database${db} via proxy at ${this._baseUrl}. Provide a SQL query.`;
  }
}
