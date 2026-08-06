import { db } from "../db";

const LIVE_MODE_KEY = "live_mode";

// Safety gate for the TikTok order webhook -> Accurate document creation path
// (Sales Order / Delivery Order / Sales Invoice / cancellation). Defaults to OFF —
// when off, the webhook still verifies signatures and logs incoming orders, but
// does not write anything to Accurate. Does NOT affect the Accurate -> TikTok
// stock-push direction, which is unrelated and already well-tested.
export function isLiveMode(): boolean {
  const row = db.prepare("SELECT value FROM settings WHERE key = ?").get(LIVE_MODE_KEY) as { value: string } | undefined;
  return row?.value === "true";
}

export function setLiveMode(live: boolean): void {
  db.prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(
    LIVE_MODE_KEY,
    live ? "true" : "false"
  );
}
