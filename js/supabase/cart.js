/**
 * BJmeem — server-persisted cart and wishlist.
 *
 * The cart holds quantities only. Prices, discounts and delivery are computed
 * by previewCart()/placeOrder() on the server, so nothing here can influence
 * what the customer is charged.
 */
import { supabase, run, rpc, currentUserId, BJmeemError } from './client.js';

const requireUser = async () => {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');
  return uid;
};

/** Ensures the customer has a cart row and returns its id. */
export async function getCartId() {
  await requireUser();
  return rpc('get_or_create_cart');
}

export async function getCart() {
  await requireUser();
  const rows = await run(supabase.from('cart_items').select(`
      id, quantity, created_at,
      variant:product_variants ( id, size, color, sku, price_override,
                                 stock_quantity, reserved_quantity, is_active ),
      product:products ( id, name, slug, price, is_active,
                         images:product_images ( image_url, is_primary, sort_order ) )
    `).order('created_at'));

  return rows.map((r) => {
    const imgs = [...(r.product?.images ?? [])].sort(
      (a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order));
    const unit = r.variant?.price_override ?? r.product?.price ?? 0;
    const available = Math.max(
      (r.variant?.stock_quantity ?? 0) - (r.variant?.reserved_quantity ?? 0), 0);
    return {
      id: r.id,
      quantity: r.quantity,
      variantId: r.variant?.id,
      productId: r.product?.id,
      name: r.product?.name,
      slug: r.product?.slug,
      size: r.variant?.size,
      color: r.variant?.color,
      image: imgs[0]?.image_url ?? null,
      unitPrice: Number(unit),
      lineTotal: Number((unit * r.quantity).toFixed(3)),
      available,
      // Surfaced so the UI can grey the line out rather than failing at checkout.
      unavailable: !r.variant?.is_active || !r.product?.is_active || available < r.quantity,
    };
  });
}

/**
 * Server-side quote. Use this for every total the customer sees — it runs the
 * same pricing code as checkout, so the numbers cannot disagree.
 */
export async function previewCart({ addressId = null, couponCode = null, rewardId = null } = {}) {
  await requireUser();
  return rpc('preview_cart', {
    p_address_id: addressId, p_coupon_code: couponCode, p_reward_id: rewardId,
  });
}

export async function addToCart(variantId, quantity = 1) {
  await requireUser();
  if (!variantId) throw new BJmeemError('Please choose a size and colour.', 'VARIANT_REQUIRED');
  if (!(quantity >= 1)) throw new BJmeemError('Quantity must be at least 1.', 'INVALID_QUANTITY');

  const cartId = await getCartId();

  const variant = await run(supabase.from('product_variants')
    .select('id, product_id, stock_quantity, reserved_quantity, is_active')
    .eq('id', variantId).single());

  const available = Math.max(variant.stock_quantity - variant.reserved_quantity, 0);
  if (!variant.is_active || available < 1) {
    throw new BJmeemError('That size and colour is out of stock.', 'OUT_OF_STOCK');
  }

  const existing = await run(supabase.from('cart_items').select('id, quantity')
    .eq('cart_id', cartId).eq('variant_id', variantId).maybeSingle());

  const wanted = Math.min((existing?.quantity ?? 0) + quantity, available, 20);
  if (existing && wanted === existing.quantity) {
    throw new BJmeemError(`Only ${available} left in stock.`, 'STOCK_LIMIT');
  }

  if (existing) {
    return run(supabase.from('cart_items').update({ quantity: wanted })
      .eq('id', existing.id).select().single());
  }
  return run(supabase.from('cart_items').insert({
    cart_id: cartId, product_id: variant.product_id, variant_id: variantId, quantity: wanted,
  }).select().single());
}

export async function updateCartItem(cartItemId, quantity) {
  await requireUser();
  if (quantity < 1) return removeFromCart(cartItemId);
  return run(supabase.from('cart_items')
    .update({ quantity: Math.min(quantity, 20) })
    .eq('id', cartItemId).select().single());
}

export async function removeFromCart(cartItemId) {
  await requireUser();
  await run(supabase.from('cart_items').delete().eq('id', cartItemId));
  return true;
}

export async function clearCart() {
  const cartId = await getCartId();
  await run(supabase.from('cart_items').delete().eq('cart_id', cartId));
  return true;
}

/**
 * Merge a guest cart (the localStorage one the storefront already keeps) into
 * the server cart after login, then hand back the merged cart.
 * @param {Array<{variantId:string, quantity:number}>} localItems
 */
export async function mergeLocalCart(localItems = []) {
  await requireUser();
  for (const item of localItems) {
    if (!item?.variantId) continue;
    try { await addToCart(item.variantId, item.quantity ?? 1); }
    catch { /* skip lines that are no longer purchasable */ }
  }
  return getCart();
}

/* ----------------------------------------------------------------- wishlist */

export async function getWishlist() {
  await requireUser();
  const rows = await run(supabase.from('wishlist_items').select(`
      id, created_at,
      product:products ( id, name, slug, price, compare_at_price, is_active,
                         rating_average, rating_count,
                         images:product_images ( image_url, is_primary, sort_order ) )
    `).order('created_at', { ascending: false }));

  return rows.filter((r) => r.product?.is_active).map((r) => {
    const imgs = [...(r.product.images ?? [])].sort(
      (a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order));
    return { wishlistId: r.id, ...r.product, primaryImage: imgs[0]?.image_url ?? null };
  });
}

/** Idempotent: a unique index makes a second add a no-op rather than an error. */
export async function addToWishlist(productId) {
  const uid = await requireUser();
  const { data, error } = await supabase.from('wishlist_items')
    .upsert({ user_id: uid, product_id: productId }, { onConflict: 'user_id,product_id' })
    .select().single();
  if (error) throw error;
  return data;
}

export async function removeFromWishlist(productId) {
  const uid = await requireUser();
  await run(supabase.from('wishlist_items').delete()
    .eq('user_id', uid).eq('product_id', productId));
  return true;
}

export async function toggleWishlist(productId) {
  const uid = await requireUser();
  const existing = await run(supabase.from('wishlist_items').select('id')
    .eq('user_id', uid).eq('product_id', productId).maybeSingle());
  if (existing) { await removeFromWishlist(productId); return { saved: false }; }
  await addToWishlist(productId);
  return { saved: true };
}

export async function isWishlisted(productId) {
  const uid = await currentUserId();
  if (!uid) return false;
  const row = await run(supabase.from('wishlist_items').select('id')
    .eq('user_id', uid).eq('product_id', productId).maybeSingle());
  return !!row;
}
