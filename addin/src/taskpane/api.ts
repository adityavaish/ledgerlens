import type {
  AnalysisResponse,
  TrialBalanceRow,
} from "../../../shared/src";

const BASE = (typeof window !== "undefined" && (window as any).LEDGERLENS_API)
  || "https://localhost:3001";

export type ChatMessage = { role: "user" | "assistant" | "system"; content: string };

export interface ChatRequest {
  messages: ChatMessage[];
  rangeAddress?: string;
}

export async function sendChat(req: ChatRequest): Promise<AnalysisResponse> {
  const res = await fetch(`${BASE}/chat`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(req),
  });
  if (!res.ok) throw new Error(`chat failed: ${res.status}`);
  return res.json();
}

export async function pullTrialBalance(): Promise<{ rows: TrialBalanceRow[] }> {
  const today = new Date();
  const from = new Date(today.getFullYear(), today.getMonth(), 1).toISOString().slice(0, 10);
  const to = today.toISOString().slice(0, 10);
  const res = await fetch(`${BASE}/data/pull`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ dataset: "trial_balance", period: { from, to } }),
  });
  if (!res.ok) throw new Error(`pull failed: ${res.status}`);
  return res.json();
}
