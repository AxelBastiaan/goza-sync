// WhatsApp texts (Bahasa Indonesia) and wa.me links. Wording is a draft pending
// the owner's approval — kept in one place so it's a one-file change.

export const BANK_ACCOUNT = "256.488.6024";
export const BANK_ACCOUNT_NAME = "PT. Goza Rekan Dagang Terpercaya";
export const BANK_LINE = `BCA ${BANK_ACCOUNT} a/n ${BANK_ACCOUNT_NAME}`;
// Payment-confirmation number as printed on the FORM TAGIHAN template.
export const CONFIRM_NUMBER = "082226700909";

// As finance's Excel prints "dd mmm yyyy" (e.g. "18 Juli 2026", "17 Agu 2026").
const BULAN_PENDEK = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Juli", "Agu", "Sep", "Okt", "Nov", "Des"];
const BULAN = [
  "Januari", "Februari", "Maret", "April", "Mei", "Juni",
  "Juli", "Agustus", "September", "Oktober", "November", "Desember",
];

// Dates here are Jakarta calendar dates (YYYY-MM-DD), formatted from their
// components so the host's timezone can't shift them.
export function formatIndoDate(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${BULAN[m - 1]} ${y}`;
}

export function formatIndoDateShort(iso: string): string {
  const [y, m, d] = iso.split("-").map(Number);
  return `${d} ${BULAN_PENDEK[m - 1]} ${y}`;
}

export function formatRupiah(amount: number): string {
  return `Rp${Math.round(amount).toLocaleString("id-ID")}`;
}

export function formatNumber(amount: number): string {
  return Math.round(amount).toLocaleString("id-ID");
}

// Accurate phone fields are free text ("081392834404 WA", "031-1234567 / 0812…").
// Returns the first Indonesian mobile number in it (08… / 628…) in the
// international form wa.me wants, or null. Landlines (e.g. 0431… in Manado) are
// skipped — wa.me can't open a chat with them, so the button stays greyed out.
export function toWhatsAppNumber(raw: string | null | undefined): string | null {
  if (!raw) return null;
  for (const match of raw.match(/\+?\d[\d\s.\-()]{7,}\d/g) ?? []) {
    let digits = match.replace(/\D/g, "");
    if (digits.startsWith("0")) digits = "62" + digits.slice(1);
    else if (digits.startsWith("8")) digits = "62" + digits;
    if (digits.startsWith("628") && digits.length >= 11 && digits.length <= 15) return digits;
  }
  return null;
}

export function waLink(phone: string | null | undefined, text: string): string | null {
  const num = toWhatsAppNumber(phone);
  return num ? `https://wa.me/${num}?text=${encodeURIComponent(text)}` : null;
}

export interface MessageInvoice {
  number: string;
  dueDate: string;
  daysLate: number;
  primeOwing: number;
}

// A wa.me link carries the whole text in the URL — keep huge lists (one customer
// has 46 overdue invoices) to a readable size; the PDF has them all.
const MAX_LINES = 12;

export function customerMessage(customerName: string, invoices: MessageInvoice[], stage: number): string {
  const opening =
    stage >= 3
      ? "Selamat siang Bapak/Ibu, ini adalah pengingat ketiga dari kami."
      : stage === 2
        ? "Selamat siang Bapak/Ibu, kami ingin mengingatkan kembali."
        : "Selamat siang Bapak/Ibu,";
  const total = invoices.reduce((s, i) => s + i.primeOwing, 0);
  const shown = invoices.slice(0, MAX_LINES);
  const lines = shown.map((i) => `• ${i.number} — jatuh tempo ${formatIndoDateShort(i.dueDate)} — ${formatRupiah(i.primeOwing)}`);
  if (invoices.length > shown.length) lines.push(`• …dan ${invoices.length - shown.length} faktur lainnya (lihat PDF)`);
  return [
    opening,
    "",
    `Kami dari Bagian Keuangan PT. Goza Rekan Dagang Terpercaya. Berikut faktur *${customerName}* yang telah melewati tanggal jatuh tempo:`,
    "",
    ...lines,
    "",
    `*Total: ${formatRupiah(total)}*`,
    "",
    "Pembayaran dapat ditransfer ke:",
    BANK_LINE,
    "",
    "Rincian faktur terlampir (PDF). Apabila sudah melakukan pembayaran, mohon abaikan pesan ini dan kirimkan bukti transfernya ke nomor ini. Terima kasih 🙏",
  ].join("\n");
}

export interface SalesHandoffCustomer {
  name: string;
  invoiceCount: number;
  owing: number;
  maxDaysLate: number;
}

export function salesMessage(salesperson: string, customers: SalesHandoffCustomer[]): string {
  const name = salesperson === "RICKYANTO" ? "Ricky" : salesperson.charAt(0) + salesperson.slice(1).toLowerCase();
  const lines = customers.map(
    (c, k) => `${k + 1}. *${c.name}* — ${c.invoiceCount} faktur — ${formatRupiah(c.owing)} (telat s/d ${c.maxDaysLate} hari)`
  );
  return [
    `Halo Pak ${name},`,
    "",
    "Customer berikut sudah menerima pengingat tagihan dari admin, namun fakturnya masih belum lunas lebih dari 14 hari setelah jatuh tempo:",
    "",
    ...lines,
    "",
    "Mohon bantu follow up langsung ke customer ya Pak. Surat tagihan (PDF) terlampir. Terima kasih 🙏",
  ].join("\n");
}
