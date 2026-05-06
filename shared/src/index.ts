// Shared DTOs between the Excel add-in and the backend.
// Keep these stable — they're effectively the public contract of Ledgerlens.

export interface JournalEntry {
  id: string;
  postedAt: string;
  companyCode: string;
  account: string;
  accountName: string;
  debit: number;
  credit: number;
  currency: string;
  memo?: string;
  source: string;
}

export interface TrialBalanceRow {
  account: string;
  accountName: string;
  openingBalance: number;
  debits: number;
  credits: number;
  closingBalance: number;
  currency: string;
  period: string;
}

export interface DataPullRequest {
  dataset: "trial_balance" | "journal_entries" | "ap_aging" | "ar_aging";
  period: { from: string; to: string };
  companyCodes?: string[];
  accounts?: string[];
}

export interface AnalysisRequest {
  question: string;
  rangeAddress?: string;
  workbookContextId?: string;
}

export interface AnalysisResponse {
  answer: string;
  citations: Array<{ rowId: string; reason: string }>;
  suggestedFormulas?: string[];
}
