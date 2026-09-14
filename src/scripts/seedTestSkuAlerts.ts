// Seeds the SKU Alerts tab with realistic test data so the flagging feature can be
// reviewed in the GUI without waiting for a real unmappable order to arrive.
//
//   npx ts-node src/scripts/seedTestSkuAlerts.ts          # seed
//   npx ts-node src/scripts/seedTestSkuAlerts.ts --clear   # remove every seeded row
//
// Every row it writes is blocked on a TEST- order id (and, bar one deliberate case,
// a TEST- SKU), so --clear removes exactly what it added and nothing else. It writes
// only to the local alerts table — it never touches Accurate or either marketplace.
import { db } from "../db";
import { recordUnmappedSkus } from "../services/skuAlerts";
import { resolveOrderLines } from "../services/accurateSalesFlow";
import { getSkuMappings } from "../services/skuMappings";
import { OrderLineItem } from "../services/tiktokOrders";

const TEST_SKU_PREFIX = "TEST-";

function clear(): void {
  // Matches on the blocked order ids too, so the one row that deliberately borrows
  // a real SKU string (the auto-resolve demo) is cleaned up as well.
  const result = db
    .prepare("DELETE FROM unmapped_sku_alerts WHERE marketplace_sku LIKE ? OR blocked_orders_json LIKE ?")
    .run(`${TEST_SKU_PREFIX}%`, `%"${TEST_SKU_PREFIX}%`);
  console.log(`Removed ${result.changes} seeded test alert(s).`);
}

async function seed(): Promise<void> {
  // 1. The most common case by far: a variant SKU nobody has mapped yet. Modelled on
  //    the real Shopee order 2608210B85BWCJ, where the intended item was only
  //    identifiable from the variant name.
  recordUnmappedSkus("shopee", "TEST-2609091A11AAAA", [
    {
      sellerSku: "TEST-SMR-38-F",
      productName: "TERMURAH!!! Buku Tulis Semar Premium 1 Pack isi 10 Pcs - Isi 38 Lembar / Buku Karakter",
      variantName: "CAMPUS BIRU",
      reason: "No SKU mapping — this marketplace SKU isn't linked to any Accurate item yet",
    },
  ]);
  // Same SKU, a second order: proves repeat blockage stays one row to act on.
  recordUnmappedSkus("shopee", "TEST-2609092B22BBBB", [
    {
      sellerSku: "TEST-SMR-38-F",
      productName: "TERMURAH!!! Buku Tulis Semar Premium 1 Pack isi 10 Pcs - Isi 38 Lembar / Buku Karakter",
      variantName: "CAMPUS BIRU",
      reason: "No SKU mapping — this marketplace SKU isn't linked to any Accurate item yet",
    },
  ]);

  // 2. A TikTok order blocked on two different SKUs at once — one unmapped, one
  //    mapped to an Accurate item that doesn't exist (a typo'd mapping).
  recordUnmappedSkus("tiktok", "TEST-576123456789012345", [
    {
      sellerSku: "TEST-SON-99Z",
      productName: "SON Lilin Ulang Tahun Spiral Gold 10 Pcs",
      variantName: "GOLD",
      reason: "No SKU mapping — this marketplace SKU isn't linked to any Accurate item yet",
    },
    {
      sellerSku: "TEST-GZ-238-X",
      productName: "Goza Pita Kado Roll 2cm",
      reason: "Mapped to Accurate item TEST-GZ-238-TYPO, but no such item exists in Accurate",
    },
  ]);

  // 3. A line the marketplace sent with no product title at all — the hardest kind
  //    to act on, and worth seeing rendered.
  recordUnmappedSkus("shopee", "TEST-2609093C33CCCC", [
    {
      sellerSku: "TEST-NO-TITLE-01",
      reason: "No SKU mapping — this marketplace SKU isn't linked to any Accurate item yet",
    },
  ]);

  // 4. The self-healing case: an alert on a SKU that IS mapped. Opening the tab
  //    flips it to "mapped ✓" on its own, with no one having to tick it off.
  //    Uses a real mapping from this database so the check is genuine.
  const mapped = getSkuMappings().find((m) => m.marketplaceSku);
  if (mapped?.marketplaceSku) {
    recordUnmappedSkus("tiktok", "TEST-576987654321098765", [
      {
        sellerSku: mapped.marketplaceSku,
        productName: `(already mapped to ${mapped.accurateSku} — this row should show as resolved)`,
        reason: "No SKU mapping — this marketplace SKU isn't linked to any Accurate item yet",
      },
    ]);
    console.log(`Seeded a resolved-case alert borrowing the real mapping ${mapped.marketplaceSku} -> ${mapped.accurateSku}.`);
  } else {
    console.log("No mapped SKU found in this database — skipped the auto-resolve demo row.");
  }

  // 5. Live check of the real detection path (not a hand-written alert): run actual
  //    order lines through the same resolver the webhooks use, and confirm it flags
  //    the unmapped one. This is what proves the tab reflects reality.
  const lines: OrderLineItem[] = [
    {
      sellerSku: "TEST-DEFINITELY-NOT-MAPPED",
      quantity: 1,
      unitPrice: 21000,
      originalPrice: 31000,
      productName: "Live resolver check — should be flagged",
    },
  ];
  const { details, unresolved } = await resolveOrderLines(lines);
  console.log(`\nLive resolver check: ${details.length} resolved line(s), ${unresolved.length} unresolved.`);
  for (const u of unresolved) {
    console.log(`  flagged ${u.sellerSku}: ${u.reason}`);
  }
  if (unresolved.length > 0) {
    recordUnmappedSkus("tiktok", "TEST-RESOLVER-CHECK", unresolved);
  }

  const rows = db
    .prepare("SELECT platform, marketplace_sku, occurrence_count, status FROM unmapped_sku_alerts ORDER BY id")
    .all() as { platform: string; marketplace_sku: string; occurrence_count: number; status: string }[];
  console.log(`\nAlerts table now holds ${rows.length} row(s):`);
  for (const r of rows) {
    console.log(`  [${r.platform}] ${r.marketplace_sku} — ${r.occurrence_count} order(s), ${r.status}`);
  }
}

async function main(): Promise<void> {
  if (process.argv.includes("--clear")) {
    clear();
    return;
  }
  await seed();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
