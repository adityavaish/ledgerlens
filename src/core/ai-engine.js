/**
 * Ledgerlens — AI Engine.
 * Orchestrates: gather context → call AI → execute action → respond.
 * This is the brain that connects the UI, AI service, connectors, and Excel ops.
 */

import aiService from "../services/ai-service.js";
import excelOps from "./excel-ops.js";
import connectorRegistry from "../connectors/connector-registry.js";
import mcpClient from "../services/mcp-client.js";
import { getCustomAction } from "./plugin-api.js";

class AIEngine {
  constructor() {
    this._history = [];
  }

  get history() {
    return this._history;
  }

  /**
   * Process a natural-language command from the user.
   * Runs an agent loop: the AI can issue gather_data actions to collect
   * information before producing a final terminal action.
   * Returns { success, message } for the UI to display.
   * @param {string} userCommand
   * @param {function} [onThinking] - callback for thinking progress steps
   */
  async execute(userCommand, onThinking) {
    const MAX_ITERATIONS = 6;
    const entry = { command: userCommand, timestamp: Date.now(), result: null };

    try {
      // 1. Gather spreadsheet context
      const context = await excelOps.getContext();
      context.connectorNames = connectorRegistry.getNames();
      context.mcpTools = mcpClient.getAllTools().map(({ serverId, tool }) => ({
        serverId,
        name: tool.name,
        description: tool.description,
        inputSchema: tool.inputSchema,
      }));
      context.mcpPrompts = mcpClient.getAllPrompts().map(({ serverId, prompt }) => ({
        serverId,
        name: prompt.name,
        description: prompt.description,
        arguments: prompt.arguments,
      }));

      // 2. Agent loop — allows multi-step data gathering before final action
      let prompt = userCommand;
      let action = null;

      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        action = await aiService.interpret(prompt, iteration === 0 ? context : {}, onThinking);

        // gather_data is an intermediate step — fetch data and feed it back
        if (action.action === "gather_data") {
          if (onThinking) onThinking(`Gathering: ${action.params?.query?.slice(0, 60) || "data"}…`);
          const gatherResult = await this._handleGatherData(action.params || {});

          if (gatherResult.error) {
            // Feed error back so AI can try a different approach
            prompt = `The gather_data query "${action.params?.query}" failed with error: "${gatherResult.error}". Try a different approach. Original request: "${userCommand}"`;
          } else {
            // Feed results back so AI can continue reasoning
            prompt = [
              `Here are the results from your gather_data query (${action.params?.query}):`,
              `Columns: ${gatherResult.headers.join(", ")}`,
              `Rows: ${gatherResult.totalRows}`,
              `Data: ${JSON.stringify(gatherResult.data).slice(0, 30000)}`,
              ``,
              `Now continue with the original request: "${userCommand}"`,
              `If you have enough information, provide your final response. You can use "explain" with a detailed markdown message, "query_and_display" to show results, or any other terminal action.`,
            ].join("\n");
          }
          continue; // loop again
        }

        // Any other action is terminal — break the loop
        break;
      }

      // 3. Execute the terminal action
      const dispatchError = await this._dispatchSafe(action);

      // 4. If there was an error, send it back to AI for retry
      if (dispatchError) {
        if (onThinking) onThinking(`Retrying: ${dispatchError.slice(0, 80)}…`);
        const retryCommand = `The previous action failed with error: "${dispatchError}". Please try a different approach. Original request: "${userCommand}"`;
        const retryAction = await aiService.interpret(retryCommand, context, onThinking);
        await this._dispatch(retryAction);
        entry.result = { success: true, action: retryAction.action, message: retryAction.message };
      } else {
        entry.result = { success: true, action: action.action, message: action.message };
      }

      this._history.push(entry);
      return entry.result;
    } catch (err) {
      entry.result = { success: false, message: err.message };
      this._history.push(entry);
      return entry.result;
    }
  }

  /** Dispatch with error capture instead of throwing */
  async _dispatchSafe(action) {
    try {
      await this._dispatch(action);
      return null;
    } catch (err) {
      return err.message;
    }
  }

  async _dispatch(action) {
    const p = action.params || {};
    switch (action.action) {
      case "generate_data":
        await excelOps.writeData(p.startCell || "A1", p.headers, p.rows);
        break;
      case "update_data":
        await excelOps.updateRange(p.range, p.values);
        break;
      case "create_table":
        await excelOps.createTable(p.range, p.name, p.hasHeaders !== false);
        break;
      case "update_table":
        await excelOps.updateTable(p.name, p);
        break;
      case "create_chart":
        await excelOps.createChart(p.type, p.dataRange, p.title);
        break;
      case "update_chart":
        await excelOps.updateChart(p.name, p.updates || p);
        break;
      case "create_pivot":
        await excelOps.createPivot(p.sourceRange, p.rows, p.columns, p.values);
        break;
      case "format_range":
        await excelOps.formatRange(p.range, p.format || {});
        break;
      case "conditional_format":
        await excelOps.conditionalFormat(p.range, p.rule, p.values, p.format || {});
        break;
      case "insert_formula":
        await excelOps.insertFormula(p.cell, p.formula);
        break;
      case "fill_formulas":
        await excelOps.fillFormulas(p.startCell, p.formula, p.fillDown);
        break;
      case "sort_data":
        await excelOps.sortRange(p.range, p.column, p.ascending !== false);
        break;
      case "filter_data":
        await excelOps.filterRange(p.range, p.column, p.criteria);
        break;
      case "clear_filters":
        await excelOps.clearFilters(p.range);
        break;
      case "merge_cells":
        await excelOps.mergeCells(p.range);
        break;
      case "unmerge_cells":
        await excelOps.unmergeCells(p.range);
        break;
      case "add_sheet":
        await excelOps.addSheet(p.name || "New Sheet");
        break;
      case "rename_sheet":
        await excelOps.renameSheet(p.oldName, p.newName);
        break;
      case "delete_sheet":
        await excelOps.deleteSheet(p.name);
        break;
      case "delete_range":
        await excelOps.deleteRange(p.range);
        break;
      case "freeze_panes":
        await excelOps.freezePanes(p.row || 0, p.column || 0);
        break;
      case "name_range":
        await excelOps.nameRange(p.range, p.name);
        break;
      case "protect_sheet":
        await excelOps.protectSheet(p.password);
        break;
      case "auto_fit":
        await excelOps.autoFit(p.range);
        break;
      case "find_replace":
        await excelOps.findReplace(p.find, p.replace, p.range);
        break;
      case "hide_columns":
        await excelOps.hideColumns(p.columns);
        break;
      case "show_columns":
        await excelOps.showColumns(p.columns);
        break;
      case "hide_rows":
        await excelOps.hideRows(p.rows);
        break;
      case "show_rows":
        await excelOps.showRows(p.rows);
        break;
      case "validate_data":
        await excelOps.validateData(p.range, p.type, p.values);
        break;

      case "fetch_data":
        await this._handleFetchData(p);
        break;

      case "query_and_display":
        action.message = await this._handleQueryAndDisplay(p);
        break;

      case "mcp_tool":
        action.message = await this._handleMcpTool(p);
        break;

      case "mcp_prompt":
        await this._handleMcpPrompt(p);
        break;

      case "multi_action": {
        const errors = [];
        for (let i = 0; i < (p.actions || []).length; i++) {
          const sub = p.actions[i];
          try {
            await this._dispatch(sub);
          } catch (err) {
            console.error(`[Ledgerlens] multi_action step ${i + 1} (${sub.action}) failed:`, err.message);
            errors.push(`Step ${i + 1} (${sub.action}): ${err.message}`);
          }
        }
        if (errors.length > 0) {
          action.message = (action.message || "") + "\n⚠ Some steps had issues: " + errors.join("; ");
        }
        break;
      }

      case "explain":
      case "error":
        break;

      default: {
        const customHandler = getCustomAction(action.action);
        if (customHandler) {
          await customHandler(p);
        } else {
          throw new Error(`Unknown action: ${action.action}`);
        }
      }
    }
  }

  async _handleFetchData(params) {
    const connectorId = params.connector;
    const connector = connectorRegistry.get(connectorId);
    if (!connector) throw new Error(`Connector "${connectorId}" not found. Add it in Data Sources.`);
    if (!connector.isConnected) throw new Error(`Connector "${connector.name}" is not connected. Please connect it first.`);

    const { headers, rows } = await connector.fetchData(params.query);
    await excelOps.writeData(params.startCell || "A1", headers, rows);
  }

  /** Fetch data from a connector and return it as a markdown table for chat display (no Excel write). */
  async _handleQueryAndDisplay(params) {
    const connectorId = params.connector;
    const connector = connectorRegistry.get(connectorId);
    if (!connector) throw new Error(`Connector "${connectorId}" not found. Add it in Data Sources.`);
    if (!connector.isConnected) throw new Error(`Connector "${connector.name}" is not connected. Please connect it first.`);

    const { headers, rows } = await connector.fetchData(params.query);

    if (!headers || headers.length === 0) return params.message || "Query returned no results.";

    // Sanitize a cell value for markdown table display
    const sanitize = (v) => {
      let s = String(v ?? "");
      // Collapse JSON/multiline to single line, truncate long values
      s = s.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      s = s.replace(/\|/g, "\u2502"); // replace pipe with box-drawing char
      if (s.length > 80) s = s.slice(0, 77) + "…";
      return s;
    };

    // Build markdown table
    const headerRow = "| " + headers.map(sanitize).join(" | ") + " |";
    const separator = "| " + headers.map(() => "---").join(" | ") + " |";
    const dataRows = (rows || []).map(r => "| " + r.map(sanitize).join(" | ") + " |").join("\n");
    const table = [headerRow, separator, dataRows].join("\n");

    return (params.message ? params.message + "\n\n" : "") + table;
  }

  /** Fetch data from a connector without writing to Excel. Returns { headers, data, totalRows } or { error }. */
  async _handleGatherData(params) {
    try {
      const connectorId = params.connector;
      const connector = connectorRegistry.get(connectorId);
      if (!connector) return { error: `Connector "${connectorId}" not found.` };
      if (!connector.isConnected) return { error: `Connector "${connector.name}" is not connected.` };

      const { headers, rows } = await connector.fetchData(params.query);

      if (!headers || headers.length === 0) return { error: "Query returned no results." };

      const data = (rows || []).slice(0, 200).map(row => {
        const obj = {};
        headers.forEach((h, i) => { obj[h] = row[i] ?? null; });
        return obj;
      });

      return { headers, data, totalRows: (rows || []).length };
    } catch (err) {
      return { error: err.message };
    }
  }

  async _handleMcpTool(params) {
    const { serverId, toolName, args, startCell } = params;
    const result = await mcpClient.callTool(serverId, toolName, args || {});

    const contents = result?.content || [];
    const textParts = contents
      .filter((c) => c.type === "text")
      .map((c) => c.text);

    for (const text of textParts) {
      try {
        const parsed = JSON.parse(text);
        if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0] === "object") {
          const headers = Object.keys(parsed[0]);
          const rows = parsed.map((item) => headers.map((h) => item[h] ?? ""));
          if (startCell) {
            await excelOps.writeData(startCell, headers, rows);
            return `Wrote ${rows.length} row${rows.length === 1 ? "" : "s"} from MCP tool \"${toolName}\" to ${startCell}.`;
          }
          return this._formatMarkdownTable(headers, rows, { intro: `Results from MCP tool \"${toolName}\"`, maxRows: 100 });
        }

        if (parsed && typeof parsed === "object") {
          if (startCell) {
            const headers = Object.keys(parsed);
            const rows = [headers.map((header) => parsed[header] ?? "")];
            await excelOps.writeData(startCell, headers, rows);
            return `Wrote the MCP tool \"${toolName}\" result to ${startCell}.`;
          }
          return `Results from MCP tool \"${toolName}\":\n\n\
\
${JSON.stringify(parsed, null, 2)}`;
        }
      } catch { /* not JSON array, continue */ }
    }

    if (textParts.length > 0) {
      const combined = textParts.join("\n\n").trim();
      if (startCell) {
        await excelOps.writeData(startCell, null, [[combined]]);
        return `Wrote the MCP tool \"${toolName}\" response to ${startCell}.`;
      }
      return combined;
    }

    const fallback = JSON.stringify(result, null, 2);
    if (startCell) {
      await excelOps.writeData(startCell, null, [[fallback]]);
      return `Wrote the MCP tool \"${toolName}\" response to ${startCell}.`;
    }
    return `Results from MCP tool \"${toolName}\":\n\n\
\
${fallback}`;
  }

  _formatMarkdownTable(headers, rows, options = {}) {
    const intro = options.intro || "Results";
    const maxRows = Number.isFinite(options.maxRows) ? options.maxRows : 50;
    const visibleRows = (rows || []).slice(0, maxRows);
    const sanitize = (value) => {
      let text = String(value ?? "");
      text = text.replace(/[\r\n]+/g, " ").replace(/\s+/g, " ").trim();
      text = text.replace(/\|/g, "\u2502");
      if (text.length > 120) text = text.slice(0, 117) + "…";
      return text;
    };

    const headerRow = "| " + headers.map(sanitize).join(" | ") + " |";
    const separator = "| " + headers.map(() => "---").join(" | ") + " |";
    const body = visibleRows.map((row) => "| " + row.map(sanitize).join(" | ") + " |").join("\n");
    const suffix = rows.length > visibleRows.length ? `\n\nShowing ${visibleRows.length} of ${rows.length} rows.` : "";
    return `${intro}:\n\n${headerRow}\n${separator}${body ? `\n${body}` : ""}${suffix}`;
  }

  async _handleMcpPrompt(params) {
    const { serverId, promptName, args } = params;
    const result = await mcpClient.getPrompt(serverId, promptName, args || {});

    // Extract the prompt messages and feed them back through the AI
    const messages = result?.messages || [];
    const combined = messages.map((m) => m.content?.text || JSON.stringify(m.content)).join("\n");
    if (combined) {
      // Re-execute the prompt output as a new command
      return this.execute(combined);
    }
  }
}

const aiEngine = new AIEngine();
export default aiEngine;
