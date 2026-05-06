# Ledgerlens

> AI-driven Excel add-in for Finance teams to fetch, explore, and analyze corporate accounting data directly from the spreadsheet.

**Code name:** Ledgerlens
**Target host:** Microsoft Excel (Office.js add-in — Windows, Mac, Web)
**Status:** scaffold

## What it does

Ledgerlens drops a task pane into Excel that lets accounting and FP&A users:

- Pull GL data, trial balances, AP/AR aging, and journal entries from corporate accounting systems (ERP / data warehouse) into a worksheet.
- Ask natural-language questions about the active workbook ("flag all JEs over $1M posted to intercompany accounts last quarter").
- Generate variance, flux, and close-readiness analyses with one click; results are written back to the sheet with formulas and citations to source rows.
- Build reusable "data pulls" and analysis templates that other finance users can run.

## Architecture

```
┌────────────────────────┐        ┌─────────────────────────┐
│  Excel (Office.js)     │  HTTPS │  Backend API (Node/TS)  │
│  React task pane       │ ─────► │  - /data  (ERP fetch)   │
│  Office.js bindings    │        │  - /chat  (AI analysis) │
└────────────────────────┘        │  - /auth  (Entra ID)    │
                                  └───────────┬─────────────┘
                                              │
                              ┌───────────────┼───────────────┐
                              ▼               ▼               ▼
                        ERP / GL API    Data warehouse   Azure OpenAI
                        (SAP, D365,     (Snowflake,      (gpt-4o /
                         NetSuite…)      Synapse…)        reasoning)
```

## Repo layout

```
ledgerlens/
├── addin/          Office Add-in (task pane UI, manifest, Office.js)
├── server/         Backend API: ERP connectors + AI orchestration
├── shared/         Shared TS types (DTOs for accounting data)
└── docs/           Design notes, ERP connector specs
```

## Quickstart

```pwsh
# install (run from each subproject)
cd addin;  npm install
cd ../server; npm install

# dev — runs sideloaded Excel + backend together
npm run dev   # (root, once turborepo/concurrently is wired up)
```

Open Excel → Insert → My Add-ins → Ledgerlens (dev).

## Roadmap

- [ ] Auth via Entra ID (SSO into the workbook)
- [ ] First ERP connector (pick one: D365 F&O / NetSuite / SAP)
- [ ] Trial balance pull + pivot template
- [ ] NL → analysis pipeline with row-level citations
- [ ] Saved analysis templates and scheduling
