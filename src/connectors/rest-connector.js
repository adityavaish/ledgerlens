/**
 * Pivot — REST API Connector.
 * Fetches data from any REST/JSON endpoint.
 * Auth token obtained via MSAL if scopes are provided.
 */

import BaseConnector from "./base-connector.js";

export default class RestConnector extends BaseConnector {
  constructor() {
    super({ id: "rest", name: "REST API", icon: "🌐" });
    this._baseUrl = "";
    this._token = null;
  }

  get configSchema() {
    return [
      { key: "baseUrl", label: "Base URL", type: "url", required: true, placeholder: "https://api.example.com" },
      { key: "scopes", label: "OAuth Scopes (comma-separated)", type: "text", required: false, placeholder: "api://app-id/.default" },
    ];
  }

  async connect(config, authService) {
    this._baseUrl = config.baseUrl.replace(/\/+$/, "");
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
    const url = new URL(query, this._baseUrl);
    const headers = { Accept: "application/json" };
    if (this._token) headers["Authorization"] = `Bearer ${this._token}`;

    const res = await fetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`REST fetch failed: ${res.status}`);
    const json = await res.json();
    return this._normalize(json);
  }

  /** Convert arbitrary JSON array into { headers, rows }. */
  _normalize(json) {
    const arr = Array.isArray(json) ? json : json.value || json.data || json.results || [json];
    if (arr.length === 0) return { headers: [], rows: [] };
    const headers = Object.keys(arr[0]);
    const rows = arr.map((item) => headers.map((h) => item[h] ?? ""));
    return { headers, rows };
  }

  async describeData() {
    return `REST API at ${this._baseUrl}. Provide an endpoint path as query.`;
  }
}
