import { callAccurateApi } from "../services/accurateClient";

async function main() {
  const detail = await callAccurateApi("GET", "sales-invoice/detail.do", { id: 335403 });
  const d = detail.data?.d;
  console.log(JSON.stringify(d?.detailItem?.[0], null, 2));
}

main().catch((e) => console.error("ERROR", e?.message ?? e));
