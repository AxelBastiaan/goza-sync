import path from "path";
import PDFDocument from "pdfkit";
import { BANK_ACCOUNT, BANK_ACCOUNT_NAME, CONFIRM_NUMBER, formatIndoDate, formatIndoDateShort, formatNumber } from "./messages";

// The reminder letter: page 1 is finance's own FORM TAGIHAN, copied word for word
// (letterhead, addressee, 25-row invoice table, bank + payment-confirmation boxes,
// signed Dwi.S.Gosal) — except the subject/opening say "sudah jatuh tempo" rather
// than "mendekati", since these letters only go out after the due date. Then one
// attachment section per invoice with its line items from Accurate.

// Header/footer images are the ones embedded in the FORM TAGIHAN workbook.
const ASSETS = path.join(__dirname, "..", "..", "..", "assets");
const LETTERHEAD_PATH = path.join(ASSETS, "letterhead.jpg");
const LETTERHEAD_ASPECT = 193 / 2061; // letterhead.jpg is 2061×193
const FOOTER_PATH = path.join(ASSETS, "footer.jpg");
const FOOTER_ASPECT = 91 / 2480; // footer.jpg is 2480×91
const MARGIN = 45;
const FORM_ROWS = 25;
const LETTER_SUBJECT = "FAKTUR SUDAH JATUH TEMPO";
const LETTER_OPENING = "Dengan ini kami ingin mengingatkan bahwa ada faktur yang sudah jatuh tempo, sbb ;";

export interface LetterLine {
  itemNo: string | null;
  itemName: string | null;
  quantity: number;
  unit: string | null;
  unitPrice: number;
  discPercent: string | null;
  cashDiscount: number;
  totalPrice: number;
}

export interface LetterInvoice {
  number: string;
  transDate: string;
  dueDate: string;
  totalAmount: number;
  primeOwing: number;
  dppAmount: number | null;
  taxAmount: number | null;
  paymentTerm: string | null;
  lines: LetterLine[];
}

export interface LetterInput {
  letterNo: string;
  date: string; // YYYY-MM-DD (Jakarta)
  customerName: string;
  salesperson: string | null;
  invoices: LetterInvoice[];
}

interface Column {
  header: string;
  width: number;
  align?: "left" | "center" | "right";
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T12:00:00Z`) - Date.parse(`${from}T12:00:00Z`)) / 86400000);
}

export function generateLetterPdf(input: LetterInput): Promise<Buffer> {
  const doc = new PDFDocument({ size: "A4", margins: { top: 40, bottom: 50, left: MARGIN, right: MARGIN }, bufferPages: true });
  const chunks: Buffer[] = [];
  doc.on("data", (c: Buffer) => chunks.push(c));
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on("end", () => resolve(Buffer.concat(chunks)));
    doc.on("error", reject);
  });

  const W = doc.page.width - MARGIN * 2;
  const pageBottom = () => doc.page.height - 70;

  function header(): void {
    doc.image(LETTERHEAD_PATH, MARGIN, 30, { width: W });
    const y = 30 + W * LETTERHEAD_ASPECT + 6;
    doc.moveTo(MARGIN, y).lineTo(MARGIN + W, y).lineWidth(2.5).stroke("#000");
    doc.lineWidth(0.5);
    doc.x = MARGIN;
    doc.y = y + 8;
  }

  function newPage(): void {
    doc.addPage();
    header();
  }

  // Fixed-height single-line cells (long item names are cut with an ellipsis);
  // the header row repeats on every page the table spills onto.
  function table(columns: Column[], rows: string[][], opts: { fontSize?: number; headH?: number; rowH?: number } = {}): void {
    const fs = opts.fontSize ?? 7.5;
    const headH = opts.headH ?? 26;
    const rowH = opts.rowH ?? 13;
    const drawHead = () => {
      let x = MARGIN;
      const y = doc.y;
      for (const c of columns) {
        doc.rect(x, y, c.width, headH).fillAndStroke("#e6e6e6", "#444");
        const lines = c.header.split("\n").length;
        doc.fillColor("#000").font("Helvetica-Bold").fontSize(fs + 1)
          .text(c.header, x + 2, y + (headH - lines * (fs + 2)) / 2, { width: c.width - 4, align: "center" });
        x += c.width;
      }
      doc.y = y + headH;
    };
    drawHead();
    for (const row of rows) {
      if (doc.y + rowH > pageBottom()) {
        newPage();
        drawHead();
      }
      let x = MARGIN;
      const y = doc.y;
      columns.forEach((c, i) => {
        doc.rect(x, y, c.width, rowH).stroke("#444");
        doc.font("Helvetica").fontSize(fs).fillColor("#000")
          .text(row[i] ?? "", x + 3, y + (rowH - fs) / 2, { width: c.width - 6, align: c.align ?? "left", height: fs + 1, ellipsis: true });
        x += c.width;
      });
      doc.y = y + rowH;
    }
    doc.x = MARGIN;
  }

  const owing = input.invoices.reduce((s, i) => s + i.primeOwing, 0);

  // ---------- page 1: the letter, word for word from finance's "FORM TAGIHAN"
  // Excel template (sheet "FORM TAGIHAN bulanan") ----------
  header();
  doc.font("Helvetica").fontSize(10).text(`Surabaya, ${formatIndoDate(input.date)}`, MARGIN, doc.y, { width: W, align: "right" });
  doc.moveDown(1);
  doc.text("Kepada Yth,", MARGIN);
  doc.text("Bagian Keuangan");
  doc.font("Helvetica-Bold").text(input.customerName, { underline: true });
  doc.font("Helvetica").text("Di tempat");
  doc.moveDown(0.8);
  doc.text(`No.       : ${input.letterNo}`);
  doc.text("Perihal : ", { continued: true }).font("Helvetica-Bold").text(LETTER_SUBJECT, { underline: true });
  doc.font("Helvetica").moveDown(0.8);
  doc.text("Dengan Hormat,");
  doc.moveDown(0.6);
  doc.text(LETTER_OPENING, { width: W });
  doc.moveDown(0.6);

  const letterCols: Column[] = [
    { header: "No.", width: 26, align: "center" },
    { header: "Nomor\nFaktur", width: 76 },
    { header: "Tanggal\nFaktur", width: 62, align: "center" },
    { header: "tanggal\nJatuh Tempo", width: 64, align: "center" },
    { header: "Nama Pelanggan", width: 110 },
    { header: "Total\n(Rupiah)", width: 64, align: "right" },
    { header: "Sisa Piutang\n(Rupiah)", width: 66, align: "right" },
    { header: "Umur\n(hari)", width: W - 468, align: "center" },
  ];
  // The form always prints 25 numbered rows (blank ones included); more
  // invoices than that simply extend the table.
  const rows = input.invoices.map((inv, k) => [
    String(k + 1),
    inv.number,
    formatIndoDateShort(inv.transDate),
    formatIndoDateShort(inv.dueDate),
    input.customerName,
    formatNumber(inv.totalAmount),
    formatNumber(inv.primeOwing),
    String(daysBetween(inv.transDate, input.date)),
  ]);
  for (let k = rows.length; k < FORM_ROWS; k++) rows.push([String(k + 1), "", "", "", "", "", "", ""]);
  table(letterCols, rows, { rowH: 11.5 });

  if (doc.y + 16 + 72 + 110 > pageBottom()) newPage();
  let y = doc.y;
  doc.rect(MARGIN, y, W, 16).stroke("#444");
  doc.font("Helvetica").fontSize(9).text(`Marketing : ${input.salesperson ?? "-"}`, MARGIN + 4, y + 4);
  doc.text("TOTAL :", MARGIN + W - 160, y + 4);
  doc.font("Helvetica-Bold").text(formatNumber(owing), MARGIN + W - 100, y + 4, { width: 96, align: "right" });
  doc.y = y + 16;

  y = doc.y;
  const boxH = 64;
  const leftW = W * 0.58;
  doc.rect(MARGIN, y, leftW, boxH).fillAndStroke("#dcdcdc", "#444");
  doc.rect(MARGIN + leftW, y, W - leftW, boxH).fillAndStroke("#dcdcdc", "#444");
  doc.fillColor("#000");
  doc.font("Helvetica-Bold").fontSize(9).text("DETAIL BANK :", MARGIN + 6, y + 5, { underline: true });
  doc.font("Helvetica").fontSize(8.5)
    .text(`BCA Cabang Semut - Surabaya\na/c : ${BANK_ACCOUNT}\na/n : ${BANK_ACCOUNT_NAME}`, MARGIN + 6, y + 17);
  doc.font("Helvetica-Bold").fontSize(9).text("KONFIRMASI PEMBAYARAN :", MARGIN + leftW + 6, y + 5, { underline: true });
  doc.font("Helvetica").fontSize(8.5).text(
    `${CONFIRM_NUMBER} (WA / SMS)\nMohon mengirim teks sebagai berikut:\n${formatIndoDate(input.date)} , ${input.customerName} , Rp. ${Math.round(owing).toLocaleString("en-US")},-`,
    MARGIN + leftW + 6,
    y + 17,
    { width: W - leftW - 12, height: boxH - 20, ellipsis: true }
  );
  doc.y = y + boxH + 14;
  doc.x = MARGIN;

  doc.fontSize(10).text("Demikian pemberitahuan ini kami sampaikan. Atas perhatian Bapak / Ibu kami ucapkan terima kasih.", MARGIN, doc.y, { width: W });
  doc.moveDown(1);
  doc.text("Hormat kami,");
  doc.moveDown(2.6);
  doc.text("Dwi.S.Gosal");
  doc.text("(Direktur Keuangan)");

  // ---------- attachments: one section per invoice ----------
  const itemCols: Column[] = [
    { header: "No.", width: 24, align: "center" },
    { header: "Kode", width: 62 },
    { header: "Nama Barang", width: 175 },
    { header: "Qty", width: 30, align: "center" },
    { header: "Satuan", width: 38, align: "center" },
    { header: "Harga", width: 62, align: "right" },
    { header: "Disc", width: 40, align: "center" },
    { header: "Jumlah", width: W - 431, align: "right" },
  ];
  for (const inv of input.invoices) {
    newPage();
    doc.font("Helvetica-Bold").fontSize(12).text(`LAMPIRAN : RINCIAN FAKTUR ${inv.number}`, MARGIN, doc.y, { width: W });
    doc.moveDown(0.4);
    doc.font("Helvetica").fontSize(9);
    const info: [string, string][] = [
      ["Pelanggan", input.customerName],
      ["Tanggal Faktur", formatIndoDate(inv.transDate)],
      ["Jatuh Tempo", `${formatIndoDate(inv.dueDate)}${inv.paymentTerm ? `  (${inv.paymentTerm})` : ""}`],
      ["Marketing", input.salesperson ?? "-"],
    ];
    for (const [k, v] of info) {
      const yy = doc.y;
      doc.text(k, MARGIN, yy, { width: 90 });
      doc.text(`: ${v}`, MARGIN + 90, yy);
    }
    doc.moveDown(0.6);
    if (inv.lines.length > 0) {
      table(
        itemCols,
        inv.lines.map((l, k) => [
          String(k + 1),
          l.itemNo ?? "",
          l.itemName ?? "",
          String(l.quantity),
          l.unit ?? "",
          formatNumber(l.unitPrice),
          l.discPercent ? `${l.discPercent}%` : l.cashDiscount ? formatNumber(l.cashDiscount) : "-",
          formatNumber(l.totalPrice),
        ]),
        { headH: 18, rowH: 12.5 }
      );
    } else {
      doc.fillColor("#666").text("(Rincian barang tidak tersedia)").fillColor("#000");
    }
    const summary: [string, number | null][] = [
      ["Total (termasuk PPN)", inv.totalAmount],
      ["DPP", inv.dppAmount],
      ["PPN", inv.taxAmount],
      ["Sudah dibayar", inv.totalAmount - inv.primeOwing],
      ["SISA PIUTANG", inv.primeOwing],
    ];
    if (doc.y + summary.length * 13 + 6 > pageBottom()) newPage();
    doc.moveDown(0.3);
    for (const [k, v] of summary) {
      if (v === null) continue;
      const yy = doc.y;
      doc.font(k === "SISA PIUTANG" ? "Helvetica-Bold" : "Helvetica").fontSize(9).text(k, MARGIN + W - 230, yy, { width: 130 });
      doc.text(formatNumber(v), MARGIN + W - 100, yy, { width: 96, align: "right" });
      doc.y = yy + 13;
    }
  }

  // Footer image (address + colour bar) on every page, as in the form; attachment
  // pages also get a small page count. Drawn below the bottom margin, so the
  // margin is zeroed first — otherwise pdfkit treats it as overflow and adds pages.
  const range = doc.bufferedPageRange();
  const footerW = W * 0.8;
  for (let p = 0; p < range.count; p++) {
    doc.switchToPage(p);
    doc.page.margins.bottom = 0;
    doc.image(FOOTER_PATH, MARGIN + (W - footerW) / 2, doc.page.height - 44, { width: footerW });
    if (p > 0) {
      doc.fontSize(7).fillColor("#999")
        .text(`${input.letterNo} · Hal. ${p + 1} / ${range.count}`, MARGIN, doc.page.height - 24, { width: W, align: "right", lineBreak: false });
      doc.fillColor("#000");
    }
  }

  doc.end();
  return done;
}
