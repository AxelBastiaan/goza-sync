// ---- Auth: bounce to login on any 401 from the API ----
const _fetch = window.fetch;
window.fetch = async (...args) => {
  const res = await _fetch(...args);
  if (res.status === 401 && !String(args[0]).includes("/api/auth/login")) {
    window.location.href = "/login.html";
  }
  return res;
};

// ---- Nav ----
function switchView(view) {
  document.querySelectorAll(".nav-item").forEach((i) => i.classList.toggle("active", i.dataset.view === view));
  document.querySelectorAll(".view").forEach((v) => { v.hidden = v.id !== `view-${view}`; });
  // Re-read the store list on entry so a store connected since page load shows up.
  if (view === "import") loadImportStores();
}
document.querySelectorAll(".nav-item").forEach((item) => {
  item.addEventListener("click", () => switchView(item.dataset.view));
});

const PLATFORM_ICON = { tiktok: "♪", shopee: "🛍" };

const addForm = document.getElementById("add-form");
const addBtn = document.getElementById("add-btn");
const addBtnText = document.getElementById("add-btn-text");
const accurateSkuInput = document.getElementById("accurate-sku-input");
const refreshBtn = document.getElementById("refresh-btn");
const accordionList = document.getElementById("accordion-list");
const emptyState = document.getElementById("empty-state");
const message = document.getElementById("message");

let data = [];
let storeCount = 0;
const openAccordions = new Set();
let modalSku = null;

function showMessage(text, type) {
  message.textContent = text;
  message.className = `message ${type}`;
  message.hidden = false;
  setTimeout(() => { message.hidden = true; }, 4000);
}

function unitLabel(entry, unitLevel) {
  const unit = entry.units && entry.units[unitLevel];
  if (unit) return `${unit.name} (${unit.ratio}:1)`;
  return entry.stockKnown ? `level ${unitLevel} (not found)` : `level ${unitLevel}`;
}

function render() {
  accordionList.innerHTML = "";

  if (data.length === 0) {
    emptyState.hidden = false;
    return;
  }
  emptyState.hidden = true;

  for (const entry of data) {
    const wrap = document.createElement("div");
    wrap.className = "accordion" + (openAccordions.has(entry.accurateSku) ? " open" : "");

    const header = document.createElement("div");
    header.className = "accordion-header";

    const chevron = document.createElement("span");
    chevron.className = "chevron";
    chevron.textContent = "▶";

    const title = document.createElement("span");
    title.className = "accordion-title";
    title.textContent = entry.accurateSku;

    const stock = document.createElement("span");
    stock.className = "accordion-stock";
    if (entry.stock !== null) {
      stock.textContent = `${entry.stock.toLocaleString()} PCS`;
    } else if (entry.stockKnown) {
      stock.textContent = "not found in Accurate";
    } else {
      stock.className += " muted";
      stock.textContent = "loading stock…";
    }

    const gearBtn = document.createElement("button");
    gearBtn.className = "icon-btn";
    gearBtn.textContent = "⚙";
    gearBtn.title = "Manage mappings";
    gearBtn.addEventListener("click", (e) => { e.stopPropagation(); openModal(entry.accurateSku); });

    header.append(chevron, title, stock, gearBtn);
    header.addEventListener("click", () => {
      if (openAccordions.has(entry.accurateSku)) openAccordions.delete(entry.accurateSku);
      else openAccordions.add(entry.accurateSku);
      render();
    });

    const body = document.createElement("div");
    body.className = "accordion-body";
    const table = document.createElement("table");
    table.innerHTML = "<thead><tr><th>Marketplace SKU</th><th></th><th>Unit</th><th>Stock</th></tr></thead>";
    const tbody = document.createElement("tbody");
    for (const m of entry.mappings) {
      const row = document.createElement("tr");

      const skuCell = document.createElement("td");
      if (m.marketplaceSku) {
        skuCell.textContent = m.marketplaceSku + " ";
        if (m.isDefault) {
          const badge = document.createElement("span");
          badge.className = "badge default";
          badge.textContent = "default";
          skuCell.appendChild(badge);
        }
      } else {
        skuCell.innerHTML = '<span class="muted">not set</span>';
      }

      const storesCell = document.createElement("td");
      const storesLink = document.createElement("a");
      storesLink.className = "stores-link";
      storesLink.textContent = `${storeCount} store${storeCount === 1 ? "" : "s"}`;
      storesLink.addEventListener("click", () => openStores(m.id));
      storesCell.appendChild(storesLink);

      const unitCell = document.createElement("td");
      unitCell.textContent = unitLabel(entry, m.unitLevel);
      const stockCell = document.createElement("td");
      if (m.stock !== null) stockCell.textContent = m.stock;
      else if (entry.stockKnown) stockCell.textContent = "—";
      else stockCell.innerHTML = '<span class="muted">…</span>';

      row.append(skuCell, storesCell, unitCell, stockCell);
      tbody.appendChild(row);
    }
    table.appendChild(tbody);
    body.appendChild(table);

    wrap.append(header, body);
    accordionList.appendChild(wrap);
  }
}

// Carries stock/unit figures we already have over to a freshly-fetched list, so
// phase 1 below never blanks out numbers that are still perfectly good.
function reuseKnownStock(fresh) {
  const previous = new Map(data.map((e) => [e.accurateSku, e]));
  for (const entry of fresh) {
    const old = previous.get(entry.accurateSku);
    if (!old || !old.stockKnown) continue;

    entry.stockKnown = true;
    entry.stock = old.stock;
    entry.units = old.units;
    for (const m of entry.mappings) {
      const oldMapping = old.mappings.find((x) => x.id === m.id && x.unitLevel === m.unitLevel);
      if (oldMapping) {
        m.stock = oldMapping.stock;
        m.unitName = oldMapping.unitName;
        m.ratio = oldMapping.ratio;
      }
    }
  }
  return fresh;
}

// Only the newest load may write to `data` — an older, slower phase 2 landing
// late would otherwise clobber a newer list (e.g. right after a delete).
let loadToken = 0;

// Two phases on purpose: the mappings themselves come from the local DB and are
// instant, while the stock figures need one rate-limited Accurate call per SKU
// and can take many seconds. Rendering phase 1 first keeps the list on screen
// instead of blanking it out on every refresh.
async function loadAccurateSkus({ fresh = false } = {}) {
  const token = ++loadToken;

  try {
    const quickRes = await fetch("/api/accurate-skus?stock=skip");
    if (token !== loadToken) return;
    if (quickRes.ok) {
      data = reuseKnownStock(await quickRes.json());
      render();
    }
  } catch (err) {
    // Non-fatal: the full request below reports any real connectivity problem.
  }

  const res = await fetch(`/api/accurate-skus${fresh ? "?fresh=1" : ""}`);
  if (token !== loadToken) return;
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    showMessage(result.error || "Failed to load stock from Accurate", "error");
    return;
  }
  data = await res.json();
  render();
}

async function loadStoreCount() {
  const res = await fetch("/api/stores");
  const stores = await res.json();
  storeCount = stores.length;
}

addForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  const accurateSku = accurateSkuInput.value.trim();
  if (!accurateSku) return;

  addBtn.disabled = true;
  addBtnText.innerHTML = '<span class="spinner"></span> Searching…';

  try {
    const res = await fetch("/api/accurate-skus", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ accurateSku }),
    });
    const result = await res.json();

    if (!res.ok) {
      showMessage(result.error || "Failed to add SKU", "error");
      return;
    }

    accurateSkuInput.value = "";
    await loadAccurateSkus();
    showMessage(`Added "${accurateSku}"`, "success");
  } catch (err) {
    showMessage("Failed to reach the server", "error");
  } finally {
    addBtn.disabled = false;
    addBtnText.textContent = "Add";
  }
});

refreshBtn.addEventListener("click", async () => {
  refreshBtn.disabled = true;
  try {
    await loadAccurateSkus({ fresh: true });
    showMessage("Stock refreshed from Accurate", "success");
  } catch (err) {
    showMessage("Failed to refresh", "error");
  } finally {
    refreshBtn.disabled = false;
  }
});

// ---- Settings modal ----
const modalOverlay = document.getElementById("modal-overlay");
const modalTitle = document.getElementById("modal-title");
const modalRows = document.getElementById("modal-rows");
const addRowBtn = document.getElementById("add-row-btn");

function openModal(accurateSku) {
  modalSku = accurateSku;
  modalTitle.textContent = `Mappings for ${accurateSku}`;
  renderModal();
  modalOverlay.classList.add("open");
}

function renderModal() {
  const entry = data.find((d) => d.accurateSku === modalSku);
  modalRows.innerHTML = "";

  for (const m of entry.mappings) {
    const row = document.createElement("div");
    row.className = "modal-row";

    const label = document.createElement("span");
    label.className = "row-label";
    label.textContent = m.isDefault ? "Default" : "";
    row.appendChild(label);

    const input = document.createElement("input");
    input.type = "text";
    input.placeholder = "Marketplace SKU (blank = disabled)";
    input.value = m.marketplaceSku || "";
    input.addEventListener("change", () => saveMappingRow(m.id, input.value.trim() || null, m.unitLevel));
    row.appendChild(input);

    const select = document.createElement("select");
    if (!entry.units) {
      // Units come from Accurate; until that lands there is nothing to pick from.
      const opt = document.createElement("option");
      opt.value = String(m.unitLevel);
      opt.textContent = entry.stockKnown ? `level ${m.unitLevel} (not found in Accurate)` : "loading units…";
      select.appendChild(opt);
      select.disabled = true;
    }
    for (const [level, unit] of Object.entries(entry.units || {})) {
      const opt = document.createElement("option");
      opt.value = level;
      opt.textContent = `${unit.name} (${unit.ratio}:1)`;
      if (Number(level) === m.unitLevel) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener("change", () => saveMappingRow(m.id, m.marketplaceSku, Number(select.value)));
    row.appendChild(select);

    const delBtn = document.createElement("button");
    delBtn.className = "danger";
    delBtn.textContent = "Remove";
    delBtn.title = "Remove this mapping";
    delBtn.addEventListener("click", () => deleteMappingRow(m.id));
    row.appendChild(delBtn);

    modalRows.appendChild(row);
  }
}

async function saveMappingRow(id, marketplaceSku, unitLevel) {
  const res = await fetch(`/api/mappings/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketplaceSku, unitLevel }),
  });
  const result = await res.json();

  if (!res.ok) {
    showMessage(result.error || "Failed to save mapping", "error");
  }

  await loadAccurateSkus();
  renderModal();
}

async function deleteMappingRow(id) {
  const res = await fetch(`/api/mappings/${id}`, { method: "DELETE" });

  if (!res.ok && res.status !== 204) {
    const result = await res.json().catch(() => ({}));
    showMessage(result.error || "Failed to remove mapping", "error");
    return;
  }

  await loadAccurateSkus();
  renderModal();
}

addRowBtn.addEventListener("click", async () => {
  const entry = data.find((d) => d.accurateSku === modalSku);
  const usedLevels = new Set(entry.mappings.map((m) => m.unitLevel));
  const availableLevels = Object.keys(entry.units || {}).map(Number);
  const unitLevel = availableLevels.find((l) => !usedLevels.has(l)) ?? availableLevels[0];
  if (!unitLevel) {
    showMessage(
      entry.stockKnown ? `No units available for "${modalSku}" in Accurate` : "Still loading units from Accurate — try again in a moment",
      "error"
    );
    return;
  }

  const res = await fetch(`/api/accurate-skus/${encodeURIComponent(modalSku)}/mappings`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ marketplaceSku: null, unitLevel }),
  });
  const result = await res.json();

  if (!res.ok) {
    showMessage(result.error || "Failed to add mapping", "error");
    return;
  }

  await loadAccurateSkus();
  renderModal();
});

document.getElementById("modal-close-btn").addEventListener("click", () => {
  modalOverlay.classList.remove("open");
  render();
});
modalOverlay.addEventListener("click", (e) => {
  if (e.target === modalOverlay) {
    modalOverlay.classList.remove("open");
    render();
  }
});

// ---- Stores popup ----
const storesOverlay = document.getElementById("stores-overlay");
const storesTitle = document.getElementById("stores-title");
const storesRows = document.getElementById("stores-rows");

async function openStores(mappingId) {
  storesTitle.textContent = "Stores";
  storesRows.innerHTML = "<p class=\"muted\">Loading…</p>";
  storesOverlay.classList.add("open");

  try {
    const res = await fetch(`/api/mappings/${mappingId}/store-status`);
    const stores = await res.json();

    storesRows.innerHTML = "";
    for (const s of stores) {
      const row = document.createElement("div");
      row.className = "store-row";
      row.innerHTML = `
        <span class="store-name-wrap">
          <span class="platform-icon ${s.platform}">${PLATFORM_ICON[s.platform] || "?"}</span>
          <span class="store-name">${s.storeName}</span>
        </span>
        <span class="store-status ${s.found ? "found" : "not-found"}">${s.found ? `✓ Found${s.quantity !== undefined ? ` — qty ${s.quantity.toLocaleString()}` : ""}` : "Not found"}</span>
      `;
      storesRows.appendChild(row);
    }
  } catch (err) {
    storesRows.innerHTML = '<p class="muted">Failed to load store status.</p>';
  }
}

document.getElementById("stores-close-btn").addEventListener("click", () => {
  storesOverlay.classList.remove("open");
});
storesOverlay.addEventListener("click", (e) => {
  if (e.target === storesOverlay) {
    storesOverlay.classList.remove("open");
  }
});

// ---- Sync ----
const syncBtnTiktok = document.getElementById("sync-btn-tiktok");
const syncBtnShopee = document.getElementById("sync-btn-shopee");
const syncMessage = document.getElementById("sync-message");
const syncSummaryDetails = document.getElementById("sync-summary-details");

function showSyncMessage(text, type) {
  syncMessage.textContent = text;
  syncMessage.className = `message ${type}`;
  syncMessage.hidden = false;
}

function syncResultToSummaryEntry(r) {
  const label = r.marketplaceSku || r.accurateSku;
  return { marketplaceSku: r.storeName ? `${label} (${r.storeName})` : label, reason: r.message || r.status };
}

function renderSyncSummary(results) {
  const synced = results.filter((r) => r.status === "synced");
  const errors = results.filter((r) => r.status === "error");
  const skipped = results.filter((r) => r.status !== "synced" && r.status !== "error");

  showSyncMessage(
    `Synced: ${synced.length}, Skipped: ${skipped.length}, Errors: ${errors.length}`,
    errors.length > 0 ? "error" : "success"
  );

  syncSummaryDetails.innerHTML = "";
  if (skipped.length > 0) {
    syncSummaryDetails.appendChild(buildSummaryGroup("Skipped", skipped.map(syncResultToSummaryEntry)));
  }
  if (errors.length > 0) {
    syncSummaryDetails.appendChild(buildSummaryGroup("Errors", errors.map(syncResultToSummaryEntry)));
  }
}

async function runSync(button, endpoint, label) {
  const originalText = button.textContent;
  button.disabled = true;
  button.textContent = "Syncing…";
  syncMessage.hidden = true;
  syncSummaryDetails.innerHTML = "";

  try {
    const res = await fetch(endpoint, { method: "POST" });
    const results = await res.json();

    if (!res.ok) {
      showSyncMessage(results.error || `${label} sync failed`, "error");
      return;
    }

    if (results.length === 0) {
      showSyncMessage("No mappings to sync.", "success");
    } else {
      renderSyncSummary(results);
    }
    await loadAccurateSkus();
  } catch (err) {
    showSyncMessage(`${label} sync failed: could not reach the server`, "error");
  } finally {
    button.disabled = false;
    button.textContent = originalText;
  }
}

syncBtnTiktok.addEventListener("click", () => runSync(syncBtnTiktok, "/api/sync", "TikTok"));
syncBtnShopee.addEventListener("click", () => runSync(syncBtnShopee, "/api/sync/shopee", "Shopee"));

loadStoreCount().then(loadAccurateSkus);

const liveModeBanner = document.getElementById("live-mode-banner");
const liveModeToggle = document.getElementById("live-mode-toggle");
const liveModeLabel = document.getElementById("live-mode-label");

function renderLiveMode(live) {
  liveModeToggle.checked = live;
  liveModeBanner.classList.toggle("live", live);
  liveModeLabel.textContent = `Live Mode: ${live ? "ON" : "OFF"}`;
}

async function loadLiveMode() {
  const res = await fetch("/api/settings/live-mode");
  const data = await res.json();
  renderLiveMode(data.live);
}

liveModeToggle.addEventListener("change", async () => {
  const wantsLive = liveModeToggle.checked;

  if (wantsLive && !confirm("Turning Live Mode ON means real TikTok orders will create real Sales Orders/Delivery Orders/Invoices in Accurate. Continue?")) {
    liveModeToggle.checked = false;
    return;
  }

  const res = await fetch("/api/settings/live-mode", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ live: wantsLive }),
  });

  const data = await res.json();
  renderLiveMode(data.live);
});

loadLiveMode();

// ---- Users ----
const usersList = document.getElementById("users-list");
const addUserForm = document.getElementById("add-user-form");
const newUsernameInput = document.getElementById("new-username-input");
const newPasswordInput = document.getElementById("new-password-input");
const addUserBtn = document.getElementById("add-user-btn");
const usersMessage = document.getElementById("users-message");

function showUsersMessage(text, type) {
  usersMessage.textContent = text;
  usersMessage.className = `message ${type}`;
  usersMessage.hidden = false;
  setTimeout(() => { usersMessage.hidden = true; }, 4000);
}

async function loadUsers() {
  const res = await fetch("/api/auth/users");
  const users = await res.json();
  usersList.innerHTML = users.map((u) => `<div class="accordion-header"><span class="accordion-title">${u.username}</span></div>`).join("");
}

addUserForm.addEventListener("submit", async (e) => {
  e.preventDefault();
  addUserBtn.disabled = true;
  try {
    const res = await fetch("/api/auth/users", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ username: newUsernameInput.value, password: newPasswordInput.value }),
    });
    const body = await res.json();
    if (!res.ok) {
      showUsersMessage(body.error || "Could not add user", "error");
      return;
    }
    addUserForm.reset();
    showUsersMessage(`User "${body.username}" added`, "success");
    loadUsers();
  } finally {
    addUserBtn.disabled = false;
  }
});

loadUsers();

document.getElementById("logout-btn").addEventListener("click", async () => {
  await fetch("/api/auth/logout", { method: "POST" });
  window.location.href = "/login.html";
});

// ---- Integrations ----
const integrationsList = document.getElementById("integrations-list");
const integrationsMessage = document.getElementById("integrations-message");

function showIntegrationsMessage(text, type) {
  integrationsMessage.textContent = text;
  integrationsMessage.className = `message ${type}`;
  integrationsMessage.hidden = false;
}

async function loadIntegrations() {
  const res = await fetch("/api/integrations");
  const platforms = await res.json();

  integrationsList.innerHTML = "";
  for (const p of platforms) {
    if (p.platform === "accurate") {
      integrationsList.appendChild(renderAccurateGroup(p));
      continue;
    }

    const group = document.createElement("div");
    group.className = "platform-group";

    const header = document.createElement("div");
    header.className = "platform-group-header";
    header.innerHTML = `<span class="platform-icon ${p.platform}">${PLATFORM_ICON[p.platform] || "?"}</span><span class="platform-group-title">${p.name}</span>`;
    group.appendChild(header);

    if (p.stores.length === 0) {
      const note = document.createElement("p");
      note.className = "empty-note";
      note.textContent = "No stores connected yet.";
      group.appendChild(note);
    } else {
      for (const s of p.stores) {
        const row = document.createElement("div");
        row.className = "store-row";
        row.innerHTML = `
          <div class="store-info"><div class="store-name">${s.name}</div></div>
        `;
        const statusBadge = document.createElement("span");
        statusBadge.className = "status-badge connected";
        statusBadge.textContent = "Connected";
        row.appendChild(statusBadge);

        const disconnectBtn = document.createElement("button");
        disconnectBtn.className = "danger";
        disconnectBtn.textContent = "Disconnect";
        disconnectBtn.title = `Disconnect ${s.name}`;
        disconnectBtn.addEventListener("click", () => disconnectStore(s.id, s.name));
        row.appendChild(disconnectBtn);

        group.appendChild(row);
      }
    }

    const btn = document.createElement("button");
    btn.className = "secondary";
    btn.textContent = `+ Integrate ${p.stores.length > 0 ? "another" : "a"} ${p.name} store`;
    btn.addEventListener("click", () => startIntegration(p.platform));
    group.appendChild(btn);

    integrationsList.appendChild(group);
  }

  return platforms;
}

function renderAccurateGroup(p) {
  const group = document.createElement("div");
  group.className = "platform-group";

  const header = document.createElement("div");
  header.className = "platform-group-header";
  header.innerHTML = `<span class="platform-icon accurate">A</span><span class="platform-group-title">${p.name}</span>`;
  group.appendChild(header);

  if (p.connected) {
    const row = document.createElement("div");
    row.className = "store-row";
    row.innerHTML = `<div class="store-info"><div class="store-name">Accurate Online</div></div>`;

    const statusBadge = document.createElement("span");
    statusBadge.className = "status-badge connected";
    statusBadge.textContent = "Connected";
    row.appendChild(statusBadge);

    const disconnectBtn = document.createElement("button");
    disconnectBtn.className = "danger";
    disconnectBtn.textContent = "Disconnect";
    disconnectBtn.title = "Disconnect Accurate Online";
    disconnectBtn.addEventListener("click", () => disconnectAccurate());
    row.appendChild(disconnectBtn);

    group.appendChild(row);
  } else {
    const note = document.createElement("p");
    note.className = "empty-note";
    note.textContent = "Not connected. Enter your Accurate Online app credentials below.";
    group.appendChild(note);

    const form = document.createElement("form");
    form.className = "accurate-connect-form";
    form.innerHTML = `
      <input type="text" id="accurate-app-key" placeholder="App Key" autocomplete="off" required />
      <input type="text" id="accurate-signature-secret" placeholder="Signature Secret" autocomplete="off" required />
      <input type="text" id="accurate-api-token" placeholder="API Token" autocomplete="off" required />
      <button type="submit" id="accurate-connect-btn">Connect</button>
    `;
    form.addEventListener("submit", connectAccurate);
    group.appendChild(form);
  }

  return group;
}

async function connectAccurate(e) {
  e.preventDefault();
  const appKey = document.getElementById("accurate-app-key").value.trim();
  const signatureSecret = document.getElementById("accurate-signature-secret").value.trim();
  const apiToken = document.getElementById("accurate-api-token").value.trim();
  const btn = document.getElementById("accurate-connect-btn");

  btn.disabled = true;
  btn.textContent = "Connecting…";
  try {
    const res = await fetch("/api/integrations/accurate/connect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ appKey, signatureSecret, apiToken }),
    });
    const result = await res.json();
    if (!res.ok) {
      showIntegrationsMessage(result.error || "Failed to connect to Accurate", "error");
      btn.disabled = false;
      btn.textContent = "Connect";
      return;
    }
    showIntegrationsMessage("Connected to Accurate Online.", "success");
    await loadIntegrations();
  } catch (err) {
    showIntegrationsMessage("Failed to reach the server", "error");
    btn.disabled = false;
    btn.textContent = "Connect";
  }
}

async function disconnectAccurate() {
  if (!confirm("Disconnect Accurate Online? Stock sync will stop working until you reconnect.")) return;

  const res = await fetch("/api/integrations/accurate/disconnect", { method: "POST" });
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    showIntegrationsMessage(result.error || "Failed to disconnect Accurate", "error");
    return;
  }
  showIntegrationsMessage("Accurate Online disconnected.", "success");
  await loadIntegrations();
}

async function disconnectStore(id, name) {
  if (!confirm(`Disconnect "${name}"? You'll need to re-authorize it to sync again.`)) return;

  const res = await fetch(`/api/integrations/stores/${id}`, { method: "DELETE" });
  if (!res.ok) {
    const result = await res.json().catch(() => ({}));
    showIntegrationsMessage(result.error || "Failed to disconnect store", "error");
    return;
  }
  showIntegrationsMessage(`"${name}" disconnected.`, "success");
  await loadIntegrations();
}

async function startIntegration(platform) {
  try {
    const res = await fetch(`/api/integrations/${platform}/auth-url`);
    const result = await res.json();
    if (!res.ok || !result.url) {
      showIntegrationsMessage(result.error || "Failed to build authorization link", "error");
      return;
    }
    window.open(result.url, "_blank");
  } catch (err) {
    showIntegrationsMessage("Failed to reach the server", "error");
  }
}

loadIntegrations();

// ---- Import ----
const importStorePicker = document.getElementById("import-store-picker");
const importScanBtn = document.getElementById("import-scan-btn");
const importMessage = document.getElementById("import-message");
const importTable = document.getElementById("import-table");
const importRows = document.getElementById("import-rows");
const importCommitBtn = document.getElementById("import-commit-btn");
const importSummaryDetails = document.getElementById("import-summary-details");

let importScanResults = [];

function showImportMessage(text, type) {
  importMessage.textContent = text;
  importMessage.className = `message ${type}`;
  importMessage.hidden = false;
}

function buildSummaryGroup(title, entries) {
  const details = document.createElement("details");
  details.className = "import-summary-group";
  details.open = true;

  const summary = document.createElement("summary");
  summary.textContent = `${title} (${entries.length})`;
  details.appendChild(summary);

  const list = document.createElement("ul");
  for (const entry of entries) {
    const li = document.createElement("li");
    li.textContent = `${entry.marketplaceSku} — ${entry.reason}`;
    list.appendChild(li);
  }
  details.appendChild(list);

  return details;
}

function renderImportSummary(result) {
  const syncedCount = result.created.length;
  const skippedCount = result.skipped.length;
  const errorCount = result.errors.length;

  showImportMessage(
    `Synced: ${syncedCount}, Skipped: ${skippedCount}, Errors: ${errorCount}`,
    errorCount > 0 ? "error" : "success"
  );

  importSummaryDetails.innerHTML = "";
  if (skippedCount > 0) {
    importSummaryDetails.appendChild(buildSummaryGroup("Skipped", result.skipped));
  }
  if (errorCount > 0) {
    importSummaryDetails.appendChild(buildSummaryGroup("Errors", result.errors));
  }
}

async function loadImportStores() {
  let platforms;
  try {
    const res = await fetch("/api/integrations");
    if (!res.ok) throw new Error("request failed");
    platforms = await res.json();
  } catch (err) {
    importStorePicker.innerHTML = '<option value="">Could not load stores</option>';
    return;
  }

  const options = [];
  for (const p of platforms) {
    // Accurate is a single global connection, not a marketplace with stores, so
    // it comes back without a `stores` array — importing never targets it either.
    for (const s of p.stores || []) {
      options.push({ id: s.id, label: `${s.name} (${p.name})` });
    }
  }

  const previous = importStorePicker.value;
  importStorePicker.innerHTML = options.length === 0
    ? '<option value="">No stores connected yet</option>'
    : options.map((o) => `<option value="${o.id}">${o.label}</option>`).join("");
  if (previous && options.some((o) => String(o.id) === previous)) {
    importStorePicker.value = previous;
  }
}

function renderImportResults() {
  importRows.innerHTML = "";

  if (importScanResults.length === 0) {
    importTable.hidden = true;
    importCommitBtn.hidden = true;
    return;
  }

  importTable.hidden = false;
  importCommitBtn.hidden = false;

  for (const r of importScanResults) {
    const row = document.createElement("tr");
    row.className = "import-row" + (r.foundInAccurate ? "" : " not-found");

    const checkboxCell = document.createElement("td");
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = r.foundInAccurate;
    checkbox.disabled = !r.foundInAccurate;
    checkbox.dataset.sku = r.marketplaceSku;
    checkbox.addEventListener("change", updateImportCommitLabel);
    checkboxCell.appendChild(checkbox);

    const skuCell = document.createElement("td");
    skuCell.textContent = r.marketplaceSku;

    const matchCell = document.createElement("td");
    matchCell.textContent = r.foundInAccurate
      ? `✓ Found${r.stock !== undefined ? ` — ${r.stock.toLocaleString()} PCS` : ""}`
      : "Not found in Accurate";

    const unitCell = document.createElement("td");
    if (r.foundInAccurate && r.availableUnits && r.availableUnits.length > 0) {
      const select = document.createElement("select");
      select.className = "import-unit-select";
      select.dataset.sku = r.marketplaceSku;
      for (const u of r.availableUnits) {
        const option = document.createElement("option");
        option.value = String(u.level);
        option.textContent = u.name;
        if (u.level === r.suggestedUnitLevel) option.selected = true;
        select.appendChild(option);
      }
      unitCell.appendChild(select);
    } else {
      unitCell.textContent = "—";
    }

    row.append(checkboxCell, skuCell, matchCell, unitCell);
    importRows.appendChild(row);
  }

  updateImportCommitLabel();
}

function updateImportCommitLabel() {
  const checked = importRows.querySelectorAll("input[type=checkbox]:checked").length;
  importCommitBtn.textContent = `Import ${checked} selected`;
  importCommitBtn.disabled = checked === 0;
}

importScanBtn.addEventListener("click", async () => {
  const storeId = importStorePicker.value;
  if (!storeId) {
    showImportMessage("No store selected", "error");
    return;
  }

  importScanBtn.disabled = true;
  const originalText = importScanBtn.textContent;
  importScanBtn.innerHTML = '<span class="spinner"></span> Scanning…';
  importMessage.hidden = true;
  importSummaryDetails.innerHTML = "";

  try {
    const res = await fetch(`/api/import/${storeId}/scan`, { method: "POST" });
    const results = await res.json();

    if (!res.ok) {
      showImportMessage(results.error || "Scan failed", "error");
      return;
    }

    importScanResults = results;
    renderImportResults();
    if (results.length === 0) {
      showImportMessage("No new SKUs found — everything is already mapped.", "success");
    }
  } catch (err) {
    showImportMessage("Scan failed: could not reach the server", "error");
  } finally {
    importScanBtn.disabled = false;
    importScanBtn.textContent = originalText;
  }
});

importCommitBtn.addEventListener("click", async () => {
  const storeId = importStorePicker.value;
  const items = [...importRows.querySelectorAll("input[type=checkbox]:checked")].map((cb) => {
    const sku = cb.dataset.sku;
    const select = importRows.querySelector(`select[data-sku="${CSS.escape(sku)}"]`);
    return { marketplaceSku: sku, unitLevel: select ? Number(select.value) : 1 };
  });
  if (items.length === 0) return;

  importCommitBtn.disabled = true;
  importCommitBtn.innerHTML = '<span class="spinner"></span> Importing…';
  importMessage.hidden = true;
  importSummaryDetails.innerHTML = "";

  try {
    const res = await fetch(`/api/import/${storeId}/commit`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ items }),
    });
    const result = await res.json();

    if (!res.ok) {
      showImportMessage(result.error || "Import failed", "error");
      return;
    }

    renderImportSummary(result);
    importScanResults = importScanResults.filter((r) => !result.created.includes(r.marketplaceSku));
    renderImportResults();
    await loadAccurateSkus();
  } catch (err) {
    showImportMessage("Import failed: could not reach the server", "error");
  } finally {
    updateImportCommitLabel();
  }
});

loadImportStores();

// ---- OAuth callback feedback ----
// The "Integrate" flow opens the authorization link in a NEW tab; the callback
// redirects that new tab back here with ?integrate=...&status=... query params.
// Handle it if present (works whether this is that same tab or the user just
// switched back to the original one and it happens to reload).
(function handleOAuthRedirect() {
  const params = new URLSearchParams(location.search);
  const integrate = params.get("integrate");
  if (!integrate) return;

  const status = params.get("status");
  switchView("integrations");

  if (status === "success") {
    const storeCountAdded = params.get("stores") || "0";
    showIntegrationsMessage(`Connected — ${storeCountAdded} store(s) added for ${integrate}.`, "success");
    loadIntegrations();
    loadImportStores();
    loadStoreCount().then(loadAccurateSkus);
  } else {
    showIntegrationsMessage(`Failed to connect ${integrate}: ${params.get("message") || "Unknown error"}`, "error");
  }

  history.replaceState({}, "", location.pathname);
})();
