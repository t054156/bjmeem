/** BJmeem Admin — Customers, Cozy Club, Coupons, Reports, Settings. */
import * as api from '../js/supabase/admin.js';
import {
  $, esc, kwd, num, fmtDate, skeleton, emptyState, openForm, formData,
  confirmAction, ok, showError, barChart, sparkChart,
} from './ui.js';

/* ===================================================================
   CUSTOMERS  (§11, §17)
   =================================================================== */
let customerSearch = '';

export async function customers(view) {
  view.innerHTML = `
    <div class="toolbar">
      <input type="search" id="cSearch" placeholder="Name, email or phone…" value="${esc(customerSearch)}" />
      <span class="spacer"></span>
      <span class="count-note" id="cCount"></span>
    </div>
    <div class="panel"><div class="panel-body flush" id="cList">${skeleton(6)}</div></div>`;

  const load = async () => {
    const list = $('#cList');
    list.innerHTML = skeleton(6);
    const rows = await api.listCustomers({ search: customerSearch || null, limit: 200 });
    $('#cCount').textContent = `${rows.length} customer${rows.length === 1 ? '' : 's'}`;

    list.innerHTML = rows.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Customer</th><th>Phone</th><th>Joined</th>
          <th class="num">Orders</th><th class="num">Spent</th>
          <th>Tier</th><th class="num">Points</th><th></th>
        </tr></thead>
        <tbody>${rows.map((c) => `
          <tr>
            <td><b>${esc([c.first_name, c.last_name].filter(Boolean).join(' ') || '—')}</b><br>
                <small style="color:var(--muted)">${esc(c.email)}</small>
                ${c.role !== 'customer' ? ` <span class="tag pink">${esc(c.role)}</span>` : ''}</td>
            <td>${esc(c.phone_number ?? '—')}</td>
            <td>${esc(fmtDate(c.created_at))}</td>
            <td class="num">${num(c.total_orders)}</td>
            <td class="num">${esc(kwd(c.total_spent))}</td>
            <td><span class="tag grey">${esc(c.loyalty_tier ?? '—')}</span></td>
            <td class="num">${num(c.loyalty_points)}</td>
            <td class="num"><a class="btn btn-ghost btn-sm" href="#/customer/${esc(c.id)}">Open</a></td>
          </tr>`).join('')}</tbody>
      </table></div>`
      : emptyState('No customers found', 'They will appear here after they register.');
  };

  let t;
  $('#cSearch').addEventListener('input', (e) => {
    customerSearch = e.target.value;
    clearTimeout(t); t = setTimeout(load, 250);
  });
  await load();
}

export async function customerDetail(view, userId, ctx) {
  view.innerHTML = skeleton(6);
  const { profile, orders, loyalty, addresses } = await api.getCustomer(userId);
  const name = [profile.first_name, profile.last_name].filter(Boolean).join(' ') || profile.email;

  view.innerHTML = `
    <div class="section-head">
      <a class="btn btn-ghost btn-sm" href="#/customers">← Customers</a>
      <h2>${esc(name)}</h2>
      <span class="tag grey">${esc(profile.role)}</span>
      <span class="spacer"></span>
      ${ctx.me.can.loyalty ? '<button class="btn btn-ghost btn-sm" id="adjPoints">Adjust points</button>' : ''}
      ${ctx.me.isOwner ? '<button class="btn btn-primary btn-sm" id="setRole">Change role</button>' : ''}
    </div>

    <div class="stat-grid">
      <div class="stat"><b>${num(profile.total_orders)}</b><span>Orders</span></div>
      <div class="stat good"><b>${esc(kwd(profile.total_spent))}</b><span>Total spent</span></div>
      <div class="stat accent"><b>${num(loyalty?.points_balance ?? 0)}</b><span>Cozy Points</span></div>
      <div class="stat"><b>${num(loyalty?.lifetime_points ?? 0)}</b><span>Lifetime points</span></div>
    </div>

    <div class="split">
      <div class="panel">
        <div class="panel-head"><h2>Order history</h2></div>
        <div class="panel-body flush">
          ${orders.length ? `
          <div class="table-wrap"><table class="data">
            <thead><tr><th>Order</th><th>Date</th><th class="num">Total</th><th>Status</th><th></th></tr></thead>
            <tbody>${orders.map((o) => `
              <tr>
                <td><b>${esc(o.order_number)}</b></td>
                <td>${esc(fmtDate(o.created_at))}</td>
                <td class="num">${esc(kwd(o.total_amount))}</td>
                <td><span class="tag grey">${esc(o.order_status)}</span></td>
                <td class="num"><a class="btn btn-ghost btn-sm" href="#/order/${esc(o.id)}">Open</a></td>
              </tr>`).join('')}</tbody>
          </table></div>` : emptyState('No orders yet')}
        </div>
      </div>

      <div>
        <div class="panel" style="margin-top:0">
          <div class="panel-head"><h2>Contact</h2></div>
          <div class="panel-body">
            <dl class="kv">
              <dt>Email</dt><dd>${esc(profile.email)}</dd>
              <dt>Phone</dt><dd>${esc(profile.phone_number ?? '—')}</dd>
              <dt>Joined</dt><dd>${esc(fmtDate(profile.created_at))}</dd>
              <dt>Member no.</dt><dd>${esc(loyalty?.member_number ?? '—')}</dd>
              <dt>Tier</dt><dd>${esc(loyalty?.loyalty_tier ?? '—')}</dd>
            </dl>
            <p style="margin-top:12px;font-size:.8rem;color:var(--muted)">
              Passwords are managed by Supabase Auth and are never visible here.</p>
          </div>
        </div>

        <div class="panel">
          <div class="panel-head"><h2>Saved addresses</h2></div>
          <div class="panel-body">
            ${addresses.length ? addresses.map((a) => `
              <div style="padding:8px 0;border-bottom:1px solid var(--line-soft);font-size:.87rem">
                <b>${esc(a.label)}${a.is_default ? ' · default' : ''}</b><br>
                ${esc([a.area, a.block && 'Block ' + a.block, a.street && 'Street ' + a.street,
                       a.building_number && 'Bldg ' + a.building_number].filter(Boolean).join(', '))}
                <br><small style="color:var(--muted)">${esc(a.governorate)}</small>
              </div>`).join('')
              : '<p style="color:var(--muted);font-size:.87rem">No saved addresses.</p>'}
          </div>
        </div>
      </div>
    </div>`;

  $('#adjPoints')?.addEventListener('click', () => adjustPointsDialog(profile, ctx));
  $('#setRole')?.addEventListener('click', () => roleDialog(profile, ctx));
}

function adjustPointsDialog(profile, ctx) {
  openForm({
    title: `Adjust Cozy Points — ${esc(profile.first_name ?? profile.email)}`,
    submit: 'Apply adjustment',
    body: `
      <label class="field"><span>Points (negative to remove)</span>
        <input name="points" type="number" step="1" required placeholder="e.g. 50 or -25" /></label>
      <label class="field"><span>Reason *</span>
        <input name="reason" required placeholder="Customer service compensation" /></label>
      <p style="margin-top:10px;font-size:.83rem;color:var(--muted)">
        Every manual change is written to the loyalty ledger and the audit log with your name.</p>`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.points) throw new Error('Enter a non-zero number of points.');
      if (!d.reason) throw new Error('A reason is required.');
      const r = await api.adjustLoyaltyPoints(profile.id, d.points, d.reason);
      ok(`Balance is now ${r.balance} points.`, 'Points adjusted');
      ctx.refresh();
    },
  });
}

function roleDialog(profile, ctx) {
  const perms = ['orders', 'products', 'inventory', 'customers',
                 'loyalty', 'coupons', 'delivery', 'reports', 'settings'];
  const current = profile.permissions ?? {};
  openForm({
    title: `Role — ${esc(profile.email)}`,
    submit: 'Save role',
    body: `
      <label class="field"><span>Role</span>
        <select name="role">
          ${['customer', 'staff', 'admin', 'owner'].map((r) =>
            `<option value="${r}" ${profile.role === r ? 'selected' : ''}>${r}</option>`).join('')}
        </select></label>
      <p style="margin-top:14px;font-size:.85rem;color:var(--ink-2)">
        Staff permissions (ignored for admin and owner, who have everything):</p>
      <div class="form-grid" style="margin-top:8px">
        ${perms.map((p) => `<label class="field inline">
          <input type="checkbox" name="perm_${p}" ${current[p] ? 'checked' : ''}><span>${p}</span>
        </label>`).join('')}
      </div>`,
    onSubmit: async (form) => {
      const d = formData(form);
      const permissions = {};
      for (const p of perms) if (d['perm_' + p]) permissions[p] = true;
      await api.setUserRole(profile.id, d.role, permissions);
      ok('Role updated.');
      ctx.refresh();
    },
  });
}

/* ===================================================================
   COZY CLUB  (§12)
   =================================================================== */
export async function loyalty(view, _param, ctx) {
  view.innerHTML = skeleton(6);
  const accounts = await api.listLoyaltyAccounts({ limit: 200 });

  view.innerHTML = `
    <div class="panel" style="margin-top:0">
      <div class="panel-head">
        <h2>BJmeem Cozy Club</h2>
        <span class="spacer"></span>
        <span class="count-note">${accounts.length} member${accounts.length === 1 ? '' : 's'}</span>
      </div>
      <div class="panel-body flush">
        ${accounts.length ? `
        <div class="table-wrap"><table class="data">
          <thead><tr>
            <th>Member</th><th>Member no.</th><th>Tier</th>
            <th class="num">Points</th><th class="num">Lifetime</th><th>Joined</th><th></th>
          </tr></thead>
          <tbody>${accounts.map((a) => `
            <tr>
              <td><b>${esc([a.profile?.first_name, a.profile?.last_name].filter(Boolean).join(' ') || '—')}</b><br>
                  <small style="color:var(--muted)">${esc(a.profile?.email ?? '')}</small></td>
              <td><code>${esc(a.member_number)}</code></td>
              <td><span class="tag pink">${esc(a.loyalty_tier)}</span></td>
              <td class="num"><b>${num(a.points_balance)}</b></td>
              <td class="num">${num(a.lifetime_points)}</td>
              <td>${esc(fmtDate(a.joined_at))}</td>
              <td class="num"><a class="btn btn-ghost btn-sm" href="#/customer/${esc(a.user_id)}">Open</a></td>
            </tr>`).join('')}</tbody>
        </table></div>` : emptyState('No members yet')}
      </div>
    </div>`;
}

/* ===================================================================
   COUPONS  (§13)
   =================================================================== */
export async function coupons(view, _param, ctx) {
  view.innerHTML = skeleton(5);
  const rows = await api.listCoupons();

  view.innerHTML = `
    <div class="toolbar">
      <span class="count-note">${rows.length} coupon${rows.length === 1 ? '' : 's'}</span>
      <span class="spacer"></span>
      <button class="btn btn-primary btn-sm" id="addCoupon">+ Add coupon</button>
    </div>
    <div class="panel"><div class="panel-body flush">
      ${rows.length ? `
      <div class="table-wrap"><table class="data">
        <thead><tr>
          <th>Code</th><th>Discount</th><th class="num">Min order</th>
          <th class="num">Used</th><th>Window</th><th>Status</th><th></th>
        </tr></thead>
        <tbody>${rows.map((c) => `
          <tr>
            <td><b><code>${esc(c.code)}</code></b><br>
                <small style="color:var(--muted)">${esc(c.description ?? '')}</small></td>
            <td>${c.discount_type === 'percentage' ? `${num(c.discount_value)}%`
                 : c.discount_type === 'fixed' ? esc(kwd(c.discount_value)) : 'Free delivery'}
                ${c.maximum_discount ? `<br><small style="color:var(--muted)">max ${esc(kwd(c.maximum_discount))}</small>` : ''}</td>
            <td class="num">${esc(kwd(c.minimum_order_amount))}</td>
            <td class="num">${num(c.usage_count)}${c.usage_limit ? ` / ${num(c.usage_limit)}` : ''}</td>
            <td><small>${esc(fmtDate(c.starts_at))}${c.expires_at ? ` → ${esc(fmtDate(c.expires_at))}` : ' → no end'}</small></td>
            <td>${c.is_active ? '<span class="tag good">Active</span>' : '<span class="tag grey">Inactive</span>'}
                ${c.is_public ? '<span class="tag info">Public</span>' : ''}</td>
            <td class="num"><div class="row-actions">
              <button class="btn btn-ghost btn-sm" data-cedit="${esc(c.id)}">Edit</button>
              <button class="btn btn-ghost btn-sm" data-ctoggle="${esc(c.id)}"
                      data-active="${c.is_active}">${c.is_active ? 'Deactivate' : 'Activate'}</button>
            </div></td>
          </tr>`).join('')}</tbody>
      </table></div>` : emptyState('No coupons yet', 'Create one to run your first promotion.')}
    </div></div>`;

  $('#addCoupon').addEventListener('click', () => couponDialog(null, ctx));
  view.querySelectorAll('[data-cedit]').forEach((b) => b.addEventListener('click', () =>
    couponDialog(rows.find((c) => c.id === b.dataset.cedit), ctx)));
  view.querySelectorAll('[data-ctoggle]').forEach((b) => b.addEventListener('click', async () => {
    try {
      await api.updateCoupon(b.dataset.ctoggle, { is_active: b.dataset.active !== 'true' });
      ok('Coupon updated.');
      ctx.refresh();
    } catch (e) { showError(e); }
  }));
}

function couponDialog(coupon, ctx) {
  const c = coupon ?? {};
  const dt = (v) => (v ? new Date(v).toISOString().slice(0, 10) : '');

  openForm({
    title: coupon ? `Edit ${c.code}` : 'Add coupon',
    submit: coupon ? 'Save coupon' : 'Create coupon',
    wide: true,
    body: `
      <div class="form-grid">
        <label class="field"><span>Code *</span>
          <input name="code" required value="${esc(c.code ?? '')}" placeholder="WELCOME10"
                 style="text-transform:uppercase" /></label>
        <label class="field"><span>Discount type</span>
          <select name="discount_type">
            ${[['percentage', 'Percentage %'], ['fixed', 'Fixed KWD'], ['free_delivery', 'Free delivery']]
              .map(([v, l]) => `<option value="${v}" ${c.discount_type === v ? 'selected' : ''}>${l}</option>`).join('')}
          </select></label>

        <label class="field"><span>Discount value</span>
          <input name="discount_value" type="number" step="0.001" min="0"
                 value="${esc(c.discount_value ?? 10)}" /></label>
        <label class="field"><span>Maximum discount (KWD)</span>
          <input name="maximum_discount" type="number" step="0.001" min="0"
                 value="${esc(c.maximum_discount ?? '')}" placeholder="no cap" /></label>

        <label class="field"><span>Minimum order (KWD)</span>
          <input name="minimum_order_amount" type="number" step="0.001" min="0"
                 value="${esc(c.minimum_order_amount ?? 0)}" /></label>
        <label class="field"><span>Total usage limit</span>
          <input name="usage_limit" type="number" step="1" min="1"
                 value="${esc(c.usage_limit ?? '')}" placeholder="unlimited" /></label>

        <label class="field"><span>Uses per customer</span>
          <input name="usage_per_customer" type="number" step="1" min="1"
                 value="${esc(c.usage_per_customer ?? 1)}" /></label>
        <label class="field"><span>Tier restriction</span>
          <select name="tier">
            <option value="">Any tier</option>
            ${['cozy', 'teddy', 'dream'].map((t) =>
              `<option value="${t}" ${(c.allowed_tiers ?? []).includes(t) ? 'selected' : ''}>${t} and above</option>`).join('')}
          </select></label>

        <label class="field"><span>Starts</span>
          <input name="starts_at" type="date" value="${esc(dt(c.starts_at) || dt(new Date()))}" /></label>
        <label class="field"><span>Expires</span>
          <input name="expires_at" type="date" value="${esc(dt(c.expires_at))}" placeholder="no end" /></label>

        <label class="field full"><span>Description</span>
          <input name="description" value="${esc(c.description ?? '')}"
                 placeholder="10% off your first BJmeem order" /></label>
      </div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:12px">
        <label class="field inline"><input type="checkbox" name="is_active" ${coupon ? (c.is_active ? 'checked' : '') : 'checked'}><span>Active</span></label>
        <label class="field inline"><input type="checkbox" name="is_public" ${c.is_public ? 'checked' : ''}><span>Show publicly in the store</span></label>
        <label class="field inline"><input type="checkbox" name="first_order_only" ${c.first_order_only ? 'checked' : ''}><span>First order only</span></label>
        <label class="field inline"><input type="checkbox" name="loyalty_members_only" ${c.loyalty_members_only ? 'checked' : ''}><span>Members only</span></label>
      </div>`,
    onSubmit: async (form) => {
      const d = formData(form);
      if (!d.code) throw new Error('A coupon code is required.');
      if (d.discount_type === 'percentage' && (d.discount_value < 0 || d.discount_value > 100)) {
        throw new Error('A percentage discount must be between 0 and 100.');
      }

      const body = {
        code: d.code.toUpperCase(),
        description: d.description || null,
        discount_type: d.discount_type,
        discount_value: d.discount_type === 'free_delivery' ? 0 : (d.discount_value ?? 0),
        minimum_order_amount: d.minimum_order_amount ?? 0,
        maximum_discount: d.maximum_discount ?? null,
        usage_limit: d.usage_limit ?? null,
        usage_per_customer: d.usage_per_customer ?? 1,
        first_order_only: d.first_order_only,
        loyalty_members_only: d.loyalty_members_only,
        allowed_tiers: d.tier ? [d.tier] : null,
        starts_at: d.starts_at ? new Date(d.starts_at).toISOString() : new Date().toISOString(),
        expires_at: d.expires_at ? new Date(d.expires_at + 'T23:59:59').toISOString() : null,
        is_active: d.is_active,
        is_public: d.is_public,
      };

      if (coupon) await api.updateCoupon(coupon.id, body);
      else await api.createCoupon(body);
      ok(coupon ? 'Coupon updated.' : 'Coupon created.');
      ctx.refresh();
    },
  });
}

/* ===================================================================
   REPORTS  (§16)
   =================================================================== */
let reportDays = 30;

export async function reports(view, _param, ctx) {
  view.innerHTML = skeleton(6);
  const from = new Date(Date.now() - reportDays * 864e5).toISOString();
  const gran = reportDays <= 14 ? 'day' : reportDays <= 90 ? 'day' : 'week';

  const [sales, best] = await Promise.all([
    api.getSalesReport({ from, granularity: gran }),
    api.getBestSellers({ days: reportDays, limit: 8 }),
  ]);
  const low = await api.getLowStock(ctx.lowStock).catch(() => []);
  const t = sales.totals ?? {};

  view.innerHTML = `
    <div class="toolbar">
      <select id="rRange">
        ${[[7, 'Last 7 days'], [30, 'Last 30 days'], [90, 'Last 90 days'], [365, 'Last 12 months']]
          .map(([v, l]) => `<option value="${v}" ${reportDays === v ? 'selected' : ''}>${l}</option>`).join('')}
      </select>
      <span class="spacer"></span>
      <span class="count-note">Cancelled and refunded orders are excluded from revenue.</span>
    </div>

    <div class="stat-grid">
      <div class="stat good"><b>${esc(kwd(t.revenue))}</b><span>Revenue</span></div>
      <div class="stat"><b>${num(t.orders)}</b><span>Orders</span></div>
      <div class="stat accent"><b>${esc(kwd(t.average_order_value))}</b><span>Average order value</span></div>
      <div class="stat"><b>${num(t.items_sold)}</b><span>Items sold</span></div>
      <div class="stat bad"><b>${num(sales.excluded?.cancelled)}</b><span>Cancelled</span></div>
      <div class="stat bad"><b>${num(sales.excluded?.refunded)}</b><span>Refunded / returned</span></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Sales over time</h2>
        <span class="spacer"></span><span class="count-note">by ${esc(sales.granularity)}</span></div>
      <div class="panel-body">${sparkChart(sales.series)}</div>
    </div>

    <div class="split">
      <div class="panel">
        <div class="panel-head"><h2>Best selling products</h2></div>
        <div class="panel-body">${barChart(best.products)}</div>
      </div>
      <div>
        <div class="panel" style="margin-top:0">
          <div class="panel-head"><h2>Best sizes</h2></div>
          <div class="panel-body">${barChart(best.sizes)}</div>
        </div>
        <div class="panel">
          <div class="panel-head"><h2>Best colours</h2></div>
          <div class="panel-body">${barChart(best.colors)}</div>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Stock needing attention</h2>
        <span class="spacer"></span>
        <a class="btn btn-ghost btn-sm" href="#/inventory">Inventory</a></div>
      <div class="panel-body flush">
        ${low.length ? `
        <div class="table-wrap"><table class="data">
          <thead><tr><th>SKU</th><th>Size</th><th>Colour</th><th class="num">Available</th></tr></thead>
          <tbody>${low.slice(0, 30).map((v) => `
            <tr><td><small>${esc(v.sku)}</small></td><td>${esc(v.size)}</td>
                <td>${esc(v.color)}</td>
                <td class="num"><b>${num(v.available_quantity)}</b></td></tr>`).join('')}</tbody>
        </table></div>` : emptyState('All variants are well stocked', '', '☁️')}
      </div>
    </div>`;

  $('#rRange').addEventListener('change', (e) => {
    reportDays = Number(e.target.value);
    reports(view, null, ctx);
  });
}

/* ===================================================================
   SETTINGS  (§6 threshold, §21 roles)
   =================================================================== */
export async function settings(view, _param, ctx) {
  view.innerHTML = skeleton(5);
  const rows = await api.getSettings();

  const LABELS = {
    'loyalty.points_per_kwd': 'Cozy Points earned per KWD',
    'loyalty.expiry_months': 'Months until points expire',
    'loyalty.signup_bonus_points': 'Signup bonus points',
    'loyalty.birthday_bonus_points': 'Birthday bonus points',
    'loyalty.referral_bonus_points': 'Referral bonus points',
    'delivery.default_fee': 'Default delivery fee (KWD)',
    'delivery.free_threshold': 'Free delivery over (KWD)',
    'tax.rate_percent': 'Tax rate (%)',
    'inventory.low_stock_threshold': 'Low stock threshold',
    'store.currency': 'Currency',
    'store.name': 'Store name',
  };

  view.innerHTML = `
    <div class="panel" style="margin-top:0">
      <div class="panel-head"><h2>Store rules</h2>
        <span class="spacer"></span>
        <span class="count-note">Changes apply immediately — no redeploy needed.</span></div>
      <div class="panel-body flush">
        <div class="table-wrap"><table class="data">
          <thead><tr><th>Setting</th><th>Value</th><th></th></tr></thead>
          <tbody>${rows.map((s) => `
            <tr>
              <td><b>${esc(LABELS[s.key] ?? s.key)}</b><br>
                  <small style="color:var(--muted)">${esc(s.description ?? s.key)}</small></td>
              <td><code>${esc(JSON.stringify(s.value))}</code></td>
              <td class="num">
                <button class="btn btn-ghost btn-sm" data-setting="${esc(s.key)}"
                        data-value="${esc(JSON.stringify(s.value))}"
                        data-label="${esc(LABELS[s.key] ?? s.key)}">Edit</button>
              </td>
            </tr>`).join('')}</tbody>
        </table></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>Security</h2></div>
      <div class="panel-body">
        <dl class="kv">
          <dt>Signed in as</dt><dd>${esc(ctx.me.email)}</dd>
          <dt>Role</dt><dd>${esc(ctx.me.role)}</dd>
        </dl>
        <p style="margin-top:12px;font-size:.85rem;color:var(--ink-2)">
          Roles and staff permissions are changed from a customer's page
          (Customers → open a person → Change role). Only the owner can do this,
          and the database enforces it independently of this dashboard.</p>
        <p style="margin-top:10px;font-size:.83rem;color:var(--muted)">
          This dashboard only ever uses the public anon key. The service-role key
          lives in Supabase Edge Function secrets and never reaches the browser.</p>
      </div>
    </div>`;

  view.querySelectorAll('[data-setting]').forEach((b) => b.addEventListener('click', () => {
    settingDialog(b.dataset.setting, b.dataset.value, b.dataset.label, ctx);
  }));
}

function settingDialog(key, rawValue, label, ctx) {
  openForm({
    title: label,
    submit: 'Save setting',
    body: `
      <label class="field"><span>Value (JSON)</span>
        <input name="value" required value="${esc(rawValue)}" /></label>
      <p style="margin-top:10px;font-size:.83rem;color:var(--muted)">
        Numbers as <code>5</code>, text in quotes as <code>"BJmeem"</code>.</p>`,
    onSubmit: async (form) => {
      const { value } = formData(form);
      let parsed;
      try { parsed = JSON.parse(value); }
      catch { throw new Error('That is not valid JSON. Numbers: 5 · Text: "BJmeem"'); }
      await api.updateSetting(key, parsed);
      ok('Setting saved.');
      ctx.refresh();
    },
  });
}
