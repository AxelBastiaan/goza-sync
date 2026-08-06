import { callTikTokApi } from "../services/tiktokClient";
import { getTikTokStores } from "../services/storesRepo";

async function main() {
  const [store] = getTikTokStores();
  if (!store) {
    console.log("No connected TikTok store found.");
    return;
  }

  const response = await callTikTokApi("POST", "/product/202309/products/search", { page_size: 10 }, {}, store.credentials);

  console.log(response.status);
  console.log(response.data);
}

main();
