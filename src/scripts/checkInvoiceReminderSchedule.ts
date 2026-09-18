// Assertions for the invoice-reminder rules in services/invoiceReminders/schedule.ts
// (pure functions — no DB, no Accurate). Run: npx ts-node src/scripts/checkInvoiceReminderSchedule.ts
import assert from "assert";
import {
  SchedInvoice,
  addDays,
  applySent,
  assignBatches,
  daysBetween,
  initialEffectiveDueDate,
  nextReminderDate,
  pendingEscalation,
  reminderStage,
  triggeringInvoices,
} from "../services/invoiceReminders/schedule";

const D0 = "2026-10-01";

function inv(id: number, dueDate: string, effectiveDueDate: string | null = dueDate): SchedInvoice {
  return { invoiceId: id, dueDate, effectiveDueDate, stageSent: 0, escalatedAt: null };
}

interface Event {
  day: number;
  kind: "reminder" | "sales";
  stage?: number;
}

// Plays the admin doing everything the day it shows up. `sendOn` (optional)
// restricts which days the admin actually sends customer reminders; `paid`
// removes invoices on a given day.
function simulate(
  invoices: SchedInvoice[],
  days: number,
  opts: { sendOn?: (day: number) => boolean; paid?: Record<number, number[]> } = {}
): Event[] {
  let open = invoices.map((i) => ({ ...i }));
  let lastSent: string | null = null;
  const events: Event[] = [];
  for (let d = 0; d <= days; d++) {
    const today = addDays(D0, d);
    const paidToday = opts.paid?.[d] ?? [];
    open = open.filter((i) => !paidToday.includes(i.invoiceId));
    const trig = triggeringInvoices(open, lastSent, today);
    if (trig.length && (!opts.sendOn || opts.sendOn(d))) {
      events.push({ day: d, kind: "reminder", stage: reminderStage(trig, today) });
      const changes = applySent(open, trig, today);
      for (const i of open) {
        const c = changes.get(i.invoiceId);
        if (c) Object.assign(i, c);
      }
      lastSent = today;
    }
    const esc = pendingEscalation(open, today);
    if (esc.length) {
      events.push({ day: d, kind: "sales" });
      for (const i of esc) i.escalatedAt = today;
    }
  }
  return events;
}

const reminders = (ev: Event[]) => ev.filter((e) => e.kind === "reminder");
let passed = 0;
function check(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`✓ ${name}`);
}

check("single invoice: reminders at +3/+7/+10, sales at +14", () => {
  const ev = simulate([inv(1, D0)], 30);
  assert.deepStrictEqual(ev, [
    { day: 3, kind: "reminder", stage: 1 },
    { day: 7, kind: "reminder", stage: 2 },
    { day: 10, kind: "reminder", stage: 3 },
    { day: 14, kind: "sales" },
  ]);
});

check("two invoices due a day apart: still exactly three messages, ≥3 days apart", () => {
  const ev = reminders(simulate([inv(1, D0), inv(2, addDays(D0, 1))], 30));
  assert.deepStrictEqual(ev.map((e) => e.day), [3, 7, 10]);
});

check("many staggered invoices never break the 3-day gap", () => {
  const invs = [0, 1, 2, 4, 5, 9].map((o, k) => inv(k + 1, addDays(D0, o)));
  const days = reminders(simulate(invs, 40)).map((e) => e.day);
  for (let k = 1; k < days.length; k++) assert.ok(days[k] - days[k - 1] >= 3, `gap ${days}`);
});

check("invoice paid midway drops out (no further reminders or hand-off)", () => {
  const ev = simulate([inv(1, D0)], 30, { paid: { 5: [1] } });
  assert.deepStrictEqual(ev, [{ day: 3, kind: "reminder", stage: 1 }]);
});

check("backlog invoice (30 days late at start) gets a fresh cycle from its start day", () => {
  const start = addDays(D0, 2);
  const due = addDays(start, -30);
  const eff = initialEffectiveDueDate(due, start);
  assert.strictEqual(eff, addDays(start, -3));
  const ev = simulate([inv(1, due, eff)], 30);
  assert.deepStrictEqual(ev, [
    { day: 2, kind: "reminder", stage: 1 },
    { day: 6, kind: "reminder", stage: 2 },
    { day: 9, kind: "reminder", stage: 3 },
    { day: 13, kind: "sales" },
  ]);
});

check("invoice 1–2 days late at start keeps its real schedule", () => {
  assert.strictEqual(initialEffectiveDueDate("2026-09-30", D0), "2026-09-30");
});

check("backlog spread: ≤25/day, biggest first, skips Sundays and holidays", () => {
  const customers = Array.from({ length: 120 }, (_, k) => ({ customerId: k + 1, owing: 1000 - k }));
  // 2026-10-03 is a Saturday, 10-04 a Sunday; pretend 10-05 is a holiday.
  const starts = assignBatches(customers, "2026-10-03", 25, new Set(["2026-10-05"]));
  const perDay = new Map<string, number>();
  for (const d of starts.values()) perDay.set(d, (perDay.get(d) ?? 0) + 1);
  assert.deepStrictEqual([...perDay.entries()].sort(), [
    ["2026-10-03", 25],
    ["2026-10-06", 25],
    ["2026-10-07", 25],
    ["2026-10-08", 25],
    ["2026-10-09", 20],
  ]);
  assert.strictEqual(starts.get(1), "2026-10-03"); // largest balance first
  assert.strictEqual(starts.get(120), "2026-10-09");
});

check("unscheduled (pre-go-live / ignored) invoices never trigger", () => {
  const i = inv(1, addDays(D0, -40), null);
  assert.deepStrictEqual(triggeringInvoices([i], null, D0), []);
  assert.deepStrictEqual(pendingEscalation([i], D0), []);
});

check("late send (day 5) pushes the next reminder to ≥ day 8", () => {
  const ev = reminders(simulate([inv(1, D0)], 30, { sendOn: (d) => d >= 5 }));
  assert.strictEqual(ev[0].day, 5);
  assert.ok(ev[1].day >= 8, `second reminder on day ${ev[1].day}`);
});

check("a backlog invoice waiting for its batch starts with an earlier letter", () => {
  const today = addDays(D0, 3);
  const fresh = inv(1, D0); // triggers today (+3)
  const waitingBacklog = inv(2, addDays(D0, -40), addDays(D0, 5)); // batch starts day 8
  const changes = applySent([fresh, waitingBacklog], [fresh], today);
  assert.deepStrictEqual(changes.get(2), { stageSent: 1, effectiveDueDate: addDays(today, -3) });
});

check("nextReminderDate respects the gap", () => {
  const i = { ...inv(1, D0), stageSent: 1 };
  assert.strictEqual(nextReminderDate([i], addDays(D0, 6)), addDays(D0, 9)); // +7 would be day 7, gap pushes to 9
  assert.strictEqual(daysBetween(D0, nextReminderDate([i], addDays(D0, 3))!), 7);
});

console.log(`\n${passed} checks passed`);
