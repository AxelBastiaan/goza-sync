import { callAccurateApi } from "../accurateClient";
import { mapWithConcurrency, withRetry } from "../concurrency";

// Read-only Accurate calls for the invoice reminders. Field names confirmed live
// 2026-09-18: list.do with filter.outstanding=true returns only invoices that
// still have a balance (primeOwing > 0, statusName "Belum Lunas").

export interface OutstandingInvoice {
  id: number;
  number: string;
  transDate: string; // YYYY-MM-DD
  dueDate: string;
  totalAmount: number;
  primeOwing: number;
  customerId: number;
  customerName: string;
  customerNo: string | null;
}

export interface InvoiceDetail {
  id: number;
  dppAmount: number | null;
  taxAmount: number | null;
  paymentTerm: string | null;
  salesmanName: string | null;
  lines: {
    seq: number;
    itemNo: string | null;
    itemName: string | null;
    quantity: number;
    unit: string | null;
    unitPrice: number;
    discPercent: string | null;
    cashDiscount: number;
    totalPrice: number;
  }[];
}

export interface CustomerDetail {
  id: number;
  name: string;
  customerNo: string | null;
  contactName: string | null;
  phone: string | null;
  salesmanId: number | null;
}

// Accurate's own dd/mm/yyyy ↔ ISO.
function fromAccurateDate(d: string): string {
  const [day, month, year] = d.split("/");
  return `${year}-${month}-${day}`;
}
function toAccurateDate(iso: string): string {
  const [y, m, d] = iso.split("-");
  return `${d}/${m}/${y}`;
}

async function get(path: string, params: Record<string, string | number>): Promise<any> {
  return withRetry(async () => {
    const res = await callAccurateApi("GET", path, params);
    if (!res.data?.s) {
      throw new Error(`Accurate ${path} failed: ${JSON.stringify(res.data?.d ?? res.data).slice(0, 300)}`);
    }
    return res.data;
  });
}

// Every unpaid invoice whose due date is before `today` — i.e. overdue by at
// least one day. Optionally for a single customer (used to re-check right before
// a letter/WhatsApp goes out).
export async function fetchOutstandingOverdue(today: string, customerId?: number): Promise<OutstandingInvoice[]> {
  const out: OutstandingInvoice[] = [];
  let page = 1;
  let pageCount = 1;
  do {
    const params: Record<string, string | number> = {
      fields: "id,number,transDate,dueDate,totalAmount,primeOwing,customer",
      "filter.outstanding": "true",
      "filter.dueDate.op": "LESS_THAN",
      "filter.dueDate.val[0]": toAccurateDate(today),
      "sp.page": page,
      "sp.pageSize": 100,
    };
    if (customerId !== undefined) params["filter.customerId"] = customerId;
    const data = await get("sales-invoice/list.do", params);
    for (const r of data.d as any[]) {
      if (!r.dueDate || !(Number(r.primeOwing) > 0)) continue;
      out.push({
        id: r.id,
        number: r.number,
        transDate: fromAccurateDate(r.transDate),
        dueDate: fromAccurateDate(r.dueDate),
        totalAmount: Number(r.totalAmount),
        primeOwing: Number(r.primeOwing),
        customerId: r.customer?.id,
        customerName: r.customer?.name ?? "",
        customerNo: r.customer?.customerNo ?? null,
      });
    }
    pageCount = data.sp?.pageCount ?? 1;
    page++;
  } while (page <= pageCount);
  return out;
}

export async function fetchInvoiceDetail(id: number): Promise<InvoiceDetail> {
  const d = (await get("sales-invoice/detail.do", { id })).d;
  const lines = ((d.detailItem ?? []) as any[])
    .map((l) => ({
      seq: Number(l.seq ?? 0),
      itemNo: l.item?.no ?? null,
      itemName: l.detailName || l.item?.name || l.item?.shortName || null,
      quantity: Number(l.quantity ?? 0),
      unit: l.itemUnit?.name ?? null,
      unitPrice: Number(l.unitPrice ?? 0),
      discPercent: l.itemDiscPercent ? String(l.itemDiscPercent) : null,
      cashDiscount: Number(l.itemCashDiscount ?? 0),
      totalPrice: Number(l.totalPrice ?? 0),
    }))
    .sort((a, b) => a.seq - b.seq);
  return {
    id: d.id,
    dppAmount: d.dppAmount != null ? Number(d.dppAmount) : null,
    taxAmount: d.tax1Amount != null ? Number(d.tax1Amount) : null,
    paymentTerm: d.paymentTerm?.name ?? null,
    salesmanName: d.masterSalesmanName ?? null,
    lines,
  };
}

// Phone lookup order matches sales-recall/services/accurateCustomers.ts: the
// top-level mobilePhone is usually empty in practice; the real number tends to
// live on the first contact.
export async function fetchCustomerDetail(id: number): Promise<CustomerDetail> {
  const d = (await get("customer/detail.do", { id })).d;
  const contact = (d.detailContact ?? [])[0] ?? {};
  const phone = d.mobilePhone || contact.mobilePhone || contact.workPhone || d.workPhone || null;
  return {
    id: d.id,
    name: d.name,
    customerNo: d.customerNo ?? null,
    contactName: contact.name || null,
    phone: phone ? String(phone).trim() : null,
    salesmanId: d.defaultSalesmanId ?? null,
  };
}

// Accurate allows 8 parallel / 8 per second per token — stay under both.
export function fetchCustomerDetails(ids: number[]): Promise<CustomerDetail[]> {
  return mapWithConcurrency(ids, 6, fetchCustomerDetail, 160);
}

export function fetchInvoiceDetails(ids: number[]): Promise<InvoiceDetail[]> {
  return mapWithConcurrency(ids, 6, fetchInvoiceDetail, 160);
}
