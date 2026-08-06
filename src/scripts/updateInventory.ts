import { callTikTokApi } from "../services/tiktokClient";
import { getTikTokStores } from "../services/storesRepo";

const PRODUCT_ID = "1736683721714140492";
const SKU_ID = "1736683622536742220";
const NEW_QUANTITY = 699;

async function main() {
  const [store] = getTikTokStores();
  if (!store) {
    console.log("No connected TikTok store found.");
    return;
  }

  const response = await callTikTokApi(
    "POST",
    `/product/202309/products/${PRODUCT_ID}/inventory/update`,
    { version: "202309" },
    { skus: [{ id: SKU_ID, inventory: [{ quantity: NEW_QUANTITY }] }] },
    store.credentials
  );

  console.log(response.status);
  console.log(response.data);
}

main();
