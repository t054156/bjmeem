/** BJmeem — checkout, order history, tracking. */
import { supabase, run, rpc, currentUserId, BJmeemError } from './client.js';

export const ORDER_FLOW = [
  'pending', 'confirmed', 'preparing', 'packed', 'out_for_delivery', 'delivered',
];

export const STATUS_LABEL = {
  pending: 'Order received',
  confirmed: 'Order confirmed',
  preparing: 'Preparing',
  packed: 'Packed',
  out_for_delivery: 'Out for delivery',
  delivered: 'Delivered',
  cancelled: 'Cancelled',
  returned: 'Returned',
  refunded: 'Refunded',
};

/**
 * Place the order. Note what this does NOT take: no prices, no discount, no
 * delivery fee, no totals. Everything is recomputed server-side inside one
 * transaction that also reserves stock and clears the cart.
 *
 * @param {{addressId, paymentMethod, notes, couponCode, rewardId}} input
 * @returns {Promise<{order_id, order_number, total_amount, status}>}
 */
export async function createOrder({
  addressId, paymentMethod = 'cod', notes = null, couponCode = null, rewardId = null,
} = {}) {
  if (!addressId) {
    throw new BJmeemError('Please choose a delivery address.', 'ADDRESS_REQUIRED');
  }
  return rpc('place_order', {
    p_address_id: addressId,
    p_payment_method: paymentMethod,
    p_customer_notes: notes,
    p_coupon_code: couponCode,
    p_loyalty_reward_id: rewardId,
  });
}

const ORDER_SELECT = `
  id, order_number, order_status, payment_status, payment_method,
  subtotal, discount_amount, delivery_fee, tax_amount, loyalty_discount, total_amount,
  coupon_code, loyalty_points_earned, loyalty_points_used, customer_notes,
  customer_name, customer_email, customer_phone, shipping_address,
  courier_name, courier_phone, tracking_reference, estimated_delivery_time,
  delivered_at, cancelled_at, created_at,
  items:order_items ( id, product_id, variant_id, product_name, product_slug,
                      image_url, size, color, sku, quantity, unit_price, total_price )
`;

export async function getOrders({ limit = 25, offset = 0, status = null } = {}) {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to see your orders.', 'AUTH_REQUIRED');

  let q = supabase.from('orders').select(ORDER_SELECT)
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1);
  if (status) q = q.eq('order_status', status);

  return (await run(q)).map(decorateOrder);
}

export async function getOrderDetails(orderId) {
  const row = await run(supabase.from('orders').select(`
    ${ORDER_SELECT},
    history:order_status_history ( id, status, note, created_at )
  `).eq('id', orderId).maybeSingle());

  if (!row) throw new BJmeemError('We could not find that order.', 'ORDER_NOT_FOUND');
  const order = decorateOrder(row);
  order.history = (row.history ?? [])
    .sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
  return order;
}

function decorateOrder(o) {
  const idx = ORDER_FLOW.indexOf(o.order_status);
  return {
    ...o,
    statusLabel: STATUS_LABEL[o.order_status] ?? o.order_status,
    isOpen: !['delivered', 'cancelled', 'returned', 'refunded'].includes(o.order_status),
    isCancellable: ['pending', 'confirmed', 'preparing'].includes(o.order_status),
    // -1 for cancelled/returned/refunded: those leave the happy path entirely.
    progressStep: idx,
    progressPercent: idx < 0 ? 0 : Math.round((idx / (ORDER_FLOW.length - 1)) * 100),
    itemCount: (o.items ?? []).reduce((s, i) => s + i.quantity, 0),
  };
}

/**
 * Track by order number + email — works signed out. Returns { found: false }
 * for both a wrong number and a wrong email, so it cannot be used to discover
 * whether an order exists.
 */
export async function trackOrder(orderNumber, email) {
  if (!orderNumber || !email) {
    throw new BJmeemError('Enter your order number and email address.', 'FIELDS_REQUIRED');
  }
  const result = await rpc('track_order', {
    p_order_number: orderNumber.trim(), p_email: email.trim(),
  });
  if (!result?.found) {
    throw new BJmeemError(
      'We could not find an order with that number and email.', 'ORDER_NOT_FOUND');
  }
  const idx = ORDER_FLOW.indexOf(result.status);
  return {
    ...result,
    statusLabel: STATUS_LABEL[result.status] ?? result.status,
    progressStep: idx,
    progressPercent: idx < 0 ? 0 : Math.round((idx / (ORDER_FLOW.length - 1)) * 100),
  };
}

export async function cancelOrder(orderId, reason = null) {
  return rpc('cancel_my_order', { p_order_id: orderId, p_reason: reason });
}

/** Re-add a past order's still-purchasable lines to the bag. */
export async function reorder(orderId) {
  return rpc('reorder', { p_order_id: orderId });
}

/** Live status updates for the tracking page. Returns an unsubscribe function. */
export function onOrderUpdate(orderId, handler) {
  const channel = supabase.channel(`bjmeem-order-${orderId}`)
    .on('postgres_changes',
        { event: 'UPDATE', schema: 'public', table: 'orders', filter: `id=eq.${orderId}` },
        (payload) => handler(decorateOrder(payload.new)))
    .subscribe();
  return () => supabase.removeChannel(channel);
}
