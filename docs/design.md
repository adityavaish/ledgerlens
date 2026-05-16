# pivot — design notes

## Personas
- **Accountant / Controller** — runs close, needs fast pulls of TB / JE detail with drill-through to source rows.
- **FP&A analyst** — builds variance and flux analyses; wants reusable templates.
- **Finance leader** — asks NL questions of the workbook, expects cited answers.

## Key flows
1. **Data pull** — user picks dataset + period → backend hits ERP/warehouse → rows stream into a new sheet as a structured Table.
2. **NL analysis** — user selects a range and asks a question → backend sends workbook context + question to Azure OpenAI with tool access to `/data` → returns answer + citations + suggested formulas.
3. **Templates** — saved combinations of pulls + analyses, runnable per period.

## Open decisions
- First ERP connector to build (D365 F&O vs NetSuite vs SAP vs warehouse-only).
- Auth model: Office SSO (Entra) vs on-behalf-of token exchange to ERP.
- Where workbook context lives during a chat session (server-side vs stateless).
- Row-level citation format: hyperlink to source row vs sidebar drill-through.

## Non-goals (initial)
- Writing journal entries back to the ERP.
- Replacing the close checklist tool — pivot augments, not replaces.
