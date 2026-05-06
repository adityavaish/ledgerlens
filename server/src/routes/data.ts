import { Router } from "express";
import { z } from "zod";
import type { TrialBalanceRow, JournalEntry } from "../../../shared/src";

export const dataRouter = Router();

const PullSchema = z.object({
  dataset: z.enum(["trial_balance", "journal_entries", "ap_aging", "ar_aging"]),
  period: z.object({ from: z.string(), to: z.string() }),
  companyCodes: z.array(z.string()).optional(),
  accounts: z.array(z.string()).optional(),
});

dataRouter.post("/pull", (req, res) => {
  const parsed = PullSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.flatten() });
  }

  // TODO: route to the right ERP connector (D365 / NetSuite / SAP / warehouse).
  if (parsed.data.dataset === "trial_balance") {
    const rows: TrialBalanceRow[] = [
      {
        account: "1000",
        accountName: "Cash",
        openingBalance: 1_250_000,
        debits: 320_000,
        credits: 110_000,
        closingBalance: 1_460_000,
        currency: "USD",
        period: parsed.data.period.from.slice(0, 7),
      },
    ];
    return res.json({ rows });
  }

  const journals: JournalEntry[] = [];
  return res.json({ rows: journals });
});
