/** BJmeem Admin — Dashboard, Orders, Order detail, Delivery. */
import * as api from '../js/supabase/admin.js';
import { getOrderDetails } from '../js/supabase/orders.js';
import {
  $, $$, esc, kwd, num, fmtDate, timeAgo, skeleton, emptyState, openForm, formData,
  confirmAction, ok, showError, statusTag, payTag, stockTag,
  ORDER_FLOW, ORDER_STATUSES, STATUS_LABEL,
} from './ui.js';

/* ===================================================================
   DASHBOARD  (§2)
   =================================================================== */
export async function dashboard(view, _param, ctx) {
  view.innerHTML = skeleton(4);
  const o = await api.getOverview();
  const c = o.open_counts ?? {};

  view.innerHTML = `
    <div class="stat-grid">
      ${stat('Orders Today', num(o.orders_today), 'accent')}
      ${stat("Today's Revenue", kwd(o.revenue_today), 'good')}
      ${stat('Monthly Revenue', kwd(o.revenue_month), 'good')}
      ${stat('Pending', num(c.pending), c.pending ? 'warn' : '')}
      ${stat('Preparing', num(c.preparing))}
      ${stat('Out for Delivery', num(c.out_for_delivery))}
      ${stat('Delivered', num(c.delivered), 'good')}
      ${stat('Cancelled', num(c.cancelled), c.cancelled ? 'bad' : '')}
      ${stat('Total Customers', num(o.total_customers))}
      ${stat('Total Products', num(o.total_products))}
      ${stat('Low Stock', num(o.low_stock_count), o.low_stock_count ? 'warn' : '')}
      ${stat('Out of Stock', num(o.out_of_stock_count), o.out_of_stock_count ? 'bad' : '')}
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Recent orders</h2>
        <span class="spacer"></span>
        <a class="btn btn-ghost btn-sm" href="#/orders">All orders</a>
      </div>
      <div class="panel-body flush">
        ${(o.recent_orders ?? []).length ? `
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Order</th><th>Customer</th><th class="num">Total</th>
            <th>Status</th><th>Placed</th><th></th>
          </tr></thead>
          <tbody>${o.recent_orders.map((r) => `
            <tr>
              <td><b>${esc(r.order_number)}</b></td>
              <td>${esc(r.customer_name)}</td>
              <td class="num">${esc(kwd(r.total_amount))}</td>
              <td>${statusTag(r.order_status)}</td>
              <td><span title="${esc(fmtDate(r.created_at, true))}">${esc(timeAgo(r.created_at))}</span></td>
              <td class="num"><a class="btn btn-ghost btn-sm" href="#/order/${esc(r.id)}">Open</a></td>
            </tr>`).join('')}</tbody>
        </table></div>` : emptyState('No orders yet', 'New orders will appear here the moment they are placed.')}
      </div>
    </div>

    <div class="panel">
      <div class="panel-head">
        <h2>Low stock alerts</h2>
        <span class="tag grey">threshold ${num(o.low_stock_threshold)}</span>
        <span class="spacer"></span>
        <a class="btn btn-ghost btn-sm" href="#/inventory">Manage inventory</a>
      </div>
      <div class="panel-body">
        ${(o.low_stock_alerts ?? []).length ? `
          <div class="bars">${o.low_stock_alerts.map((a) => `
            <div class="bar-row">
              <span class="lbl" title="${esc(a.label)}">${esc(a.product_name)}</span>
              <span class="lbl">${esc(a.color)} / ${esc(a.size)}</span>
              <span>${stockTag(a.available, o.low_stock_threshold)}</span>
            </div>`).join('')}</div>`
          : emptyState('Everything is well stocked', 'No variant is at or below the threshold.', '☁️')}
      </div>
    </div>`;
}

const stat = (label, value, tone = '') =>
  `<div class="stat ${tone}"><b>${esc(value)}</b><span>${esc(label)}</span></div>`;

/* ===================================================================
   ORDERS  (§8, §17)
   =================================================================== */
const orderFilters = { search: '', status: '', payment: '', from: '', to: '' };

export async function orders(view) {
  view.innerHTML = `
    <div class="toolbar">
      <input type="search" id="oSearch" placeholder="Order number, customer or phone…"
             value="${esc(orderFilters.search)}" />
      <select id="oStatus">
        <option value="">All statuses</option>
        ${ORDER_STATUSES.map((s) => `<option value="${s}" ${orderFilters.status === s ? 'selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}
      </select>
      <select id="oPay">
        <option value="">Any payment</option>
        ${['unpaid', 'paid', 'refunded', 'failed'].map((s) => `<option value="${s}" ${orderFilters.payment === s ? 'selected' : ''}>${esc(s)}</option>`).join('')}
      </select>
      <input type="date" id="oFrom" value="${esc(orderFilters.from)}" title="From" />
      <input type="date" id="oTo" value="${esc(orderFilters.to)}" title="To" />
      <button class="btn btn-ghost btn-sm" id="oClear">Clear</button>
      <span class="spacer"></span>
      <span class="count-note" id="oCount"></span>
    </div>
    <div class="panel"><div class="panel-body flush" id="oList">${skeleton(6)}</div></div>`;

  const load = async () => {
    const list = $('#oList');
    list.innerHTML = skeleton(6);
    let rows = await api.listOrders({
      search: orderFilters.search || null,
      status: orderFilters.status || null,
      from: orderFilters.from ? new Date(orderFilters.from).toISOString() : null,
      to: orderFilters.to ? new Date(orderFilters.to + 'T23:59:59').toISOString() : null,
      limit: 200,
    });
    if (orderFilters.payment) rows = rows.filter((r) => r.payment_status === orderFilters.payment);

    $('#oCount').textContent = `${rows.length} order${rows.length === 1 ? '' : 's'}`;
    list.innerHTML = rows.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Order</th><th>Customer</th><th>Items</th><th class="num">Total</th>
          <th>Payment</th><th>Status</th><th>Date</th><th></th>
        </tr></thead>
        <tbody>${rows.map((r) => `
          <tr>
            <td><b>${esc(r.order_number)}</b></td>
            <td>
              <div><b>${esc(r.customer_name)}</b></div>
              <small style="color:var(--muted)">${esc(r.customer_phone ?? '')}</small>
            </td>
            <td>${num((r.items ?? []).reduce((s, i) => s + i.quantity, 0))}</td>
            <td class="num">${esc(kwd(r.total_amount))}</td>
            <td>${payTag(r.payment_status)}</td>
            <td>${statusTag(r.order_status)}</td>
            <td><span title="${esc(fmtDate(r.created_at, true))}">${esc(fmtDate(r.created_at))}</span></td>
            <td class="num"><a class="btn btn-ghost btn-sm" href="#/order/${esc(r.id)}">Open</a></td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState('No matching orders', 'Try a different search or clear the filters.');
  };

  let t;
  $('#oSearch').addEventListener('input', (e) => {
    orderFilters.search = e.target.value;
    clearTimeout(t); t = setTimeout(load, 250);
  });
  for (const [id, key] of [['oStatus', 'status'], ['oPay', 'payment'],
                           ['oFrom', 'from'], ['oTo', 'to']]) {
    $('#' + id).addEventListener('change', (e) => { orderFilters[key] = e.target.value; load(); });
  }
  $('#oClear').addEventListener('click', () => {
    Object.keys(orderFilters).forEach((k) => { orderFilters[k] = ''; });
    orders(view);
  });

  await load();
}

/* ===================================================================
   ORDER DETAIL  (§8, §9)
   =================================================================== */
export async function orderDetail(view, orderId, ctx) {
  view.innerHTML = skeleton(6);
  const o = await getOrderDetails(orderId);
  const notes = ctx.me.can.orders ? await api.getOrderNotes(orderId).catch(() => []) : [];
  const a = o.shipping_address ?? {};

  const mapLink = (a.latitude && a.longitude)
    ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener"
          href="https://www.google.com/maps?q=${a.latitude},${a.longitude}">Open map location ↗</a>`
    : '';

  view.innerHTML = `
    <div class="section-head">
      <a class="btn btn-ghost btn-sm" href="#/orders">← Orders</a>
      <h2>${esc(o.order_number)}</h2>
      ${statusTag(o.order_status)} ${payTag(o.payment_status)}
      <span class="spacer"></span>
      <button class="btn btn-primary btn-sm" id="changeStatus">Update status</button>
    </div>

    <div class="split">
      <div>
        <div class="panel" style="margin-top:0">
          <div class="panel-head"><h2>Items</h2></div>
          <div class="panel-body flush">
            <div class="table-wrap"><table class="data">
              <thead><tr><th>Product</th><th>Size</th><th>Colour</th>
                <th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead>
              <tbody>${(o.items ?? []).map((i) => `
                <tr>
                  <td><div class="cell-product">
                    ${i.image_url ? `<img class="thumb" src="${esc(i.image_url)}" alt="">` : ''}
                    <span><b>${esc(i.product_name)}</b><small>${esc(i.sku ?? '')}</small></span>
                  </div></td>
                  <td>${esc(i.size)}</td><td>${esc(i.color)}</td>
                  <td class="num">${i.quantity}</td>
                  <td class="num">${esc(kwd(i.unit_price))}</td>
                  <td class="num">${esc(kwd(i.total_price))}</td>
                </tr>`).join('')}</tbody>
            </table></div>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Timeline</h2></div>
          <div class="panel-body">${timeline(o)}</div>
        </div>

        <div class="panel">
          <div class="panel-head">
            <h2>Internal notes</h2>
            <span class="tag grey">staff only</span>
            <span class="spacer"></span>
            <button class="btn btn-ghost btn-sm" id="addNote">Add note</button>
          </div>
          <div class="panel-body">
            ${notes.length ? notes.map((n) => `
              <div style="padding:9px 0;border-bottom:1px solid var(--line-soft)">
                <div>${esc(n.note)}</div>
                <small style="color:var(--muted)">${esc(fmtDate(n.created_at, true))}</small>
              </div>`).join('')
              : '<p style="color:var(--muted);font-size:.88rem">No notes yet. Customers never see these.</p>'}
          </div>
        </div>
      </div>

      <div>
        <div class="panel" style="margin-top:0">
          <div class="panel-head"><h2>Customer</h2></div>
          <div class="panel-body">
            <dl class="kv">
              <dt>Name</dt><dd>${esc(o.customer_name)}</dd>
              <dt>Email</dt><dd>${esc(o.customer_email)}</dd>
              <dt>Phone</dt><dd>${esc(o.customer_phone)}</dd>
              <dt>Placed</dt><dd>${esc(fmtDate(o.created_at, true))}</dd>
              <dt>Payment</dt><dd>${esc(o.payment_method?.toUpperCase() ?? '—')}</dd>
            </dl>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Delivery address</h2></div>
          <div class="panel-body">
            <dl class="kv">
              <dt>Governorate</dt><dd>${esc(a.governorate ?? '—')}</dd>
              <dt>Area</dt><dd>${esc(a.area ?? '—')}</dd>
              <dt>Block</dt><dd>${esc(a.block ?? '—')}</dd>
              <dt>Street</dt><dd>${esc(a.street ?? '—')}</dd>
              <dt>Building</dt><dd>${esc(a.building_number ?? '—')}</dd>
              ${a.floor ? `<dt>Floor</dt><dd>${esc(a.floor)}</dd>` : ''}
              ${a.apartment ? `<dt>Apartment</dt><dd>${esc(a.apartment)}</dd>` : ''}
            </dl>
            ${a.additional_directions ? `<p style="margin-top:10px;font-size:.86rem;color:var(--ink-2)">
              ${esc(a.additional_directions)}</p>` : ''}
            ${o.customer_notes ? `<p style="margin-top:10px;font-size:.86rem">
              <b>Customer note:</b> ${esc(o.customer_notes)}</p>` : ''}
            ${mapLink ? `<div style="margin-top:12px">${mapLink}</div>` : ''}
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Totals</h2></div>
          <div class="panel-body">
            <div class="totals">
              <div class="row"><span>Subtotal</span><span>${esc(kwd(o.subtotal))}</span></div>
              ${Number(o.discount_amount) > 0 ? `<div class="row"><span>Coupon ${esc(o.coupon_code ?? '')}</span><span>−${esc(kwd(o.discount_amount))}</span></div>` : ''}
              ${Number(o.loyalty_discount) > 0 ? `<div class="row"><span>Cozy Points (${num(o.loyalty_points_used)})</span><span>−${esc(kwd(o.loyalty_discount))}</span></div>` : ''}
              <div class="row"><span>Delivery</span><span>${Number(o.delivery_fee) === 0 ? 'FREE' : esc(kwd(o.delivery_fee))}</span></div>
              ${Number(o.tax_amount) > 0 ? `<div class="row"><span>Tax</span><span>${esc(kwd(o.tax_amount))}</span></div>` : ''}
              <div class="row total"><span>Total</span><span>${esc(kwd(o.total_amount))}</span></div>
            </div>
            ${o.loyalty_points_earned ? `<p style="margin-top:10px;font-size:.84rem;color:var(--muted)">
              Earned ${num(o.loyalty_points_earned)} Cozy Points on delivery.</p>` : ''}
          </div>
        </div>
      </div>
    </div>`;

  $('#changeStatus').addEventListener('click', () => statusDialog(o, ctx));
  $('#addNote').addEventListener('click', () => noteDialog(o, ctx));
}

function timeline(o) {
  const history = o.history ?? [];
  const seen = new Map();
  history.forEach((h) => { if (!seen.has(h.status)) seen.set(h.status, h); });

  // Cancelled/returned/refunded leave the happy path; show history as-is.
  const offPath = ['cancelled', 'returned', 'refunded'].includes(o.order_status);
  const steps = offPath ? history.map((h) => h.status) : ORDER_FLOW;
  const currentIdx = steps.indexOf(o.order_status);

  return `<div class="timeline">${steps.map((s, i) => {
    const h = seen.get(s);
    const done = offPath ? true : (currentIdx >= 0 && i < currentIdx);
    const current = s === o.order_status;
    return `<div class="tl ${current ? 'current' : done ? 'done' : ''}">
      <span class="tl-dot">${current ? '●' : done ? '✓' : i + 1}</span>
      <span>
        <b>${esc(STATUS_LABEL[s] ?? s)}</b><br>
        <small>${h ? esc(fmtDate(h.created_at, true)) + (h.note ? ` — ${esc(h.note)}` : '') : 'Pending'}</small>
      </span>
    </div>`;
  }).join('')}</div>`;
}

function statusDialog(o, ctx) {
  openForm({
    title: `Update ${o.order_number}`,
    submit: 'Save status',
    body: `
      <label class="field"><span>New status</span>
        <select name="status">
          ${ORDER_STATUSES.map((s) => `<option value="${s}" ${s === o.order_status ? 'selected' : ''}>${esc(STATUS_LABEL[s])}</option>`).join('')}
        </select>
      </label>
      <label class="field"><span>Note (optional, saved to history)</span>
        <input name="note" type="text" placeholder="e.g. Called customer to confirm" />
      </label>
      <div class="form-grid">
        <label class="field"><span>Courier name</span>
          <input name="courierName" type="text" value="${esc(o.courier_name ?? '')}" /></label>
        <label class="field"><span>Courier phone</span>
          <input name="courierPhone" type="text" value="${esc(o.courier_phone ?? '')}" /></label>
        <label class="field"><span>Tracking reference</span>
          <input name="trackingReference" type="text" value="${esc(o.tracking_reference ?? '')}" /></label>
        <label class="field"><span>Estimated delivery</span>
          <input name="eta" type="datetime-local" /></label>
      </div>
      <p style="margin-top:12px;font-size:.82rem;color:var(--muted)">
        Marking an order <b>Delivered</b> deducts stock and awards Cozy Points.
        <b>Cancelled</b> releases the reserved stock back to inventory.</p>`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (d.status === o.order_status && !d.note) return;

      if (['cancelled', 'refunded', 'returned'].includes(d.status)) {
        const yes = await confirmAction({
          title: `Mark as ${STATUS_LABEL[d.status]}?`,
          body: d.status === 'cancelled'
            ? 'Reserved stock will be released back to inventory.'
            : 'Stock will be returned and any Cozy Points for this order reversed.',
          confirm: `Yes, mark ${STATUS_LABEL[d.status].toLowerCase()}`,
        });
        if (!yes) return true;   // keep the dialog open
      }

      await api.updateOrderStatus(o.id, d.status, {
        note: d.note || null,
        courierName: d.courierName || null,
        courierPhone: d.courierPhone || null,
        trackingReference: d.trackingReference || null,
        estimatedDeliveryTime: d.eta ? new Date(d.eta).toISOString() : null,
      });
      ok('Order status updated.');
      ctx.refresh();
    },
  });
}

function noteDialog(o, ctx) {
  openForm({
    title: 'Internal note',
    submit: 'Save note',
    body: `<label class="field"><span>Note (customers never see this)</span>
             <textarea name="note" required placeholder="e.g. Customer asked for gift wrap"></textarea>
           </label>`,
    onSubmit: async (form) => {
      const { note } = formData(form);
      if (!note) throw new Error('Please write a note first.');
      await api.addOrderNote(o.id, note);
      ok('Note saved.');
      ctx.refresh();
    },
  });
}

/* ===================================================================
   DELIVERY  (§14)
   =================================================================== */
export async function delivery(view, _param, ctx) {
  view.innerHTML = skeleton(5);
  const board = await api.getDeliveryBoard();

  const column = (title, rows, tone, nextStatus, nextLabel) => `
    <div class="panel" style="margin-top:0">
      <div class="panel-head">
        <h2>${esc(title)}</h2><span class="tag ${tone}">${rows.length}</span>
      </div>
      <div class="panel-body flush">
        ${rows.length ? rows.map((o) => {
          const a = o.shipping_address ?? {};
          const map = (a.latitude && a.longitude)
            ? `<a class="btn btn-ghost btn-sm" target="_blank" rel="noopener"
                  href="https://www.google.com/maps?q=${a.latitude},${a.longitude}">Map ↗</a>` : '';
          return `
          <div style="padding:14px 18px;border-bottom:1px solid var(--line-soft)">
            <div style="display:flex;gap:10px;align-items:baseline;flex-wrap:wrap">
              <b>${esc(o.order_number)}</b>
              <span style="color:var(--muted);font-size:.84rem">${esc(kwd(o.total_amount))}
                · ${esc((o.payment_method ?? '').toUpperCase())}</span>
              <span class="spacer" style="margin-left:auto"></span>
              <a class="btn btn-ghost btn-sm" href="#/order/${esc(o.id)}">Open</a>
            </div>
            <div style="margin-top:4px;font-size:.87rem">
              <b>${esc(o.customer_name)}</b> · ${esc(o.customer_phone ?? '')}
            </div>
            <div style="margin-top:2px;font-size:.84rem;color:var(--ink-2)">
              ${esc([a.area, a.block && 'Block ' + a.block, a.street && 'Street ' + a.street,
                     a.building_number && 'Bldg ' + a.building_number]
                     .filter(Boolean).join(', '))}
              ${a.governorate ? ` — ${esc(a.governorate)}` : ''}
            </div>
            ${o.customer_notes ? `<div style="margin-top:4px;font-size:.82rem;color:var(--muted)">
              Note: ${esc(o.customer_notes)}</div>` : ''}
            <div class="row-actions" style="justify-content:flex-start;margin-top:9px">
              ${map}
              ${nextStatus ? `<button class="btn btn-primary btn-sm"
                data-advance="${esc(o.id)}" data-to="${nextStatus}">${esc(nextLabel)}</button>` : ''}
            </div>
          </div>`;
        }).join('') : emptyState('Nothing here', '', '🚚')}
      </div>
    </div>`;

  view.innerHTML = `
    <div class="split" style="grid-template-columns:1fr 1fr">
      ${column('Ready for delivery', board.ready, 'pink', 'out_for_delivery', 'Send out')}
      ${column('Out for delivery', board.out, 'warn', 'delivered', 'Mark delivered')}
    </div>
    ${column('Delivered recently', board.delivered.slice(0, 20), 'good', null, null)}`;

  view.querySelectorAll('[data-advance]').forEach((b) => {
    b.addEventListener('click', async () => {
      const to = b.dataset.to;
      if (to === 'delivered') {
        const yes = await confirmAction({
          title: 'Mark this order delivered?',
          body: 'Stock will be deducted and the customer will earn their Cozy Points.',
          confirm: 'Yes, delivered', danger: false,
        });
        if (!yes) return;
      }
      try {
        await api.updateOrderStatus(b.dataset.advance, to);
        ok('Order status updated.');
        ctx.refresh();
      } catch (e) { showError(e); }
    });
  });
}
