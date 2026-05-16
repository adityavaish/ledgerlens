## Ledgerlens

> AI-driven Excel add-in for Finance and Accounting teams to fetch, explore, and analyze corporate accounting data directly from the spreadsheet.

**Host:** Microsoft Excel (Office.js add-in — Windows desktop)

### What it does

Ledgerlens drops a chat task pane into Excel that lets finance and accounting users:

- Pull GL data, trial balances, AP/AR aging, and journal entries from corporate systems (REST / SQL / SharePoint / Microsoft Graph / Azure Data Explorer / MCP servers) into a worksheet.
- Ask natural-language questions about the active workbook ("flag all JEs over $1M posted to intercompany accounts last quarter").
- Generate variance, flux, and close-readiness analyses with chart, formula, and pivot output written back to the sheet.
- Run multi-step `gather_data` reasoning chains with the GitHub Copilot SDK (default model: `claude-opus-4.6`).

### Architecture

Ledgerlens runs entirely on the user's machine. A small launcher (`ledgerlens`) starts a local Node server on a random free port, generates an Excel add-in manifest pointing at that port, and sideloads it into Excel. The server hosts the taskpane bundle, proxies Copilot SDK chat, runs Azure Data Explorer queries directly via `azure-kusto-data`, and brokers any local stdio MCP servers the user configures.

```
Excel (taskpane @ http://localhost:<port>)
  └─► Local Node server (started by `ledgerlens`)
        ├── /api/chat-stream          → Copilot SDK
        ├── /api/kusto/{connect,query} → azure-kusto-data (withUserPrompt)
        ├── /api/mcp-stdio/*           → user-configured stdio MCP servers
        └── static dist/, manifest.xml, /health
```

Kusto auth runs locally with Azure CLI's pre-admin-consented public-client app id (`04b07795-…`) using the SDK's `withUserPrompt` flow — your default browser opens once, you sign in, and the cached token is reused for the rest of the session. No custom Entra app registration, no managed identity, no secrets.

Key directories:

```
bin/
└── ledgerlens.js   self-updating launcher (download/extract/spawn/sideload)
src/
├── taskpane/       vanilla-JS chat UI, modals, settings panel
├── commands/       Office ribbon command function file
├── core/           ai-engine (action dispatch), excel-ops (30+ Excel actions), plugin-api
├── connectors/     csv, rest, sql, sharepoint, graph, kusto
├── server/         copilot-proxy (SSE), mcp-stdio-proxy, kusto-local-proxy, office-sso-middleware
└── services/       auth (MSAL + NAA), ai-service, mcp-client
scripts/install.ps1            one-line installer (PowerShell)
.github/workflows/release.yml  builds the release tarball on tag push
manifest.xml.template          host-substituted at launch time
```

### Install (Windows)

The easiest way is the [**Ledgerlens install page**](https://adityavaish.github.io/ledgerlens/) — click **Install for Windows**, run the downloaded `Install-Ledgerlens.cmd`, then launch from the Start-menu shortcut it creates.

Power users who already have Node.js 22+ can run the installer directly from a PowerShell prompt:

```pwsh
iwr -UseBasicParsing https://raw.githubusercontent.com/adityavaish/ledgerlens/main/scripts/install.ps1 | iex
```

This downloads the latest release into `%LOCALAPPDATA%\ledgerlens\versions\<version>`, drops a `ledgerlens` shim into `%LOCALAPPDATA%\Programs\ledgerlens` (added to your user `PATH`), and creates Start-menu + Desktop shortcuts.

### Run

Open a new terminal and run:

```pwsh
ledgerlens
```

On first launch the script will:

1. Check `https://api.github.com/repos/adityavaish/ledgerlens/releases/latest` and upgrade in place if a newer version is published. Skip with `LEDGERLENS_SKIP_UPDATE=1`.
2. Pick a free localhost port (override with `LEDGERLENS_PORT=3002`).
3. Regenerate `manifest.xml` from the template with the chosen port baked into every URL.
4. Spawn `server.js` on that port and wait until it's ready.
5. Sideload the manifest into Excel desktop via `office-addin-debugging`.

Excel opens with a Ledgerlens button on the Home tab. Click it to open the taskpane and start chatting. Stop the server with `Ctrl+C`.

### Working from a checkout

```pwsh
npm install
npm run build
node bin/ledgerlens.js
```

If `bin/ledgerlens.js` is run from a repo checkout and no released version is cached yet, it runs the server out of the checkout directly. Set `LEDGERLENS_SKIP_UPDATE=1` when iterating locally so it doesn't pull a different version on every run.

For pure dev-server iteration (no Excel sideload, taskpane reachable in a normal browser):

```pwsh
npm run dev-server
```

### Releasing

Tag a commit `vX.Y.Z` and push the tag — `.github/workflows/release.yml` will build, run `npm pack`, and publish a `ledgerlens-X.Y.Z.tgz` plus the `install.ps1` script to the GitHub Release. The launcher fetches whichever release is marked **latest** on every run.

### Legacy: Azure App Service deployment

Earlier versions of Ledgerlens were hosted on Azure App Service for Containers. That deployment is still functional but is no longer the primary distribution channel — per-user auth to Azure Data Explorer from a shared cloud host requires an Entra app registration plus admin consent, which the local-runner architecture neatly avoids. The `Dockerfile`, `azure.yaml`, and `infra/` directories remain in the tree for anyone who needs that path.
