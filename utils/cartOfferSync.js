/**
 * מוצא את שורת העגלה בצד השרת שמתאימה לשורה מהלקוח אחרי findOptimalOfferCombination.
 * השוואה לפי אינדקס שבורה כש־cartItems כולל isRewardProduct אבל itemsWithOffers נבנה מ־baseCartItems.
 */
function findServerItemForClientLine(clientItem, itemsWithOffers) {
  if (!clientItem || !Array.isArray(itemsWithOffers)) return undefined;

  if (clientItem.id != null && clientItem.id !== "") {
    const byId = itemsWithOffers.find((s) => s.id === clientItem.id);
    if (byId) return byId;
  }

  if (clientItem.isRewardProduct) {
    const pid = clientItem._id?.toString?.() ?? String(clientItem._id ?? "");
    const oid =
      clientItem.rewardOfferId?.toString?.() ??
      String(clientItem.rewardOfferId ?? "");
    return itemsWithOffers.find((s) => {
      if (!s.isRewardProduct) return false;
      const spid = s._id?.toString?.() ?? String(s._id ?? "");
      const soid =
        s.rewardOfferId?.toString?.() ?? String(s.rewardOfferId ?? "");
      return spid === pid && soid === oid;
    });
  }

  const pid = clientItem._id?.toString?.() ?? String(clientItem._id ?? "");
  const regularMatches = itemsWithOffers.filter(
    (s) =>
      !s.isRewardProduct &&
      (s._id?.toString?.() ?? String(s._id ?? "")) === pid
  );
  if (regularMatches.length === 1) return regularMatches[0];

  return undefined;
}

module.exports = { findServerItemForClientLine };
