/**
 * Pivot — CSV / File Connector.
 * Parses CSV or TSV data from a URL or pasted text.
 */

import BaseConnector from "./base-connector.js";

export default class CsvConnector extends BaseConnector {
  constructor() {
    super({ id: "csv", name: "CSV / File", icon: "📄" });
  }

  get configSchema() {
    return [
      { key: "url", label: "CSV File URL (optional)", type: "url", required: false, placeholder: "https://example.com/data.csv" },
    ];
  }

  async connect(_config, _authService) {
    this._url = _config?.url || null;
    this._connected = true;
  }

  async fetchData(query) {
    let text = query;
    // If query looks like a URL, fetch it
    if (query.startsWith("http://") || query.startsWith("https://")) {
      const res = await fetch(query);
      if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
      text = await res.text();
    } else if (this._url) {
      const res = await fetch(this._url);
      if (!res.ok) throw new Error(`CSV fetch failed: ${res.status}`);
      text = await res.text();
    }
    return this._parse(text);
  }

  _parse(text) {
    const delimiter = text.includes("\t") ? "\t" : ",";
    const lines = text.trim().split(/\r?\n/);
    if (lines.length === 0) return { headers: [], rows: [] };
    const headers = lines[0].split(delimiter).map((h) => h.trim().replace(/^"|"$/g, ""));
    const rows = lines.slice(1).map((line) =>
      line.split(delimiter).map((cell) => {
        const trimmed = cell.trim().replace(/^"|"$/g, "");
        const num = Number(trimmed);
        return isNaN(num) ? trimmed : num;
      })
    );
    return { headers, rows };
  }

  async describeData() {
    return this._url
      ? `CSV file at ${this._url}. Provide a URL or raw CSV text as query.`
      : `CSV connector ready. Provide a URL or raw CSV text as query.`;
  }
}
