#!/bin/sh
# Lightweight `az` replacement. Forwards to the Node-based IMDS shim so the
# kusto-mcp-server's AzureCliCredential can mint tokens via the App Service
# managed identity without installing the full Azure CLI.
exec node /app/scripts/az-imds-shim.js "$@"
