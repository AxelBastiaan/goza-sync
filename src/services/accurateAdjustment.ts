import { getEnv, updateEnv } from "../env";
import { callAccurateApi } from "./accurateClient";

interface AccurateWarehouse {
  id: number;
  name: string;
  defaultWarehouse: boolean;
}

let cachedWarehouseId: string | undefined;

export async function getDefaultWarehouseId(): Promise<string> {
  const envValue = getEnv("ACCURATE_WAREHOUSE_ID");
  if (envValue) {
    return envValue;
  }

  if (cachedWarehouseId) {
    return cachedWarehouseId;
  }

  const response = await callAccurateApi("GET", "warehouse/list.do", { "sp.pageSize": 100 });

  if (!response.data?.s) {
    throw new Error(`Accurate warehouse list request failed: ${JSON.stringify(response.data?.d ?? response.status)}`);
  }

  const warehouses = (response.data?.d ?? []) as AccurateWarehouse[];
  const defaultWarehouse = warehouses.find((w) => w.defaultWarehouse);

  if (!defaultWarehouse) {
    throw new Error(
      "No default warehouse found in Accurate. Set ACCURATE_WAREHOUSE_ID in .env manually to the warehouse id to use."
    );
  }

  const id = String(defaultWarehouse.id);
  updateEnv("ACCURATE_WAREHOUSE_ID", id);
  cachedWarehouseId = id;
  return id;
}

// dd/mm/yyyy in Asia/Jakarta — the business's own timezone, and the one Accurate's
// books are kept in. Must NOT use getDate()/getMonth(), which read the process's
// local timezone: the production container runs UTC (same trap documented in
// accurateClient.ts's formatTimestamp), so an order placed 00:00-07:00 Jakarta —
// i.e. 17:00-24:00 UTC the previous day — would be dated a day early, silently
// booking it into the wrong day and, at a month boundary, the wrong period.
export function formatAccurateDate(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: "Asia/Jakarta",
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
  }).formatToParts(date);

  const get = (type: Intl.DateTimeFormatPartTypes) => parts.find((p) => p.type === type)!.value;
  return `${get("day")}/${get("month")}/${get("year")}`;
}

// NOTE: the exact detail-line field name (`detailItem`) and the sign convention for
// `quantity` (negative = decrease) follow Accurate's general transaction-save API
// pattern but haven't been confirmed against a live item-adjustment call yet —
// verify on first real use and adjust if Accurate rejects the shape or the
// resulting balance moves the wrong direction.
export async function decrementAccurateStock(itemNo: string, quantityDelta: number, note?: string): Promise<void> {
  const warehouseId = await getDefaultWarehouseId();

  const response = await callAccurateApi(
    "POST",
    "item-adjustment/save.do",
    {},
    {
      transDate: formatAccurateDate(new Date()),
      warehouseId: Number(warehouseId),
      detailItem: [
        {
          itemNo,
          quantity: quantityDelta,
          notes: note,
        },
      ],
    }
  );

  if (!response.data?.s) {
    throw new Error(
      `Accurate stock adjustment failed for ${itemNo}: ${JSON.stringify(response.data?.d ?? response.status)}`
    );
  }
}
