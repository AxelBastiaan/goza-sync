// Reproduces the exact failure the "Sync Now" button hits, and prints TikTok's raw
// rejection rather than the one-line message the GUI surfaces. Pushes the SAME value
// the sync itself would push (Accurate's availableToSell for the SKU, capped), so
// running this changes nothing that a normal sync wouldn't already do.
//
// Usage: npx ts-node src/scripts/reproStockPush.ts <productId> <skuId> <quantity>
import { callTikTokApi } from "../services/tiktokClient";
import { getTikTokStores } from "../services/storesRepo";

async function main() {
  const [productId, skuId, quantityArg] = process.argv.slice(2);
  if (!productId || !skuId || quantityArg === undefined) {
    console.error("Usage: ts-node src/scripts/reproStockPush.ts <productId> <skuId> <quantity>");
    process.exit(1);
  }

  const store = getTikTokStores()[0];
  if (!store) {
    console.error("No TikTok store connected");
    process.exit(1);
  }

  const response = await callTikTokApi(
    "POST",
    `/product/202309/products/${productId}/inventory/update`,
    { version: "202309" },
    { skus: [{ id: skuId, inventory: [{ quantity: Number(quantityArg) }] }] },
    store.credentials
  );

  console.log(`HTTP ${response.status}`);
  console.log(JSON.stringify(response.data, null, 2));
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
