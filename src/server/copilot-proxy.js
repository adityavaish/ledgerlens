/**
 * Pivot — Copilot SDK Proxy.
 * Runs server-side inside webpack-dev-server.
 *
 * Manages a CopilotClient + session and exposes HTTP endpoints
 * that the browser-based add-in calls to interact with GitHub Copilot.
 *
 * Auth: uses the GitHub CLI logged-in user by default.
 *       Set GITHUB_TOKEN env var as a fallback.
 */

// @github/copilot-sdk is ESM-only — lazy-loaded via dynamic import()
let _CopilotClient = null;
async function loadSDK() {
  if (!_CopilotClient) {
    const mod = await import("@github/copilot-sdk");
    _CopilotClient = mod.CopilotClient;
  }
  return _CopilotClient;
}

// ── System Prompt (moved from ai-service.js — lives server-side now) ────
const SYSTEM_PROMPT = `You are Pivot, an AI assistant embedded in Excel for finance and accounting teams. You help users explore corporate accounting data — trial balances, journal entries, GL detail, AP/AR aging, revenue and expense analysis, variance reviews, and reconciliations. When the user's intent is ambiguous, prefer a finance interpretation (e.g. "balance" → account balance; "aging" → AR/AP aging buckets; "period" → accounting period). Respond ONLY with valid JSON (no fences):
{"action":"<action>","params":{...},"message":"<short confirmation>"}

Actions: generate_data({headers,rows,startCell}), update_data({range,values}), create_table({range,name,hasHeaders}), create_chart({type,dataRange,title}), create_pivot({sourceRange,rows,columns,values}), format_range({range,format}), format_columns({columns:["A","B"],format}), conditional_format({range,rule,values,format}), insert_formula({cell,formula}), fill_formulas({startCell,formula,fillDown}), sort_data({range,column,ascending}), filter_data({range,column,criteria}), merge_cells({range}), add_sheet({name}), rename_sheet({oldName,newName}), delete_range({range}), freeze_panes({row,column}), auto_fit({range}), find_replace({find,replace,range}), validate_data({range,type,values}), hide_columns({columns:["A","B"]}), show_columns({columns:["A","B"]}), hide_rows({rows:[1,2,3]}), show_rows({rows:[1,2,3]}), fetch_data({connector,query,startCell}), query_and_display({connector,query,message}), gather_data({connector,query}), mcp_tool({serverId,toolName,args,startCell}), multi_action({actions:[...]}), explain(no params), error(no params).
Connectors: rest, sql, csv, sharepoint, graph, kusto. For kusto: query is KQL. Use ".show tables" for regular tables, ".show external tables" for external tables, ".show table T schema as json" or ".show external table T schema as json" depending on table type.
Chart types: bar,line,pie,scatter,area,column,doughnut,radar,stacked_bar,stacked_column.
Format keys: bold,italic,underline,fontSize,fontColor,fontName,fill,horizontalAlignment,verticalAlignment,wrapText,indentLevel,columnWidth,rowHeight,borders,numberFormat,numberFormatPreset.
Number-format presets (use {format:{numberFormatPreset:"<name>"}} — preferred over raw strings):
  Dates: date_short (m/d/yyyy), date_medium ("Jan 1, 2026"), date_long ("January 1, 2026"), date_iso (yyyy-mm-dd), date_us, date_eu, month_year ("Jan 2026").
  Time/datetime: time, time_24h, datetime_medium.
  Numbers: integer (#,##0), number_2 (#,##0.00), percent, percent_2, scientific, text.
  Currency: usd, usd_whole, accounting_usd. For other currencies, pass {numberFormat:"€#,##0.00"} etc.
For column-wide formatting (e.g. "format column B as dates"), use format_columns({columns:["B"],format:{numberFormatPreset:"date_medium"}}); it applies to the used range of those columns. Do NOT use format_range with "B:B" — use format_columns.

Rules:
- ALWAYS use Excel formulas (=B2*C2) for derived columns, never static values.
- For data+formulas: use multi_action with generate_data first, then fill_formulas.
- Max 10 rows unless asked otherwise. Be concise, respond fast.
- Use native Excel functions: SUM,AVERAGE,IF,VLOOKUP,COUNTIF,etc.
- For multiple tasks, use multi_action to batch them.
- For charts, use contiguous data ranges like "A1:D10". Avoid comma-separated ranges.
- For create_chart, dataRange must be a single contiguous range (e.g. "A1:E13" not "A1:A13,E1:E13").
- IMPORTANT — Decide intelligently whether results belong in Excel or in chat:
  * Use "fetch_data" ONLY when the user wants data written into the spreadsheet (e.g. "pull sales data into the sheet", "load this table", "import data").
  * Use "query_and_display" to show simple results in chat as a table (listing names, counts, previews). Keep queries lean.
  * Use "mcp_tool" for MCP-backed answers. By default it returns results in chat. Only include startCell when the user explicitly wants the MCP result written into Excel.
  * Use "explain" when no query is needed and you already know the answer. For analysis/details, use "explain" with rich markdown (## headers, bullet points, tables).
  * When in doubt: QUESTION → query_and_display. COMMAND to load data → fetch_data. ANALYSIS → gather_data then explain.
- MULTI-STEP REASONING with gather_data:
  * "gather_data"({connector,query}) is a SPECIAL intermediate action. It fetches query results and feeds them back to you in the next turn. You can then reason about the data and decide your next step.
  * Use gather_data when you need to look something up before you can answer. For example: user asks about table "foo" → gather_data to list tables and find the correct case-sensitive name → gather_data to get the schema → then "explain" with a detailed analysis.
  * You can chain multiple gather_data calls. Each one returns results that you can use in subsequent decisions.
  * ALWAYS end with a terminal action (explain, query_and_display, fetch_data, etc.). Never stop at gather_data.
  * Example flow for "analyze schema of table X": gather_data(.show external tables) → find correct name → gather_data(.show external table CorrectName schema as json) → explain with detailed markdown analysis of columns, types, and patterns.
- For kusto external tables, use external_table('TableName') syntax in KQL queries. Table names are CASE-SENSITIVE in Kusto.
- A Kusto connector marked connected means auth/cluster handshake succeeded. Do not claim it is disconnected unless the connector explicitly says it is not connected.
- Kusto 403 errors do NOT always mean the cluster URL is wrong or the connector is disconnected. They can also mean the signed-in identity lacks permission for that database, table, or management command.
- If a kusto query fails, try alternative approaches (e.g. gather_data to list tables and find the correct name first).`;

// ── State ───────────────────────────────────────────────────────────────
let client = null;
let session = null;
let currentModel = process.env.PIVOT_COPILOT_MODEL || "claude-opus-4.6";

function isHostedEnvironment() {
  return Boolean(
    process.env.CONTAINER_APP_NAME
      || process.env.CONTAINER_APP_REVISION
      || process.env.WEBSITE_HOSTNAME
      || process.env.WEBSITE_SITE_NAME
      || process.env.KUBERNETES_SERVICE_HOST
  );
}

function getGitHubToken() {
  return process.env.GITHUB_TOKEN || process.env.GH_TOKEN || process.env.COPILOT_GITHUB_TOKEN || "";
}

function getCopilotAuthStatus() {
  const token = getGitHubToken();
  if (token) {
    return {
      configured: true,
      mode: "github-token",
      message: "Copilot is configured with GITHUB_TOKEN.",
    };
  }

  if (isHostedEnvironment()) {
    return {
      configured: false,
      mode: "missing-token",
      message: "Copilot is not configured for this deployment. Set GITHUB_TOKEN in the azd environment and redeploy. GitHub CLI login is only supported for local development.",
    };
  }

  return {
    configured: true,
    mode: "logged-in-user",
    message: "Copilot will use the logged-in GitHub CLI user for local development.",
  };
}

function getCopilotClientOptions() {
  const auth = getCopilotAuthStatus();
  if (!auth.configured) {
    throw new Error(auth.message);
  }

  if (auth.mode === "github-token") {
    return {
      githubToken: getGitHubToken(),
      useLoggedInUser: false,
      logLevel: "error",
    };
  }

  return {
    useLoggedInUser: true,
    logLevel: "error",
  };
}

function formatCopilotError(err) {
  const message = err?.message || "Unknown Copilot error";
  if (message.includes("Session was not created with authentication info or custom provider")) {
    return getCopilotAuthStatus().message;
  }
  return message;
}

// ── Lifecycle helpers ───────────────────────────────────────────────────

async function getClient() {
  if (!client) {
    const CopilotClient = await loadSDK();
    const opts = getCopilotClientOptions();
    client = new CopilotClient(opts);
    await client.start();
  }
  return client;
}

async function getSession() {
  if (!session) {
    const c = await getClient();
    session = await c.createSession({
      model: currentModel,
      systemMessage: { mode: "replace", content: SYSTEM_PROMPT },
      infiniteSessions: { enabled: true },
      onPermissionRequest: () => ({ kind: "denied-by-rules" }),
    });
  }
  return session;
}

async function resetSession() {
  if (session) {
    try { await session.disconnect(); } catch { /* ignore */ }
    session = null;
  }
  // Also reset the client so a fresh connection is made
  if (client) {
    try { await client.stop(); } catch { /* ignore */ }
    client = null;
  }
}

// ── Body parser helper ──────────────────────────────────────────────────

/** Parse AI response content — handles pure JSON, markdown-wrapped, and text+JSON mixed responses */
function parseAIResponse(content) {
  if (!content) return { action: "explain", params: {}, message: "No response from Copilot." };

  let clean = content.trim();

  // Strip markdown code fences
  if (clean.startsWith("```")) {
    clean = clean.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
  }

  // Try direct JSON parse
  try {
    return JSON.parse(clean);
  } catch { /* not pure JSON */ }

  // Extract JSON from mixed text+JSON (model sometimes adds explanation before the JSON)
  const jsonMatch = content.match(/\{[\s\S]*?"action"\s*:\s*"[^"]+?"[\s\S]*\}/);
  if (jsonMatch) {
    try {
      return JSON.parse(jsonMatch[0]);
    } catch { /* malformed JSON */ }
  }

  // Fallback: treat as explanation
  return { action: "explain", params: {}, message: content };
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString()));
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// ── Middleware setup ────────────────────────────────────────────────────

const SEND_TIMEOUT_MS = 180000;

/**
 * Send a prompt via the Copilot session with retry on timeout or session errors.
 * Resets the session on recoverable errors so subsequent requests get a fresh one.
 */
async function sendWithRetry(prompt, retries = 1) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const sess = await getSession();
    try {
      console.log(`[Pivot] Sending to Copilot (attempt ${attempt + 1})…`);
      const start = Date.now();
      const result = await sess.sendAndWait({ prompt }, SEND_TIMEOUT_MS);
      console.log(`[Pivot] Copilot responded in ${((Date.now() - start) / 1000).toFixed(1)}s`);
      return result;
    } catch (err) {
      const msg = err.message || "";
      console.error(`[Pivot] Copilot error (attempt ${attempt + 1}): ${msg}`);
      const isRecoverable = msg.includes("Timeout") || msg.includes("Session not found") || msg.includes("session");
      if (isRecoverable && attempt < retries) {
        console.warn(`[Pivot] Resetting session and retrying…`);
        await resetSession();
        continue;
      }
      if (isRecoverable) {
        await resetSession();
      }
      throw err;
    }
  }
}

async function sendStreamWithRetry({ prompt, onSessionReady, onBeforeSend, onRecoverableError, retries = 1 }) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    const sess = await getSession();
    let origDispatch = null;

    try {
      if (typeof onSessionReady === "function") {
        await onSessionReady(sess, attempt);
      }

      origDispatch = sess._dispatchEvent?.bind(sess);
      if (typeof onBeforeSend === "function" && origDispatch) {
        sess._dispatchEvent = (evt, data) => {
          try {
            onBeforeSend(evt, data, attempt);
          } catch {
            /* don't let SSE event handling break the SDK flow */
          }
          origDispatch(evt, data);
        };
      }

      return await sess.sendAndWait({ prompt }, SEND_TIMEOUT_MS);
    } catch (err) {
      const msg = err?.message || "";
      const isRecoverable = msg.includes("Timeout") || msg.includes("Session not found") || msg.includes("session");

      if (typeof onRecoverableError === "function" && isRecoverable) {
        await onRecoverableError(err, attempt);
      }

      if (isRecoverable && attempt < retries) {
        await resetSession();
        continue;
      }

      if (isRecoverable) {
        await resetSession();
      }

      throw err;
    } finally {
      if (origDispatch && sess?._dispatchEvent !== origDispatch) {
        sess._dispatchEvent = origDispatch;
      }
    }
  }
}

function setupCopilotProxy(app) {
  /**
   * POST /api/chat
   * Body: { userCommand: string, context: object }
   * Returns: { action, params, message }
   */
  app.post("/api/chat", async (req, res) => {
    try {
      const body = await parseBody(req);
      const { userCommand, context } = body;

      if (!userCommand) {
        res.status(400).json({ action: "error", params: {}, message: "Missing userCommand" });
        return;
      }

      // Build the structured prompt with spreadsheet context
      const prompt = JSON.stringify({
        command: userCommand,
        activeSheet: context?.sheetName || "Sheet1",
        selectedRange: context?.selectedRange || "A1",
        nearbyData: context?.nearbyData || [],
        availableConnectors: context?.connectorNames || [],
        availableMcpTools: context?.mcpTools || [],
        availableMcpPrompts: context?.mcpPrompts || [],
      });

      const result = await sendWithRetry(prompt);
      const content = result?.data?.content?.trim();

      const parsed = parseAIResponse(content);

      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(parsed));
    } catch (err) {
      const message = formatCopilotError(err);
      res.status(500);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ action: "error", params: {}, message: `Copilot error: ${message}` }));
    }
  });

  /**
   * POST /api/configure
   * Body: { model?: string }
   */
  app.post("/api/configure", async (req, res) => {
    try {
      const body = await parseBody(req);
      if (body.model && body.model !== currentModel) {
        currentModel = body.model;
        await resetSession(); // next request will create a session with the new model
      }
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true, model: currentModel }));
    } catch (err) {
      res.status(500);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });

  /**
   * POST /api/reset
   * Resets the conversation session (clears history).
   */
  app.post("/api/reset", async (_req, res) => {
    try {
      await resetSession();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: true }));
    } catch (err) {
      res.status(500);
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ success: false, message: err.message }));
    }
  });

  /**
   * GET /api/status
   * Returns whether the Copilot client is connected and the current model.
   */
  app.get("/api/status", (_req, res) => {
    const auth = getCopilotAuthStatus();
    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      connected: !!client,
      sessionActive: !!session,
      model: currentModel,
      authConfigured: auth.configured,
      authMode: auth.mode,
      authMessage: auth.message,
    }));
  });

  console.log("[Pivot] Copilot proxy endpoints registered: /api/chat, /api/configure, /api/reset, /api/status");
}

/**
 * Returns a connect-style middleware (req, res, next) that handles /api/* routes.
 * Suitable for use inside webpack-dev-server setupMiddlewares.
 */
function createCopilotMiddleware() {
  const routes = {
    "POST /api/chat": async (req, res) => {
      try {
        const body = await parseBody(req);
        const { userCommand, context } = body;
        if (!userCommand) {
          res.statusCode = 400;
          res.setHeader("Content-Type", "application/json");
          res.end(JSON.stringify({ action: "error", params: {}, message: "Missing userCommand" }));
          return;
        }
        const prompt = JSON.stringify({
          command: userCommand,
          activeSheet: context?.sheetName || "Sheet1",
          selectedRange: context?.selectedRange || "A1",
          nearbyData: context?.nearbyData || [],
          availableConnectors: context?.connectorNames || [],
          availableMcpTools: context?.mcpTools || [],
          availableMcpPrompts: context?.mcpPrompts || [],
        });
        const result = await sendWithRetry(prompt);
        const content = result?.data?.content?.trim();
        const parsed = parseAIResponse(content);
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(parsed));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ action: "error", params: {}, message: `Copilot error: ${formatCopilotError(err)}` }));
      }
    },
    "POST /api/configure": async (req, res) => {
      try {
        const body = await parseBody(req);
        if (body.model && body.model !== currentModel) {
          currentModel = body.model;
          await resetSession();
        }
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true, model: currentModel }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    },
    "POST /api/reset": async (_req, res) => {
      try {
        await resetSession();
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: true }));
      } catch (err) {
        res.statusCode = 500;
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ success: false, message: err.message }));
      }
    },
    "GET /api/status": (_req, res) => {
      const auth = getCopilotAuthStatus();
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({
        connected: !!client,
        sessionActive: !!session,
        model: currentModel,
        authConfigured: auth.configured,
        authMode: auth.mode,
        authMessage: auth.message,
      }));
    },
    /**
     * POST /api/chat-stream
     * SSE endpoint that streams thinking events as the model processes.
     * Events: thinking, usage, content, done, error
     */
    "POST /api/chat-stream": async (req, res) => {
      const streamStart = Date.now();
      const log = (msg) => console.log(`[Pivot SSE +${((Date.now() - streamStart) / 1000).toFixed(1)}s] ${msg}`);

      res.setHeader("Content-Type", "text/event-stream");
      res.setHeader("Cache-Control", "no-cache");
      res.setHeader("Connection", "keep-alive");
      res.setHeader("Access-Control-Allow-Origin", "*");

      function sendEvent(type, data) {
        log(`→ SSE event: ${type} ${JSON.stringify(data).slice(0, 150)}`);
        res.write(`event: ${type}\ndata: ${JSON.stringify(data)}\n\n`);
      }

      // Heartbeat every 10s to keep connection alive
      const heartbeat = setInterval(() => {
        const elapsed = ((Date.now() - streamStart) / 1000).toFixed(0);
        res.write(`: heartbeat ${elapsed}s\n\n`);
        sendEvent("thinking", { step: `Still waiting for model… (${elapsed}s)` });
      }, 10000);

      try {
        const body = await parseBody(req);
        const { userCommand, context } = body;
        log(`Request: "${userCommand?.slice(0, 80)}"`);

        if (!userCommand) {
          clearInterval(heartbeat);
          sendEvent("error", { message: "Missing userCommand" });
          res.end();
          return;
        }

        sendEvent("thinking", { step: "Preparing session…" });

        const prompt = JSON.stringify({
          command: userCommand,
          activeSheet: context?.sheetName || "Sheet1",
          selectedRange: context?.selectedRange || "A1",
          nearbyData: context?.nearbyData || [],
          availableConnectors: context?.connectorNames || [],
          availableMcpTools: context?.mcpTools || [],
          availableMcpPrompts: context?.mcpPrompts || [],
        });

        log(`Prompt size: ${prompt.length} chars`);
        sendEvent("thinking", { step: "Sending to model…" });

        log("Calling sendAndWait()…");
        const result = await sendStreamWithRetry({
          prompt,
          retries: 1,
          onSessionReady: async (_sess, attempt) => {
            log(`Session ready (attempt ${attempt + 1}, model: ${currentModel})`);
          },
          onBeforeSend: (evt) => {
            const type = evt?.type || "unknown";
            const d = evt?.data || {};
            if (type === "assistant.turn_start") {
              sendEvent("thinking", { step: "Model is thinking…" });
            } else if (type === "session.usage_info") {
              const pct = d.currentTokens && d.tokenLimit
                ? Math.round((d.currentTokens / d.tokenLimit) * 100) : null;
              sendEvent("thinking", {
                step: `Context: ${d.messagesLength || "?"} messages, ${d.currentTokens || "?"} tokens${pct ? ` (${pct}% of limit)` : ""}`,
              });
            } else if (type === "assistant.usage") {
              const dur = d.duration ? `${(d.duration / 1000).toFixed(1)}s` : "";
              sendEvent("thinking", {
                step: `${d.model || "Model"} generated ${d.outputTokens || "?"} tokens${dur ? ` in ${dur}` : ""} (input: ${d.inputTokens || "?"} tokens)`,
              });
            } else if (type === "assistant.turn_end") {
              sendEvent("thinking", { step: "Parsing response…" });
            }
          },
          onRecoverableError: async (err, attempt) => {
            const msg = formatCopilotError(err);
            log(`Recoverable stream error on attempt ${attempt + 1}: ${msg}`);
            if (attempt === 0) {
              sendEvent("thinking", { step: "Copilot session expired. Reconnecting…" });
            }
          },
        });

        log(`sendAndWait returned`);
        clearInterval(heartbeat);
        log("Processing response…");

        const content = result?.data?.content?.trim();
        log(`Response content: ${content?.slice(0, 200)}…`);

        const parsed = parseAIResponse(content);

        log(`Action: ${parsed.action}`);
        sendEvent("done", parsed);
        res.end();
        log("Stream complete ✓");
      } catch (err) {
        clearInterval(heartbeat);
        const msg = formatCopilotError(err);
        log(`Stream error: ${msg}`);
        const isRecoverable = msg.includes("Timeout") || msg.includes("Session not found") || msg.includes("session");
        if (isRecoverable) await resetSession();
        sendEvent("error", { message: `Copilot error: ${msg}` });
        res.end();
      }
    },
  };

  console.log("[Pivot] Copilot middleware created for: /api/chat, /api/configure, /api/reset, /api/status");

  return function copilotProxy(req, res, next) {
    const key = `${req.method} ${req.url}`;
    const handler = routes[key];
    if (handler) {
      handler(req, res);
    } else {
      next();
    }
  };
}

module.exports = { setupCopilotProxy, createCopilotMiddleware };
