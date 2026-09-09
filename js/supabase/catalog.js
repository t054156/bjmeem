/** BJmeem — catalogue reads and product reviews. */
import { supabase, run, currentUserId, BJmeemError } from './client.js';

const SELECT = `
  id, name, slug, description, price, compare_at_price, material, fabric, pattern,
  care_instructions, is_new_arrival, is_best_seller, is_featured,
  rating_average, rating_count, created_at,
  category:categories ( id, name, slug ),
  images:product_images ( id, image_url, alt_text, sort_order, is_primary ),
  variants:product_variants ( id, size, color, sku, stock_quantity, reserved_quantity,
                              price_override, is_active )
`;

/** Shape a row for the storefront: available stock, colour/size lists, images. */
function decorate(p) {
  if (!p) return null;
  const variants = (p.variants ?? []).filter((v) => v.is_active).map((v) => ({
    ...v,
    available: Math.max((v.stock_quantity ?? 0) - (v.reserved_quantity ?? 0), 0),
    price: v.price_override ?? p.price,
  }));
  const images = [...(p.images ?? [])].sort(
    (a, b) => (b.is_primary - a.is_primary) || (a.sort_order - b.sort_order));

  return {
    ...p,
    variants,
    images,
    primaryImage: images[0]?.image_url ?? null,
    secondaryImage: images[1]?.image_url ?? null,
    colors: [...new Set(variants.map((v) => v.color))],
    sizes:  [...new Set(variants.map((v) => v.size))],
    inStock: variants.some((v) => v.available > 0),
    onSale: p.compare_at_price != null && Number(p.compare_at_price) > Number(p.price),
  };
}

export async function getCategories() {
  return run(supabase.from('categories').select('*')
    .eq('is_active', true).order('sort_order'));
}

/**
 * @param {{category,search,sizes,colors,patterns,maxPrice,minPrice,sort,limit,offset}} f
 * `sort`: 'newest' | 'best' | 'price_asc' | 'price_desc' | 'rating'
 */
export async function getProducts(f = {}) {
  let q = supabase.from('products').select(SELECT).eq('is_active', true);

  if (f.category) {
    if (f.category === 'new-arrivals')      q = q.eq('is_new_arrival', true);
    else if (f.category === 'best-sellers') q = q.eq('is_best_seller', true);
    else q = q.eq('categories.slug', f.category);
  }
  if (f.search) {
    const s = `%${f.search.replace(/[%_]/g, '')}%`;
    q = q.or(`name.ilike.${s},description.ilike.${s},pattern.ilike.${s}`);
  }
  if (Array.isArray(f.patterns) && f.patterns.length) q = q.in('pattern', f.patterns);
  if (f.minPrice != null) q = q.gte('price', f.minPrice);
  if (f.maxPrice != null) q = q.lte('price', f.maxPrice);

  switch (f.sort) {
    case 'price_asc':  q = q.order('price', { ascending: true }); break;
    case 'price_desc': q = q.order('price', { ascending: false }); break;
    case 'best':       q = q.order('is_best_seller', { ascending: false })
                            .order('rating_count', { ascending: false }); break;
    case 'rating':     q = q.order('rating_average', { ascending: false }); break;
    default:           q = q.order('created_at', { ascending: false });
  }

  const limit = f.limit ?? 48;
  const offset = f.offset ?? 0;
  q = q.range(offset, offset + limit - 1);

  let rows = (await run(q)).map(decorate);

  // Size and colour live on variants, so filter after shaping rather than
  // forcing an inner join that would drop a product's other variants.
  if (Array.isArray(f.sizes) && f.sizes.length) {
    rows = rows.filter((p) => p.sizes.some((s) => f.sizes.includes(s)));
  }
  if (Array.isArray(f.colors) && f.colors.length) {
    const want = f.colors.map((c) => c.toLowerCase());
    rows = rows.filter((p) => p.colors.some((c) => want.includes(c.toLowerCase())));
  }
  return rows;
}

export async function getProduct(slugOrId) {
  const isUuid = /^[0-9a-f-]{36}$/i.test(slugOrId);
  const row = await run(supabase.from('products').select(SELECT)
    .eq(isUuid ? 'id' : 'slug', slugOrId).eq('is_active', true).maybeSingle());
  if (!row) throw new BJmeemError('We could not find that product.', 'PRODUCT_NOT_FOUND');
  return decorate(row);
}

export async function getFeaturedProducts(kind = 'best-sellers', limit = 8) {
  return getProducts({ category: kind, limit, sort: kind === 'new-arrivals' ? 'newest' : 'best' });
}

export async function getRelatedProducts(product, limit = 4) {
  const rows = await run(supabase.from('products').select(SELECT)
    .eq('is_active', true).neq('id', product.id)
    .or(`pattern.eq.${product.pattern},category_id.eq.${product.category?.id ?? product.category_id}`)
    .limit(limit));
  return rows.map(decorate);
}

/** Live availability for one variant, used before adding to the bag. */
export async function getVariantAvailability(variantId) {
  return run(supabase.from('v_variant_availability').select('*')
    .eq('variant_id', variantId).single());
}

/* ------------------------------------------------------------------ reviews */

export async function getProductReviews(productId, limit = 20) {
  return run(supabase.from('product_reviews')
    .select('id, rating, title, review_text, is_verified_purchase, created_at, user_id')
    .eq('product_id', productId).eq('status', 'approved')
    .order('created_at', { ascending: false }).limit(limit));
}

/**
 * Verified-purchase status and moderation state are decided by a trigger, so
 * they cannot be forged from here.
 */
export async function submitReview({ productId, rating, title, text } = {}) {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to leave a review.', 'AUTH_REQUIRED');
  if (!(rating >= 1 && rating <= 5)) {
    throw new BJmeemError('Please choose a rating from 1 to 5.', 'INVALID_RATING');
  }
  return run(supabase.from('product_reviews').insert({
    user_id: uid, product_id: productId, rating,
    title: title ?? null, review_text: text ?? null,
  }).select().single());
}
