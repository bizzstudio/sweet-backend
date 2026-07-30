const Offer = require("../models/Offer");

const buildWelcomeGiftDateFilter = (now = new Date()) => ({
  $and: [
    { type: "WELCOME_GIFT" },
    { isActive: true },
    {
      $or: [
        { startsAt: { $exists: false } },
        { startsAt: null },
        { startsAt: { $lte: now } },
      ],
    },
    {
      $or: [
        { endsAt: { $exists: false } },
        { endsAt: null },
        { endsAt: { $gte: now } },
      ],
    },
  ],
});

const getActiveWelcomeGiftOffer = async () =>
  Offer.findOne(buildWelcomeGiftDateFilter())
    .populate("rewardProduct")
    .sort({ updatedAt: -1 });

const isWelcomeGiftEnabled = async () => {
  const offer = await getActiveWelcomeGiftOffer();
  return Boolean(offer?.rewardProduct);
};

const buildWelcomeGiftForNewCustomer = (offer) => {
  const product = offer.rewardProduct;
  return {
    isUsed: false,
    offerId: offer._id,
    sku: product?.sku || "",
  };
};

const hasUnusedWelcomeGift = (customer) =>
  Boolean(
    customer?.welcomeGift?.sku &&
    customer.welcomeGift.isUsed === false
  );

const assignWelcomeGiftToCustomer = async (customer) => {
  const offer = await getActiveWelcomeGiftOffer();
  if (!offer?.rewardProduct) return;
  if (hasUnusedWelcomeGift(customer)) return;
  if (customer.welcomeGift?.isUsed === true) return;
  customer.welcomeGift = buildWelcomeGiftForNewCustomer(offer);
};

const deactivateOtherWelcomeGiftOffers = async (activeOfferId) => {
  await Offer.updateMany(
    {
      type: "WELCOME_GIFT",
      _id: { $ne: activeOfferId },
      isActive: true,
    },
    { isActive: false }
  );
};

const isWelcomeGiftCartItem = (item) => Boolean(item?.isWelcomeGift);

module.exports = {
  getActiveWelcomeGiftOffer,
  isWelcomeGiftEnabled,
  buildWelcomeGiftForNewCustomer,
  hasUnusedWelcomeGift,
  assignWelcomeGiftToCustomer,
  deactivateOtherWelcomeGiftOffers,
  isWelcomeGiftCartItem,
};
