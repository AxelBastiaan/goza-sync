// ---- Invoice Reminders ----
// Daily list of customers to remind about overdue invoices over WhatsApp (wa.me
// link + PDF letter the admin attaches), hand-offs to salespeople at +14 days,
// and the log. All state lives server-side (/api/invoice-reminders); this file
// only renders it. Uses showToast() from app.js.

const irEls = {
  navBadge: document.getElementById("ir-nav-badge"),
  message: document.getElementById("ir-message"),
  golive: document.getElementById("ir-golive"),
  stats: document.getElementById("ir-stats"),
  tabbar: document.getElementById("ir-tabbar"),
  tbSend: document.getElementById("ir-tb-send"),
  tbSales: document.getElementById("ir-tb-sales"),
  filters: document.getElementById("ir-filters"),
  q: document.getElementById("ir-q"),
  sp: document.getElementById("ir-sp"),
  phone: document.getElementById("ir-phone"),
  sort: document.getElementById("ir-sort"),
  syncInfo: document.getElementById("ir-sync-info"),
  list: document.getElementById("ir-list"),
  refreshBtn: document.getElementById("ir-refresh-btn"),
  modal: document.getElementById("ir-modal"),
  modalTitle: document.getElementById("ir-modal-title"),
  modalTo: document.getElementById("ir-modal-to"),
  modalBody: document.getElementById("ir-modal-body"),
  modalOpen: document.getElementById("ir-modal-open"),
  modalClose: document.getElementById("ir-modal-close"),
};

let irState = null;
let irLog = [];
let irTab = "send";
const irOpen = new Set();
// Customers/salespeople marked sent in this session: shown greyed with an Undo
// button until the next reload, instead of vanishing from the list.
const irJustSent = new Map(); // customerId -> logId
const irJustForwarded = new Map(); // salesperson -> logId

const IR_MONTHS = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
function irDate(iso) {
  if (!iso) return "—";
  const [y, m, d] = iso.slice(0, 10).split("-").map(Number);
  return `${d} ${IR_MONTHS[m - 1]} ${y}`;
}
function irRp(n) {
  return "Rp" + Math.round(n).toLocaleString("id-ID");
}
function irRpShort(n) {
  if (n >= 1e9) return "Rp" + (n / 1e9).toLocaleString("id-ID", { maximumFractionDigits: 2 }) + " M";
  if (n >= 1e6) return "Rp" + (n / 1e6).toLocaleString("id-ID", { maximumFractionDigits: 1 }) + " jt";
  return irRp(n);
}
function irEsc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function irShowMessage(text, type) {
  irEls.message.textContent = text;
  irEls.message.className = `message ${type}`;
  irEls.message.hidden = !text;
}

async function irApi(path, options = {}) {
  const res = await fetch(`/api/invoice-reminders${path}`, {
    ...options,
    headers: options.body ? { "Content-Type": "application/json" } : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// PDFs/zips are fetched (not plain links) so a "paid in the meantime" 409 shows
// as a message instead of a broken download.
async function irDownload(path) {
  const res = await fetch(`/api/invoice-reminders${path}`);
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  const blob = await res.blob();
  const match = /filename="([^"]+)"/.exec(res.headers.get("Content-Disposition") || "");
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = match ? match[1] : "download";
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 10000);
}

function updateIrBadge(count) {
  irEls.navBadge.textContent = count;
  irEls.navBadge.hidden = !count;
}

async function loadInvoiceReminders() {
  irShowMessage("", "");
  irEls.list.innerHTML = `<p class="empty-state">Loading from Accurate…</p>`;
  try {
    irState = await irApi("/state");
    if (irTab === "log") irLog = (await irApi("/log")).log;
    irJustSent.clear();
    irJustForwarded.clear();
    irFillSalespersonFilter();
    irRender();
  } catch (err) {
    irEls.list.innerHTML = "";
    irShowMessage(`Failed to load invoice reminders: ${err.message}`, "error");
  }
}

function irFillSalespersonFilter() {
  const current = irEls.sp.value;
  const names = irState.salespeople.map((p) => p.name);
  irEls.sp.innerHTML = `<option value="">All salespeople</option>` + names.map((n) => `<option>${irEsc(n)}</option>`).join("") + `<option value="__none">(no salesperson)</option>`;
  irEls.sp.value = current;
}

function irFilter(list, sortable = true) {
  const q = irEls.q.value.trim().toLowerCase();
  const sp = irEls.sp.value;
  const onlyPhone = irEls.phone.checked;
  const out = list.filter(
    (c) =>
      (!q || c.name.toLowerCase().includes(q) || c.invoices.some((i) => i.number.toLowerCase().includes(q))) &&
      (!sp || (sp === "__none" ? !c.salesperson : c.salesperson === sp)) &&
      (!onlyPhone || c.hasWhatsApp)
  );
  if (!sortable) return out;
  const by = irEls.sort.value;
  out.sort(
    by === "name"
      ? (a, b) => a.name.localeCompare(b.name)
      : by === "late"
        ? (a, b) => b.maxDaysLate - a.maxDaysLate
        : (a, b) => b.owing - a.owing
  );
  return out;
}

function irStageChip(stage) {
  return `<span class="ir-chip s${Math.min(stage, 3)}">Pengingat ke-${stage}</span>`;
}

function irInvoiceTable(invoices) {
  return `<table class="ir-inv"><thead><tr><th>No. Faktur</th><th>Tgl Faktur</th><th>Jatuh Tempo</th><th class="r">Telat</th><th class="r">Total</th><th class="r">Sisa Piutang</th></tr></thead><tbody>${invoices
    .map(
      (i) => `<tr><td>${irEsc(i.number)}${i.escalatedAt ? ` <span class="ir-chip sales">sales</span>` : ""}</td><td>${irDate(i.transDate)}</td><td>${irDate(i.dueDate)}</td><td class="r ${i.daysLate >= 14 ? "ir-late" : ""}">${i.daysLate} hari</td><td class="r">${irRp(i.total)}</td><td class="r">${irRp(i.owing)}</td></tr>`
    )
    .join("")}</tbody></table>`;
}

function irMeta(c) {
  const phone = c.hasWhatsApp
    ? `<span>📱 ${irEsc(c.phone)}${c.contactName ? ` (${irEsc(c.contactName)})` : ""}</span>`
    : `<span class="ir-nophone">⚠ ${c.phone ? `No mobile number in Accurate (only "${irEsc(c.phone)}")` : "No WA number in Accurate"}</span>`;
  return `<div class="ir-meta"><span>${irEsc(c.customerNo || "")}</span><span>Marketing: <b>${irEsc(c.salesperson || "—")}</b></span>${phone}<span>${c.invoices.length} faktur · oldest ${c.maxDaysLate} hari telat</span></div>`;
}

function irCard(c, { chip = "", body = "", amountLabel = "sisa piutang", done = false, extraAmount = "" } = {}) {
  const open = irOpen.has(c.id);
  return `<div class="ir-card ${done ? "done" : ""}">
    <div class="ir-head" data-ir-toggle="${c.id}">
      <div class="ir-main">
        <div class="ir-name">${irEsc(c.name)} ${chip}</div>
        ${irMeta(c)}
        ${c.reviewNote ? `<div class="ir-review">⚑ ${irEsc(c.reviewNote)}</div>` : ""}
      </div>
      <div class="ir-amt"><div class="v">${irRp(c.owing)}</div><div class="l">${amountLabel} ${open ? "▴" : "▾"}</div>${extraAmount}</div>
    </div>
    ${open ? `<div class="ir-body">${irInvoiceTable(c.invoices)}${body}</div>` : ""}
  </div>`;
}

function irRenderStats() {
  const s = irState;
  const live = !!s.liveSince;
  const all = live ? [...s.toSend, ...s.waiting, ...s.withSales, ...s.salesTasks.flatMap((t) => t.customers)] : s.review;
  const uniq = new Map(all.map((c) => [c.id, c]));
  const owing = [...uniq.values()].reduce((a, c) => a + c.owing, 0);
  const tiles = live
    ? [
        [s.toSend.length, "customers to remind today"],
        [s.salesTasks.length, "hand-offs to salespeople"],
        [s.toSend.filter((c) => !c.hasWhatsApp).length, "to remind with no WA number in Accurate"],
        [irRpShort(owing), "total overdue (excl. ignored)"],
      ]
    : [
        [s.review.length, "customers with overdue invoices"],
        [s.review.filter((c) => c.reviewNote).length, "flagged for a look"],
        [s.review.filter((c) => !c.hasWhatsApp).length, "with no WA number in Accurate"],
        [irRpShort(owing), "total overdue"],
      ];
  irEls.stats.innerHTML = tiles.map(([v, l]) => `<div class="ir-stat"><div class="v">${v}</div><div class="l">${l}</div></div>`).join("");
}

function irRenderGoLive() {
  const s = irState;
  if (s.liveSince) {
    irEls.golive.hidden = true;
    return;
  }
  const backlog = s.review.filter((c) => !c.ignored && c.maxDaysLate >= 3).length;
  irEls.golive.hidden = false;
  irEls.golive.innerHTML = `<div class="ir-golive">
    <div><b>Not live yet — review first.</b> Below is everyone with overdue invoices. Press <i>Ignore</i> on customers who should never get reminders (related parties, special arrangements, disputes). Nothing is sent before you go live.
    <br/>On go-live, the ${backlog} customers already overdue start their reminders in batches of 25 per working day, biggest balances first.</div>
    <button type="button" id="ir-golive-btn">Go live</button>
  </div>`;
  document.getElementById("ir-golive-btn").addEventListener("click", irGoLive);
}

function irRender() {
  if (!irState) return;
  const s = irState;
  const live = !!s.liveSince;
  irRenderGoLive();
  irRenderStats();
  irEls.tabbar.hidden = !live;
  const sendLeft = s.toSend.filter((c) => !irJustSent.has(c.id)).length;
  const salesLeft = s.salesTasks.filter((t) => !irJustForwarded.has(t.salesperson)).length;
  irEls.tbSend.textContent = sendLeft;
  irEls.tbSend.hidden = !sendLeft;
  irEls.tbSales.textContent = salesLeft;
  irEls.tbSales.hidden = !salesLeft;
  updateIrBadge(live ? sendLeft + salesLeft : 0);
  document.querySelectorAll("[data-ir-tab]").forEach((b) => b.classList.toggle("active", b.dataset.irTab === irTab));
  const tab = live ? irTab : "review";
  irEls.filters.hidden = !["review", "send", "waiting", "withsales", "ignored"].includes(tab);
  irEls.syncInfo.textContent =
    (s.lastRefresh ? `Synced with Accurate ${new Date(s.lastRefresh).toLocaleString("id-ID")}` : "Not synced yet") +
    (s.refreshError ? ` — last sync failed: ${s.refreshError}` : "");
  irEls.syncInfo.classList.toggle("error", !!s.refreshError);

  let h = "";
  if (tab === "review") {
    const list = irFilter(s.review);
    h = list.length
      ? list.map((c) => irCard(c, { chip: c.ignored ? `<span class="ir-chip muted">ignored</span>` : "", done: c.ignored, body: irIgnoreActions(c) })).join("")
      : `<p class="empty-state">No overdue invoices.</p>`;
  } else if (tab === "send") {
    const list = irFilter(s.toSend);
    h = list.length ? list.map(irSendCard).join("") : `<p class="empty-state">Nothing to send today 🎉</p>`;
  } else if (tab === "sales") {
    h = s.salesTasks.length ? s.salesTasks.map(irSalesGroup).join("") : `<p class="empty-state">No hand-offs today. Invoices land here 14 days after their (effective) due date.</p>`;
  } else if (tab === "waiting") {
    const list = irFilter(s.waiting);
    h =
      `<p class="subtitle">Overdue, but not due for a reminder yet (3-day gap, next step not reached, or waiting for their go-live batch).</p>` +
      (list.length
        ? list
            .map((c) =>
              irCard(c, {
                extraAmount: `<div class="ir-next">Next reminder: <b>${irDate(c.nextReminder)}</b>${c.lastSent ? `<br/>Last: ${irDate(c.lastSent)}` : ""}</div>`,
                body: irIgnoreActions(c),
              })
            )
            .join("")
        : `<p class="empty-state">No one waiting.</p>`);
  } else if (tab === "withsales") {
    const list = irFilter(s.withSales);
    h =
      `<p class="subtitle">Handed to the salesperson — no more automatic customer reminders for these invoices. They disappear once Accurate shows them as paid.</p>` +
      (list.length
        ? list.map((c) => irCard(c, { chip: `<span class="ir-chip sales">with ${irEsc(c.salesperson || "sales")}</span>`, body: `<div class="ir-actions"><button type="button" class="secondary" data-ir-pdf="${c.id}" data-ir-for="sales">📄 Download PDF</button></div>` })).join("")
        : `<p class="empty-state">Nothing with sales.</p>`);
  } else if (tab === "ignored") {
    const list = irFilter(s.ignored);
    h =
      `<p class="subtitle">Never reminded. Stop ignoring to start a fresh reminder cycle for them.</p>` +
      (list.length ? list.map((c) => irCard(c, { chip: c.ignoredNote ? `<span class="ir-chip muted">${irEsc(c.ignoredNote)}</span>` : "", body: irIgnoreActions(c) })).join("") : `<p class="empty-state">No ignored customers.</p>`);
  } else if (tab === "log") {
    h = irLogTable();
  } else if (tab === "people") {
    h = irPeopleTable();
  }
  irEls.list.innerHTML = h;
}

function irIgnoreActions(c) {
  return `<div class="ir-actions"><span class="ir-spacer"></span>${
    c.ignored
      ? `<button type="button" class="secondary" data-ir-unignore="${c.id}">Stop ignoring</button>`
      : `<button type="button" class="ir-ghost" data-ir-ignore="${c.id}">Ignore customer</button>`
  }</div>`;
}

function irSendCard(c) {
  const logId = irJustSent.get(c.id);
  const body = `<div class="ir-actions">
      <button type="button" class="secondary" data-ir-pdf="${c.id}">📄 Download PDF</button>
      <button type="button" class="ir-wa" data-ir-wa="${c.id}" ${c.hasWhatsApp ? "" : `disabled title="No usable mobile number on this customer in Accurate"`}>WhatsApp</button>
      ${c.hasWhatsApp ? "" : `<span class="ir-hint">Add the number in Accurate (Pelanggan → Kontak), then ↻</span>`}
      <span class="ir-spacer"></span>
      ${logId ? `<button type="button" class="ir-ghost" data-ir-undo="${logId}">Undo</button>` : `<button type="button" class="ir-ghost" data-ir-ignore="${c.id}">Ignore customer</button><button type="button" data-ir-sent="${c.id}">✓ Mark sent</button>`}
    </div>`;
  return irCard(c, { chip: logId ? `<span class="ir-chip muted">✓ sent</span>` : irStageChip(c.stage), body, done: !!logId });
}

function irSalesGroup(t) {
  const logId = irJustForwarded.get(t.salesperson);
  const total = t.customers.reduce((s, c) => s + c.handoff.reduce((a, i) => a + i.owing, 0), 0);
  const known = t.salesperson !== "(no salesperson)";
  return `<div class="ir-group-h">${irEsc(t.salesperson)} <span class="sub">${
    t.phone ? `📱 ${irEsc(t.phone)}` : known ? `<span class="ir-nophone">⚠ no WA number — add it under Salespeople</span>` : `<span class="ir-nophone">no salesperson on these customers in Accurate</span>`
  } · ${t.customers.length} customers · ${irRp(total)}</span></div>
  <div class="ir-card ${logId ? "done" : ""}"><div class="ir-body ir-body-flat">
    <table class="ir-inv"><thead><tr><th>Customer</th><th class="r">Faktur</th><th class="r">Telat s/d</th><th class="r">Sisa Piutang</th><th></th></tr></thead><tbody>${[...t.customers]
      .sort((a, b) => b.owing - a.owing)
      .map(
        (c) =>
          `<tr><td>${irEsc(c.name)}</td><td class="r">${c.handoff.length}</td><td class="r ir-late">${Math.max(...c.handoff.map((i) => i.daysLate))} hari</td><td class="r">${irRp(c.handoff.reduce((a, i) => a + i.owing, 0))}</td><td class="r"><a href="#" data-ir-pdf="${c.id}" data-ir-for="sales">PDF</a></td></tr>`
      )
      .join("")}</tbody></table>
    <div class="ir-actions">
      <button type="button" class="ir-wa" data-ir-wasales="${irEsc(t.salesperson)}" ${t.phone ? "" : "disabled"}>WhatsApp ${irEsc(t.salesperson)}</button>
      <button type="button" class="secondary" data-ir-zip="${irEsc(t.salesperson)}">📦 All PDFs (zip)</button>
      <span class="ir-spacer"></span>
      ${logId ? `<span class="ir-chip muted">✓ forwarded</span><button type="button" class="ir-ghost" data-ir-undo="${logId}">Undo</button>` : `<button type="button" data-ir-fwd="${irEsc(t.salesperson)}">✓ Mark forwarded</button>`}
    </div>
  </div></div>`;
}

function irLogTable() {
  if (!irLog.length) return `<p class="empty-state">No reminders sent yet.</p>`;
  return `<table class="ir-table"><thead><tr><th>Date</th><th>Type</th><th>To</th><th>Detail</th><th>By</th><th></th></tr></thead><tbody>${irLog
    .map((l) => {
      const type = l.kind === "customer" ? irStageChip(l.stage || 1) : `<span class="ir-chip sales">To sales</span>`;
      const to = l.kind === "customer" ? irEsc(l.customerName) : irEsc(l.salesperson);
      const detail = `${l.letterNo ? irEsc(l.letterNo) + " · " : ""}${l.invoiceCount} faktur · ${irRp(l.totalOwing || 0)}`;
      const action = l.undoneAt ? `<span class="ir-chip muted">undone</span>` : l.undoable ? `<button type="button" class="ir-ghost" data-ir-undo="${l.id}">Undo</button>` : "";
      return `<tr class="${l.undoneAt ? "ir-undone" : ""}"><td>${irDate(l.sentDate)}</td><td>${type}</td><td>${to}</td><td>${detail}</td><td>${irEsc(l.sentBy || "")}</td><td>${action}</td></tr>`;
    })
    .join("")}</tbody></table>`;
}

function irPeopleTable() {
  const s = irState;
  return `<p class="subtitle">WhatsApp numbers for the +14 hand-off. Customers are matched to a salesperson by the default salesman on the customer in Accurate.</p>
    <table class="ir-table"><thead><tr><th>Salesperson</th><th>Accurate salesman ID</th><th>WhatsApp</th><th></th></tr></thead><tbody>${s.salespeople
      .map(
        (p) => `<tr><td><b>${irEsc(p.name)}</b></td><td>${p.salesmanIds.join(", ")}</td>
        <td><input type="text" class="ir-phone-input" data-ir-person="${irEsc(p.name)}" value="${irEsc(p.phone || "")}" placeholder="+62…" /></td>
        <td><button type="button" class="secondary" data-ir-savephone="${irEsc(p.name)}">Save</button></td></tr>`
      )
      .join("")}</tbody></table>`;
}

// ---------- actions ----------

function irOpenModal(title, to, message, url) {
  irEls.modalTitle.textContent = title;
  irEls.modalTo.innerHTML = to;
  irEls.modalBody.textContent = message;
  if (url) {
    irEls.modalOpen.href = url;
    irEls.modalOpen.classList.remove("disabled");
  } else {
    irEls.modalOpen.removeAttribute("href");
    irEls.modalOpen.classList.add("disabled");
  }
  irEls.modal.classList.add("open");
}
irEls.modalClose.addEventListener("click", () => irEls.modal.classList.remove("open"));
irEls.modal.addEventListener("click", (e) => {
  if (e.target === irEls.modal) irEls.modal.classList.remove("open");
});
irEls.modalOpen.addEventListener("click", () => irEls.modal.classList.remove("open"));

async function irGoLive() {
  if (!confirm("Start sending invoice reminders? Customers not ignored will start appearing under “To send” from today.")) return;
  try {
    const r = await irApi("/go-live", { method: "POST" });
    showToast(`Live — ${r.backlogCustomers} overdue customers spread until ${irDate(r.lastBatchDay)}`);
    irTab = "send";
    await loadInvoiceReminders();
  } catch (err) {
    irShowMessage(err.message, "error");
  }
}

async function irWithBusy(btn, fn) {
  if (btn) btn.disabled = true;
  try {
    await fn();
  } catch (err) {
    irShowMessage(err.message, "error");
    window.scrollTo({ top: 0, behavior: "smooth" });
  } finally {
    if (btn && document.body.contains(btn)) btn.disabled = false;
  }
}

function irFindCustomer(id) {
  const s = irState;
  return [...s.review, ...s.toSend, ...s.waiting, ...s.withSales, ...s.ignored].find((c) => c.id === id);
}

irEls.list.addEventListener("click", async (e) => {
  const t = e.target.closest("[data-ir-toggle],[data-ir-pdf],[data-ir-wa],[data-ir-sent],[data-ir-undo],[data-ir-ignore],[data-ir-unignore],[data-ir-wasales],[data-ir-zip],[data-ir-fwd],[data-ir-savephone]");
  if (!t) return;
  const d = t.dataset;
  if (d.irToggle) {
    const id = Number(d.irToggle);
    irOpen.has(id) ? irOpen.delete(id) : irOpen.add(id);
    return irRender();
  }
  e.preventDefault();
  irShowMessage("", "");
  if (d.irPdf) {
    return irWithBusy(t, async () => {
      showToast("Checking Accurate and building the letter…", "undo");
      await irDownload(`/customers/${d.irPdf}/letter.pdf${d.irFor === "sales" ? "?for=sales" : ""}`);
    });
  }
  if (d.irWa) {
    return irWithBusy(t, async () => {
      const r = await irApi(`/customers/${d.irWa}/whatsapp`, { method: "POST" });
      const c = irFindCustomer(Number(d.irWa));
      irOpenModal(
        "WhatsApp preview",
        r.url ? `To <b>${irEsc(c?.name)}</b> — ${irEsc(r.phone)}. Attach the PDF in WhatsApp, send, then come back and press <b>Mark sent</b>.` : `No usable number for this customer in Accurate.`,
        r.message,
        r.url
      );
    });
  }
  if (d.irSent) {
    return irWithBusy(t, async () => {
      const r = await irApi(`/customers/${d.irSent}/sent`, { method: "POST" });
      irJustSent.set(Number(d.irSent), r.logId);
      showToast(`Marked sent — next reminder ${irDate(r.nextReminder)} at the earliest`);
      irRender();
    });
  }
  if (d.irUndo) {
    return irWithBusy(t, async () => {
      await irApi(`/log/${d.irUndo}/undo`, { method: "POST" });
      showToast("↺ Undone", "undo");
      await loadInvoiceReminders();
    });
  }
  if (d.irIgnore) {
    const c = irFindCustomer(Number(d.irIgnore));
    const note = prompt(`Stop all reminders for ${c ? c.name : "this customer"}?\nOptional reason (e.g. related party, payment arrangement):`, "");
    if (note === null) return;
    return irWithBusy(t, async () => {
      await irApi(`/customers/${d.irIgnore}/ignore`, { method: "POST", body: JSON.stringify({ ignored: true, note }) });
      showToast("Customer ignored");
      await loadInvoiceReminders();
    });
  }
  if (d.irUnignore) {
    return irWithBusy(t, async () => {
      await irApi(`/customers/${d.irUnignore}/ignore`, { method: "POST", body: JSON.stringify({ ignored: false }) });
      showToast("Customer will be reminded again");
      await loadInvoiceReminders();
    });
  }
  if (d.irWasales) {
    return irWithBusy(t, async () => {
      const r = await irApi(`/salespeople/${encodeURIComponent(d.irWasales)}/whatsapp`, { method: "POST" });
      irOpenModal("WhatsApp preview", `To <b>${irEsc(d.irWasales)}</b> — ${irEsc(r.phone || "")}. Attach the PDFs (zip) in WhatsApp, send, then press <b>Mark forwarded</b>.`, r.message, r.url);
    });
  }
  if (d.irZip) {
    return irWithBusy(t, async () => {
      showToast("Checking Accurate and building the letters…", "undo");
      await irDownload(`/salespeople/${encodeURIComponent(d.irZip)}/letters.zip`);
    });
  }
  if (d.irFwd) {
    return irWithBusy(t, async () => {
      const r = await irApi(`/salespeople/${encodeURIComponent(d.irFwd)}/forwarded`, { method: "POST" });
      irJustForwarded.set(d.irFwd, r.logId);
      showToast(`Forwarded ${r.customers} customers to ${d.irFwd}`);
      irRender();
    });
  }
  if (d.irSavephone) {
    const input = irEls.list.querySelector(`[data-ir-person="${CSS.escape(d.irSavephone)}"]`);
    return irWithBusy(t, async () => {
      await irApi(`/salespeople/${encodeURIComponent(d.irSavephone)}`, { method: "PUT", body: JSON.stringify({ phone: input.value }) });
      const p = irState.salespeople.find((x) => x.name === d.irSavephone);
      if (p) p.phone = input.value.trim() || null;
      showToast(`Saved ${d.irSavephone}'s number`);
    });
  }
});

document.querySelectorAll("[data-ir-tab]").forEach((b) =>
  b.addEventListener("click", async () => {
    irTab = b.dataset.irTab;
    if (irTab === "log") {
      try {
        irLog = (await irApi("/log")).log;
      } catch (err) {
        irShowMessage(err.message, "error");
      }
    }
    irRender();
  })
);
[irEls.q, irEls.sp, irEls.phone, irEls.sort].forEach((el) => el.addEventListener("input", irRender));
irEls.refreshBtn.addEventListener("click", () =>
  irWithBusy(irEls.refreshBtn, async () => {
    irEls.syncInfo.textContent = "Re-reading everything from Accurate…";
    irState = await irApi("/refresh", { method: "POST" });
    irFillSalespersonFilter();
    irRender();
    showToast("Synced with Accurate");
  })
);

// Badge on load, so today's reminders are visible without opening the tab.
fetch("/api/invoice-reminders/count")
  .then((res) => (res.ok ? res.json() : null))
  .then((data) => data && updateIrBadge(data.count))
  .catch(() => {});
