/**
 * Pivot — Taskpane Entry Point.
 * Wires the UI to the AI engine, connector registry, auth, and settings.
 */

import "./taskpane.css";
import aiEngine from "../core/ai-engine.js";
import aiService from "../services/ai-service.js";
import authService from "../services/auth.js";
import connectorRegistry from "../connectors/connector-registry.js";
import mcpClient from "../services/mcp-client.js";
import "../core/plugin-api.js";

// Register built-in connectors
import CsvConnector from "../connectors/csv-connector.js";
import RestConnector from "../connectors/rest-connector.js";
import SharePointConnector from "../connectors/sharepoint-connector.js";
import GraphConnector from "../connectors/graph-connector.js";
import SqlConnector from "../connectors/sql-connector.js";
import KustoConnector from "../connectors/kusto-connector.js";

connectorRegistry.register(new CsvConnector());
connectorRegistry.register(new RestConnector());
connectorRegistry.register(new SqlConnector());
connectorRegistry.register(new SharePointConnector());
connectorRegistry.register(new GraphConnector());
connectorRegistry.register(new KustoConnector());

/* global Office */

// ── DOM References ──────────────────────────────────────────────────────
let $chat, $input, $sendBtn, $welcome;
let $panelSources, $panelSettings, $connectorsList;
let $modal, $modalTitle, $modalFields, $btnConnect, $btnDisconnect;
let $settingModel;
let $copilotStatus;
let $mcpModal, $mcpId, $mcpUrl, $mcpKey, $mcpTransport, $mcpToolsPreview, $btnMcpConnect, $btnMcpDisconnect;
let $mcpHttpFields, $mcpStdioFields, $mcpCommand, $mcpArgs, $mcpCwd, $mcpProxyUrl, $mcpImportStatus;
let _activeConnectorId = null;
let _activeMcpServerId = null;
let _commandHistory = [];
let _historyIndex = -1;

const DEFAULT_LOCAL_MCP_BRIDGE_URL = ""; // empty = same-origin (Pivot local server)

// ── Initialization ──────────────────────────────────────────────────────
if (typeof Office !== "undefined" && Office.onReady) {
  Office.onReady(({ host }) => {
    if (host === Office.HostType.Excel) {
      initUI();
      loadSettings();
    }
  });
} else {
  // Fallback: Office.js not loaded — init on DOMContentLoaded
  document.addEventListener("DOMContentLoaded", () => {
    initUI();
    loadSettings();
  });
}

function initUI() {
  $chat            = document.getElementById("chat");
  $input           = document.getElementById("input");
  $sendBtn         = document.getElementById("btn-send");
  $welcome         = document.getElementById("welcome");
  $panelSources    = document.getElementById("panel-sources");
  $panelSettings   = document.getElementById("panel-settings");
  $connectorsList  = document.getElementById("connectors-list");
  $modal           = document.getElementById("modal-connector");
  $modalTitle      = document.getElementById("modal-connector-title");
  $modalFields     = document.getElementById("modal-connector-fields");
  $btnConnect      = document.getElementById("btn-connect");
  $btnDisconnect   = document.getElementById("btn-disconnect");
  $settingModel    = document.getElementById("setting-model");
  $copilotStatus   = document.getElementById("copilot-status");

  // Chat input
  $input.addEventListener("input", onInputChange);
  $input.addEventListener("keydown", onInputKeydown);
  $sendBtn.addEventListener("click", sendCommand);

  // Quick-action chips
  document.querySelectorAll(".chip[data-cmd]").forEach((chip) => {
    chip.addEventListener("click", () => {
      $input.value = chip.dataset.cmd;
      onInputChange();
      sendCommand();
    });
  });

  // Header buttons
  document.getElementById("btn-sources").addEventListener("click", openSourcesPanel);
  document.getElementById("btn-settings").addEventListener("click", openSettingsPanel);
  document.getElementById("btn-user").addEventListener("click", toggleAuth);

  // Panel close buttons
  document.querySelectorAll(".panel-close").forEach((btn) => {
    btn.addEventListener("click", () => {
      btn.closest(".panel").classList.add("hidden");
    });
  });

  // Modal close
  document.querySelector(".modal-close").addEventListener("click", closeModal);

  // Settings save
  document.getElementById("btn-save-settings").addEventListener("click", saveSettings);

  // Connector modal actions
  $btnConnect.addEventListener("click", connectActiveConnector);
  $btnDisconnect.addEventListener("click", disconnectActiveConnector);

  // MCP modal
  $mcpModal         = document.getElementById("modal-mcp");
  $mcpId            = document.getElementById("mcp-id");
  $mcpUrl           = document.getElementById("mcp-url");
  $mcpKey           = document.getElementById("mcp-key");
  $mcpTransport     = document.getElementById("mcp-transport");
  $mcpToolsPreview  = document.getElementById("mcp-tools-preview");
  $btnMcpConnect    = document.getElementById("btn-mcp-connect");
  $btnMcpDisconnect = document.getElementById("btn-mcp-disconnect");
  $mcpHttpFields    = document.getElementById("mcp-http-fields");
  $mcpStdioFields   = document.getElementById("mcp-stdio-fields");
  $mcpCommand       = document.getElementById("mcp-command");
  $mcpArgs          = document.getElementById("mcp-args");
  $mcpCwd           = document.getElementById("mcp-cwd");
  $mcpProxyUrl      = document.getElementById("mcp-proxy-url");
  $mcpImportStatus  = document.getElementById("mcp-import-status");

  document.getElementById("btn-add-mcp").addEventListener("click", () => openMcpModal());
  document.getElementById("btn-import-local-mcp").addEventListener("click", importLocalMcpServers);
  document.querySelector(".modal-mcp-close").addEventListener("click", closeMcpModal);
  $btnMcpConnect.addEventListener("click", connectMcpServer);
  $btnMcpDisconnect.addEventListener("click", disconnectMcpServer);
  $mcpTransport.addEventListener("change", onMcpTransportChange);

  // Load saved MCP servers
  loadMcpServers();

  // Hydrate the user button from any cached MSAL account so the user can
  // see they're signed in (and as whom) on subsequent loads without having
  // to click the sign-in button again.
  authService.initialize().then(applyAuthUiState).catch(() => {});
}

// ── Chat ────────────────────────────────────────────────────────────────
function onInputChange() {
  $sendBtn.disabled = !$input.value.trim();
  autoResize($input);
}

function onInputKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    sendCommand();
  }
  // Command history navigation
  if (e.key === "ArrowUp" && _commandHistory.length > 0) {
    e.preventDefault();
    if (_historyIndex < _commandHistory.length - 1) _historyIndex++;
    $input.value = _commandHistory[_commandHistory.length - 1 - _historyIndex];
    onInputChange();
  }
  if (e.key === "ArrowDown") {
    e.preventDefault();
    if (_historyIndex > 0) {
      _historyIndex--;
      $input.value = _commandHistory[_commandHistory.length - 1 - _historyIndex];
    } else {
      _historyIndex = -1;
      $input.value = "";
    }
    onInputChange();
  }
  // Ctrl+L to clear chat
  if (e.key === "l" && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    clearChat();
  }
}

function autoResize(el) {
  el.style.height = "auto";
  el.style.height = Math.min(el.scrollHeight, 120) + "px";
}

async function sendCommand() {
  const text = $input.value.trim();
  if (!text) return;

  // Save to command history
  _commandHistory.push(text);
  _historyIndex = -1;

  // Hide welcome
  if ($welcome) {
    $welcome.remove();
    $welcome = null;
  }

  appendBubble(text, "user");
  $input.value = "";
  onInputChange();
  $sendBtn.disabled = true;
  $input.disabled = true;

  // Show thinking indicator with live steps
  const thinking = appendThinking();
  thinking.addStep("Reading spreadsheet context…");
  thinking.startTimer();

  // Small delay so the UI renders before the blocking fetch
  await new Promise((r) => setTimeout(r, 50));

  thinking.addStep("Sending to AI model…");

  const result = await aiEngine.execute(text, (step) => {
    thinking.addStep(step);
  });

  if (result.success) {
    thinking.addStep("Executing: " + (result.action || "respond").replace(/_/g, " "));
  }

  // Collapse thinking into a details control
  thinking.stopTimer();
  thinking.finish(result.success);

  if (result.success) {
    const tag = result.action && result.action !== "explain" ? result.action : null;
    appendBubble(result.message, "ai", tag);
  } else {
    appendBubble(result.message, "ai-error");
  }

  $sendBtn.disabled = false;
  $input.disabled = false;
  $input.focus();
}

function clearChat() {
  $chat.innerHTML = "";
  aiService.resetSession();
}

function appendBubble(text, type, actionTag) {
  const div = document.createElement("div");
  div.className = "bubble";

  if (type === "user") {
    div.classList.add("bubble-user");
    div.textContent = text;
  } else if (type === "ai-error") {
    div.classList.add("bubble-ai", "error");
    div.textContent = text;
  } else {
    div.classList.add("bubble-ai");
    if (actionTag) {
      const tag = document.createElement("span");
      tag.className = "action-tag";
      tag.textContent = actionTag.replace(/_/g, " ");
      div.appendChild(tag);
      div.appendChild(document.createElement("br"));
    }
    // Render markdown content as HTML when it contains formatting
    if (text && /(\|.*\|[\r\n]|^#{1,4} |^\- |\*\*)/m.test(text)) {
      div.innerHTML += renderMarkdown(text);
    } else {
      div.appendChild(document.createTextNode(text));
    }
  }

  $chat.appendChild(div);
  $chat.scrollTop = $chat.scrollHeight;
  return div;
}

/** Lightweight markdown renderer: tables, headers, bold, italic, bullet lists, code. */
function renderMarkdown(md) {
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const inline = (s) => {
    let r = esc(s);
    r = r.replace(/`([^`]+)`/g, "<code>$1</code>");
    r = r.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    r = r.replace(/\*(.+?)\*/g, "<em>$1</em>");
    return r;
  };

  const lines = md.split("\n");
  let html = "";
  let inTable = false;
  let headerDone = false;
  let inList = false;

  for (const line of lines) {
    const trimmed = line.trim();

    // Table rows
    if (trimmed.startsWith("|") && trimmed.endsWith("|")) {
      if (inList) { html += "</ul>"; inList = false; }
      const cells = trimmed.slice(1, -1).split("|").map((c) => c.trim());
      if (cells.every((c) => /^[-:]+$/.test(c))) continue;
      if (!inTable) {
        html += '<table class="md-table"><thead>';
        inTable = true;
        headerDone = false;
      }
      if (!headerDone) {
        html += "<tr>" + cells.map((c) => `<th>${inline(c)}</th>`).join("") + "</tr></thead><tbody>";
        headerDone = true;
      } else {
        html += "<tr>" + cells.map((c) => `<td>${inline(c)}</td>`).join("") + "</tr>";
      }
      continue;
    }

    if (inTable) { html += "</tbody></table>"; inTable = false; }

    // Headers
    const hMatch = trimmed.match(/^(#{1,4})\s+(.+)$/);
    if (hMatch) {
      if (inList) { html += "</ul>"; inList = false; }
      const level = hMatch[1].length;
      html += `<h${level + 1}>${inline(hMatch[2])}</h${level + 1}>`;
      continue;
    }

    // Bullet list items
    if (/^[-*]\s+/.test(trimmed)) {
      if (!inList) { html += "<ul>"; inList = true; }
      html += `<li>${inline(trimmed.replace(/^[-*]\s+/, ""))}</li>`;
      continue;
    }

    // End list if non-list line
    if (inList && trimmed) { html += "</ul>"; inList = false; }

    // Blank line or paragraph
    if (trimmed) {
      html += `<p>${inline(trimmed)}</p>`;
    }
  }

  if (inTable) html += "</tbody></table>";
  if (inList) html += "</ul>";
  return html;
}

function appendThinking() {
  const container = document.createElement("div");
  container.className = "thinking";

  const header = document.createElement("div");
  header.className = "thinking-header";
  header.innerHTML = `
    <span class="thinking-spinner"></span>
    <span class="thinking-label">Thinking…</span>
  `;
  container.appendChild(header);

  const stepsList = document.createElement("div");
  stepsList.className = "thinking-steps";
  container.appendChild(stepsList);

  $chat.appendChild(container);
  $chat.scrollTop = $chat.scrollHeight;

  const startTime = Date.now();
  let timerInterval = null;

  const timerEl = document.createElement("span");
  timerEl.className = "thinking-timer";
  timerEl.textContent = "0s";
  header.appendChild(timerEl);

  return {
    addStep(text) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      const step = document.createElement("div");
      step.className = "thinking-step";
      step.innerHTML = `<span class="thinking-step-icon">›</span> ${escapeHtml(text)} <span class="thinking-step-time">${elapsed}s</span>`;
      stepsList.appendChild(step);
      // Keep scroll at bottom so latest steps are visible through the fade mask
      stepsList.scrollTop = stepsList.scrollHeight;
      // Toggle fade mask: only show when there are enough steps to overflow
      if (stepsList.children.length <= 4) {
        stepsList.classList.add("no-fade");
      } else {
        stepsList.classList.remove("no-fade");
      }
      $chat.scrollTop = $chat.scrollHeight;
    },
    startTimer() {
      timerInterval = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTime) / 1000);
        timerEl.textContent = `${elapsed}s`;
      }, 1000);
    },
    stopTimer() {
      if (timerInterval) {
        clearInterval(timerInterval);
        timerInterval = null;
      }
    },
    finish(success) {
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);

      // Replace the live thinking with a collapsible details element
      const details = document.createElement("details");
      details.className = "thinking-collapsed";

      const summary = document.createElement("summary");
      summary.className = "thinking-summary";
      summary.innerHTML = `
        <span class="thinking-done-icon">${success ? "✓" : "✗"}</span>
        <span>Thought for ${elapsed}s</span>
      `;
      details.appendChild(summary);

      // Move steps inside the collapsed body
      const body = document.createElement("div");
      body.className = "thinking-collapsed-body";
      body.innerHTML = stepsList.innerHTML;
      details.appendChild(body);

      container.replaceWith(details);
    },
  };
}

// ── Data Sources Panel ──────────────────────────────────────────────────
function openSourcesPanel() {
  renderMcpServerList();
  renderConnectorList();
  $panelSources.classList.remove("hidden");
}

function renderConnectorList() {
  $connectorsList.innerHTML = "";
  connectorRegistry.getAll().forEach((c) => {
    const card = document.createElement("div");
    card.className = "connector-card";
    card.innerHTML = `
      <span class="connector-icon">${escapeHtml(c.icon)}</span>
      <div class="connector-info">
        <div class="connector-name">${escapeHtml(c.name)}</div>
        <div class="connector-status ${c.isConnected ? "connected" : ""}">${c.isConnected ? "Connected" : "Not connected"}</div>
      </div>
    `;
    card.addEventListener("click", () => openConnectorModal(c.id));
    $connectorsList.appendChild(card);
  });
}

// ── Connector Config Modal ──────────────────────────────────────────────
function openConnectorModal(connectorId) {
  const connector = connectorRegistry.get(connectorId);
  if (!connector) return;
  _activeConnectorId = connectorId;

  $modalTitle.textContent = `Configure ${connector.name}`;
  $modalFields.innerHTML = "";

  const schema = connector.configSchema;
  if (schema.length === 0) {
    $modalFields.innerHTML = '<p style="color:var(--text-muted);font-size:12px;">No configuration needed — connects using your signed-in account.</p>';
  } else {
    schema.forEach((field) => {
      const label = document.createElement("label");
      label.className = "field-label";
      label.textContent = field.label;
      label.setAttribute("for", `cfg-${field.key}`);

      const input = document.createElement("input");
      input.className = "field";
      input.id = `cfg-${field.key}`;
      input.type = field.type || "text";
      input.placeholder = field.placeholder || "";
      input.required = !!field.required;
      input.dataset.key = field.key;

      // Restore saved value
      const saved = loadConnectorConfig(connectorId);
      if (saved && saved[field.key]) input.value = saved[field.key];

      $modalFields.appendChild(label);
      $modalFields.appendChild(input);
    });
  }

  $btnConnect.classList.toggle("hidden", connector.isConnected);
  $btnDisconnect.classList.toggle("hidden", !connector.isConnected);
  $modal.classList.remove("hidden");
}

function closeModal() {
  $modal.classList.add("hidden");
  _activeConnectorId = null;
}

async function connectActiveConnector() {
  if (!_activeConnectorId) return;
  const connector = connectorRegistry.get(_activeConnectorId);
  if (!connector) return;

  // Gather config from modal fields
  const config = {};
  $modalFields.querySelectorAll("input[data-key]").forEach((el) => {
    config[el.dataset.key] = el.value.trim();
  });

  try {
    $btnConnect.textContent = "Connecting…";
    $btnConnect.disabled = true;
    await connector.connect(config, authService);
    saveConnectorConfig(_activeConnectorId, config);
    applyAuthUiState();
    closeModal();
    renderConnectorList();
  } catch (err) {
    const errDiv = $modalFields.querySelector(".modal-error");
    if (errDiv) errDiv.remove();
    const div = document.createElement("div");
    div.className = "modal-error";
    div.style.cssText = "color:#c0392b;background:#fdf0ef;border:1px solid #e74c3c;border-radius:6px;padding:8px 10px;margin-top:8px;font-size:12px;";
    div.textContent = err.message;
    $modalFields.appendChild(div);
  } finally {
    $btnConnect.textContent = "Connect";
    $btnConnect.disabled = false;
  }
}

async function disconnectActiveConnector() {
  if (!_activeConnectorId) return;
  const connector = connectorRegistry.get(_activeConnectorId);
  if (!connector) return;

  await connector.disconnect();
  closeModal();
  renderConnectorList();
}

// ── MCP Servers ─────────────────────────────────────────────────────────

function onMcpTransportChange() {
  const isStdio = $mcpTransport.value === "stdio";
  $mcpHttpFields.classList.toggle("hidden", isStdio);
  $mcpStdioFields.classList.toggle("hidden", !isStdio);
}

function getLocalMcpBridgeUrl() {
  // Default to same-origin: the Pivot local server itself hosts
  // /api/mcp-stdio/* and /api/mcp-config/discover. Power users can override
  // via localStorage to point at a separate bridge running elsewhere.
  try {
    const value = localStorage.getItem("pivot_local_mcp_bridge_url");
    if (!value) return DEFAULT_LOCAL_MCP_BRIDGE_URL;
    return value.replace(/\/+$/, "");
  } catch {
    return DEFAULT_LOCAL_MCP_BRIDGE_URL;
  }
}

function setLocalMcpBridgeUrl(url) {
  try {
    localStorage.setItem("pivot_local_mcp_bridge_url", (url || DEFAULT_LOCAL_MCP_BRIDGE_URL).replace(/\/+$/, ""));
  } catch { /* ignore */ }
}

function setMcpImportStatus(message, isError = false) {
  if (!$mcpImportStatus) return;
  $mcpImportStatus.textContent = message;
  $mcpImportStatus.style.color = isError ? "var(--danger,#c62828)" : "var(--text-muted,#666)";
  $mcpImportStatus.classList.toggle("hidden", !message);
}

function renderMcpServerList() {
  const container = document.getElementById("mcp-servers-list");
  container.innerHTML = "";

  const serverIds = mcpClient.serverIds;
  if (serverIds.length === 0) {
    container.innerHTML = '<p style="color:var(--text-muted);font-size:11px;padding:4px 0;">No MCP servers connected. Click + to add one.</p>';
    return;
  }

  for (const id of serverIds) {
    const session = mcpClient.getSession(id);
    const toolCount = session.tools.length;
    const promptCount = session.prompts.length;
    const isStdio = session.transport === "stdio";
    const card = document.createElement("div");
    card.className = "connector-card";
    card.innerHTML = `
      <span class="connector-icon">${isStdio ? "⚡" : "🔧"}</span>
      <div class="connector-info">
        <div class="connector-name">${escapeHtml(session.serverInfo?.name || id)}</div>
        <div class="connector-status connected">${isStdio ? "stdio" : "http"} · ${toolCount} tool${toolCount !== 1 ? "s" : ""}${promptCount > 0 ? `, ${promptCount} prompt${promptCount !== 1 ? "s" : ""}` : ""}</div>
      </div>
    `;
    card.addEventListener("click", () => openMcpModal(id));
    container.appendChild(card);
  }
}

function openMcpModal(serverId) {
  _activeMcpServerId = serverId || null;
  const isEdit = !!serverId && mcpClient.getSession(serverId);

  if (isEdit) {
    const session = mcpClient.getSession(serverId);
    const isStdio = session.transport === "stdio";
    document.getElementById("modal-mcp-title").textContent = `MCP: ${session.serverInfo?.name || serverId}`;
    $mcpId.value = serverId;
    $mcpId.disabled = true;
    $mcpTransport.value = isStdio ? "stdio" : (session._transport || "auto");
    $mcpTransport.disabled = true;

    // Show/hide correct field groups
    $mcpHttpFields.classList.toggle("hidden", isStdio);
    $mcpStdioFields.classList.toggle("hidden", !isStdio);

    if (isStdio) {
      $mcpCommand.value = session.command || "";
      $mcpCommand.disabled = true;
      $mcpArgs.value = (session.args || []).join(" ");
      $mcpArgs.disabled = true;
      $mcpCwd.value = session._cwd || "";
      $mcpCwd.disabled = true;
      $mcpProxyUrl.value = session._proxyBaseUrl || getLocalMcpBridgeUrl();
      $mcpProxyUrl.disabled = true;
    } else {
      $mcpUrl.value = session.url;
      $mcpUrl.disabled = true;
      $mcpKey.value = "";
      $mcpKey.disabled = true;
    }

    // Show tools and prompts preview
    $mcpToolsPreview.classList.remove("hidden");
    let previewHtml = `<p class="field-label" style="margin-top:0;">Tools (${session.tools.length}):</p>` +
      session.tools.map((t) =>
        `<div class="mcp-tool-item"><strong>${escapeHtml(t.name)}</strong><span class="mcp-tool-desc">${escapeHtml(t.description || "")}</span></div>`
      ).join("");

    if (session.prompts.length > 0) {
      previewHtml += `<p class="field-label" style="margin-top:8px;">Prompts (${session.prompts.length}):</p>` +
        session.prompts.map((p) =>
          `<div class="mcp-tool-item"><strong>${escapeHtml(p.name)}</strong><span class="mcp-tool-desc">${escapeHtml(p.description || "")}</span></div>`
        ).join("");
    }

    $mcpToolsPreview.innerHTML = previewHtml;

    $btnMcpConnect.classList.add("hidden");
    $btnMcpDisconnect.classList.remove("hidden");
  } else {
    document.getElementById("modal-mcp-title").textContent = "Add MCP Server";
    $mcpId.value = "";
    $mcpId.disabled = false;
    $mcpUrl.value = "";
    $mcpUrl.disabled = false;
    $mcpKey.value = "";
    $mcpKey.disabled = false;
    $mcpTransport.value = "auto";
    $mcpTransport.disabled = false;
    $mcpCommand.value = "";
    $mcpCommand.disabled = false;
    $mcpArgs.value = "";
    $mcpArgs.disabled = false;
    $mcpCwd.value = "";
    $mcpCwd.disabled = false;
    $mcpProxyUrl.value = getLocalMcpBridgeUrl();
    $mcpProxyUrl.disabled = false;
    $mcpHttpFields.classList.remove("hidden");
    $mcpStdioFields.classList.add("hidden");
    $mcpToolsPreview.classList.add("hidden");
    $mcpToolsPreview.innerHTML = "";
    $btnMcpConnect.classList.remove("hidden");
    $btnMcpDisconnect.classList.add("hidden");
  }

  $mcpModal.classList.remove("hidden");
}

function closeMcpModal() {
  $mcpModal.classList.add("hidden");
  _activeMcpServerId = null;
}

async function connectMcpServer() {
  const id = $mcpId.value.trim();
  const transport = $mcpTransport.value;
  const isStdio = transport === "stdio";

  if (!id) {
    alert("Server ID is required.");
    return;
  }

  if (isStdio) {
    const command = $mcpCommand.value.trim();
    if (!command) {
      alert("Command is required for stdio transport.");
      return;
    }
    const argsStr = $mcpArgs.value.trim();
    const args = argsStr ? argsStr.split(/\s+/) : [];
    const cwd = $mcpCwd.value.trim() || undefined;
    const proxyBaseUrl = ($mcpProxyUrl.value.trim() || getLocalMcpBridgeUrl()).replace(/\/+$/, "");

    try {
      $btnMcpConnect.textContent = "Connecting…";
      $btnMcpConnect.disabled = true;

      const session = await mcpClient.connectStdio(id, command, args, { cwd, proxyBaseUrl });

      setLocalMcpBridgeUrl(proxyBaseUrl);

      saveMcpServerConfig(id, { transport: "stdio", command, args: argsStr, cwd: cwd || "", proxyBaseUrl });

      showMcpConnectedPreview(session);
      renderMcpServerList();
    } catch (err) {
      alert(`MCP stdio connection failed: ${err.message}`);
    } finally {
      $btnMcpConnect.textContent = "Connect";
      $btnMcpConnect.disabled = false;
    }
  } else {
    const url = $mcpUrl.value.trim();
    const apiKey = $mcpKey.value.trim();

    if (!url) {
      alert("Server URL is required.");
      return;
    }

    try {
      $btnMcpConnect.textContent = "Connecting…";
      $btnMcpConnect.disabled = true;

      const session = await mcpClient.connect(id, url, { apiKey: apiKey || undefined, transport });

      saveMcpServerConfig(id, { url, apiKey, transport });

      showMcpConnectedPreview(session);
      renderMcpServerList();
    } catch (err) {
      alert(`MCP connection failed: ${err.message}`);
    } finally {
      $btnMcpConnect.textContent = "Connect";
      $btnMcpConnect.disabled = false;
    }
  }
}

function showMcpConnectedPreview(session) {
  $mcpToolsPreview.classList.remove("hidden");
  let previewHtml = `<p class="field-label" style="margin-top:0;">Connected — ${session.tools.length} tool${session.tools.length !== 1 ? "s" : ""} discovered:</p>` +
    session.tools.map((t) =>
      `<div class="mcp-tool-item"><strong>${escapeHtml(t.name)}</strong><span class="mcp-tool-desc">${escapeHtml(t.description || "")}</span></div>`
    ).join("");

  if (session.prompts.length > 0) {
    previewHtml += `<p class="field-label" style="margin-top:8px;">${session.prompts.length} prompt${session.prompts.length !== 1 ? "s" : ""}:</p>` +
      session.prompts.map((p) =>
        `<div class="mcp-tool-item"><strong>${escapeHtml(p.name)}</strong><span class="mcp-tool-desc">${escapeHtml(p.description || "")}</span></div>`
      ).join("");
  }

  $mcpToolsPreview.innerHTML = previewHtml;
}

async function disconnectMcpServer() {
  const id = _activeMcpServerId;
  if (!id) return;

  await mcpClient.disconnect(id);
  removeMcpServerConfig(id);
  closeMcpModal();
  renderMcpServerList();
}

function saveMcpServerConfig(id, config) {
  try {
    const all = JSON.parse(localStorage.getItem("pivot_mcp_servers") || "{}");
    if (config.transport === "stdio") {
      all[id] = {
        transport: "stdio",
        command: config.command,
        args: config.args,
        cwd: config.cwd || "",
        proxyBaseUrl: config.proxyBaseUrl || getLocalMcpBridgeUrl(),
        importedFrom: config.importedFrom || "",
      };
    } else {
      all[id] = {
        url: config.url,
        transport: config.transport || "auto",
        importedFrom: config.importedFrom || "",
      };
      // API key in sessionStorage for security
      if (config.apiKey) sessionStorage.setItem(`pivot_mcp_key_${id}`, config.apiKey);
    }
    localStorage.setItem("pivot_mcp_servers", JSON.stringify(all));
  } catch { /* ignore */ }
}

function removeMcpServerConfig(id) {
  try {
    const all = JSON.parse(localStorage.getItem("pivot_mcp_servers") || "{}");
    delete all[id];
    localStorage.setItem("pivot_mcp_servers", JSON.stringify(all));
    sessionStorage.removeItem(`pivot_mcp_key_${id}`);
  } catch { /* ignore */ }
}

async function loadMcpServers() {
  try {
    const raw = localStorage.getItem("pivot_mcp_servers");
    if (!raw) return;
    const servers = JSON.parse(raw);
    for (const [id, cfg] of Object.entries(servers)) {
      try {
        if (cfg.transport === "stdio") {
          const args = cfg.args ? cfg.args.split(/\s+/) : [];
          await mcpClient.connectStdio(id, cfg.command, args, {
            cwd: cfg.cwd || undefined,
            proxyBaseUrl: cfg.proxyBaseUrl || getLocalMcpBridgeUrl(),
          });
        } else {
          const apiKey = sessionStorage.getItem(`pivot_mcp_key_${id}`) || undefined;
          await mcpClient.connect(id, cfg.url, { apiKey, transport: cfg.transport || "auto" });
        }
      } catch {
        // Server unavailable at startup — ignore silently
      }
    }
  } catch { /* ignore */ }
}

async function importLocalMcpServers() {
  const proxyBaseUrl = getLocalMcpBridgeUrl();
  const label = proxyBaseUrl ? proxyBaseUrl : "this Pivot server";
  setMcpImportStatus(`Scanning local MCP configs via ${label}…`);

  try {
    const res = await fetch(`${proxyBaseUrl}/api/mcp-config/discover`);
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const payload = await res.json();
    const servers = Array.isArray(payload.servers) ? payload.servers : [];
    if (servers.length === 0) {
      setMcpImportStatus(
        "No MCP server configs were found. Looked for VS Code, GitHub Copilot CLI, Claude (Desktop/Code), Cursor, Windsurf, Continue, Roo, Cline and Zed config files. " +
        "Add servers in those clients (or set PIVOT_MCP_CONFIGS) and retry."
      );
      return;
    }

    let imported = 0;
    let skipped = 0;

    for (const server of servers) {
      try {
        if (server.transport === "stdio") {
          const session = await mcpClient.connectStdio(server.id, server.command, server.args || [], {
            cwd: server.cwd || undefined,
            env: server.env || {},
            proxyBaseUrl,
          });
          saveMcpServerConfig(server.id, {
            transport: "stdio",
            command: server.command,
            args: Array.isArray(server.args) ? server.args.join(" ") : "",
            cwd: server.cwd || "",
            proxyBaseUrl,
            importedFrom: server.sourcePath || server.source || "",
          });
          imported += session ? 1 : 0;
        } else if (server.url) {
          const session = await mcpClient.connect(server.id, server.url, { transport: server.transport || "auto" });
          saveMcpServerConfig(server.id, {
            url: server.url,
            transport: server.transport || "auto",
            importedFrom: server.sourcePath || server.source || "",
          });
          imported += session ? 1 : 0;
        }
      } catch {
        skipped++;
      }
    }

    renderMcpServerList();
    const detail = skipped > 0 ? ` (${skipped} skipped — check the server's command is on PATH)` : "";
    setMcpImportStatus(
      imported > 0
        ? `Imported ${imported} MCP server${imported === 1 ? "" : "s"}${detail}.`
        : `Found ${servers.length} server${servers.length === 1 ? "" : "s"} but none could be connected${detail}.`,
      imported === 0,
    );
  } catch (err) {
    setMcpImportStatus(
      `Could not reach the MCP discovery endpoint at ${label}. ` +
      `Make sure the Pivot local server is running (run \`pivot\`). ${err.message}`,
      true,
    );
  }
}

// ── Settings Panel ──────────────────────────────────────────────────────
function openSettingsPanel() {
  $panelSettings.classList.remove("hidden");
  loadCopilotStatus();
}

function saveSettings() {
  const model = $settingModel.value.trim();

  aiService.configure({ model: model || undefined });

  try {
    const store = {};
    if (model) store.model = model;
    localStorage.setItem("pivot_settings", JSON.stringify(store));
  } catch { /* storage unavailable */ }

  $panelSettings.classList.add("hidden");
}

function loadSettings() {
  try {
    const raw = localStorage.getItem("pivot_settings");
    if (raw) {
      const s = JSON.parse(raw);
      if (s.model) { $settingModel.value = s.model; }
      aiService.configure({ model: s.model });
    }
  } catch { /* storage unavailable */ }

  loadCopilotStatus();
}

async function loadCopilotStatus() {
  if (!$copilotStatus) return;

  $copilotStatus.textContent = "Checking Copilot configuration…";
  $copilotStatus.style.color = "var(--text-muted,#888)";

  try {
    const res = await authService.fetchApi("/api/status");
    if (!res.ok) {
      throw new Error(`HTTP ${res.status}`);
    }

    const status = await res.json();
    $copilotStatus.textContent = status.authMessage || "Copilot status unavailable.";
    $copilotStatus.style.color = status.authConfigured ? "var(--ok,#2e7d32)" : "var(--danger,#c62828)";
  } catch {
    $copilotStatus.textContent = "Could not read Copilot configuration status.";
    $copilotStatus.style.color = "var(--danger,#c62828)";
  }
}

// ── Auth Toggle ─────────────────────────────────────────────────────────
function applyAuthUiState() {
  const btn = document.getElementById("btn-user");
  const label = document.getElementById("user-label");
  if (!btn) return;
  if (authService.isSignedIn) {
    const u = authService.user;
    const name = u?.name || u?.email || "Signed in";
    btn.classList.add("signed-in");
    btn.title = `Signed in as ${u?.email || name} — click to sign out`;
    btn.setAttribute("aria-label", btn.title);
    if (label) label.textContent = name;
  } else {
    btn.classList.remove("signed-in");
    btn.title = "Sign in";
    btn.setAttribute("aria-label", "Sign in");
    if (label) label.textContent = "";
  }
}

async function toggleAuth() {
  const btn = document.getElementById("btn-user");
  if (authService.isSignedIn) {
    await authService.signOut();
    applyAuthUiState();
  } else {
    try {
      btn.disabled = true;
      await authService.signIn();
    } catch (err) {
      // Surface the sign-in failure inline so the user knows what happened
      // rather than seeing a silent no-op.
      console.error("[Pivot] sign-in failed:", err);
      const msg = err && err.message ? err.message : String(err);
      alert(`Sign-in failed: ${msg}`);
    } finally {
      btn.disabled = false;
    }
    applyAuthUiState();
  }
}

// ── Connector Config Persistence ────────────────────────────────────────
function saveConnectorConfig(id, config) {
  try {
    const all = JSON.parse(localStorage.getItem("pivot_connectors") || "{}");
    all[id] = config;
    localStorage.setItem("pivot_connectors", JSON.stringify(all));
  } catch { /* ignore */ }
}

function loadConnectorConfig(id) {
  try {
    const all = JSON.parse(localStorage.getItem("pivot_connectors") || "{}");
    return all[id] || null;
  } catch { return null; }
}

// ── Util ────────────────────────────────────────────────────────────────
function escapeHtml(str) {
  const el = document.createElement("span");
  el.textContent = str;
  return el.innerHTML;
}
