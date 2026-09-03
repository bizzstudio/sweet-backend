// script/test-duplicate-order.js
//
// בדיקת "הזמנה חוזרת" — הרצה: npm run order:duplicate-test
//
// ── למה זה קיים ──
//
// יצירת הזמנה חוזרת נוגעת בכסף (סכום ההזמנה), בסחורה (הורדת מלאי) ובחיוב
// (תעודת משלוח שנגזרת מהעגלה). כל אחת מהתקלות שנבדקות כאן שקטה: היא לא
// מפילה דבר, היא רק מייצרת הזמנה שגויה שמתגלה מול הלקוח או בחשבונית.
//
// שלוש תקלות אמיתיות שהבדיקה הזו תפסה בפיתוח:
//
//   • מוצר שנמחק ונוצר מחדש (ייבוא קטלוג, איחוד כפילויות) לא נמצא לפי המק"ט,
//     כי רק ה-_id נשאל — הנפילה למק"ט הייתה קוד מת (תרחיש G).
//   • usedOfferIds יצא ריק תמיד, כי המפתח שנקרא היה `_id` ולא `offerId`
//     (תרחישים M ו-N).
//   • שורה בלי מחיר / כמות לא תקינה עברה לעגלה החדשה בשקט (תרחיש L).
//
// הבדיקה רצה בלי מסד נתונים: המודלים והתלויות הכבדות מוזרקים ל-require.cache
// לפני טעינת הנבדק. מנוע המבצעים ו-buildCartItem הם האמיתיים — הם הליבה
// שהתוצאה תלויה בה, ודמה שלהם היה בודק את הדמה ולא את הקוד.

const path = require("path");
const Module = require("module");

const BE = path.join(__dirname, "..");
const LIBDIR = path.join(BE, "lib/orders");
const mongoose = require("mongoose");

const state = {
  products: [],
  order: null,
  customer: { _id: "cust1", name: "דנה", createdAt: new Date("2020-01-01") },
  status: { _id: "statusProcessing", name: "Processing" },
  saved: null,
  stockCalls: [],
  statusLogs: [],
  offers: [],
  priceMap: null,
};

const stub = (request, exports) => {
  const resolved = Module._resolveFilename(request, {
    id: path.join(LIBDIR, "x.js"),
    filename: path.join(LIBDIR, "x.js"),
    paths: Module._nodeModulePaths(LIBDIR),
  });
  require.cache[resolved] = { id: resolved, filename: resolved, loaded: true, exports };
};

const chainable = (result) => {
  const o = {
    select: () => o,
    lean: async () => result,
    populate: () => o,
    then: (res, rej) => Promise.resolve(result).then(res, rej),
  };
  return o;
};

stub("../../models/Order", function Order(payload) {
  Object.assign(this, payload);
  this._id = "newOrderId";
  this.invoice = payload.invoice;
  this.statusHistory = [];
  this.save = async () => { state.saved = this; return this; };
});
require.cache[Module._resolveFilename("../../models/Order", { id: path.join(LIBDIR,"x.js"), filename: path.join(LIBDIR,"x.js"), paths: Module._nodeModulePaths(LIBDIR) })].exports.findById =
  (id) => chainable(state.order && String(state.order._id) === String(id) ? state.order : null);

stub("../../models/Status", { findOne: async () => state.status });
stub("../../models/Product", {
  find: (q) => {
    // סימולציה של $or עם $in על _id ועל sku
    const clauses = q.$or || [q];
    const match = (p) => clauses.some((c) => {
      if (c._id) return c._id.$in.map(String).includes(String(p._id));
      if (c.sku) return c.sku.$in.map(String).includes(String(p.sku));
      return false;
    });
    return chainable(state.products.filter(match));
  },
});
stub("../../models/Customer", { findById: () => chainable(state.customer) });
stub("../../utils/logStatusChange", async (args) => { state.statusLogs.push(args); if (args.order) await args.order.save(); });
stub("../stock-controller/others", { handleProductQuantity: async (cart) => { state.stockCalls.push(cart); } });
stub("../../utils/customerPriceList", {
  getCustomerPriceMap: async () => state.priceMap,
  priceForProduct: (map, product) => {
    if (!map) return null;
    const v = map.get(String(product.sku));
    return v === undefined ? null : v;
  },
});

// createOrder אמיתי חוץ מ-saveOrder ו-fetchEligibleOffers
const realCreateOrder = require(path.join(BE, "lib/order-ingestion/createOrder"));
stub("../order-ingestion/createOrder", {
  buildCartItem: realCreateOrder.buildCartItem,
  fetchEligibleOffers: async () => state.offers,
  saveOrder: async (payload) => {
    const Order = require.cache[Module._resolveFilename("../../models/Order", { id: path.join(LIBDIR,"x.js"), filename: path.join(LIBDIR,"x.js"), paths: Module._nodeModulePaths(LIBDIR) })].exports;
    const o = new Order({ ...payload, invoice: 5001 });
    return await o.save();
  },
});

const { duplicateOrder, OrderDuplicateError } = require(path.join(LIBDIR, "duplicateOrder.js"));

// ── כלי בדיקה ──
let pass = 0, fail = 0;
const check = (name, cond, extra = "") => {
  if (cond) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
};

const oid = () => new mongoose.Types.ObjectId();
const P = (over = {}) => ({
  _id: oid(), sku: "S" + Math.random().toString(36).slice(2, 7),
  title: { he: "מוצר", en: "Product" }, slug: "p", barcode: "1", image: ["i.jpg"],
  category: oid(), prices: { price: 10, originalPrice: 10 },
  isVatFree: false, purchaseLimit: null, weight: 1, stock: 100, status: "show",
  productId: "legacy", ...over,
});
const L = (product, over = {}) => ({
  _id: product._id, id: product._id, sku: product.sku, title: product.title,
  prices: { price: 10, originalPrice: 10 }, price: 10, quantity: 1, itemTotal: 10, ...over,
});
const reset = () => {
  state.products = []; state.order = null; state.saved = null;
  state.stockCalls = []; state.statusLogs = []; state.offers = []; state.priceMap = null;
  state.customer = { _id: "cust1", name: "דנה", createdAt: new Date("2020-01-01") };
};
const ORDER_ID = String(oid());
const mkOrder = (cart, over = {}) => ({
  _id: ORDER_ID, invoice: 1234, user: "cust1", cart,
  user_info: { name: "דנה", lastName: "כהן", address: { street: "הרצל" } },
  subTotal: 0, shippingCost: 20, discount: 0, total: 0,
  shippingOption: "2", paymentMethod: "manual", customer_note: "בלי בצל",
  callOnArrival: true, ...over,
});

(async () => {
  // ── A: מסלול תקין ──
  console.log("\nA. מסלול תקין");
  reset();
  const p1 = P({ prices: { price: 12, originalPrice: 12 } });
  const p2 = P({ prices: { price: 30, originalPrice: 30 } });
  state.products = [p1, p2];
  state.order = mkOrder([
    L(p1, { prices: { price: 12, originalPrice: 12 }, price: 12, quantity: 3, itemTotal: 36 }),
    L(p2, { prices: { price: 30, originalPrice: 30 }, price: 30, quantity: 0.75, itemTotal: 22.5 }),
  ]);
  let res = await duplicateOrder(ORDER_ID, { createdBy: "a@b.c" });
  check("נוצרו 2 שורות", res.order.cart.length === 2, JSON.stringify(res.order.cart.length));
  check("כמות שברירית נשמרה", res.order.cart[1].quantity === 0.75, String(res.order.cart[1].quantity));
  check("subTotal = 36 + 22.5", res.order.subTotal === 58.5, String(res.order.subTotal));
  check("shippingCost הועתק", res.order.shippingCost === 20, String(res.order.shippingCost));
  check("total = 78.5", res.order.total === 78.5, String(res.order.total));
  check("סטטוס Processing", String(res.order.status) === "statusProcessing");
  check("source=duplicate", res.order.source === "duplicate");
  check("discount=0, coupon=null", res.order.discount === 0 && res.order.coupon === null);
  check("המלאי ירד", state.stockCalls.length === 1 && state.stockCalls[0].length === 2);
  check("נרשם שינוי סטטוס", state.statusLogs.length === 1 && state.statusLogs[0].to === "Processing");
  check("systemNote מזכיר את ההזמנה המקורית", /1234/.test(res.order.systemNote), res.order.systemNote);
  check("customer_note הועתק", res.order.customer_note === "בלי בצל");
  check("callOnArrival הועתק", res.order.callOnArrival === true);
  check("priceSource=reorder", res.order.cart[0].priceSource === "reorder");
  check("אין דיווחי נשירה", res.dropped.length === 0);
  check("אין דיווחי שינוי מחיר", res.priceChanges.length === 0, JSON.stringify(res.priceChanges));

  // ── B: מוצר נמחק ──
  console.log("\nB. מוצר שנמחק מהקטלוג");
  reset();
  const p3 = P(); const pGone = P();
  state.products = [p3];
  state.order = mkOrder([L(p3, { quantity: 2 }), L(pGone, { quantity: 1 })]);
  res = await duplicateOrder(ORDER_ID);
  check("שורה אחת בלבד", res.order.cart.length === 1);
  check("דווחה נשירה", res.dropped.length === 1 && /אינו קיים/.test(res.dropped[0].reason), JSON.stringify(res.dropped));
  check("systemNote מכיל את הנשירה", /לא הועתקו/.test(res.order.systemNote));

  // ── C: מוצר מוסתר ──
  console.log("\nC. מוצר מוסתר");
  reset();
  const pHidden = P({ status: "hide" }); const pOk = P();
  state.products = [pHidden, pOk];
  state.order = mkOrder([L(pHidden), L(pOk)]);
  res = await duplicateOrder(ORDER_ID);
  check("המוסתר נשר", res.order.cart.length === 1 && /אינו זמין/.test(res.dropped[0].reason));

  // ── D: כל השורות נשרו ──
  console.log("\nD. כל השורות נשרו");
  reset();
  state.products = [];
  state.order = mkOrder([L(P())]);
  try { await duplicateOrder(ORDER_ID); check("נזרקה שגיאה", false); }
  catch (e) { check("נזרקה OrderDuplicateError", e instanceof OrderDuplicateError && e.code === "all_items_dropped", e.message); }

  // ── E: שורות מנוע ──
  console.log("\nE. שורות מנוע (פרס/מתנה/קופון)");
  reset();
  const pReal = P(); const pGift = P();
  state.products = [pReal, pGift];
  state.order = mkOrder([
    L(pReal, { quantity: 2 }),
    L(pGift, { isRewardProduct: true, rewardPrice: 0 }),
    L(pGift, { isWelcomeGift: true }),
    L(pGift, { isCouponFreeProduct: true }),
  ]);
  res = await duplicateOrder(ORDER_ID);
  check("רק השורה האמיתית הועתקה", res.order.cart.length === 1, JSON.stringify(res.order.cart.map(c=>c.sku)));
  check("שורות מנוע לא דווחו כנשירה", res.dropped.length === 0);

  // ── F: אותו מוצר בשתי שורות ──
  console.log("\nF. אותו מוצר בשתי שורות");
  reset();
  const pDup = P({ prices: { price: 10, originalPrice: 10 } });
  state.products = [pDup];
  state.order = mkOrder([L(pDup, { quantity: 2 }), L(pDup, { quantity: 3 })]);
  res = await duplicateOrder(ORDER_ID);
  check("שורה אחת מאוחדת", res.order.cart.length === 1);
  check("כמות 5", res.order.cart[0].quantity === 5, String(res.order.cart[0].quantity));
  check("itemTotal 50", res.order.cart[0].itemTotal === 50, String(res.order.cart[0].itemTotal));
  check("subTotal 50", res.order.subTotal === 50, String(res.order.subTotal));

  // ── G: התאמה לפי מק"ט כשה-_id כבר לא קיים ──
  console.log("G. מוצר שנוצר מחדש — אותו מק\"ט, _id אחר");
  reset();
  const pNew = P({ sku: "SKU-777" });
  state.products = [pNew];
  const oldLine = L(pNew, { quantity: 2 });
  oldLine._id = String(oid()); oldLine.id = oldLine._id; oldLine.sku = "SKU-777";
  state.order = mkOrder([oldLine]);
  res = await duplicateOrder(ORDER_ID).catch((e) => ({ err: e }));
  check("נמצא לפי מק\"ט", !res.err && res.order?.cart?.length === 1, res.err ? res.err.message : "");

  // ── H: שינוי מחיר ──
  console.log("\nH. מחיר שהשתנה מאז");
  reset();
  const pPrice = P({ prices: { price: 25, originalPrice: 25 } });
  state.products = [pPrice];
  state.order = mkOrder([L(pPrice, { prices: { price: 20, originalPrice: 20 }, price: 20, quantity: 1 })]);
  res = await duplicateOrder(ORDER_ID);
  check("המחיר שהועתק הוא הישן", res.order.cart[0].prices.price === 20, String(res.order.cart[0].prices.price));
  check("catalogPrice הוא הנוכחי", res.order.cart[0].catalogPrice === 25, String(res.order.cart[0].catalogPrice));
  check("דווח שינוי מחיר", res.priceChanges.length === 1 && res.priceChanges[0].currentPrice === 25);
  check("systemNote מזכיר שינוי מחיר", /מחיר השתנה/.test(res.order.systemNote));

  // ── H2: מחירון לקוח גובר על הקטלוג בהשוואה ──
  console.log("\nH2. מחירון לקוח");
  reset();
  const pList = P({ sku: "LST1", prices: { price: 25, originalPrice: 25 } });
  state.products = [pList];
  state.priceMap = new Map([["LST1", 20]]);
  state.order = mkOrder([L(pList, { prices: { price: 20, originalPrice: 20 }, price: 20 })]);
  res = await duplicateOrder(ORDER_ID);
  check("אין דיווח כשמחיר המחירון תואם", res.priceChanges.length === 0, JSON.stringify(res.priceChanges));

  // ── I: מזהה לא תקין / הזמנה לא נמצאה ──
  console.log("\nI. קלט לא תקין");
  reset();
  try { await duplicateOrder("not-an-id"); check("מזהה לא תקין", false); }
  catch (e) { check("400 על מזהה לא תקין", e.status === 400, e.message); }
  reset(); state.order = null;
  try { await duplicateOrder(String(oid())); check("הזמנה לא נמצאה", false); }
  catch (e) { check("404 על הזמנה שלא נמצאה", e.status === 404, e.message); }

  // ── J: לקוח נמחק ──
  console.log("\nJ. לקוח שנמחק");
  reset();
  state.customer = null;
  state.order = mkOrder([L(P())]);
  try { await duplicateOrder(ORDER_ID); check("לקוח נמחק", false); }
  catch (e) { check("409 על לקוח שנמחק", e.status === 409, e.message); }

  // ── K: עגלה ריקה ──
  console.log("\nK. הזמנה בלי שורות");
  reset();
  state.order = mkOrder([]);
  try { await duplicateOrder(ORDER_ID); check("עגלה ריקה", false); }
  catch (e) { check("שגיאה על עגלה ריקה", e.code === "no_items", e.message); }

  // ── L: שורה בלי מחיר ──
  console.log("\nL. שורה בלי מחיר");
  reset();
  const pFree = P(); const pPaid = P();
  state.products = [pFree, pPaid];
  state.order = mkOrder([
    L(pFree, { prices: { price: 0, originalPrice: 0 }, price: 0 }),
    L(pPaid, { quantity: 1 }),
  ]);
  res = await duplicateOrder(ORDER_ID);
  check("שורת אפס נשרה ודווחה", res.order.cart.length === 1 && /אין מחיר/.test(res.dropped[0].reason), JSON.stringify(res.dropped));

  // ── M: הנחת סף — usedOfferIds חייב להתמלא ──
  console.log("\nM. מבצע הנחת סף");
  reset();
  const pM = P({ prices: { price: 100, originalPrice: 100 } });
  state.products = [pM];
  const thresholdOfferId = oid();
  state.offers = [{
    _id: thresholdOfferId, type: "THRESHOLD_DISCOUNT", name: { he: "10% מעל 150" },
    thresholdAmount: 150, discountType: "percentage", discountValue: 10, isActive: true,
  }];
  state.order = mkOrder([L(pM, { prices: { price: 100, originalPrice: 100 }, price: 100, quantity: 2 })], { shippingCost: 0 });
  res = await duplicateOrder(ORDER_ID);
  check("subTotal 200", res.order.subTotal === 200, String(res.order.subTotal));
  check("offerDiscount 20", res.order.offerDiscount === 20, String(res.order.offerDiscount));
  check("total 180", res.order.total === 180, String(res.order.total));
  check("usedOfferIds מכיל את המבצע", res.order.usedOfferIds.includes(String(thresholdOfferId)),
    JSON.stringify(res.order.usedOfferIds));

  // ── N: מבצע חבילה — offerId מגיע משורת העגלה ──
  console.log("\nN. מבצע חבילה");
  reset();
  const pN = P({ prices: { price: 50, originalPrice: 50 } });
  state.products = [pN];
  const bundleOfferId = oid();
  state.offers = [{
    _id: bundleOfferId, type: "BUNDLE_PRICE", name: { he: "2 ב-80" },
    products: [{ _id: pN._id }], quantity: 2, price: 80, isActive: true,
  }];
  state.order = mkOrder([L(pN, { prices: { price: 50, originalPrice: 50 }, price: 50, quantity: 2 })], { shippingCost: 0 });
  res = await duplicateOrder(ORDER_ID);
  check("שורת המבצע נושאת appliedOffers",
    Array.isArray(res.order.cart[0].appliedOffers) && res.order.cart[0].appliedOffers.length > 0,
    JSON.stringify(res.order.cart[0].appliedOffers));
  check("usedOfferIds מכיל את מבצע החבילה", res.order.usedOfferIds.includes(String(bundleOfferId)),
    JSON.stringify(res.order.usedOfferIds));
  check("subTotal לפי מחיר החבילה", res.order.subTotal === 80, String(res.order.subTotal));

  // ── O: אין מבצעים פעילים — העגלה יוצאת נקייה ──
  console.log("\nO. בלי מבצעים פעילים");
  reset();
  const pO = P();
  state.products = [pO];
  state.order = mkOrder([L(pO, { quantity: 1 })], { shippingCost: 0 });
  res = await duplicateOrder(ORDER_ID);
  check("usedOfferIds ריק", Array.isArray(res.order.usedOfferIds) && res.order.usedOfferIds.length === 0);
  check("אין discountedPrice על השורה", !res.order.cart[0].discountedPrice);

  // ── P: מוצר עם וריאציות — נושר במקום להישלח שגוי ──
  console.log("\nP. מוצר עם וריאציות");
  reset();
  const pVar = P({ isCombination: true });
  const pPlain = P();
  state.products = [pVar, pPlain];
  state.order = mkOrder([L(pVar), L(pPlain)]);
  res = await duplicateOrder(ORDER_ID);
  check("מוצר הווריאציות נשר", res.order.cart.length === 1);
  check("הסיבה מוסברת", /וריאציות/.test(res.dropped[0]?.reason || ""), JSON.stringify(res.dropped));

  // ── Q: מלאי חסר — מדווח ולא חוסם ──
  console.log("\nQ. מלאי חסר");
  reset();
  const pLow = P({ stock: 1 });
  const pUnlimited = P({ stock: null });
  state.products = [pLow, pUnlimited];
  state.order = mkOrder([L(pLow, { quantity: 5 }), L(pUnlimited, { quantity: 99 })]);
  res = await duplicateOrder(ORDER_ID);
  check("ההזמנה נוצרה בכל זאת", res.order.cart.length === 2);
  check("דווחה אזהרת מלאי אחת", res.stockWarnings.length === 1, JSON.stringify(res.stockWarnings));
  check("האזהרה על המוצר הנכון",
    res.stockWarnings[0].requested === 5 && res.stockWarnings[0].inStock === 1,
    JSON.stringify(res.stockWarnings));
  check("מלאי null אינו מתריע", !res.stockWarnings.some((w) => w.sku === pUnlimited.sku));
  check("systemNote מזכיר מלאי חסר", /מלאי חסר/.test(res.order.systemNote), res.order.systemNote);

  // ── R: הערת המערכת אינה גדלה בלי גבול ──
  console.log("\nR. תקרה להערת המערכת");
  reset();
  const kept = P();
  state.products = [kept];
  const manyGone = Array.from({ length: 20 }, () => L(P(), { quantity: 1 }));
  state.order = mkOrder([L(kept, { quantity: 1 }), ...manyGone]);
  res = await duplicateOrder(ORDER_ID);
  check("כל הנשירות דווחו למסך", res.dropped.length === 20, String(res.dropped.length));
  check("ההערה מקוצרת", /ועוד 12/.test(res.order.systemNote), res.order.systemNote);
  check("ההערה נשארת קצרה", res.order.systemNote.length < 900, String(res.order.systemNote.length));

  // ── S: שם מוצר שאינו he/en לא מודפס כאובייקט ──
  console.log("\nS. שם מוצר חריג");
  reset();
  state.products = [];
  const weird = P();
  state.order = mkOrder([L(weird, { title: { fr: "pomme" }, sku: "SKU-FR" })]);
  try { await duplicateOrder(ORDER_ID); check("ציפינו לשגיאה", false); }
  catch (e) {
    check("לא מודפס [object Object]", !/\[object Object\]/.test(e.message), e.message);
    check("נופלים למק\"ט", /SKU-FR/.test(e.message), e.message);
  }

  console.log(`\n${"\u2500".repeat(50)}`);
  if (fail) {
    console.log(`נכשלו ${fail} בדיקות מתוך ${pass + fail}.`);
    process.exit(1);
  }
  console.log(`כל ${pass} הבדיקות עברו.`);
})().catch((e) => {
  console.error("הבדיקה קרסה:", e);
  process.exit(1);
});
