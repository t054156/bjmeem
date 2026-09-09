/**
 * BJmeem — admin/staff operations.
 *
 * Every function here is also enforced server-side: the RPCs re-check
 * is_staff()/is_admin(), and RLS blocks the plain table reads for customers.
 * Hiding the admin UI is a convenience, not the security boundary.
 */
import { supabase, run, rpc, currentUserId, BJmeemError } from './client.js';

/** True when the signed-in user is staff or admin. */
export async function isStaff() {
  const uid = await currentUserId();
  if (!uid) return false;
  const p = await run(supabase.from('profiles').select('role').eq('id', uid).single());
  return p.role === 'admin' || p.role === 'staff';
}

export async function isAdmin() {
  const uid = await currentUserId();
  if (!uid) return false;
  const p = await run(supabase.from('profiles').select('role').eq('id', uid).single());
  return p.role === 'admin';
}

/* ------------------------------------------------------------------- orders */

/**
 * @param {{status,search,from,to,limit,offset}} f
 * `search` matches order number, customer name, email or phone.
 */
export async function listOrders(f = {}) {
  let q = supabase.from('orders').select(`
      id, order_number, order_status, payment_status, payment_method, total_amount,
      customer_name, customer_email, customer_phone, created_at, delivered_at,
      items:order_items ( id, product_name, size, color, quantity, total_price )
    `).order('created_at', { ascending: false });

  if (f.status) q = q.eq('order_status', f.status);
  if (f.from)   q = q.gte('created_at', f.from);
  if (f.to)     q = q.lte('created_at', f.to);
  if (f.search) {
    const s = `%${f.search.replace(/[%_]/g, '')}%`;
    q = q.or(`order_number.ilike.${s},customer_name.ilike.${s},` +
             `customer_email.ilike.${s},customer_phone.ilike.${s}`);
  }
  const limit = f.limit ?? 50, offset = f.offset ?? 0;
  return run(q.range(offset, offset + limit - 1));
}

export async function updateOrderStatus(orderId, status, opts = {}) {
  return rpc('admin_update_order_status', {
    p_order_id: orderId,
    p_status: status,
    p_note: opts.note ?? null,
    p_courier_name: opts.courierName ?? null,
    p_courier_phone: opts.courierPhone ?? null,
    p_tracking_reference: opts.trackingReference ?? null,
    p_estimated_delivery_time: opts.estimatedDeliveryTime ?? null,
  });
}

export async function getOrderNotes(orderId) {
  return run(supabase.from('order_admin_notes').select('*')
    .eq('order_id', orderId).order('created_at', { ascending: false }));
}

/** Internal note. Never visible to the customer (RLS restricts it to staff). */
export async function addOrderNote(orderId, note) {
  const uid = await currentUserId();
  if (!note?.trim()) throw new BJmeemError('Note cannot be empty.', 'NOTE_REQUIRED');
  return run(supabase.from('order_admin_notes')
    .insert({ order_id: orderId, admin_user_id: uid, note: note.trim() })
    .select().single());
}

/* ---------------------------------------------------------------- customers */

export async function listCustomers({ search = null, limit = 50, offset = 0 } = {}) {
  let q = supabase.from('profiles')
    .select('id, email, first_name, last_name, phone_number, role, loyalty_tier, ' +
            'loyalty_points, total_orders, total_spent, created_at')
    .order('created_at', { ascending: false });
  if (search) {
    const s = `%${search.replace(/[%_]/g, '')}%`;
    q = q.or(`email.ilike.${s},first_name.ilike.${s},last_name.ilike.${s},phone_number.ilike.${s}`);
  }
  return run(q.range(offset, offset + limit - 1));
}

export async function getCustomer(userId) {
  const [profile, orders, loyalty, addresses] = await Promise.all([
    run(supabase.from('profiles').select('*').eq('id', userId).single()),
    run(supabase.from('orders').select('id, order_number, order_status, total_amount, created_at')
      .eq('user_id', userId).order('created_at', { ascending: false }).limit(25)),
    run(supabase.from('loyalty_accounts').select('*').eq('user_id', userId).maybeSingle()),
    run(supabase.from('addresses').select('*').eq('user_id', userId)),
  ]);
  return { profile, orders, loyalty, addresses };
}

/* ------------------------------------------------------------------ catalog */

export async function createProduct(p) {
  return run(supabase.from('products').insert(p).select().single());
}

export async function updateProduct(id, patch) {
  return run(supabase.from('products').update(patch).eq('id', id).select().single());
}

export async function createVariant(v) {
  return run(supabase.from('product_variants').insert(v).select().single());
}

/** Goes through an RPC so the change is audited and reserved stock is respected. */
export async function setStock(variantId, stockQuantity, reason) {
  return rpc('admin_set_stock', {
    p_variant_id: variantId,
    p_stock_quantity: stockQuantity,
    p_reason: reason ?? 'Manual stock update',
  });
}

export async function getLowStock(threshold = 5) {
  return run(supabase.from('v_variant_availability').select('*')
    .eq('is_active', true).lte('available_quantity', threshold)
    .order('available_quantity'));
}

/** Upload a product photo and register it against the product. */
export async function uploadProductImage(productId, file, { altText, isPrimary = false } = {}) {
  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
  const path = `${productId}/${Date.now()}.${ext}`;

  await run(supabase.storage.from('product-images')
    .upload(path, file, { contentType: file.type, upsert: false }));

  const url = supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;

  return run(supabase.from('product_images').insert({
    product_id: productId, image_url: url,
    alt_text: altText ?? null, is_primary: isPrimary,
  }).select().single());
}

/* ------------------------------------------------------------------ coupons */

export async function listCoupons() {
  return run(supabase.from('coupons').select('*').order('created_at', { ascending: false }));
}

export async function createCoupon(c) {
  return run(supabase.from('coupons').insert(c).select().single());
}

export async function updateCoupon(id, patch) {
  return run(supabase.from('coupons').update(patch).eq('id', id).select().single());
}

/* ------------------------------------------------------------------ loyalty */

export async function listLoyaltyAccounts({ limit = 50, offset = 0 } = {}) {
  return run(supabase.from('loyalty_accounts')
    .select('*, profile:profiles ( email, first_name, last_name )')
    .order('lifetime_points', { ascending: false })
    .range(offset, offset + limit - 1));
}

/** Audited: writes a loyalty_transactions row and an audit_logs entry. */
export async function adjustLoyaltyPoints(userId, points, reason) {
  if (!reason?.trim()) throw new BJmeemError('A reason is required.', 'REASON_REQUIRED');
  return rpc('admin_adjust_loyalty', {
    p_user_id: userId, p_points: points, p_reason: reason.trim(),
  });
}

/* ---------------------------------------------------------------- dashboard */

export async function getDashboardStats(days = 30) {
  return rpc('admin_dashboard_stats', { p_days: days });
}

export async function getAuditLog({ entity = null, limit = 100 } = {}) {
  let q = supabase.from('audit_logs').select('*')
    .order('created_at', { ascending: false }).limit(limit);
  if (entity) q = q.eq('entity', entity);
  return run(q);
}

/* ----------------------------------------------------------------- settings */

export async function getSettings() {
  return run(supabase.from('app_settings').select('*').order('key'));
}

/** Change a business rule (points per KWD, expiry months, delivery fee…). */
export async function updateSetting(key, value) {
  return run(supabase.from('app_settings')
    .update({ value, updated_at: new Date().toISOString() })
    .eq('key', key).select().single());
}
