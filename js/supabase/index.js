/**
 * BJmeem backend API — single entry point.
 *
 *   import BJmeemAPI from './js/supabase/index.js';
 *   const products = await BJmeemAPI.getProducts({ category: 'best-sellers' });
 *
 * or named:
 *
 *   import { loginUser, addToCart } from './js/supabase/index.js';
 */
export { supabase, BJmeemError, toError, storageUrl, currentUserId } from './client.js';

export {
  signUpUser, loginUser, logoutUser, resetPassword, updatePassword,
  resendVerification, getSession, getCurrentUser, isLoggedIn, onAuthChange,
} from './auth.js';

export {
  getProfile, updateProfile, uploadAvatar,
  getAddresses, getDefaultAddress, createAddress, updateAddress, deleteAddress,
  setDefaultAddress, getDeliveryZone, getDeliveryZones,
  getNotifications, getUnreadCount, markNotificationRead, markAllNotificationsRead,
  onNotification,
} from './account.js';

export {
  getCategories, getProducts, getProduct, getFeaturedProducts, getRelatedProducts,
  getVariantAvailability, getProductReviews, submitReview,
} from './catalog.js';

export {
  getCartId, getCart, previewCart, addToCart, updateCartItem, removeFromCart,
  clearCart, mergeLocalCart,
  getWishlist, addToWishlist, removeFromWishlist, toggleWishlist, isWishlisted,
} from './cart.js';

export {
  createOrder, getOrders, getOrderDetails, trackOrder, cancelOrder, reorder,
  onOrderUpdate, ORDER_FLOW, STATUS_LABEL,
} from './orders.js';

export {
  getLoyaltyAccount, getLoyaltyTiers, getLoyaltyTransactions, getRewards,
  getAvailableRewards, redeemReward,
  validateCoupon, applyCoupon, clearCoupon, getAvailableCoupons, getReferralInfo,
} from './loyalty.js';

export * as admin from './admin.js';

import * as client from './client.js';
import * as auth from './auth.js';
import * as account from './account.js';
import * as catalog from './catalog.js';
import * as cart from './cart.js';
import * as orders from './orders.js';
import * as loyalty from './loyalty.js';
import * as adminApi from './admin.js';

/**
 * Everything needed for the "My BJmeem" dashboard in one round trip.
 * Individually resilient: one failing section does not blank the page.
 */
export async function getAccountDashboard() {
  const settle = async (fn, fallback) => {
    try { return await fn(); } catch { return fallback; }
  };

  const [profile, recentOrders, addresses, card, points, rewards, wishlist, notifications] =
    await Promise.all([
      settle(account.getProfile, null),
      settle(() => orders.getOrders({ limit: 5 }), []),
      settle(account.getAddresses, []),
      settle(loyalty.getLoyaltyAccount, null),
      settle(() => loyalty.getLoyaltyTransactions({ limit: 10 }), []),
      settle(loyalty.getAvailableRewards, []),
      settle(cart.getWishlist, []),
      settle(() => account.getNotifications({ limit: 10 }), []),
    ]);

  return {
    profile, recentOrders, addresses,
    loyaltyCard: card, pointsHistory: points, rewards,
    wishlist, notifications,
    greeting: profile?.first_name ? `Hi ${profile.first_name} 🧸` : 'Hi there 🧸',
  };
}

const BJmeemAPI = {
  ...client, ...auth, ...account, ...catalog, ...cart, ...orders, ...loyalty,
  getAccountDashboard,
  admin: adminApi,
};

export default BJmeemAPI;
