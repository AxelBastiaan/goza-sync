// Pure reminder rules — no DB, no Accurate — so they can be checked in isolation
// (src/scripts/checkInvoiceReminderSchedule.ts). All dates are Jakarta calendar
// dates as YYYY-MM-DD strings.
//
// The rules, per customer:
// - Each unpaid invoice is due a customer reminder at +3, +7 and +10 days past its
//   effective due date, and is handed to the salesperson at +14 (after which it
//   never triggers a customer reminder again).
// - A customer gets at most one reminder per GAP_DAYS; that one reminder lists
//   every overdue invoice they have, so several invoices never mean several
//   messages.

export const THRESHOLDS = [3, 7, 10];
export const ESCALATE_AT = 14;
export const GAP_DAYS = 3;

export interface SchedInvoice {
  invoiceId: number;
  dueDate: string;
  effectiveDueDate: string | null; // null = not scheduled yet (before go-live)
  stageSent: number;
  escalatedAt: string | null;
}

export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

export function stageReached(daysOverdue: number): number {
  return THRESHOLDS.filter((t) => t <= daysOverdue).length;
}

function overdue(inv: SchedInvoice, today: string): number {
  return daysBetween(inv.effectiveDueDate!, today);
}

function isActive(inv: SchedInvoice): boolean {
  return inv.effectiveDueDate !== null && inv.escalatedAt === null;
}

// Invoices that make the customer due for a reminder today. Empty when nothing
// has reached its next step, or when the last reminder was under GAP_DAYS ago.
export function triggeringInvoices(invoices: SchedInvoice[], lastSent: string | null, today: string): SchedInvoice[] {
  if (lastSent && daysBetween(lastSent, today) < GAP_DAYS) return [];
  return invoices.filter((i) => {
    if (!isActive(i)) return false;
    const o = overdue(i, today);
    return o < ESCALATE_AT && stageReached(o) > i.stageSent;
  });
}

// The "Pengingat ke-N" number for today's reminder.
export function reminderStage(triggering: SchedInvoice[], today: string): number {
  return Math.max(1, ...triggering.map((i) => stageReached(overdue(i, today))));
}

export function pendingEscalation(invoices: SchedInvoice[], today: string): SchedInvoice[] {
  return invoices.filter((i) => isActive(i) && overdue(i, today) >= ESCALATE_AT);
}

// State each invoice moves to when today's reminder is marked sent:
// - invoices that triggered it are covered up to the step they reached;
// - every other overdue invoice on the letter is also covered for a step that
//   would otherwise come due inside the GAP_DAYS window — this letter already
//   told the customer about it, and waiting for it would only push the next
//   reminder further out;
// - a backlog invoice whose (spread-out) start day hasn't come yet starts its
//   cycle with this letter instead, as reminder 1.
export function applySent(
  invoices: SchedInvoice[],
  triggering: SchedInvoice[],
  today: string
): Map<number, { stageSent: number; effectiveDueDate: string }> {
  const trigIds = new Set(triggering.map((i) => i.invoiceId));
  const out = new Map<number, { stageSent: number; effectiveDueDate: string }>();
  for (const inv of invoices) {
    if (!isActive(inv)) continue;
    if (daysBetween(inv.dueDate, today) < 1) continue; // not actually overdue
    const o = overdue(inv, today);
    if (trigIds.has(inv.invoiceId)) {
      out.set(inv.invoiceId, { stageSent: stageReached(o), effectiveDueDate: inv.effectiveDueDate! });
    } else if (o < 1) {
      out.set(inv.invoiceId, { stageSent: 1, effectiveDueDate: addDays(today, -THRESHOLDS[0]) });
    } else {
      const covered = Math.max(inv.stageSent, stageReached(o + GAP_DAYS - 1));
      if (covered !== inv.stageSent) out.set(inv.invoiceId, { stageSent: covered, effectiveDueDate: inv.effectiveDueDate! });
    }
  }
  return out;
}

// When the customer will next show up in "To send" (assuming nothing is paid).
export function nextReminderDate(invoices: SchedInvoice[], lastSent: string | null): string | null {
  let next: string | null = null;
  for (const inv of invoices) {
    if (!isActive(inv)) continue;
    const t = THRESHOLDS[inv.stageSent];
    if (t === undefined) continue;
    let d = addDays(inv.effectiveDueDate!, t);
    if (lastSent && daysBetween(lastSent, d) < GAP_DAYS) d = addDays(lastSent, GAP_DAYS);
    if (!next || d < next) next = d;
  }
  return next;
}

// Where an invoice with no schedule yet starts: normally its real due date; an
// invoice first seen already THRESHOLDS[0]+ days overdue (the go-live backlog, or
// one that appeared late) starts its cycle on startDay instead, so it gets
// reminder 1 then rather than jumping straight to a later step or to sales.
export function initialEffectiveDueDate(dueDate: string, startDay: string): string {
  return daysBetween(dueDate, startDay) >= THRESHOLDS[0] ? addDays(startDay, -THRESHOLDS[0]) : dueDate;
}

export function isWorkday(date: string, holidays: Set<string>): boolean {
  return new Date(`${date}T12:00:00Z`).getUTCDay() !== 0 && !holidays.has(date);
}

// Spreads the go-live backlog so the admin gets a steady batch per working day:
// biggest balances first, `perDay` customers per working day (Mon–Sat, skipping
// holidays) starting at `from`. Returns customerId → the day their cycle starts.
export function assignBatches(
  customers: { customerId: number; owing: number }[],
  from: string,
  perDay: number,
  holidays: Set<string>
): Map<number, string> {
  const sorted = [...customers].sort((a, b) => b.owing - a.owing);
  const out = new Map<number, string>();
  let day = from;
  while (!isWorkday(day, holidays)) day = addDays(day, 1);
  sorted.forEach((c, idx) => {
    if (idx > 0 && idx % perDay === 0) {
      day = addDays(day, 1);
      while (!isWorkday(day, holidays)) day = addDays(day, 1);
    }
    out.set(c.customerId, day);
  });
  return out;
}
