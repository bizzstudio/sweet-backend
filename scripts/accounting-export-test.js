// scripts/accounting-export-test.js
//
// בדיקת הייצוא להנהלת החשבונות (lib/billing/accountingExport) בלי רשת:
// הקריאה ל-iCount מוחלפת בפונקציה מדומה לפני טעינת המודול.
//
//   node scripts/accounting-export-test.js

const assert = require("assert");
const client = require("../lib/icount/client");

let handler = () => ({ results_count: 0, results_list: [] });
const calls = [];
client.call = async (endpoint, params) => {
  calls.push({ endpoint, params });
  return handler(params);
};

const { accountingExport, monthChunks, splitNet } = require("../lib/billing/accountingExport");

const err = (reason) => Object.assign(new Error(reason), { reason });

const doc = (doctype, docnum, extra = {}) => ({
  doctype,
  docnum: String(docnum),
  dateissued: "2026-10-05",
  custom_client_id: "519",
  client_name: "לקוח",
  vat_percent: "18",
  afterdiscount: "100.00",
  totalvat: "18.00",
  totalwithvat: "118.00",
  total: "118.00",
  status: 0,
  ...extra,
});

let passed = 0;
const test = async (name, fn) => {
  calls.length = 0;
  await fn();
  passed += 1;
  console.log("✓", name);
};

(async () => {
  await test("חודשים: חותך בגבול חודש ושנה", async () => {
    assert.deepStrictEqual(monthChunks("2026-12-20", "2027-01-03"), [
      ["2026-12-20", "2026-12-31"],
      ["2027-01-01", "2027-01-03"],
    ]);
    assert.deepStrictEqual(monthChunks("2028-02-01", "2028-02-29"), [["2028-02-01", "2028-02-29"]]);
  });

  await test("פיצול חייב/פטור: עיגול לא הופך לפטור, פטור אמיתי נשאר", async () => {
    assert.deepStrictEqual(splitNet(249.18, 44.85, "18"), { taxable: 249.18, exempt: 0 });
    assert.deepStrictEqual(splitNet(2833.45, 498.21, "18"), { taxable: 2767.83, exempt: 65.62 });
    assert.deepStrictEqual(splitNet(348.63, 0, "18"), { taxable: 0, exempt: 348.63 });
  });

  await test("חודש ריק (no_results_found) מחזיר רשימה ריקה", async () => {
    handler = () => { throw err("no_results_found"); };
    const r = await accountingExport({ from: "2026-10-01", to: "2026-10-31" });
    assert.strictEqual(r.rows.length, 0);
    assert.strictEqual(r.totals.invoice.count, 0);
  });

  await test("זיכוי במינוס, קבלה בלי מע\"מ, ביטול מסומן, הסכומים מסתכמים", async () => {
    handler = () => ({
      results_count: 3,
      results_list: [
        doc("invoice", 2000, { is_cancelled: 1 }),
        doc("refund", 5000, { is_cancellation: 1, based_on: [{ doctype: "invoice", docnum: "2000" }] }),
        doc("receipt", 1000, { total: "50.00", has_bt: "1" }),
      ],
    });
    const r = await accountingExport({ from: "2026-10-01", to: "2026-10-31" });
    const [inv, ref, rec] = r.rows;
    assert.strictEqual(inv.status, "בוטל");
    assert.strictEqual(ref.status, "ביטול");
    assert.strictEqual(ref.basedOn, "חשבונית מס 2000");
    assert.strictEqual(ref.gross, -118);
    assert.strictEqual(ref.vat, -18);
    assert.strictEqual(rec.vat, null);
    assert.strictEqual(rec.gross, 50);
    assert.strictEqual(rec.paymentMethod, "העברה בנקאית");
    assert.strictEqual(r.totals.invoice.gross + r.totals.refund.gross, 0);
  });

  await test("עמודים: ממשיך עד results_count", async () => {
    handler = (p) => {
      const all = Array.from({ length: 700 }, (_, i) => doc("invoice", 3000 + i));
      return { results_count: 700, results_list: all.slice(p.offset, p.offset + p.limit) };
    };
    const r = await accountingExport({ from: "2026-10-01", to: "2026-10-31", types: ["invoice"] });
    assert.strictEqual(r.rows.length, 700);
    assert.deepStrictEqual(calls.map((c) => c.params.offset), [0, 500]);
  });

  await test("יותר מ-1000 בחודש: הטווח נחצה ולא נכשל", async () => {
    handler = (p) => {
      if (p.start_date === "2026-10-01" && p.end_date === "2026-10-31") throw err("too_many_results");
      return { results_count: 1, results_list: [doc("invoice", p.start_date.slice(-2))] };
    };
    const r = await accountingExport({ from: "2026-10-01", to: "2026-10-31", types: ["invoice"] });
    assert.deepStrictEqual(
      calls.slice(1).map((c) => [c.params.start_date, c.params.end_date]),
      [["2026-10-01", "2026-10-16"], ["2026-10-17", "2026-10-31"]]
    );
    assert.strictEqual(r.rows.length, 2);
  });

  await test("שגיאה אחרת של iCount עולה למעלה", async () => {
    handler = () => { throw err("auth_failed"); };
    await assert.rejects(accountingExport({ from: "2026-10-01", to: "2026-10-31" }), /auth_failed/);
  });

  await test("סוג שלא התבקש מסונן; סוג לא מוכר נדחה", async () => {
    handler = () => ({ results_count: 2, results_list: [doc("invoice", 1), doc("deal", 7000)] });
    const r = await accountingExport({ from: "2026-10-01", to: "2026-10-31", types: ["invoice", "deal"] });
    assert.deepStrictEqual(r.types, ["invoice"]);
    assert.deepStrictEqual(calls[0].params.doctype, ["invoice"]);
    assert.strictEqual(r.rows.length, 1);
    await assert.rejects(accountingExport({ from: "2026-10-01", to: "2026-10-31", types: ["deal"] }), /לא נבחר סוג/);
  });

  await test("טווח: יותר משנה נדחה, שנה מלאה עוברת, הפוך נדחה", async () => {
    handler = () => ({ results_count: 0, results_list: [] });
    await assert.rejects(accountingExport({ from: "2025-01-01", to: "2026-12-31" }), /עד שנה/);
    await accountingExport({ from: "2026-01-15", to: "2027-01-14" });
    await assert.rejects(accountingExport({ from: "2026-11-01", to: "2026-10-01" }), /מוקדם/);
    await assert.rejects(accountingExport({ from: "", to: "2026-10-01" }), /טווח/);
  });

  console.log(`\n${passed} בדיקות עברו`);
})().catch((e) => {
  console.error("✗", e);
  process.exit(1);
});
