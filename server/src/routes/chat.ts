import { Router } from "express";
import { z } from "zod";
import type { AnalysisResponse } from "../../../shared/src";

export const chatRouter = Router();

const ChatSchema = z.object({
  messages: z.array(z.object({
    role: z.enum(["user", "assistant", "system"]),
    content: z.string(),
  })).min(1),
  rangeAddress: z.string().optional(),
});

// Lightweight intent classifier so the stub UX feels alive before a real LLM is wired in.
function craftReply(userText: string, rangeAddress?: string): AnalysisResponse {
  const t = userText.toLowerCase();
  const ctx = rangeAddress ? ` (looking at ${rangeAddress})` : "";

  if (/(variance|flux|vs (last|prior))/.test(t)) {
    return {
      answer:
        `Here's a variance scaffold${ctx}. I'll compute current vs prior period and flag any account moving more than 10% or $50k. ` +
        `Once Azure OpenAI is configured, I'll ground these on your pulled trial balance and cite the source rows.`,
      citations: [],
      suggestedFormulas: [
        "=LET(cur, B2, prior, C2, IFERROR((cur-prior)/prior, 0))",
        "=IF(ABS(B2-C2) > 50000, \"flag\", \"\")",
      ],
    };
  }

  if (/(unusual|anomal|outlier|suspicious|risky)/.test(t)) {
    return {
      answer:
        `I'll scan for round-dollar entries, weekend/after-hours postings, manual top-side adjustments, and reversals${ctx}. ` +
        `Connect an ERP and I'll flag the actual JE IDs with reasoning.`,
      citations: [],
      suggestedFormulas: [
        "=IF(MOD(D2,1000)=0, \"round-dollar\", \"\")",
        "=IF(WEEKDAY(A2,2)>5, \"weekend posting\", \"\")",
      ],
    };
  }

  if (/(ar |aging|receivable|collect)/.test(t)) {
    return {
      answer:
        `For AR aging risk I'll bucket balances 0–30 / 31–60 / 61–90 / 90+ days, then highlight customers concentrated in the 90+ bucket and any whose share of >60-day debt grew month over month.`,
      citations: [],
      suggestedFormulas: [
        "=SUMIFS(AR[Amount], AR[Bucket], \">90\", AR[Customer], A2)",
      ],
    };
  }

  if (/(hello|hi|hey|what can you do|help)/.test(t)) {
    return {
      answer:
        `Hi! I'm ledgerlens. I can:\n• Pull GL data into your workbook (trial balance, journals, AP/AR aging)\n• Analyze a selected range — variance, anomalies, summaries\n• Suggest formulas you can drop into the active cell\n\nTry one of the chips above, or ask me anything about your books.`,
      citations: [],
      suggestedFormulas: [],
    };
  }

  return {
    answer:
      `I'd analyze that against your accounting data${ctx}. Right now I'm running on a stub — wire AZURE_OPENAI_* in server/.env to enable grounded answers. ` +
      `In the meantime, try "pull trial balance" or pick a chip above.`,
    citations: [],
    suggestedFormulas: [],
  };
}

chatRouter.post("/", async (req, res) => {
  const parsed = ChatSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }
  const last = [...parsed.data.messages].reverse().find((m) => m.role === "user");
  const reply = craftReply(last?.content ?? "", parsed.data.rangeAddress);

  // Slight artificial delay so the typing indicator is visible — replace with real streaming later.
  await new Promise((r) => setTimeout(r, 500));
  res.json(reply);
});
