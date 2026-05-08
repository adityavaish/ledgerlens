/**
 * Ledgerlens — AI Service (GitHub Copilot SDK).
 * Thin client that calls the server-side Copilot proxy at /api/chat.
 * The proxy manages CopilotClient sessions using the user's GitHub auth.
 */

import authService from "./auth.js";

const DEFAULT_MODEL = "gpt-4o";

function getErrorMessage(err, fallback = "Unknown error") {
  if (!err) return fallback;
  if (typeof err === "string") return err;
  return err.message || err.errorMessage || err.toString?.() || fallback;
}

class AIService {
  constructor() {
    this._model = DEFAULT_MODEL;
  }

  configure({ model }) {
    if (model && model !== this._model) {
      this._model = model;
      // Notify the server-side proxy about model change
      authService.fetchApi("/api/configure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model }),
      }).catch(() => {});
    }
  }

  /**
   * Send a user command to the Copilot proxy, along with spreadsheet context.
   * Returns the parsed action object.
   * The conversation history is managed server-side by the Copilot session.
   */
  /**
   * Send a user command to the Copilot proxy with SSE streaming.
   * Returns the parsed action object.
   * Calls onThinking(step) for each thinking step from the server.
   */
  async interpret(userCommand, context = {}, onThinking) {
    let res;
    try {
      res = await authService.fetchApi("/api/chat-stream", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ userCommand, context }),
      });
    } catch (err) {
      throw new Error(`AI request failed: ${getErrorMessage(err)}`);
    }

    if (!res.ok) {
      const text = await res.text();
      let message;
      try { message = JSON.parse(text).message; } catch { message = text; }
      throw new Error(`AI request failed (${res.status}): ${message}`);
    }

    // Parse SSE stream
    return new Promise((resolve, reject) => {
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      function processChunk({ done, value }) {
        if (done) {
          reject(new Error("Stream ended without a result"));
          return;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop(); // keep incomplete line in buffer

        let eventType = null;
        for (const line of lines) {
          if (line.startsWith("event: ")) {
            eventType = line.slice(7).trim();
          } else if (line.startsWith("data: ") && eventType) {
            try {
              const data = JSON.parse(line.slice(6));
              if (eventType === "thinking" && onThinking) {
                onThinking(data.step);
              } else if (eventType === "usage" && onThinking) {
                const model = data.model || "AI";
                const dur = data.duration ? `${(data.duration / 1000).toFixed(1)}s` : "";
                onThinking(`${model} processed ${dur ? "in " + dur : ""} (${data.inputTokens || 0} in / ${data.outputTokens || 0} out tokens)`);
              } else if (eventType === "done") {
                resolve(data);
                return;
              } else if (eventType === "error") {
                reject(new Error(data.message || "AI error"));
                return;
              }
            } catch { /* skip malformed */ }
            eventType = null;
          }
        }

        reader.read().then(processChunk).catch((err) => {
          reject(err);
        });
      }

      reader.read().then(processChunk).catch((err) => {
        reject(err);
      });
    });
  }

  /**
   * Reset the Copilot session (clears conversation history server-side).
   */
  async resetSession() {
    await authService.fetchApi("/api/reset", { method: "POST" }).catch(() => {});
  }
}

const aiService = new AIService();
export default aiService;
