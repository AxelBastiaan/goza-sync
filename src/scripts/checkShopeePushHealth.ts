// Read-only: what Shopee itself says about our push subscription — the
// registered callback URL, which codes are on, and any pushes it tried to
// deliver and couldn't (Shopee keeps those for 3 days as "lost push messages").
//   node dist/scripts/checkShopeePushHealth.js
import { callShopeeApi } from "../services/shopeeClient";

(async () => {
  const cfg = await callShopeeApi("GET", "/api/v2/push/get_push_config", {});
  console.log("push config:", JSON.stringify(cfg.data?.response ?? cfg.data));

  const lost = await callShopeeApi("GET", "/api/v2/push/get_lost_push_message", {});
  const msgs = lost.data?.response?.push_message_list ?? [];
  console.log(`lost pushes reported by Shopee (last 3 days): ${msgs.length}${lost.data?.response?.has_next_page ? " (more pages)" : ""}`);
  for (const m of msgs.slice(0, 40)) console.log("  ", JSON.stringify(m).slice(0, 220));
  if (lost.data?.error) console.log("lost-push call error:", lost.data.error, lost.data.message);
})().catch((err) => {
  console.error("FAILED:", err?.message ?? err);
  process.exit(1);
});
