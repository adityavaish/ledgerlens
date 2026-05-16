/**
 * Pivot — SharePoint Connector.
 * Reads SharePoint lists via Microsoft Graph, authenticated with MSAL.
 */

import BaseConnector from "./base-connector.js";

const GRAPH_BASE = "https://graph.microsoft.com/v1.0";
const GRAPH_SCOPES = ["Sites.Read.All"];

export default class SharePointConnector extends BaseConnector {
  constructor() {
    super({ id: "sharepoint", name: "SharePoint", icon: "📋" });
    this._token = null;
    this._siteId = null;
  }

  get requiredScopes() {
    return GRAPH_SCOPES;
  }

  get configSchema() {
    return [
      { key: "siteUrl", label: "SharePoint Site URL", type: "url", required: true, placeholder: "https://contoso.sharepoint.com/sites/team" },
    ];
  }

  async connect(config, authService) {
    this._token = await authService.getToken(GRAPH_SCOPES);
    // Resolve site id from URL
    const hostname = new URL(config.siteUrl).hostname;
    const sitePath = new URL(config.siteUrl).pathname;
    const res = await fetch(`${GRAPH_BASE}/sites/${hostname}:${sitePath}`, {
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!res.ok) throw new Error(`Could not resolve SharePoint site: ${res.status}`);
    const site = await res.json();
    this._siteId = site.id;
    this._connected = true;
  }

  async disconnect() {
    this._token = null;
    this._siteId = null;
    this._connected = false;
  }

  async fetchData(listName) {
    const listsRes = await fetch(`${GRAPH_BASE}/sites/${this._siteId}/lists/${encodeURIComponent(listName)}/items?expand=fields`, {
      headers: { Authorization: `Bearer ${this._token}` },
    });
    if (!listsRes.ok) throw new Error(`Failed to fetch list "${listName}": ${listsRes.status}`);
    const data = await listsRes.json();
    const items = (data.value || []).map((i) => i.fields);
    if (items.length === 0) return { headers: [], rows: [] };
    const headers = Object.keys(items[0]).filter((k) => !k.startsWith("@"));
    const rows = items.map((item) => headers.map((h) => item[h] ?? ""));
    return { headers, rows };
  }

  async describeData() {
    return `SharePoint site connected. Provide a list name as query.`;
  }
}
