import { getEnv } from "../env";
import { exchangeShopeeToken, upsertShopeeStore } from "../services/shopeeAuth";

async function main() {
  const code = getEnv("SHOPEE_AUTH_CODE");
  const shopId = getEnv("SHOPEE_SHOP_ID");

  if (!code || !shopId) {
    console.log("Missing SHOPEE_AUTH_CODE or SHOPEE_SHOP_ID in .env — run shopee-get-auth-url and authorize first.");
    return;
  }

  try {
    const tokens = await exchangeShopeeToken(code, shopId);
    await upsertShopeeStore(shopId, tokens);
    console.log(`Connected Shopee shop ${shopId} — saved as a store row.`);
  } catch (err: any) {
    console.log("Request failed:", err?.message ?? err);
  }
}

main();
