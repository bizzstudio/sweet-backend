/* Copy tomer-store offerCalculations → backend CommonJS */
const fs = require("fs");
const path = require("path");

const storePath =
  process.env.STORE_OFFER_CALC ||
  "C:/Users/user/Desktop/tomer/tomer-store/src/utils/offerCalculations.js";
const outPath =
  process.env.BACKEND_OFFER_CALC_OUT ||
  "C:/Users/user/Desktop/tomer/tomer-backend/utils/offerCalculations.js";

let s = fs.readFileSync(storePath, "utf8");

s = s.replace(/^\/\/ src\/utils\/offerCalculations\.js/m, "// utils/offerCalculations.js");
s = s.replace(/export const /g, "const ");

s = s.replace(
  `const findOptimalOfferCombinationInternal = (cartItems, offers = []) => {
    if (!Array.isArray(offers) || offers.length === 0 || cartItems.length === 0) {
        return emptyCartWithClearedOffers(cartItems);
    }`,
  `const findOptimalOfferCombinationInternal = (cartItems, offers = []) => {
    const safeCart = Array.isArray(cartItems) ? cartItems : [];
    if (!Array.isArray(offers) || offers.length === 0 || safeCart.length === 0) {
        return emptyCartWithClearedOffers(safeCart);
    }`
);

s = s.replace(
  `    const baseCartItems = cartItems.filter((item) => !item.isRewardProduct);`,
  `    const baseCartItems = safeCart.filter((item) => !item.isRewardProduct);`
);

s = s.replace(
  `const findOptimalOfferCombination = (cartItems, offers = []) => {
    if (!Array.isArray(offers) || offers.length === 0 || cartItems.length === 0) {
        return {
            ...emptyCartWithClearedOffers(cartItems),
            exclusiveStackingNotices: [],
        };
    }`,
  `const findOptimalOfferCombination = (cartItems, offers = []) => {
    const safeCart = Array.isArray(cartItems) ? cartItems : [];
    if (!Array.isArray(offers) || offers.length === 0 || safeCart.length === 0) {
        return {
            ...emptyCartWithClearedOffers(safeCart),
            exclusiveStackingNotices: [],
        };
    }`
);

s = s.replace(
  /findOptimalOfferCombinationInternal\(cartItems,/g,
  "findOptimalOfferCombinationInternal(safeCart,"
);

if (s.includes("export const")) {
  console.error("Still has export const");
  process.exit(1);
}

const tail = `

module.exports = {
    calculateCartTotal,
    createProductCountMap,
    applyBundlePrice,
    applyBuyXGetY,
    applyThresholdGetItem,
    applyThresholdDiscount,
    mergeRewardItems,
    createUpdatedCartItems,
    findOptimalOfferCombination,
};
`;

if (!s.trim().endsWith("};")) {
  // remove accidental duplicate export block from previous runs
  const marker = "\n\nmodule.exports = {";
  const last = s.lastIndexOf(marker);
  if (last !== -1) {
    const second = s.indexOf(marker, last + 1);
    if (second !== -1) s = s.slice(0, second);
  }
}

if (!s.includes("module.exports =")) {
  s += tail;
}

fs.writeFileSync(outPath, s, "utf8");
console.log("Wrote", outPath, "from", storePath, "bytes", s.length);
