/**
 * BJmeem — admin/staff operations.
 *
 * Every function here is also enforced server-side: the RPCs re-check
 * is_staff()/is_admin(), and RLS blocks the plain table reads for customers.
 * Hiding the admin UI is a convenience, not the security boundary.
 */
import { supabase, run, rpc, currentUserId, BJmeemError } from './client.js';

export const STAFF_PERMISSIONS = [
  'orders', 'products', 'inventory', 'customers',
  'loyalty', 'coupons', 'delivery', 'reports', 'settings',
];

/**
 * Who is signed in and what may they do. The server enforces all of this
 * again on every call — this is only so the UI can hide what won't work.
 */
export async function getAdminIdentity() {
  const uid = await currentUserId();
  if (!uid) return { signedIn: false, role: null, isStaff: false };

  const p = await run(supabase.from('profiles')
    .select('id, email, first_name, last_name, role, permissions, avatar_url')
    .eq('id', uid).single());

  const role = p.role;
  const privileged = role === 'owner' || role === 'admin';
  const can = {};
  for (const k of STAFF_PERMISSIONS) {
    can[k] = privileged ? true : (role === 'staff' && p.permissions?.[k] === true);
  }

  return {
    signedIn: true,
    id: p.id,
    email: p.email,
    name: [p.first_name, p.last_name].filter(Boolean).join(' ') || p.email,
    role,
    isOwner: role === 'owner',
    isAdmin: privileged,
    isStaff: privileged || role === 'staff',
    can,
  };
}

export async function isStaff() {
  return (await getAdminIdentity()).isStaff;
}

export async function isAdmin() {
  return (await getAdminIdentity()).isAdmin;
}

export async function isOwner() {
  return (await getAdminIdentity()).isOwner === true;
}

/** Dashboard tiles, recent orders and low-stock alerts in one round trip. */
export async function getOverview() {
  return rpc('admin_overview');
}

export async function getSalesReport({ from, to, granularity = 'day' } = {}) {
  return rpc('admin_sales_report', {
    p_from: from ?? new Date(Date.now() - 30 * 864e5).toISOString(),
    p_to: to ?? new Date().toISOString(),
    p_granularity: granularity,
  });
}

export async function getBestSellers({ days = 30, limit = 10 } = {}) {
  return rpc('admin_best_sellers', { p_days: days, p_limit: limit });
}

/** Role and staff-permission changes. Owner only, enforced in the database. */
export async function setUserRole(userId, role, permissions = null) {
  return rpc('admin_set_role', {
    p_user_id: userId, p_role: role, p_permissions: permissions,
  });
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

const ADMIN_PRODUCT_SELECT = `
  id, name, slug, description, category_id, price, compare_at_price, cost_price,
  material, fabric, pattern, care_instructions,
  is_active, is_featured, is_new_arrival, is_best_seller,
  rating_average, rating_count, created_at, updated_at,
  category:categories ( id, name, slug ),
  images:product_images ( id, image_url, alt_text, sort_order, is_primary ),
  variants:product_variants ( id, size, color, sku, stock_quantity, reserved_quantity,
                              price_override, is_active )
`;

/** Admin listing — unlike the storefront, this includes hidden products. */
export async function listProducts({ search = null, visibility = null, category = null,
                                     stock = null, limit = 100, offset = 0 } = {}) {
  let q = supabase.from('products').select(ADMIN_PRODUCT_SELECT)
    .order('created_at', { ascending: false });

  if (visibility === 'visible') q = q.eq('is_active', true);
  if (visibility === 'hidden')  q = q.eq('is_active', false);
  if (category) q = q.eq('category_id', category);
  if (search) {
    const s = `%${search.replace(/[%_]/g, '')}%`;
    q = q.or(`name.ilike.${s},slug.ilike.${s},pattern.ilike.${s}`);
  }

  let rows = await run(q.range(offset, offset + limit - 1));

  rows = rows.map((p) => {
    const variants = (p.variants ?? []).map((v) => ({
      ...v, available: Math.max((v.stock_quantity ?? 0) - (v.reserved_quantity ?? 0), 0),
    }));
    const totalAvailable = variants.reduce((s, v) => s + (v.is_active ? v.available : 0), 0);
    const images = [...(p.images ?? [])].sort(
      (a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order));
    return { ...p, variants, images, primaryImage: images[0]?.image_url ?? null, totalAvailable };
  });

  // SKU search has to look at variants, so it is applied after shaping.
  if (search) {
    const s = search.toLowerCase();
    rows = rows.filter((p) =>
      p.name.toLowerCase().includes(s) ||
      p.slug.toLowerCase().includes(s) ||
      p.variants.some((v) => (v.sku ?? '').toLowerCase().includes(s)));
  }
  if (stock === 'out')  rows = rows.filter((p) => p.totalAvailable === 0);
  if (stock === 'low')  rows = rows.filter((p) => p.totalAvailable > 0 && p.totalAvailable <= 5);
  if (stock === 'in')   rows = rows.filter((p) => p.totalAvailable > 5);

  return rows;
}

export async function getProductAdmin(id) {
  return run(supabase.from('products').select(ADMIN_PRODUCT_SELECT).eq('id', id).single());
}

const slugify = (s) => s.toLowerCase().trim()
  .replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

export async function createProduct(p) {
  const body = { ...p };
  if (!body.slug && body.name) body.slug = slugify(body.name);
  return run(supabase.from('products').insert(body).select().single());
}

export async function updateProduct(id, patch) {
  return run(supabase.from('products').update(patch).eq('id', id).select().single());
}

/** Hide/show. Goes through an RPC so it is permission-checked and audited. */
export async function setProductVisibility(id, isActive) {
  return rpc('admin_set_product_visibility', { p_product_id: id, p_is_active: !!isActive });
}

/** Copies details, variants and images into a hidden, zero-stock draft. */
export async function duplicateProduct(id) {
  return rpc('admin_duplicate_product', { p_product_id: id });
}

/**
 * Permanent delete. Blocked by a foreign key if the product appears on an
 * order — order_items keeps its own snapshot, but the FK is ON DELETE SET NULL,
 * so this succeeds and history stays intact. Prefer hiding.
 */
export async function deleteProduct(id) {
  await run(supabase.from('products').delete().eq('id', id));
  return true;
}

/* ---------------------------------------------------------------- variants */

export async function listVariants(productId) {
  return run(supabase.from('v_variant_availability').select('*')
    .eq('product_id', productId).order('color').order('size'));
}

/** Create or update a variant; refuses stock below what live orders reserve. */
export async function upsertVariant({
  productId, variantId = null, size, color, sku,
  stockQuantity, priceOverride = null, isActive = true,
} = {}) {
  return rpc('admin_upsert_variant', {
    p_product_id: productId,
    p_variant_id: variantId,
    p_size: size,
    p_color: color,
    p_sku: sku,
    p_stock_quantity: Number(stockQuantity) || 0,
    p_price_override: priceOverride === '' || priceOverride == null ? null : Number(priceOverride),
    p_is_active: !!isActive,
  });
}

/** Deactivate rather than delete, so historical orders keep their link. */
export async function setVariantActive(variantId, isActive) {
  return run(supabase.from('product_variants')
    .update({ is_active: !!isActive }).eq('id', variantId).select().single());
}

export async function deleteVariant(variantId) {
  await run(supabase.from('product_variants').delete().eq('id', variantId));
  return true;
}

export function stockStatus(available, lowThreshold = 5) {
  if (available <= 0) return { code: 'out', label: 'Out of Stock' };
  if (available <= lowThreshold) return { code: 'low', label: 'Low Stock' };
  return { code: 'in', label: 'In Stock' };
}

/* ------------------------------------------------------------------ images */

const ALLOWED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/webp', 'image/avif'];
const MAX_IMAGE_BYTES = 5 * 1024 * 1024;

export async function listProductImages(productId) {
  return run(supabase.from('product_images').select('*')
    .eq('product_id', productId).order('is_primary', { ascending: false }).order('sort_order'));
}

export async function deleteProductImage(imageId) {
  await run(supabase.from('product_images').delete().eq('id', imageId));
  return true;
}

export async function setPrimaryImage(imageId) {
  return run(supabase.from('product_images')
    .update({ is_primary: true }).eq('id', imageId).select().single());
}

/** Persist a new display order. */
export async function reorderProductImages(orderedIds = []) {
  await Promise.all(orderedIds.map((id, i) =>
    run(supabase.from('product_images').update({ sort_order: i }).eq('id', id))));
  return true;
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

/**
 * Upload a product photo and register it against the product.
 * Type and size are checked here for a fast error, and again by the bucket's
 * own allowed_mime_types / file_size_limit, which is the real enforcement.
 */
export async function uploadProductImage(productId, file, { altText, isPrimary = false } = {}) {
  if (!ALLOWED_IMAGE_TYPES.includes(file.type)) {
    throw new BJmeemError(
      'Please choose a JPG, PNG, WebP or AVIF image.', 'UNSUPPORTED_IMAGE_TYPE');
  }
  if (file.size > MAX_IMAGE_BYTES) {
    throw new BJmeemError('Images must be 5 MB or smaller.', 'IMAGE_TOO_LARGE');
  }

  const ext = ({ 'image/jpeg': 'jpg', 'image/png': 'png',
                 'image/webp': 'webp', 'image/avif': 'avif' })[file.type];
  const path = `${productId}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;

  await run(supabase.storage.from('product-images')
    .upload(path, file, { contentType: file.type, upsert: false }));

  const url = supabase.storage.from('product-images').getPublicUrl(path).data.publicUrl;

  const existing = await run(supabase.from('product_images')
    .select('id', { count: 'exact' }).eq('product_id', productId));

  return run(supabase.from('product_images').insert({
    product_id: productId, image_url: url, alt_text: altText ?? null,
    sort_order: existing.length,
    // The first image uploaded becomes the primary automatically.
    is_primary: isPrimary || existing.length === 0,
  }).select().single());
}

/* ----------------------------------------------------------------- delivery */

/** Orders grouped for the delivery board (§14). */
export async function getDeliveryBoard() {
  const rows = await run(supabase.from('orders').select(`
      id, order_number, order_status, customer_name, customer_phone,
      shipping_address, total_amount, payment_method, customer_notes,
      courier_name, courier_phone, tracking_reference, estimated_delivery_time,
      created_at, delivered_at
    `)
    .in('order_status', ['packed', 'out_for_delivery', 'delivered'])
    .order('created_at', { ascending: false })
    .limit(200));

  return {
    ready:     rows.filter((o) => o.order_status === 'packed'),
    out:       rows.filter((o) => o.order_status === 'out_for_delivery'),
    delivered: rows.filter((o) => o.order_status === 'delivered'),
  };
}

/* ----------------------------------------------------------------- realtime */

/**
 * Live order feed for the dashboard (§22). Fires on new orders and on status
 * changes. Realtime respects RLS, so only staff sessions receive these.
 * Returns an unsubscribe function.
 */
export function onOrderActivity({ onInsert, onUpdate } = {}) {
  const channel = supabase.channel('bjmeem-admin-orders')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'orders' },
        (p) => onInsert?.(p.new))
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'orders' },
        (p) => onUpdate?.(p.new, p.old))
    .subscribe();
  return () => supabase.removeChannel(channel);
}

/** Live stock changes, so the inventory screen stays honest while open. */
export function onStockChange(handler) {
  const channel = supabase.channel('bjmeem-admin-stock')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'product_variants' },
        (p) => handler(p.new))
    .subscribe();
  return () => supabase.removeChannel(channel);
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
