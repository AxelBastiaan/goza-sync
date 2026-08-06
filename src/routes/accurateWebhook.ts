import { Router, Request, Response } from "express";
import { syncAllMappingsForAccurateSku } from "../services/stockSync";
import { syncAllMappingsForAccurateSkuShopee } from "../services/shopeeStockSync";

const router = Router();

// Confirmed from Accurate's Webhook API PDF: the payload is a JSON ARRAY of event
// envelopes (a single delivery can carry more than one), and each envelope's `data`
// is itself an array of change entries. Only ITEM_QUANTITY ("Stok Barang") and
// STOCK_MUTATION ("Mutasi Stok") events are relevant here — both include `itemNo`.
const RELEVANT_TYPES = new Set(["ITEM_QUANTITY", "STOCK_MUTATION"]);

interface AccurateWebhookEvent {
  type: string;
  data?: { itemNo?: string }[];
}

function extractItemNos(body: unknown): Set<string> {
  const events: AccurateWebhookEvent[] = Array.isArray(body) ? body : [body as AccurateWebhookEvent];
  const itemNos = new Set<string>();

  for (const event of events) {
    if (!RELEVANT_TYPES.has(event?.type)) continue;
    for (const entry of event?.data ?? []) {
      if (entry?.itemNo) {
        itemNos.add(entry.itemNo);
      }
    }
  }

  return itemNos;
}

router.post("/", async (req: Request, res: Response) => {
  console.log("[accurateWebhook] raw payload:", JSON.stringify(req.body));

  // Ack immediately so Accurate doesn't retry/back off on a slow downstream call.
  res.status(200).json({ received: true });

  const itemNos = extractItemNos(req.body);
  if (itemNos.size === 0) {
    console.warn("[accurateWebhook] no relevant item identifiers found in payload — see raw log above");
    return;
  }

  for (const itemNo of itemNos) {
    try {
      const results = await syncAllMappingsForAccurateSku(itemNo);
      if (results.length === 0) {
        console.log(`[accurateWebhook] item ${itemNo} has no marketplace SKU mappings, skipping TikTok sync`);
      } else {
        console.log(`[accurateWebhook] synced ${itemNo} to TikTok:`, JSON.stringify(results));
      }
    } catch (err: any) {
      console.error(`[accurateWebhook] failed to sync ${itemNo} to TikTok:`, err?.message ?? err);
    }

    try {
      const shopeeResults = await syncAllMappingsForAccurateSkuShopee(itemNo);
      if (shopeeResults.length > 0) {
        console.log(`[accurateWebhook] synced ${itemNo} to Shopee:`, JSON.stringify(shopeeResults));
      }
    } catch (err: any) {
      console.error(`[accurateWebhook] failed to sync ${itemNo} to Shopee:`, err?.message ?? err);
    }
  }
});

export default router;
