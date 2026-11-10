// script/test-recent-purchases.js — בדיקת utils/recentPurchases בלי מסד נתונים.
// הרצה: node --test script/test-recent-purchases.js
const test = require("node:test");
const assert = require("node:assert/strict");
const { buildRecentPurchases, normalizeMonths, periodStart, dayOf } = require("../utils/recentPurchases");

const catalog = {
  "100": { _id: "p100", sku: "100", title: { he: "תפוח" } },
  "200": { _id: "p200", sku: "200", title: { he: "בננה" } },
};
const lookup = (sku) => catalog[String(Number(sku))] || null;

test("normalizeMonths: only allowed periods, default 3", () => {
  assert.equal(normalizeMonths("6"), 6);
  assert.equal(normalizeMonths("5"), 3);
  assert.equal(normalizeMonths(undefined), 3);
  assert.equal(normalizeMonths("1e3"), 3);
});

test("periodStart: midnight UTC N months back, end-of-month safe", () => {
  assert.equal(periodStart(3, new Date("2026-11-10T15:00:00Z")).toISOString(), "2026-08-10T00:00:00.000Z");
  assert.equal(periodStart(1, new Date("2026-01-05T00:00:00Z")).toISOString(), "2025-12-05T00:00:00.000Z");
  assert.equal(periodStart(1, new Date("2026-03-31T10:00:00Z")).toISOString(), "2026-02-28T00:00:00.000Z");
  assert.equal(periodStart(12, new Date("2028-02-29T10:00:00Z")).toISOString(), "2027-02-28T00:00:00.000Z");
});

test("dayOf: note in Israel time, archive as written", () => {
  assert.equal(dayOf(new Date("2026-10-01T22:30:00Z"), "note"), "2026-10-02");
  assert.equal(dayOf(new Date("2026-10-01T22:30:00Z"), "archive"), "2026-10-01");
  assert.equal(dayOf("garbage", "note"), "");
});

test("merges sources per product, newest first, keeps each purchase", () => {
  const products = buildRecentPurchases({
    lookup,
    notes: [
      { number: 5, issuedAt: new Date("2026-10-20T08:00:00Z"), items: [
        { sku: "100", name: "תפוח ישן", quantity: 2.5, unitPrice: 7 },
        { sku: "999", name: "לא בקטלוג", quantity: 1, unitPrice: 3 },
      ] },
      { number: 4, issuedAt: new Date("2026-09-01T08:00:00Z"), items: [
        { sku: "100", name: "תפוח", quantity: 1, unitPrice: 6 },
      ] },
    ],
    archives: [
      { archive: { docNumber: "77", docType: "חשבונית", docDate: new Date("2026-08-15T00:00:00Z"),
          unmatchedItems: [{ sku: "888", name: "פריט ישן", quantity: 4, price: 2 }] },
        cart: [{ _id: "p100", sku: "0100", title: { he: "תפוח" }, quantity: 3, price: 5 },
               { _id: "p200", sku: "200", title: { he: "בננה" }, quantity: 6, price: 4 }] },
    ],
  });

  const apple = products.find((p) => p.sku === "100");
  assert.equal(apple.count, 3);
  assert.equal(apple.name, "תפוח"); // catalog name wins over the note text
  assert.equal(apple.totalQty, 6.5);
  assert.equal(apple.lastDay, "2026-10-20");
  assert.equal(apple.lastQty, 2.5);
  assert.equal(apple.lastPrice, 7);
  assert.deepEqual(apple.purchases.map((p) => p.source), ["note", "note", "archive"]);
  assert.equal(apple.purchases[2].doc, "חשבונית 77");
  assert.equal(apple.purchases[0].doc, "תעודה 5");

  const unknown = products.find((p) => p.sku === "999");
  assert.equal(unknown.inCatalog, false);
  assert.equal(unknown.name, "לא בקטלוג");
  assert.ok(products.find((p) => p.sku === "888" && !p.inCatalog));

  // a missing price stays missing, not 0
  const noPrice = buildRecentPurchases({ archives: [{ archive: { docDate: new Date("2026-10-01T00:00:00Z"),
    unmatchedItems: [{ sku: "5", name: "x", quantity: 1, price: null }] } }] });
  assert.equal(noPrice[0].lastPrice, null);

  // sort: last purchase first
  assert.deepEqual(products.map((p) => p.sku).slice(0, 2).sort(), ["100", "999"]);
  assert.equal(products.at(-1).lastDay, "2026-08-15");
});

test("empty input and lines without sku or name", () => {
  assert.deepEqual(buildRecentPurchases({}), []);
  const out = buildRecentPurchases({ notes: [{ number: 1, issuedAt: new Date(), items: [{ quantity: 1 }] }] });
  assert.deepEqual(out, []);
});

test("an old sku first does not leave a catalog product blocked", () => {
  const products = buildRecentPurchases({
    lookup,
    notes: [
      { number: 2, issuedAt: new Date("2026-10-02T08:00:00Z"), items: [{ productId: "p200", sku: "OLD-200", name: "בננה ישנה", quantity: 1, unitPrice: 4 }] },
      { number: 1, issuedAt: new Date("2026-10-01T08:00:00Z"), items: [{ productId: "p200", sku: "200", name: "בננה", quantity: 2, unitPrice: 4 }] },
    ],
  });
  assert.equal(products.length, 1);
  assert.equal(products[0].inCatalog, true);
  assert.equal(products[0].sku, "200");
  assert.equal(products[0].count, 2);
});
