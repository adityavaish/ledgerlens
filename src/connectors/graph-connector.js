/**
 * Ledgerlens — Microsoft Graph Connector.
 * Pulls data from OneDrive Excel files, Outlook, Planner, etc. via Graph API.
 */

import BaseConnector from "./base-connector.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";

export default class GraphConnector extends BaseConnector {
  constructor() {
    super({ id: "graph", name: "Microsoft 365", icon: "☁️" });
    this._token = null;
  }

  get requiredScopes() {
    return ["Files.Read.All", "User.Read"];
  }

  get configSchema() {
    return []; // No extra config — uses signed-in user's Graph
  }

  async connect(_config, authService) {
    this._token = await authService.getToken(this.requiredScopes);
    this._connected = true;
  }

  async disconnect() {
    this._token = null;
    this._connected = false;
  }

  /**
   * Query is a Graph API path, e.g.:
   *  "/me/drive/root:/Reports/Sales.xlsx:/workbook/worksheets/Sheet1/usedRange"
   */
  async fetchData(query) {
    const url = `${GRAPH_BASE}${query.startsWith("/") ? "" : "/"}${query}`;
    const res = await fetch(url, {
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!res.ok) throw new Error(`Graph fetch failed: ${res.status}`);
    const json = await res.json();

    // If it's an Excel range response
    if (json.values) {
      const [headers, ...rows] = json.values;
      return { headers, rows };
    }

    // Generic array response
    const arr = json.value || [json];
    if (arr.length === 0) return { headers: [], rows: [] };
    const headers = Object.keys(arr[0]).filter((k) => !k.startsWith("@"));
    const rows = arr.map((item) => headers.map((h) => item[h] ?? ""));
    return { headers, rows };
  }

  async describeData() {
    return `Microsoft 365 Graph connected. Provide a Graph API path as query.`;
  }
}
