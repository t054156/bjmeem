/** BJmeem Admin — Products, product editor, images, Inventory. */
import * as api from '../js/supabase/admin.js';
import { getCategories } from '../js/supabase/catalog.js';
import {
  $, $$, esc, kwd, num, fmtDate, skeleton, emptyState, openForm, formData,
  confirmAction, ok, info, showError, stockTag, visToggle,
} from './ui.js';

const SIZES = ['XS', 'S', 'M', 'L', 'XL'];

/* ===================================================================
   PRODUCTS  (§3, §4, §17)
   =================================================================== */
const productFilters = { search: '', visibility: '', category: '', stock: '' };
let categoryCache = null;

async function categories() {
  if (!categoryCache) categoryCache = await getCategories().catch(() => []);
  return categoryCache;
}

export async function products(view, _param, ctx) {
  const cats = await categories();

  view.innerHTML = `
    <div class="toolbar">
      <input type="search" id="pSearch" placeholder="Product name or SKU…"
             value="${esc(productFilters.search)}" />
      <select id="pVis">
        <option value="">All products</option>
        <option value="visible" ${productFilters.visibility === 'visible' ? 'selected' : ''}>Visible only</option>
        <option value="hidden"  ${productFilters.visibility === 'hidden' ? 'selected' : ''}>Hidden only</option>
      </select>
      <select id="pCat">
        <option value="">All categories</option>
        ${cats.map((c) => `<option value="${esc(c.id)}" ${productFilters.category === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
      </select>
      <select id="pStock">
        <option value="">Any stock</option>
        <option value="in"  ${productFilters.stock === 'in' ? 'selected' : ''}>In stock</option>
        <option value="low" ${productFilters.stock === 'low' ? 'selected' : ''}>Low stock</option>
        <option value="out" ${productFilters.stock === 'out' ? 'selected' : ''}>Out of stock</option>
      </select>
      <span class="spacer"></span>
      <span class="count-note" id="pCount"></span>
      <button class="btn btn-primary btn-sm" id="pAdd">+ Add product</button>
    </div>
    <div class="panel"><div class="panel-body flush" id="pList">${skeleton(6)}</div></div>`;

  const load = async () => {
    const list = $('#pList');
    list.innerHTML = skeleton(6);
    const rows = await api.listProducts({
      search: productFilters.search || null,
      visibility: productFilters.visibility || null,
      category: productFilters.category || null,
      stock: productFilters.stock || null,
    });
    $('#pCount').textContent = `${rows.length} product${rows.length === 1 ? '' : 's'}`;

    list.innerHTML = rows.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Product</th><th class="num">Price</th><th>Stock</th>
          <th>Flags</th><th>Visibility</th><th></th>
        </tr></thead>
        <tbody>${rows.map((p) => `
          <tr>
            <td><div class="cell-product">
              ${p.primaryImage
                ? `<img class="thumb" src="${esc(p.primaryImage)}" alt="">`
                : '<span class="thumb" style="display:grid;place-items:center">🧸</span>'}
              <span>
                <b>${esc(p.name)}</b>
                <small>${esc(p.category?.name ?? 'Uncategorised')} · ${p.variants.length} variant${p.variants.length === 1 ? '' : 's'}</small>
              </span>
            </div></td>
            <td class="num">
              ${esc(kwd(p.price))}
              ${p.compare_at_price ? `<br><small style="color:var(--muted);text-decoration:line-through">${esc(kwd(p.compare_at_price))}</small>` : ''}
            </td>
            <td>${stockTag(p.totalAvailable, ctx.lowStock)}
              <small style="color:var(--muted);display:block">${num(p.totalAvailable)} available</small></td>
            <td>${[
              p.is_new_arrival ? '<span class="tag info">New</span>' : '',
              p.is_best_seller ? '<span class="tag pink">Best</span>' : '',
              p.is_featured ? '<span class="tag grey">Featured</span>' : '',
            ].filter(Boolean).join(' ') || '<span style="color:var(--muted)">—</span>'}</td>
            <td>${visToggle(p.is_active, p.id)}</td>
            <td><div class="row-actions">
              <a class="btn btn-ghost btn-sm" href="#/product/${esc(p.id)}">Edit</a>
              <button class="btn btn-ghost btn-sm" data-dup="${esc(p.id)}">Duplicate</button>
              <button class="btn btn-ghost btn-sm" data-del="${esc(p.id)}"
                      data-name="${esc(p.name)}">Delete</button>
            </div></td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState('No products match', 'Adjust the filters, or add your first product.');

    list.querySelectorAll('[data-dup]').forEach((b) => b.addEventListener('click', async () => {
      try {
        const r = await api.duplicateProduct(b.dataset.dup);
        ok('Duplicated as a hidden draft with zero stock.', 'Product duplicated');
        location.hash = `#/product/${r.product_id}`;
      } catch (e) { showError(e); }
    }));

    list.querySelectorAll('[data-del]').forEach((b) => b.addEventListener('click', async () => {
      const yes = await confirmAction({
        title: 'Are you sure you want to delete this product?',
        body: `“${b.dataset.name}” and all its variants and images will be permanently removed. ` +
              'Past orders keep their own copy of the details. If you only want it off the ' +
              'store, hide it instead.',
        confirm: 'Delete permanently',
      });
      if (!yes) return;
      try {
        await api.deleteProduct(b.dataset.del);
        ok('Product deleted.');
        load();
      } catch (e) { showError(e); }
    }));
  };

  let t;
  $('#pSearch').addEventListener('input', (e) => {
    productFilters.search = e.target.value;
    clearTimeout(t); t = setTimeout(load, 250);
  });
  for (const [id, key] of [['pVis', 'visibility'], ['pCat', 'category'], ['pStock', 'stock']]) {
    $('#' + id).addEventListener('change', (e) => { productFilters[key] = e.target.value; load(); });
  }
  $('#pAdd').addEventListener('click', () => productDialog(null, ctx));

  await load();
}

/** Create / edit the product record itself. Variants and images have their own screens. */
async function productDialog(product, ctx) {
  const cats = await categories();
  const p = product ?? {};

  openForm({
    title: product ? 'Edit product' : 'Add product',
    submit: product ? 'Save changes' : 'Create product',
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field full"><span>Product name *</span>
          <input name="name" required value="${esc(p.name ?? '')}" placeholder="Teddy Cloud Cotton Set" /></label>
        <label class="field full"><span>Description</span>
          <textarea name="description" placeholder="Soft cotton pajama set with tiny teddy bear print.">${esc(p.description ?? '')}</textarea></label>

        <label class="field"><span>Category</span>
          <select name="category_id">
            <option value="">— none —</option>
            ${cats.map((c) => `<option value="${esc(c.id)}" ${p.category_id === c.id ? 'selected' : ''}>${esc(c.name)}</option>`).join('')}
          </select></label>
        <label class="field"><span>Pattern</span>
          <input name="pattern" value="${esc(p.pattern ?? '')}" placeholder="teddy, heart, bow…" /></label>

        <label class="field"><span>Price (KWD) *</span>
          <input name="price" type="number" step="0.001" min="0" required value="${esc(p.price ?? '')}" /></label>
        <label class="field"><span>Compare-at price (old price)</span>
          <input name="compare_at_price" type="number" step="0.001" min="0" value="${esc(p.compare_at_price ?? '')}" /></label>

        <label class="field"><span>Material</span>
          <input name="material" value="${esc(p.material ?? '')}" placeholder="100% cotton" /></label>
        <label class="field"><span>Fabric</span>
          <input name="fabric" value="${esc(p.fabric ?? '')}" placeholder="100% breathable cotton" /></label>

        <label class="field full"><span>Care instructions</span>
          <input name="care_instructions" value="${esc(p.care_instructions ?? '')}"
                 placeholder="Machine wash cold on a gentle cycle." /></label>
      </div>

      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:14px">
        <label class="field inline"><input type="checkbox" name="is_new_arrival" ${p.is_new_arrival ? 'checked' : ''}><span>New Arrival</span></label>
        <label class="field inline"><input type="checkbox" name="is_best_seller" ${p.is_best_seller ? 'checked' : ''}><span>Best Seller</span></label>
        <label class="field inline"><input type="checkbox" name="is_featured" ${p.is_featured ? 'checked' : ''}><span>Featured</span></label>
        <label class="field inline"><input type="checkbox" name="is_active" ${product ? (p.is_active ? 'checked' : '') : 'checked'}><span>Visible on the store</span></label>
      </div>
      ${product ? '' : `<p style="margin-top:14px;font-size:.83rem;color:var(--muted)">
        After creating the product you will be taken to its page to add images,
        sizes, colours and stock.</p>`}`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.name) throw new Error('Please enter a product name.');
      if (d.price == null || d.price < 0) throw new Error('Please enter a valid price.');
      if (d.compare_at_price != null && d.compare_at_price !== '' &&
          Number(d.compare_at_price) < Number(d.price)) {
        throw new Error('Compare-at price must be higher than the price.');
      }

      const body = {
        name: d.name, description: d.description || null,
        category_id: d.category_id || null, pattern: d.pattern || null,
        price: d.price, compare_at_price: d.compare_at_price ?? null,
        material: d.material || null, fabric: d.fabric || null,
        care_instructions: d.care_instructions || null,
        is_new_arrival: d.is_new_arrival, is_best_seller: d.is_best_seller,
        is_featured: d.is_featured, is_active: d.is_active,
      };

      if (product) {
        await api.updateProduct(product.id, body);
        ok('Product updated.');
        ctx.refresh();
      } else {
        const created = await api.createProduct(body);
        ok('Product created. Now add images and stock.', 'Saved');
        location.hash = `#/product/${created.id}`;
      }
    },
  });
}

/* ===================================================================
   PRODUCT DETAIL — variants + images  (§3, §5, §15)
   =================================================================== */
export async function productDetail(view, productId, ctx) {
  view.innerHTML = skeleton(6);
  const p = await api.getProductAdmin(productId);
  const variants = await api.listVariants(productId);
  const images = await api.listProductImages(productId);

  view.innerHTML = `
    <div class="section-head">
      <a class="btn btn-ghost btn-sm" href="#/products">← Products</a>
      <h2>${esc(p.name)}</h2>
      ${visToggle(p.is_active, p.id)}
      <span class="spacer"></span>
      <button class="btn btn-ghost btn-sm" id="editProduct">Edit details</button>
      <button class="btn btn-primary btn-sm" id="addVariant">+ Add variant</button>
    </div>

    <div class="split">
      <div>
        <div class="panel" style="margin-top:0">
          <div class="panel-head">
            <h2>Stock by size &amp; colour</h2>
            <span class="spacer"></span>
            <span class="count-note">Available = Stock − Reserved</span>
          </div>
          <div class="panel-body flush">
            ${variants.length ? `
            <div class="table-wrap"><table class="data">
              <thead><tr>
                <th>Colour</th><th>Size</th><th>SKU</th>
                <th class="num">Stock</th><th class="num">Reserved</th><th class="num">Available</th>
                <th>Status</th><th></th>
              </tr></thead>
              <tbody>${variants.map((v) => `
                <tr>
                  <td>${esc(v.color)}</td>
                  <td><b>${esc(v.size)}</b></td>
                  <td><small style="color:var(--muted)">${esc(v.sku)}</small></td>
                  <td class="num">${num(v.stock_quantity)}</td>
                  <td class="num">${num(v.reserved_quantity)}</td>
                  <td class="num"><b>${num(v.available_quantity)}</b></td>
                  <td>${v.is_active ? stockTag(v.available_quantity, ctx.lowStock)
                                    : '<span class="tag grey">Inactive</span>'}</td>
                  <td><div class="row-actions">
                    <button class="btn btn-ghost btn-sm" data-vedit="${esc(v.variant_id)}">Edit</button>
                    <button class="btn btn-ghost btn-sm" data-vtoggle="${esc(v.variant_id)}"
                            data-active="${v.is_active}">${v.is_active ? 'Deactivate' : 'Activate'}</button>
                  </div></td>
                </tr>`).join('')}</tbody>
            </table></div>`
            : emptyState('No variants yet',
                'Add a size and colour with its stock so customers can order this product.')}
          </div>
        </div>
      </div>

      <div>
        <div class="panel" style="margin-top:0">
          <div class="panel-head"><h2>Images</h2>
            <span class="spacer"></span>
            <span class="count-note">${images.length} image${images.length === 1 ? '' : 's'}</span>
          </div>
          <div class="panel-body">
            <div class="dropzone" id="dropzone">
              Click or drop images here<br>
              <small>JPG, PNG, WebP or AVIF · up to 5 MB each</small>
            </div>
            <input type="file" id="imgInput" accept="image/jpeg,image/png,image/webp,image/avif"
                   multiple hidden />
            <div class="img-grid" id="imgGrid" style="margin-top:14px">
              ${images.map((im, i) => `
                <div class="img-card ${im.is_primary ? 'primary' : ''}">
                  ${im.is_primary ? '<span class="img-badge">Primary</span>' : ''}
                  <img src="${esc(im.image_url)}" alt="${esc(im.alt_text ?? '')}" loading="lazy">
                  <div class="img-tools">
                    ${im.is_primary ? '' : `<button data-primary="${esc(im.id)}">Make primary</button>`}
                    ${i > 0 ? `<button data-move="${esc(im.id)}" data-dir="-1">←</button>` : ''}
                    ${i < images.length - 1 ? `<button data-move="${esc(im.id)}" data-dir="1">→</button>` : ''}
                    <button data-imgdel="${esc(im.id)}">Delete</button>
                  </div>
                </div>`).join('') || '<p style="color:var(--muted);font-size:.86rem">No images yet.</p>'}
            </div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Details</h2></div>
          <div class="panel-body">
            <dl class="kv">
              <dt>Price</dt><dd>${esc(kwd(p.price))}</dd>
              ${p.compare_at_price ? `<dt>Compare at</dt><dd>${esc(kwd(p.compare_at_price))}</dd>` : ''}
              <dt>Category</dt><dd>${esc(p.category?.name ?? '—')}</dd>
              <dt>Material</dt><dd>${esc(p.material ?? '—')}</dd>
              <dt>Fabric</dt><dd>${esc(p.fabric ?? '—')}</dd>
              <dt>Slug</dt><dd>${esc(p.slug)}</dd>
              <dt>Created</dt><dd>${esc(fmtDate(p.created_at))}</dd>
            </dl>
          </div>
        </div>
      </div>
    </div>`;

  $('#editProduct').addEventListener('click', () => productDialog(p, ctx));
  $('#addVariant').addEventListener('click', () => variantDialog(p, null, ctx));

  view.querySelectorAll('[data-vedit]').forEach((b) => b.addEventListener('click', () => {
    variantDialog(p, variants.find((v) => v.variant_id === b.dataset.vedit), ctx);
  }));

  view.querySelectorAll('[data-vtoggle]').forEach((b) => b.addEventListener('click', async () => {
    const active = b.dataset.active === 'true';
    try {
      await api.setVariantActive(b.dataset.vtoggle, !active);
      ok(active ? 'Variant deactivated.' : 'Variant activated.');
      ctx.refresh();
    } catch (e) { showError(e); }
  }));

  wireImages(view, productId, images, ctx);
}

function variantDialog(product, variant, ctx) {
  const v = variant ?? {};
  openForm({
    title: variant ? `Edit ${v.color} / ${v.size}` : 'Add variant',
    submit: variant ? 'Update stock' : 'Add variant',
    body: `
      <div class="form-grid">
        <label class="field"><span>Size *</span>
          <input name="size" list="sizeList" required value="${esc(v.size ?? '')}" placeholder="M" />
          <datalist id="sizeList">${SIZES.map((s) => `<option value="${s}">`).join('')}</datalist>
        </label>
        <label class="field"><span>Colour *</span>
          <input name="color" required value="${esc(v.color ?? '')}" placeholder="Pink" /></label>
        <label class="field"><span>SKU *</span>
          <input name="sku" required value="${esc(v.sku ?? '')}" placeholder="BJM-TEDDY-PNK-M" /></label>
        <label class="field"><span>Stock quantity *</span>
          <input name="stock" type="number" min="0" step="1" required
                 value="${esc(v.stock_quantity ?? 0)}" /></label>
        <label class="field"><span>Price override (optional)</span>
          <input name="price" type="number" min="0" step="0.001"
                 value="${esc(v.price_override ?? '')}" placeholder="uses product price" /></label>
        <label class="field inline" style="align-self:end">
          <input type="checkbox" name="active" ${variant ? (v.is_active ? 'checked' : '') : 'checked'}>
          <span>Active</span></label>
      </div>
      ${variant ? `<p style="margin-top:12px;font-size:.83rem;color:var(--muted)">
        ${num(v.reserved_quantity)} unit(s) are reserved by live orders. Stock cannot be set
        below that.</p>` : ''}`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.size || !d.color || !d.sku) throw new Error('Size, colour and SKU are required.');
      if (d.stock == null || d.stock < 0) throw new Error('Stock cannot be negative.');

      await api.upsertVariant({
        productId: product.id,
        variantId: variant ? v.variant_id : null,
        size: d.size, color: d.color, sku: d.sku,
        stockQuantity: d.stock, priceOverride: d.price, isActive: d.active,
      });
      ok('Stock updated.');
      ctx.refresh();
    },
  });
}

function wireImages(view, productId, images, ctx) {
  const input = $('#imgInput');
  const zone = $('#dropzone');

  const upload = async (files) => {
    const list = [...files].filter(Boolean);
    if (!list.length) return;
    info(`Uploading ${list.length} image${list.length === 1 ? '' : 's'}…`);
    try {
      for (const f of list) await api.uploadProductImage(productId, f);
      ok('Images uploaded.');
      ctx.refresh();
    } catch (e) { showError(e); }
  };

  zone.addEventListener('click', () => input.click());
  input.addEventListener('change', () => upload(input.files));
  ['dragenter', 'dragover'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.add('over');
  }));
  ['dragleave', 'drop'].forEach((ev) => zone.addEventListener(ev, (e) => {
    e.preventDefault(); zone.classList.remove('over');
  }));
  zone.addEventListener('drop', (e) => upload(e.dataTransfer?.files ?? []));

  view.querySelectorAll('[data-primary]').forEach((b) => b.addEventListener('click', async () => {
    try { await api.setPrimaryImage(b.dataset.primary); ok('Primary image updated.'); ctx.refresh(); }
    catch (e) { showError(e); }
  }));

  view.querySelectorAll('[data-imgdel]').forEach((b) => b.addEventListener('click', async () => {
    const yes = await confirmAction({
      title: 'Delete this image?', body: 'It will be removed from the product gallery.',
      confirm: 'Delete image',
    });
    if (!yes) return;
    try { await api.deleteProductImage(b.dataset.imgdel); ok('Image deleted.'); ctx.refresh(); }
    catch (e) { showError(e); }
  }));

  view.querySelectorAll('[data-move]').forEach((b) => b.addEventListener('click', async () => {
    const ids = images.map((i) => i.id);
    const from = ids.indexOf(b.dataset.move);
    const to = from + Number(b.dataset.dir);
    if (to < 0 || to >= ids.length) return;
    ids.splice(to, 0, ids.splice(from, 1)[0]);
    try { await api.reorderProductImages(ids); ok('Image order saved.'); ctx.refresh(); }
    catch (e) { showError(e); }
  }));
}

/* ===================================================================
   INVENTORY  (§5, §6)
   =================================================================== */
const invFilters = { search: '', status: '' };

export async function inventory(view, _param, ctx) {
  view.innerHTML = `
    <div class="toolbar">
      <input type="search" id="iSearch" placeholder="Product or SKU…" value="${esc(invFilters.search)}" />
      <select id="iStatus">
        <option value="">All stock levels</option>
        <option value="out" ${invFilters.status === 'out' ? 'selected' : ''}>Out of stock</option>
        <option value="low" ${invFilters.status === 'low' ? 'selected' : ''}>Low stock</option>
        <option value="in"  ${invFilters.status === 'in' ? 'selected' : ''}>In stock</option>
      </select>
      <span class="spacer"></span>
      <span class="count-note" id="iCount"></span>
    </div>
    <div class="panel"><div class="panel-body flush" id="iList">${skeleton(8)}</div></div>`;

  const load = async () => {
    const list = $('#iList');
    list.innerHTML = skeleton(8);

    const prods = await api.listProducts({ search: invFilters.search || null, limit: 200 });
    let rows = [];
    for (const p of prods) {
      for (const v of p.variants) {
        rows.push({ product: p, ...v });
      }
    }
    if (invFilters.status === 'out') rows = rows.filter((r) => r.available <= 0);
    if (invFilters.status === 'low') rows = rows.filter((r) => r.available > 0 && r.available <= ctx.lowStock);
    if (invFilters.status === 'in')  rows = rows.filter((r) => r.available > ctx.lowStock);
    if (invFilters.search) {
      const s = invFilters.search.toLowerCase();
      rows = rows.filter((r) => r.product.name.toLowerCase().includes(s) ||
                                (r.sku ?? '').toLowerCase().includes(s));
    }
    rows.sort((a, b) => a.available - b.available);

    $('#iCount').textContent = `${rows.length} variant${rows.length === 1 ? '' : 's'}`;
    list.innerHTML = rows.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Product</th><th>Colour / Size</th><th>SKU</th>
          <th class="num">Stock</th><th class="num">Reserved</th><th class="num">Available</th>
          <th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><div class="cell-product">
              ${r.product.primaryImage
                ? `<img class="thumb" src="${esc(r.product.primaryImage)}" alt="">`
                : '<span class="thumb" style="display:grid;place-items:center">🧸</span>'}
              <span><b>${esc(r.product.name)}</b>
                <small>${r.product.is_active ? 'Visible' : 'Hidden'}</small></span>
            </div></td>
            <td>${esc(r.color)} / <b>${esc(r.size)}</b></td>
            <td><small style="color:var(--muted)">${esc(r.sku)}</small></td>
            <td class="num">${num(r.stock_quantity)}</td>
            <td class="num">${num(r.reserved_quantity)}</td>
            <td class="num"><b>${num(r.available)}</b></td>
            <td>${r.is_active ? stockTag(r.available, ctx.lowStock)
                              : '<span class="tag grey">Inactive</span>'}</td>
            <td class="num">
              <button class="btn btn-ghost btn-sm" data-restock="${esc(r.id)}"
                data-name="${esc(r.product.name)}" data-size="${esc(r.size)}"
                data-color="${esc(r.color)}" data-sku="${esc(r.sku)}"
                data-stock="${r.stock_quantity}" data-reserved="${r.reserved_quantity}"
                data-product="${esc(r.product.id)}">Update stock</button>
            </td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState('Nothing to show', 'No variants match this filter.', '📦');

    list.querySelectorAll('[data-restock]').forEach((b) => b.addEventListener('click', () => {
      restockDialog(b.dataset, ctx);
    }));
  };

  let t;
  $('#iSearch').addEventListener('input', (e) => {
    invFilters.search = e.target.value;
    clearTimeout(t); t = setTimeout(load, 250);
  });
  $('#iStatus').addEventListener('change', (e) => { invFilters.status = e.target.value; load(); });

  await load();
}

function restockDialog(d, ctx) {
  openForm({
    title: `${d.name} — ${d.color} / ${d.size}`,
    submit: 'Update stock',
    body: `
      <label class="field"><span>Stock quantity</span>
        <input name="stock" type="number" min="${d.reserved}" step="1" required value="${esc(d.stock)}" />
      </label>
      <p style="margin-top:10px;font-size:.84rem;color:var(--muted)">
        SKU ${esc(d.sku)} · ${esc(d.reserved)} reserved by live orders.
        Available becomes stock − reserved.</p>`,
    onSubmit: async (form) => {
      const { stock } = formData(form);
      await api.upsertVariant({
        productId: d.product, variantId: d.restock,
        size: d.size, color: d.color, sku: d.sku,
        stockQuantity: stock, isActive: true,
      });
      ok('Stock updated.');
      ctx.refresh();
    },
  });
}
