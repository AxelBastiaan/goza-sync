import { db } from "../../db";
import { getEnv } from "../../env";
import { isAccurateConnected } from "../accurateClient";
import { getTodayJakarta } from "../stockOpname";
import {
  fetchOutstandingOverdue,
  fetchCustomerDetails,
  fetchInvoiceDetails,
  OutstandingInvoice,
  CustomerDetail,
} from "./accurate";

// Accurate → local tables. Accurate stays the source of truth for what is owed;
// these refreshes only mirror it so the queues can be built without a round trip.

// Marketplace storefront "customers" — their invoices are settled by the
// marketplace, never chased. Same ids as sales-recall's MARKETPLACE_CUSTOMER_IDS
// (confirmed live 2026-07-31), plus whatever the env points the order flow at.
const MARKETPLACE_CUSTOMER_IDS = new Set<number>(
  [87400, 87450, 87350, 89451, 89450, Number(getEnv("ACCURATE_TIKTOK_CUSTOMER_ID")), Number(getEnv("ACCURATE_SHOPEE_CUSTOMER_ID"))].filter(
    (n) => Number.isFinite(n) && n > 0
  )
);

const LAST_REFRESH_KEY = "invoice_reminders_last_refresh";
const STALE_AFTER_MS = 30 * 60 * 1000;
// Contact data changes rarely; re-read it a few times a day, not on every refresh.
const CUSTOMER_STALE_AFTER_MS = 6 * 60 * 60 * 1000;

export function getLastRefresh(): string | null {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LAST_REFRESH_KEY) as { value: string } | undefined;
  return row?.value ?? null;
}

function setLastRefresh(iso: string): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    LAST_REFRESH_KEY,
    iso
  );
}

function upsertInvoices(rows: OutstandingInvoice[], today: string): void {
  const upsert = db.prepare(`
    INSERT INTO invoice_reminder_invoices
      (invoice_id, number, customer_id, trans_date, due_date, total_amount, prime_owing, first_seen, last_seen)
    VALUES (@id, @number, @customerId, @transDate, @dueDate, @totalAmount, @primeOwing, @today, @today)
    ON CONFLICT(invoice_id) DO UPDATE SET
      number = excluded.number, customer_id = excluded.customer_id, trans_date = excluded.trans_date,
      due_date = excluded.due_date, total_amount = excluded.total_amount, prime_owing = excluded.prime_owing,
      last_seen = excluded.last_seen, paid_at = NULL
  `);
  for (const r of rows) upsert.run({ ...r, today });
}

function upsertCustomers(details: CustomerDetail[], nowIso: string): void {
  const upsert = db.prepare(`
    INSERT INTO invoice_reminder_customers (customer_id, name, customer_no, contact_name, phone, salesman_id, fetched_at)
    VALUES (@id, @name, @customerNo, @contactName, @phone, @salesmanId, @nowIso)
    ON CONFLICT(customer_id) DO UPDATE SET
      name = excluded.name, customer_no = excluded.customer_no, contact_name = excluded.contact_name,
      phone = excluded.phone, salesman_id = excluded.salesman_id, fetched_at = excluded.fetched_at
  `);
  for (const d of details) upsert.run({ ...d, nowIso });
}

// Placeholder row for a customer whose detail call hasn't happened (or failed),
// so the invoice still shows up — with no phone, which greys out WhatsApp.
function ensureCustomerRows(rows: OutstandingInvoice[]): void {
  const insert = db.prepare(
    "INSERT OR IGNORE INTO invoice_reminder_customers (customer_id, name, customer_no) VALUES (?, ?, ?)"
  );
  for (const r of rows) insert.run(r.customerId, r.customerName, r.customerNo);
}

async function refreshCustomerDetails(ids: number[], nowIso: string): Promise<void> {
  if (ids.length === 0) return;
  const details = await fetchCustomerDetails(ids);
  db.transaction(() => upsertCustomers(details, nowIso))();
}

let inFlight: Promise<void> | null = null;

// Full refresh: every overdue unpaid invoice, then contact details for customers
// that are new or whose details are older than CUSTOMER_STALE_AFTER_MS (or all of
// them when `forceCustomers`). Concurrent callers share one run.
export function refreshFromAccurate(forceCustomers = false): Promise<void> {
  if (!inFlight) {
    inFlight = doRefresh(forceCustomers).finally(() => {
      inFlight = null;
    });
  }
  return inFlight;
}

async function doRefresh(forceCustomers: boolean): Promise<void> {
  if (!isAccurateConnected()) throw new Error("Accurate is not connected (see Integrations).");
  const today = getTodayJakarta();
  const nowIso = new Date().toISOString();
  // Fetch everything before touching the tables: a failure halfway must not mark
  // the invoices we didn't get to as paid.
  const rows = (await fetchOutstandingOverdue(today)).filter((r) => !MARKETPLACE_CUSTOMER_IDS.has(r.customerId));

  db.transaction(() => {
    upsertInvoices(rows, today);
    ensureCustomerRows(rows);
    const seen = new Set(rows.map((r) => r.id));
    const open = db.prepare("SELECT invoice_id FROM invoice_reminder_invoices WHERE paid_at IS NULL").all() as { invoice_id: number }[];
    const markPaid = db.prepare("UPDATE invoice_reminder_invoices SET paid_at = ? WHERE invoice_id = ?");
    for (const o of open) if (!seen.has(o.invoice_id)) markPaid.run(today, o.invoice_id);
  })();

  const customerIds = [...new Set(rows.map((r) => r.customerId))];
  const staleBefore = new Date(Date.now() - CUSTOMER_STALE_AFTER_MS).toISOString();
  const toFetch = forceCustomers
    ? customerIds
    : customerIds.filter((id) => {
        const c = db.prepare("SELECT fetched_at FROM invoice_reminder_customers WHERE customer_id = ?").get(id) as
          | { fetched_at: string | null }
          | undefined;
        return !c?.fetched_at || c.fetched_at < staleBefore;
      });
  await refreshCustomerDetails(toFetch, nowIso);
  setLastRefresh(nowIso);
}

export async function refreshIfStale(): Promise<void> {
  const last = getLastRefresh();
  if (last && Date.now() - Date.parse(last) < STALE_AFTER_MS) return;
  await refreshFromAccurate();
}

// Re-reads one customer's invoices + contact right before a letter or WhatsApp
// goes out, so nobody is chased for something paid this morning.
export async function refreshCustomer(customerId: number): Promise<void> {
  if (!isAccurateConnected()) throw new Error("Accurate is not connected (see Integrations).");
  const today = getTodayJakarta();
  const nowIso = new Date().toISOString();
  const rows = await fetchOutstandingOverdue(today, customerId);
  const [detail] = await fetchCustomerDetails([customerId]);
  db.transaction(() => {
    upsertInvoices(rows, today);
    ensureCustomerRows(rows);
    upsertCustomers([detail], nowIso);
    const seen = new Set(rows.map((r) => r.id));
    const open = db
      .prepare("SELECT invoice_id FROM invoice_reminder_invoices WHERE paid_at IS NULL AND customer_id = ?")
      .all(customerId) as { invoice_id: number }[];
    const markPaid = db.prepare("UPDATE invoice_reminder_invoices SET paid_at = ? WHERE invoice_id = ?");
    for (const o of open) if (!seen.has(o.invoice_id)) markPaid.run(today, o.invoice_id);
  })();
}

// Line items + tax breakdown for the letter's attachment pages, refetched at most
// once per day per invoice.
export async function ensureInvoiceDetails(invoiceIds: number[]): Promise<void> {
  const today = getTodayJakarta();
  const stale = invoiceIds.filter((id) => {
    const r = db.prepare("SELECT detail_fetched_date FROM invoice_reminder_invoices WHERE invoice_id = ?").get(id) as
      | { detail_fetched_date: string | null }
      | undefined;
    return r?.detail_fetched_date !== today;
  });
  if (stale.length === 0) return;
  const details = await fetchInvoiceDetails(stale);
  const setHeader = db.prepare(
    "UPDATE invoice_reminder_invoices SET dpp_amount = ?, tax_amount = ?, payment_term = ?, salesman_name = ?, detail_fetched_date = ? WHERE invoice_id = ?"
  );
  const clearLines = db.prepare("DELETE FROM invoice_reminder_lines WHERE invoice_id = ?");
  const insertLine = db.prepare(`
    INSERT INTO invoice_reminder_lines (invoice_id, seq, item_no, item_name, quantity, unit, unit_price, disc_percent, cash_discount, total_price)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  db.transaction(() => {
    for (const d of details) {
      setHeader.run(d.dppAmount, d.taxAmount, d.paymentTerm, d.salesmanName, today, d.id);
      clearLines.run(d.id);
      d.lines.forEach((l, idx) =>
        insertLine.run(d.id, idx + 1, l.itemNo, l.itemName, l.quantity, l.unit, l.unitPrice, l.discPercent, l.cashDiscount, l.totalPrice)
      );
    }
  })();
}
