import { db } from "../../db";
import { fetchHolidays, getTodayJakarta } from "../stockOpname";
import {
  SchedInvoice,
  applySent,
  assignBatches,
  daysBetween,
  initialEffectiveDueDate,
  nextReminderDate,
  pendingEscalation,
  reminderStage,
  triggeringInvoices,
  ESCALATE_AT,
  THRESHOLDS,
} from "./schedule";
import { customerMessage, salesMessage, toWhatsAppNumber, waLink } from "./messages";
import { ensureInvoiceDetails } from "./sync";
import { generateLetterPdf, LetterInvoice } from "./letterPdf";

// Queues and admin actions for the Invoice Reminders tab, on top of the tables
// sync.ts mirrors from Accurate. Nothing here talks to Accurate except through
// ensureInvoiceDetails (line items for the PDF).

const LIVE_SINCE_KEY = "invoice_reminders_live_since";
const BACKLOG_PER_DAY = 25;
const NO_SALESPERSON = "(no salesperson)";

interface InvoiceRow {
  invoice_id: number;
  number: string;
  customer_id: number;
  trans_date: string;
  due_date: string;
  effective_due_date: string | null;
  total_amount: number;
  prime_owing: number;
  stage_sent: number;
  escalated_at: string | null;
  dpp_amount: number | null;
  tax_amount: number | null;
  payment_term: string | null;
  salesman_name: string | null;
}

interface CustomerRow {
  customer_id: number;
  name: string;
  customer_no: string | null;
  contact_name: string | null;
  phone: string | null;
  salesman_id: number | null;
  ignored: number;
  ignored_note: string | null;
}

export interface Salesperson {
  name: string;
  salesmanIds: number[];
  phone: string | null;
}

export interface InvoiceView {
  id: number;
  number: string;
  transDate: string;
  dueDate: string;
  daysLate: number;
  total: number;
  owing: number;
  stageSent: number;
  escalatedAt: string | null;
}

export interface CustomerView {
  id: number;
  name: string;
  customerNo: string | null;
  contactName: string | null;
  phone: string | null;
  hasWhatsApp: boolean;
  salesperson: string | null;
  ignored: boolean;
  ignoredNote: string | null;
  reviewNote: string | null;
  owing: number;
  maxDaysLate: number;
  invoices: InvoiceView[];
}

export interface RemindersState {
  today: string;
  liveSince: string | null;
  review: CustomerView[];
  toSend: (CustomerView & { stage: number })[];
  salesTasks: { salesperson: string; phone: string | null; customers: (CustomerView & { handoff: InvoiceView[] })[] }[];
  waiting: (CustomerView & { nextReminder: string | null; lastSent: string | null })[];
  withSales: (CustomerView & { escalated: InvoiceView[] })[];
  ignored: CustomerView[];
  salespeople: Salesperson[];
}

export function getLiveSince(): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LIVE_SINCE_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

export function listSalespeople(): Salesperson[] {
  const rows = db.prepare("SELECT name, salesman_ids, phone FROM invoice_reminder_salespeople ORDER BY name").all() as {
    name: string;
    salesman_ids: string;
    phone: string | null;
  }[];
  return rows.map((r) => ({ name: r.name, salesmanIds: JSON.parse(r.salesman_ids), phone: r.phone }));
}

export function setSalespersonPhone(name: string, phone: string | null): void {
  const res = db.prepare("UPDATE invoice_reminder_salespeople SET phone = ? WHERE name = ?").run(phone?.trim() || null, name);
  if (res.changes === 0) throw new Error(`Unknown salesperson ${name}`);
}

function salespersonFor(salesmanId: number | null, people: Salesperson[]): string | null {
  if (salesmanId === null) return null;
  return people.find((p) => p.salesmanIds.includes(salesmanId))?.name ?? null;
}

// Why a customer deserves a look before go-live (not an automatic exclusion).
function reviewNoteFor(c: CustomerRow, maxDaysLate: number): string | null {
  const notes: string[] = [];
  if (/\bGOSAL\b/i.test(c.name)) notes.push("Same name as the finance director (Dwi.S.Gosal) — related party?");
  if (maxDaysLate > 365) notes.push("Oldest invoice is over a year overdue");
  return notes.length ? notes.join(" · ") : null;
}

function lastSentByCustomer(): Map<number, string> {
  const rows = db
    .prepare(
      "SELECT customer_id, MAX(sent_date) AS d FROM invoice_reminder_log WHERE kind = 'customer' AND undone_at IS NULL GROUP BY customer_id"
    )
    .all() as { customer_id: number; d: string }[];
  return new Map(rows.map((r) => [r.customer_id, r.d]));
}

function toSched(r: InvoiceRow): SchedInvoice {
  return {
    invoiceId: r.invoice_id,
    dueDate: r.due_date,
    effectiveDueDate: r.effective_due_date,
    stageSent: r.stage_sent,
    escalatedAt: r.escalated_at,
  };
}

function toInvoiceView(r: InvoiceRow, today: string): InvoiceView {
  return {
    id: r.invoice_id,
    number: r.number,
    transDate: r.trans_date,
    dueDate: r.due_date,
    daysLate: daysBetween(r.due_date, today),
    total: r.total_amount,
    owing: r.prime_owing,
    stageSent: r.stage_sent,
    escalatedAt: r.escalated_at,
  };
}

function loadOpen(): { customers: Map<number, CustomerRow>; invoicesByCustomer: Map<number, InvoiceRow[]> } {
  const customers = new Map(
    (db.prepare("SELECT * FROM invoice_reminder_customers").all() as CustomerRow[]).map((c) => [c.customer_id, c])
  );
  const invoicesByCustomer = new Map<number, InvoiceRow[]>();
  const rows = db
    .prepare("SELECT * FROM invoice_reminder_invoices WHERE paid_at IS NULL ORDER BY due_date, number")
    .all() as InvoiceRow[];
  for (const r of rows) {
    if (!invoicesByCustomer.has(r.customer_id)) invoicesByCustomer.set(r.customer_id, []);
    invoicesByCustomer.get(r.customer_id)!.push(r);
  }
  return { customers, invoicesByCustomer };
}

// Once live, any open invoice without a schedule (newly overdue, or its customer
// was just un-ignored) gets one: its real due date, or — if it's already past
// the first step — a fresh cycle starting today.
function scheduleNewInvoices(today: string): void {
  if (!getLiveSince()) return;
  const rows = db
    .prepare(
      `SELECT i.invoice_id, i.due_date FROM invoice_reminder_invoices i
       JOIN invoice_reminder_customers c ON c.customer_id = i.customer_id
       WHERE i.paid_at IS NULL AND i.effective_due_date IS NULL AND c.ignored = 0`
    )
    .all() as { invoice_id: number; due_date: string }[];
  const set = db.prepare("UPDATE invoice_reminder_invoices SET effective_due_date = ? WHERE invoice_id = ?");
  db.transaction(() => {
    for (const r of rows) set.run(initialEffectiveDueDate(r.due_date, today), r.invoice_id);
  })();
}

function customerView(c: CustomerRow, invs: InvoiceRow[], people: Salesperson[], today: string): CustomerView {
  const invoices = invs.map((r) => toInvoiceView(r, today));
  const maxDaysLate = Math.max(...invoices.map((i) => i.daysLate));
  return {
    id: c.customer_id,
    name: c.name,
    customerNo: c.customer_no,
    contactName: c.contact_name,
    phone: c.phone,
    hasWhatsApp: toWhatsAppNumber(c.phone) !== null,
    salesperson: salespersonFor(c.salesman_id, people),
    ignored: c.ignored === 1,
    ignoredNote: c.ignored_note,
    reviewNote: reviewNoteFor(c, maxDaysLate),
    owing: invoices.reduce((s, i) => s + i.owing, 0),
    maxDaysLate,
    invoices,
  };
}

export function buildState(): RemindersState {
  const today = getTodayJakarta();
  scheduleNewInvoices(today);
  const liveSince = getLiveSince();
  const people = listSalespeople();
  const { customers, invoicesByCustomer } = loadOpen();
  const lastSent = lastSentByCustomer();

  const state: RemindersState = {
    today,
    liveSince,
    review: [],
    toSend: [],
    salesTasks: [],
    waiting: [],
    withSales: [],
    ignored: [],
    salespeople: people,
  };
  const tasks = new Map<string, RemindersState["salesTasks"][number]>();

  for (const [customerId, invs] of invoicesByCustomer) {
    const c = customers.get(customerId);
    if (!c) continue;
    const view = customerView(c, invs, people, today);
    if (!liveSince) {
      state.review.push(view);
      continue;
    }
    if (view.ignored) {
      state.ignored.push(view);
      continue;
    }
    const sched = invs.map(toSched);
    const byId = new Map(view.invoices.map((i) => [i.id, i]));
    const last = lastSent.get(customerId) ?? null;

    const trig = triggeringInvoices(sched, last, today);
    if (trig.length) state.toSend.push({ ...view, stage: reminderStage(trig, today) });

    const handoff = pendingEscalation(sched, today).map((s) => byId.get(s.invoiceId)!);
    if (handoff.length) {
      const sp = view.salesperson ?? NO_SALESPERSON;
      if (!tasks.has(sp)) tasks.set(sp, { salesperson: sp, phone: people.find((p) => p.name === sp)?.phone ?? null, customers: [] });
      tasks.get(sp)!.customers.push({ ...view, handoff });
    }

    const escalated = view.invoices.filter((i) => i.escalatedAt);
    if (escalated.length) state.withSales.push({ ...view, escalated });

    const stillCycling = sched.some(
      (s) => s.effectiveDueDate && !s.escalatedAt && daysBetween(s.effectiveDueDate, today) < ESCALATE_AT
    );
    if (!trig.length && stillCycling) {
      state.waiting.push({ ...view, nextReminder: nextReminderDate(sched, last), lastSent: last });
    }
  }
  state.salesTasks = [...tasks.values()].sort((a, b) => a.salesperson.localeCompare(b.salesperson));
  return state;
}

export function pendingCount(): number {
  const s = buildState();
  return s.liveSince ? s.toSend.length + s.salesTasks.length : 0;
}

// ---------- go-live ----------

// Starts the reminders. Customers already THRESHOLDS[0]+ days overdue (the
// backlog) are spread over the coming working days, biggest balances first, so
// the admin gets a steady batch per day instead of everyone on day one.
export async function goLive(): Promise<{ backlogCustomers: number; lastBatchDay: string | null }> {
  if (getLiveSince()) throw new Error("Invoice reminders are already live.");
  const today = getTodayJakarta();
  const year = Number(today.slice(0, 4));
  const holidays = new Set([...(await fetchHolidays(year)), ...(await fetchHolidays(year + 1))]);

  const { customers, invoicesByCustomer } = loadOpen();
  const backlog: { customerId: number; owing: number }[] = [];
  for (const [customerId, invs] of invoicesByCustomer) {
    const c = customers.get(customerId);
    if (!c || c.ignored) continue;
    if (invs.some((i) => daysBetween(i.due_date, today) >= THRESHOLDS[0])) {
      backlog.push({ customerId, owing: invs.reduce((s, i) => s + i.prime_owing, 0) });
    }
  }
  const starts = assignBatches(backlog, today, BACKLOG_PER_DAY, holidays);

  const set = db.prepare("UPDATE invoice_reminder_invoices SET effective_due_date = ? WHERE invoice_id = ?");
  db.transaction(() => {
    for (const [customerId, invs] of invoicesByCustomer) {
      const c = customers.get(customerId);
      if (!c || c.ignored) continue;
      const start = starts.get(customerId) ?? today;
      for (const i of invs) set.run(initialEffectiveDueDate(i.due_date, start), i.invoice_id);
    }
    db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
      LIVE_SINCE_KEY,
      today
    );
  })();
  const days = [...starts.values()].sort();
  return { backlogCustomers: backlog.length, lastBatchDay: days.length ? days[days.length - 1] : null };
}

// ---------- admin actions ----------

export function setIgnored(customerId: number, ignored: boolean, note: string | null): void {
  const res = db
    .prepare("UPDATE invoice_reminder_customers SET ignored = ?, ignored_note = ? WHERE customer_id = ?")
    .run(ignored ? 1 : 0, ignored ? note : null, customerId);
  if (res.changes === 0) throw new Error("Unknown customer");
  if (!ignored) {
    // Coming back from ignored = a fresh start (scheduleNewInvoices picks these up).
    db.prepare(
      "UPDATE invoice_reminder_invoices SET effective_due_date = NULL, stage_sent = 0 WHERE customer_id = ? AND paid_at IS NULL AND escalated_at IS NULL"
    ).run(customerId);
  }
}

interface Snapshot {
  invoiceId: number;
  stageSent: number;
  effectiveDueDate: string | null;
  escalatedAt: string | null;
}

function openInvoices(customerId: number): InvoiceRow[] {
  return db
    .prepare("SELECT * FROM invoice_reminder_invoices WHERE customer_id = ? AND paid_at IS NULL ORDER BY due_date, number")
    .all(customerId) as InvoiceRow[];
}

function latestLetterToday(customerId: number, today: string): string | null {
  const r = db
    .prepare("SELECT letter_no FROM invoice_reminder_letters WHERE customer_id = ? AND issued_date = ? ORDER BY letter_no DESC LIMIT 1")
    .get(customerId, today) as { letter_no: string } | undefined;
  return r?.letter_no ?? null;
}

export function markSent(customerId: number, sentBy: string | null): { logId: number; nextReminder: string | null } {
  const today = getTodayJakarta();
  if (!getLiveSince()) throw new Error("Invoice reminders are not live yet.");
  return db.transaction(() => {
    const invs = openInvoices(customerId);
    const sched = invs.map(toSched);
    const last = lastSentByCustomer().get(customerId) ?? null;
    const trig = triggeringInvoices(sched, last, today);
    if (!trig.length) throw new Error("This customer isn't due for a reminder today (already sent, or paid in the meantime).");
    const stage = reminderStage(trig, today);
    const changes = applySent(sched, trig, today);
    const snapshot: Snapshot[] = [];
    const update = db.prepare("UPDATE invoice_reminder_invoices SET stage_sent = ?, effective_due_date = ? WHERE invoice_id = ?");
    for (const s of sched) {
      const ch = changes.get(s.invoiceId);
      if (!ch) continue;
      snapshot.push({ invoiceId: s.invoiceId, stageSent: s.stageSent, effectiveDueDate: s.effectiveDueDate, escalatedAt: s.escalatedAt });
      update.run(ch.stageSent, ch.effectiveDueDate, s.invoiceId);
      s.stageSent = ch.stageSent;
      s.effectiveDueDate = ch.effectiveDueDate;
    }
    const c = db.prepare("SELECT salesman_id FROM invoice_reminder_customers WHERE customer_id = ?").get(customerId) as
      | { salesman_id: number | null }
      | undefined;
    const res = db
      .prepare(
        `INSERT INTO invoice_reminder_log (kind, customer_id, salesperson, stage, letter_no, invoice_ids, total_owing, snapshot, sent_by, sent_at, sent_date)
         VALUES ('customer', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        customerId,
        salespersonFor(c?.salesman_id ?? null, listSalespeople()),
        stage,
        latestLetterToday(customerId, today),
        JSON.stringify(invs.map((i) => i.invoice_id)),
        invs.reduce((s, i) => s + i.prime_owing, 0),
        JSON.stringify(snapshot),
        sentBy,
        new Date().toISOString(),
        today
      );
    return { logId: Number(res.lastInsertRowid), nextReminder: nextReminderDate(sched, today) };
  })();
}

export function markForwarded(salesperson: string, sentBy: string | null): { logId: number; customers: number } {
  const today = getTodayJakarta();
  const task = buildState().salesTasks.find((t) => t.salesperson === salesperson);
  if (!task) throw new Error(`Nothing to forward to ${salesperson} today.`);
  return db.transaction(() => {
    const snapshot: Snapshot[] = [];
    const ids: number[] = [];
    const get = db.prepare("SELECT stage_sent, effective_due_date, escalated_at FROM invoice_reminder_invoices WHERE invoice_id = ?");
    const set = db.prepare("UPDATE invoice_reminder_invoices SET escalated_at = ? WHERE invoice_id = ?");
    for (const c of task.customers) {
      for (const inv of c.handoff) {
        const r = get.get(inv.id) as { stage_sent: number; effective_due_date: string | null; escalated_at: string | null };
        snapshot.push({ invoiceId: inv.id, stageSent: r.stage_sent, effectiveDueDate: r.effective_due_date, escalatedAt: r.escalated_at });
        set.run(today, inv.id);
        ids.push(inv.id);
      }
    }
    const res = db
      .prepare(
        `INSERT INTO invoice_reminder_log (kind, salesperson, invoice_ids, total_owing, snapshot, sent_by, sent_at, sent_date)
         VALUES ('sales', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        salesperson,
        JSON.stringify(ids),
        task.customers.reduce((s, c) => s + c.handoff.reduce((a, i) => a + i.owing, 0), 0),
        JSON.stringify(snapshot),
        sentBy,
        new Date().toISOString(),
        today
      );
    return { logId: Number(res.lastInsertRowid), customers: task.customers.length };
  })();
}

interface LogRow {
  id: number;
  kind: "customer" | "sales";
  customer_id: number | null;
  salesperson: string | null;
  stage: number | null;
  letter_no: string | null;
  invoice_ids: string;
  total_owing: number | null;
  snapshot: string;
  sent_by: string | null;
  sent_at: string;
  sent_date: string;
  undone_at: string | null;
}

// Only the most recent action for a customer (or salesperson hand-off) can be
// undone — restoring an older snapshot would overwrite what came after it.
function isUndoable(row: LogRow): boolean {
  if (row.undone_at) return false;
  const latest =
    row.kind === "customer"
      ? (db.prepare("SELECT MAX(id) AS id FROM invoice_reminder_log WHERE kind = 'customer' AND customer_id = ? AND undone_at IS NULL").get(row.customer_id) as { id: number })
      : (db.prepare("SELECT MAX(id) AS id FROM invoice_reminder_log WHERE kind = 'sales' AND salesperson = ? AND undone_at IS NULL").get(row.salesperson) as { id: number });
  return latest.id === row.id;
}

export function undo(logId: number): void {
  const row = db.prepare("SELECT * FROM invoice_reminder_log WHERE id = ?").get(logId) as LogRow | undefined;
  if (!row) throw new Error("Unknown log entry");
  if (!isUndoable(row)) throw new Error("Only the most recent action for this customer/salesperson can be undone.");
  const snapshot = JSON.parse(row.snapshot) as Snapshot[];
  db.transaction(() => {
    const restore = db.prepare(
      "UPDATE invoice_reminder_invoices SET stage_sent = ?, effective_due_date = ?, escalated_at = ? WHERE invoice_id = ?"
    );
    for (const s of snapshot) restore.run(s.stageSent, s.effectiveDueDate, s.escalatedAt, s.invoiceId);
    db.prepare("UPDATE invoice_reminder_log SET undone_at = ? WHERE id = ?").run(new Date().toISOString(), logId);
  })();
}

export function getLog(limit = 300) {
  const names = new Map(
    (db.prepare("SELECT customer_id, name FROM invoice_reminder_customers").all() as { customer_id: number; name: string }[]).map((r) => [
      r.customer_id,
      r.name,
    ])
  );
  const rows = db.prepare("SELECT * FROM invoice_reminder_log ORDER BY id DESC LIMIT ?").all(limit) as LogRow[];
  return rows.map((r) => ({
    id: r.id,
    kind: r.kind,
    customerId: r.customer_id,
    customerName: r.customer_id !== null ? names.get(r.customer_id) ?? `#${r.customer_id}` : null,
    salesperson: r.salesperson,
    stage: r.stage,
    letterNo: r.letter_no,
    invoiceCount: (JSON.parse(r.invoice_ids) as number[]).length,
    totalOwing: r.total_owing,
    sentBy: r.sent_by,
    sentAt: r.sent_at,
    sentDate: r.sent_date,
    undoneAt: r.undone_at,
    undoable: isUndoable(r),
  }));
}

// ---------- letters + WhatsApp ----------

// JT-YYMM####: one number per letter produced, counting up within the month.
// The same customer + same invoices on the same day keeps its number, so
// re-downloading a letter doesn't burn a new one.
function letterNumberFor(customerId: number, invoiceIds: number[], today: string): string {
  const key = JSON.stringify([...invoiceIds].sort((a, b) => a - b));
  const existing = db
    .prepare("SELECT letter_no FROM invoice_reminder_letters WHERE customer_id = ? AND issued_date = ? AND invoice_ids = ?")
    .get(customerId, today, key) as { letter_no: string } | undefined;
  if (existing) return existing.letter_no;
  const prefix = `JT-${today.slice(2, 4)}${today.slice(5, 7)}`;
  const last = db
    .prepare("SELECT letter_no FROM invoice_reminder_letters WHERE letter_no LIKE ? ORDER BY letter_no DESC LIMIT 1")
    .get(`${prefix}%`) as { letter_no: string } | undefined;
  const seq = last ? Number(last.letter_no.slice(prefix.length)) + 1 : 1;
  const letterNo = `${prefix}${String(seq).padStart(4, "0")}`;
  db.prepare("INSERT INTO invoice_reminder_letters (letter_no, customer_id, issued_date, invoice_ids) VALUES (?, ?, ?, ?)").run(
    letterNo,
    customerId,
    today,
    key
  );
  return letterNo;
}

function currentStage(customerId: number, invs: InvoiceRow[], today: string): number {
  const trig = triggeringInvoices(invs.map(toSched), lastSentByCustomer().get(customerId) ?? null, today);
  if (trig.length) return reminderStage(trig, today);
  const r = db
    .prepare("SELECT stage FROM invoice_reminder_log WHERE kind = 'customer' AND customer_id = ? AND undone_at IS NULL ORDER BY id DESC LIMIT 1")
    .get(customerId) as { stage: number } | undefined;
  return r?.stage ?? 1;
}

export async function buildLetter(
  customerId: number,
  forSalesperson: boolean
): Promise<{ pdf: Buffer; letterNo: string; fileName: string }> {
  const today = getTodayJakarta();
  const customer = db.prepare("SELECT * FROM invoice_reminder_customers WHERE customer_id = ?").get(customerId) as CustomerRow | undefined;
  if (!customer) throw new Error("Unknown customer");
  let invs = openInvoices(customerId);
  if (!invs.length) throw new Error(`${customer.name} has no overdue unpaid invoices any more.`);
  await ensureInvoiceDetails(invs.map((i) => i.invoice_id));
  invs = openInvoices(customerId);
  const lineStmt = db.prepare("SELECT * FROM invoice_reminder_lines WHERE invoice_id = ? ORDER BY seq");
  const invoices: LetterInvoice[] = invs.map((i) => ({
    number: i.number,
    transDate: i.trans_date,
    dueDate: i.due_date,
    totalAmount: i.total_amount,
    primeOwing: i.prime_owing,
    dppAmount: i.dpp_amount,
    taxAmount: i.tax_amount,
    paymentTerm: i.payment_term,
    lines: (lineStmt.all(i.invoice_id) as any[]).map((l) => ({
      itemNo: l.item_no,
      itemName: l.item_name,
      quantity: l.quantity,
      unit: l.unit,
      unitPrice: l.unit_price,
      discPercent: l.disc_percent,
      cashDiscount: l.cash_discount,
      totalPrice: l.total_price,
    })),
  }));
  // "Marketing :" prints the salesperson as Accurate names them on the invoice
  // (e.g. "YOYOK WIDODO"), falling back to our short name.
  const salesperson = invs.find((i) => i.salesman_name)?.salesman_name ?? salespersonFor(customer.salesman_id, listSalespeople());
  const letterNo = letterNumberFor(customerId, invs.map((i) => i.invoice_id), today);
  const pdf = await generateLetterPdf({
    letterNo,
    date: today,
    customerName: customer.name,
    salesperson,
    invoices,
  });
  const safeName = customer.name.replace(/[^A-Za-z0-9 .,-]/g, "").trim();
  return { pdf, letterNo, fileName: `${letterNo} - ${safeName}.pdf` };
}

export function customerWhatsApp(customerId: number): { url: string | null; message: string; phone: string | null } {
  const today = getTodayJakarta();
  const customer = db.prepare("SELECT * FROM invoice_reminder_customers WHERE customer_id = ?").get(customerId) as CustomerRow | undefined;
  if (!customer) throw new Error("Unknown customer");
  const invs = openInvoices(customerId);
  if (!invs.length) throw new Error(`${customer.name} has no overdue unpaid invoices any more.`);
  const message = customerMessage(
    customer.name,
    invs.map((i) => ({ number: i.number, dueDate: i.due_date, daysLate: daysBetween(i.due_date, today), primeOwing: i.prime_owing })),
    currentStage(customerId, invs, today)
  );
  return { url: waLink(customer.phone, message), message, phone: customer.phone };
}

export function salesWhatsApp(salesperson: string): { url: string | null; message: string; phone: string | null } {
  const task = buildState().salesTasks.find((t) => t.salesperson === salesperson);
  if (!task) throw new Error(`Nothing to forward to ${salesperson} today.`);
  const message = salesMessage(
    salesperson,
    task.customers.map((c) => ({
      name: c.name,
      invoiceCount: c.handoff.length,
      owing: c.handoff.reduce((s, i) => s + i.owing, 0),
      maxDaysLate: Math.max(...c.handoff.map((i) => i.daysLate)),
    }))
  );
  return { url: waLink(task.phone, message), message, phone: task.phone };
}

export function salesTaskCustomerIds(salesperson: string): number[] {
  return buildState().salesTasks.find((t) => t.salesperson === salesperson)?.customers.map((c) => c.id) ?? [];
}

