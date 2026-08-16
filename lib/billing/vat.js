// lib/billing/vat.js
//
// חישוב המע"מ של מסמך. מקור אמת אחד.
//
// החישוב הזה היה משוכפל בשלושה מקומות — רשימת החשבוניות בשרת, המסמך
// המודפס בדפדפן, ואומדן הברוטו — וכל אחד יכול היה להשתנות בנפרד. מסמך
// שמראה 1,180 ומסך שמראה 1,090 על אותה חשבונית הוא בדיוק סוג התקלה שאף
// אחד לא מגלה עד שהלקוח מתקשר.
//
// כללי החישוב:
//
//   - שורות פטורות (isVatFree) אינן נכנסות לבסיס המע"מ. 377 מוצרים
//     בקטלוג מסומנים כך.
//   - הנחה כללית מתחלקת יחסית בין החלק החייב לפטור. הנחה שיורדת כולה
//     מהחלק החייב מקטינה את המע"מ יותר מדי.
//   - משלוח חייב במע"מ תמיד.
//
// ⚠️ זהו אומדן. הרשות היא iCount — הוא מקבל שורות נטו ומחשב את המע"מ
//    בעצמו על החשבונית. לפני פעולה כספית (רישום תשלום) יש לקרוא את
//    הסכום משם ולא להסתמך על החישוב הזה.

const VAT_RATE = 0.18;

/**
 * @param {object} doc - מסמך עם items / subTotal / shippingCost / discount
 * @returns {{net, shipping, discount, beforeVat, taxableBase, exemptBase, vat, total, rate}}
 */
const calculateVat = (doc = {}) => {
  const items = Array.isArray(doc.items) ? doc.items : [];
  const net = Number(doc.subTotal || 0);
  const shipping = Number(doc.shippingCost || 0);
  const discount = Number(doc.discount || 0);
  const beforeVat = Number((net + shipping - discount).toFixed(2));

  // מסמך בלי שורות (רשומה ישנה, או מסמך שנשמר לפני שהשדה קיים) — אין על
  // מה לחשב פיצול, ולכן הכל נחשב חייב. עדיף אומדן גס מאשר 0 שנראה כמו
  // מסמך פטור לגמרי.
  if (!items.length) {
    const vat = Number((Math.max(0, beforeVat) * VAT_RATE).toFixed(2));
    return {
      net, shipping, discount, beforeVat,
      taxableBase: beforeVat, exemptBase: 0,
      vat, total: Number((beforeVat + vat).toFixed(2)),
      rate: VAT_RATE,
    };
  }

  const taxableItems = items
    .filter((i) => !i.isVatFree)
    .reduce((s, i) => s + Number(i.lineTotal || 0), 0);
  const exemptItems = items
    .filter((i) => i.isVatFree)
    .reduce((s, i) => s + Number(i.lineTotal || 0), 0);

  const share = net > 0 ? taxableItems / net : 1;
  const taxableBase = Math.max(0, taxableItems - discount * share + shipping);
  const exemptBase = Math.max(0, exemptItems - discount * (1 - share));

  const vat = Number((taxableBase * VAT_RATE).toFixed(2));

  return {
    net,
    shipping,
    discount,
    beforeVat,
    taxableBase: Number(taxableBase.toFixed(2)),
    exemptBase: Number(exemptBase.toFixed(2)),
    vat,
    total: Number((taxableBase + exemptBase + vat).toFixed(2)),
    rate: VAT_RATE,
  };
};

module.exports = { calculateVat, VAT_RATE };
