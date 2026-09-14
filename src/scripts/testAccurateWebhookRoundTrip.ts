// Live proof that an Accurate stock change reaches the marketplaces: adds +1 to one
// mapped item via an item adjustment, then deletes that adjustment so the books end
// exactly where they started. Both the add and the delete should each trigger
// Accurate's stock webhook — the VPS log is checked separately.
//
//   npx ts-node src/scripts/testAccurateWebhookRoundTrip.ts pick     # find a candidate
//   npx ts-node src/scripts/testAccurateWebhookRoundTrip.ts add SKU  # +1, prints adjustment id
//   npx ts-node src/scripts/testAccurateWebhookRoundTrip.ts delete ID
//   npx ts-node src/scripts/testAccurateWebhookRoundTrip.ts stock SKU
import { callAccurateApi } from "../services/accurateClient";
import { getDefaultWarehouseId, formatAccurateDate } from "../services/accurateAdjustment";
import { fetchAccurateItemDataFor } from "../services/stockSync";
import { getSkuMappings } from "../services/skuMappings";

async function pick(): Promise<void> {
  // Marketplace display is capped at 500, so only an item under the cap can show a
  // visible change. Look at the first few dozen mapped SKUs and print low-stock ones.
  const skus = [...new Set(getSkuMappings().map((m) => m.accurateSku))].slice(0, 60);
  const data = await fetchAccurateItemDataFor(skus);
  for (const sku of skus) {
    const d = data.get(sku);
    if (d && d.quantity > 0 && d.quantity < 400) {
      console.log(`${sku}\tqty=${d.quantity}\tunits=${JSON.stringify(d.units)}`);
    }
  }
}

async function stock(sku: string): Promise<void> {
  const data = await fetchAccurateItemDataFor([sku]);
  console.log(`${sku} availableToSell = ${data.get(sku)?.quantity}`);
}

async function add(sku: string): Promise<void> {
  const warehouseId = await getDefaultWarehouseId();
  const response = await callAccurateApi("POST", "item-adjustment/save.do", {}, {
    transDate: formatAccurateDate(new Date()),
    warehouseId: Number(warehouseId),
    description: "goza-sync webhook test — will be deleted immediately",
    detailItem: [{ itemNo: sku, quantity: 1, notes: "webhook round-trip test" }],
  });
  console.log(JSON.stringify(response.data));
  if (!response.data?.s) throw new Error("save failed");
  console.log(`ADJUSTMENT_ID=${response.data.r?.id}`);
}

async function del(id: string): Promise<void> {
  const response = await callAccurateApi("POST", "item-adjustment/delete.do", { id: Number(id) });
  console.log(JSON.stringify(response.data));
  if (!response.data?.s) throw new Error("delete failed");
}

async function main(): Promise<void> {
  const [cmd, arg] = process.argv.slice(2);
  if (cmd === "pick") return pick();
  if (cmd === "stock" && arg) return stock(arg);
  if (cmd === "add" && arg) return add(arg);
  if (cmd === "delete" && arg) return del(arg);
  throw new Error("usage: pick | stock SKU | add SKU | delete ID");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
