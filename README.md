## Ledgerlens

> AI-driven Excel add-in for Finance and Accounting teams to fetch, explore, and analyze corporate accounting data directly from the spreadsheet.

**Host:** Microsoft Excel (Office.js add-in — Windows, Mac, Web)

### What it does

Ledgerlens drops a chat task pane into Excel that lets finance and accounting users:

- Pull GL data, trial balances, AP/AR aging, and journal entries from corporate systems (REST / SQL / SharePoint / Microsoft Graph / Azure Data Explorer / MCP servers) into a worksheet.
- Ask natural-language questions about the active workbook ("flag all JEs over $1M posted to intercompany accounts last quarter").
- Generate variance, flux, and close-readiness analyses with chart, formula, and pivot output written back to the sheet.
- Run multi-step `gather_data` reasoning chains with the GitHub Copilot SDK (default model: `claude-opus-4.6`).

### Architecture

Single Node.js package. In dev, `webpack-dev-server` hosts both the static taskpane and the API middlewares; in production, `server.js` (Express) serves the prebuilt `dist/` and mounts the same middlewares.

```
Excel (Office.js taskpane)  ──HTTPS──►  Express server (port 3002)
                                          ├── /api/chat-stream  → Copilot SDK
                                          ├── /api/kusto/*      → Azure Data Explorer
                                          ├── /api/mcp-stdio/*  → MCP stdio bridge
                                          └── /api/runtime-config, /health
```

Key directories:

```
src/
├── taskpane/      vanilla-JS chat UI, modals, settings panel
├── commands/      Office ribbon command function file
├── core/          ai-engine (action dispatch), excel-ops (30+ Excel actions), plugin-api
├── connectors/    csv, rest, sql, sharepoint, graph, kusto
├── server/        copilot-proxy (SSE), kusto-proxy, mcp-stdio-proxy, office-sso-middleware
└── services/      auth (MSAL + NAA), ai-service, mcp-client
infra/             Bicep for Azure App Service for Containers (azd)
Dockerfile         multi-stage Node 22 image, exposes :3002, runs as non-root
```

### Local dev (sideload into Excel)

Prereqs: Node ≥ 22, Excel desktop or Excel for the web, GitHub Copilot subscription, `gh auth login` (or `GITHUB_TOKEN` env var).

```pwsh
npm install
npm run start:desktop      # installs trusted dev cert, builds, sideloads into Excel
```

Excel opens with a Ledgerlens button on the Home tab. Click it to open the side pane. Stop with `npm run stop`.

To run the dev server alone (browser-debuggable at https://localhost:3002):

```pwsh
npm run dev-server
```

### Deploy to Azure (App Service for Containers)

Prereqs: [Azure Developer CLI (azd)](https://aka.ms/azd-install), [Docker Desktop](https://www.docker.com/products/docker-desktop), an Azure subscription.

```pwsh
azd auth login
azd env new ledgerlens-prod
azd env set GITHUB_TOKEN ghp_xxx                # Copilot SDK token
azd env set LEDGERLENS_COPILOT_MODEL claude-opus-4.6   # optional
azd up                                          # provisions ACR + App Service, builds & pushes image, deploys
```

The Bicep at `infra/` provisions:

- Azure Container Registry (Basic)
- Linux App Service Plan (B1) + Web App for Containers
- User-assigned managed identity with `AcrPull` on the registry
- Log Analytics workspace + Application Insights
- App settings: `WEBSITES_PORT=3002`, `GITHUB_TOKEN`, `LEDGERLENS_COPILOT_MODEL`, App Insights connection string

After `azd up` completes it prints `SERVICE_APP_URI` (e.g. `https://app-abc123.azurewebsites.net`). Point the manifest at it and re-sideload:

```pwsh
node scripts/set-manifest-host.js https://app-abc123.azurewebsites.net
npm run start:desktop
```

To go back to local: `node scripts/set-manifest-host.js --reset`.

### Distribute to other users

After deploying, share the published `manifest.xml` (with the App Service URL) via:

- **Microsoft 365 Admin Center → Integrated apps → Upload custom apps** (tenant-wide deployment)
- A SharePoint or network share configured as a **trusted add-in catalog** (Excel → File → Options → Trust Center → Trusted Add-in Catalogs)
- Submission to AppSource for global click-to-install
