import React, { useEffect, useRef, useState } from "react";
import { sendChat, pullTrialBalance, type ChatMessage } from "./api";

const SUGGESTIONS = [
  "Pull this month's trial balance",
  "Find unusual journal entries in selection",
  "Variance vs prior period for revenue accounts",
  "Summarize AR aging risk",
];

type UiMessage = ChatMessage & {
  id: string;
  citations?: Array<{ rowId: string; reason: string }>;
  suggestedFormulas?: string[];
  error?: boolean;
};

declare const Excel: any;
declare const Office: any;

export function App() {
  const [messages, setMessages] = useState<UiMessage[]>([]);
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [selection, setSelection] = useState<string>("");
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: "smooth" });
  }, [messages, busy]);

  useEffect(() => {
    if (typeof Office === "undefined" || !Office.context?.document) return;
    const handler = async () => {
      try {
        await Excel.run(async (ctx: any) => {
          const r = ctx.workbook.getSelectedRange().load("address");
          await ctx.sync();
          setSelection(r.address ?? "");
        });
      } catch { /* outside Excel — ignore */ }
    };
    handler();
    try {
      Office.context.document.addHandlerAsync(
        Office.EventType.DocumentSelectionChanged,
        handler,
      );
    } catch { /* not in Excel host */ }
  }, []);

  function autoresize() {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }

  async function handleSend(text?: string) {
    const content = (text ?? input).trim();
    if (!content || busy) return;

    const userMsg: UiMessage = {
      id: crypto.randomUUID(),
      role: "user",
      content,
    };
    const history = [...messages, userMsg];
    setMessages(history);
    setInput("");
    setBusy(true);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    // Intent shortcut: explicit data pull
    if (/\btrial balance\b/i.test(content) && /\bpull|fetch|get\b/i.test(content)) {
      try {
        const { rows } = await pullTrialBalance();
        await writeRowsToSheet(rows);
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            role: "assistant",
            content: `Pulled ${rows.length} trial-balance row${rows.length === 1 ? "" : "s"} into a new sheet. Ask a follow-up to analyze them.`,
          },
        ]);
      } catch (e: any) {
        setMessages((prev) => [
          ...prev,
          { id: crypto.randomUUID(), role: "assistant", content: `Pull failed: ${e.message}`, error: true },
        ]);
      } finally {
        setBusy(false);
      }
      return;
    }

    try {
      const res = await sendChat({
        messages: history.map(({ role, content }) => ({ role, content })),
        rangeAddress: selection || undefined,
      });
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          role: "assistant",
          content: res.answer,
          citations: res.citations,
          suggestedFormulas: res.suggestedFormulas,
        },
      ]);
    } catch (e: any) {
      setMessages((prev) => [
        ...prev,
        { id: crypto.randomUUID(), role: "assistant", content: `Error: ${e.message}`, error: true },
      ]);
    } finally {
      setBusy(false);
    }
  }

  async function writeRowsToSheet(rows: any[]) {
    if (typeof Excel === "undefined") return;
    await Excel.run(async (ctx: any) => {
      const sheet = ctx.workbook.worksheets.add(`TB ${new Date().toISOString().slice(0, 10)}`);
      const header = ["Account", "Name", "Opening", "Debits", "Credits", "Closing", "Currency", "Period"];
      const data = rows.map((r) => [
        r.account, r.accountName, r.openingBalance, r.debits, r.credits, r.closingBalance, r.currency, r.period,
      ]);
      const range = sheet.getRangeByIndexes(0, 0, data.length + 1, header.length);
      range.values = [header, ...data];
      sheet.getUsedRange().format.autofitColumns();
      sheet.activate();
      await ctx.sync();
    });
  }

  async function insertFormula(formula: string) {
    if (typeof Excel === "undefined") {
      navigator.clipboard?.writeText(formula);
      return;
    }
    await Excel.run(async (ctx: any) => {
      const r = ctx.workbook.getSelectedRange();
      r.formulas = [[formula]];
      await ctx.sync();
    });
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  }

  return (
    <div className="app">
      <header className="app-header">
        <div className="logo">L</div>
        <div>
          <div className="app-title">ledgerlens</div>
          <div className="app-subtitle">AI assistant for your books</div>
        </div>
      </header>

      <div className="chip-row">
        {SUGGESTIONS.map((s) => (
          <button key={s} className="chip" onClick={() => handleSend(s)} disabled={busy}>
            {s}
          </button>
        ))}
      </div>

      <div className="messages" ref={scrollRef}>
        {messages.length === 0 && (
          <div className="empty">
            <span className="empty-emoji">📊</span>
            Ask anything about your accounting data, or pull a dataset to start.
          </div>
        )}

        {messages.map((m) => (
          <div key={m.id} className={`msg ${m.role} ${m.error ? "error" : ""}`}>
            <div className="bubble">
              {m.content}
              {m.suggestedFormulas?.length ? (
                <div>
                  {m.suggestedFormulas.map((f, i) => (
                    <div key={i} className="formula" title="Click to insert into selected cell" onClick={() => insertFormula(f)}>
                      {f}
                    </div>
                  ))}
                </div>
              ) : null}
              {m.citations?.length ? (
                <div className="citations">
                  Sources: {m.citations.map((c) => c.rowId).join(", ")}
                </div>
              ) : null}
            </div>
          </div>
        ))}

        {busy && (
          <div className="msg assistant">
            <div className="bubble">
              <div className="typing"><span /><span /><span /></div>
            </div>
          </div>
        )}
      </div>

      <div className="composer">
        {selection && <span className="context-pill">📌 selection: {selection}</span>}
        <div className="row">
          <textarea
            ref={textareaRef}
            value={input}
            placeholder="Message ledgerlens…"
            onChange={(e) => { setInput(e.target.value); autoresize(); }}
            onKeyDown={onKeyDown}
            rows={1}
            disabled={busy}
          />
          <button className="send-btn" onClick={() => handleSend()} disabled={busy || !input.trim()} aria-label="Send">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="22" y1="2" x2="11" y2="13"></line>
              <polygon points="22 2 15 22 11 13 2 9 22 2"></polygon>
            </svg>
          </button>
        </div>
        <div className="hint">Enter to send · Shift+Enter for newline</div>
      </div>
    </div>
  );
}
