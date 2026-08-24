import axios from "axios";
import path from "path";
import * as XLSX from "xlsx";
import { db } from "../db";

const EXCEL_PATH = path.join(__dirname, "..", "..", "sales-recall", "CATEGORY PRODUCT.xlsx");
const HOLIDAY_API = "https://api-harilibur.vercel.app/api";

export interface StockOpnameItem {
  sku: string;
  item_name: string;
}

// Jakarta wall-clock date as YYYY-MM-DD, no matter where the process runs (the
// Docker host runs UTC — see the same problem/fix in accurateClient.ts's
// formatTimestamp, which this mirrors).
export function getTodayJakarta(): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Jakarta",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get("year")}-${get("month")}-${get("day")}`;
}

function isSundayJakarta(dateStr: string): boolean {
  // Constructing with a fixed noon UTC time keeps the weekday stable regardless of
  // the host's own timezone (midnight UTC could roll to the previous/next day).
  const weekday = new Date(`${dateStr}T12:00:00Z`).toLocaleDateString("en-US", {
    timeZone: "Asia/Jakarta",
    weekday: "short",
  });
  return weekday === "Sun";
}

// Reads the same "CATEGORY PRODUCT.xlsx" file sales-recall/services/categoryMapping.ts
// uses for the "STATUS BARANG" discontinued signal. Read directly here (rather than
// importing that module) since sales-recall/ is a separate TS project not included in
// this app's tsconfig — src/**/*.ts only.
export function loadActiveItems(): StockOpnameItem[] {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.readFile(EXCEL_PATH);
  } catch (err) {
    throw new Error(
      `Could not read "CATEGORY PRODUCT.xlsx" at ${EXCEL_PATH} — stock opname needs this file to know which items are active. (${(err as Error).message})`
    );
  }

  const sheet = workbook.Sheets["CLEAN PRODUCT"] ?? workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1 }) as unknown[][];

  const header = (rows[0] ?? []).map((h) => String(h ?? "").trim().toUpperCase());
  const colIndex = (name: string): number => {
    const idx = header.indexOf(name);
    if (idx === -1) throw new Error(`"CATEGORY PRODUCT.xlsx" is missing expected column "${name}"`);
    return idx;
  };
  const codeCol = colIndex("KODE BARANG");
  const nameCol = colIndex("NAMA BARANG");
  const statusCol = header.indexOf("STATUS BARANG");

  const items: StockOpnameItem[] = [];
  const seen = new Set<string>();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i];
    const sku = String(row[codeCol] ?? "").trim();
    if (!sku || seen.has(sku)) continue;
    const discontinued = statusCol !== -1 && String(row[statusCol] ?? "").trim().toUpperCase() === "DISCONTINUE";
    if (discontinued) continue;
    seen.add(sku);
    items.push({ sku, item_name: String(row[nameCol] ?? "").trim() });
  }
  return items;
}

// Both national holidays and "cuti bersama" (joint leave days) count as "tanggal
// merah" for this purpose — both are printed red on an Indonesian calendar and
// neither is a work day.
export async function fetchHolidays(year: number): Promise<Set<string>> {
  const cached = db.prepare("SELECT date FROM stock_opname_holidays WHERE year = ?").all(year) as { date: string }[];
  if (cached.length > 0) {
    return new Set(cached.map((r) => r.date));
  }

  try {
    const res = await axios.get(HOLIDAY_API, { params: { year } });
    const rows = (res.data ?? []) as { holiday_date: string; holiday_name?: string }[];
    const insert = db.prepare(
      "INSERT OR IGNORE INTO stock_opname_holidays (year, date, name) VALUES (?, ?, ?)"
    );
    const insertMany = db.transaction((entries: typeof rows) => {
      for (const r of entries) insert.run(year, r.holiday_date, r.holiday_name ?? null);
    });
    insertMany(rows);
    return new Set(rows.map((r) => r.holiday_date));
  } catch (err) {
    console.warn(`[stockOpname] Failed to fetch ${year} holiday list, treating it as having no holidays: ${(err as Error).message}`);
    return new Set();
  }
}

export function countWorkdays(year: number, holidays: Set<string>): number {
  let count = 0;
  const start = new Date(Date.UTC(year, 0, 1));
  const end = new Date(Date.UTC(year, 11, 31));
  for (let d = start; d <= end; d = new Date(d.getTime() + 86400000)) {
    const dateStr = d.toISOString().slice(0, 10);
    if (isSundayJakarta(dateStr) || holidays.has(dateStr)) continue;
    count++;
  }
  return count;
}

interface CycleState {
  id: number;
  cycle_year: number;
  batch_size: number;
  queue_json: string;
  last_release_date: string | null;
}

// Rolls over to a fresh yearly cycle if needed, then releases today's batch if
// today is a work day and hasn't already had a batch released. Called at the top
// of every /today request — there's no cron/scheduler in this app, so this is
// deliberately idempotent and cheap to re-run on every hit.
export async function ensureCycle(): Promise<void> {
  const today = getTodayJakarta();
  const currentYear = Number(today.slice(0, 4));

  let state = db.prepare("SELECT * FROM stock_opname_state WHERE id = 1").get() as CycleState | undefined;

  if (!state || state.cycle_year !== currentYear) {
    const activeItems = loadActiveItems();

    const insertItem = db.prepare(
      "INSERT OR IGNORE INTO stock_opname_items (sku, item_name, released_date, completed_date) VALUES (?, ?, NULL, NULL)"
    );
    const insertMany = db.transaction((items: StockOpnameItem[]) => {
      for (const item of items) insertItem.run(item.sku, item.item_name);
    });
    insertMany(activeItems);

    const holidays = await fetchHolidays(currentYear);
    const workdays = countWorkdays(currentYear, holidays);
    const batchSize = Math.max(1, Math.ceil(activeItems.length / Math.max(1, workdays)));

    const unreleased = db
      .prepare("SELECT sku FROM stock_opname_items WHERE released_date IS NULL ORDER BY sku")
      .all() as { sku: string }[];

    db.prepare(
      `INSERT INTO stock_opname_state (id, cycle_year, batch_size, queue_json, last_release_date)
       VALUES (1, ?, ?, ?, NULL)
       ON CONFLICT(id) DO UPDATE SET cycle_year = excluded.cycle_year, batch_size = excluded.batch_size,
         queue_json = excluded.queue_json, last_release_date = excluded.last_release_date`
    ).run(currentYear, batchSize, JSON.stringify(unreleased.map((r) => r.sku)));

    state = db.prepare("SELECT * FROM stock_opname_state WHERE id = 1").get() as CycleState;
  }

  const holidaysToday = await fetchHolidays(currentYear);
  const isWorkday = !isSundayJakarta(today) && !holidaysToday.has(today);

  if (isWorkday && state.last_release_date !== today) {
    const queue = JSON.parse(state.queue_json) as string[];
    const releasing = queue.slice(0, state.batch_size);
    const remaining = queue.slice(state.batch_size);

    if (releasing.length > 0) {
      const release = db.prepare("UPDATE stock_opname_items SET released_date = ? WHERE sku = ?");
      const releaseMany = db.transaction((skus: string[]) => {
        for (const sku of skus) release.run(today, sku);
      });
      releaseMany(releasing);
    }

    db.prepare("UPDATE stock_opname_state SET queue_json = ?, last_release_date = ? WHERE id = 1").run(
      JSON.stringify(remaining),
      today
    );
  }
}

export function getTodayList(): (StockOpnameItem & { released_date: string })[] {
  return db
    .prepare(
      "SELECT sku, item_name, released_date FROM stock_opname_items WHERE released_date IS NOT NULL AND completed_date IS NULL ORDER BY released_date, sku"
    )
    .all() as (StockOpnameItem & { released_date: string })[];
}

export function markDone(skus: string[]): void {
  if (skus.length === 0) return;
  const today = getTodayJakarta();
  const update = db.prepare("UPDATE stock_opname_items SET completed_date = ? WHERE sku = ?");
  const updateMany = db.transaction((list: string[]) => {
    for (const sku of list) update.run(today, sku);
  });
  updateMany(skus);
}

export function getCycleInfo(): { cycle_year: number; batch_size: number } | null {
  const state = db.prepare("SELECT cycle_year, batch_size FROM stock_opname_state WHERE id = 1").get() as
    | { cycle_year: number; batch_size: number }
    | undefined;
  return state ?? null;
}
