import { getEnv } from "../env";
import { upsertTikTokStores } from "../services/tiktokAuth";

// Manual fallback: re-fetch/refresh the "stores" rows for the TikTok shops
// authorized under the token currently in .env. The in-GUI "Integrate" flow does
// this automatically right after token exchange; this script exists for re-running
// it by hand if needed.
async function main() {
  const accessToken = getEnv("ACCESS_TOKEN");
  const refreshToken = getEnv("REFRESH_TOKEN");
  if (!accessToken) {
    console.log("No ACCESS_TOKEN in .env — run exchange-token first.");
    return;
  }

  const count = await upsertTikTokStores({ accessToken, refreshToken });
  console.log(`Upserted ${count} TikTok store(s).`);
}

main();
