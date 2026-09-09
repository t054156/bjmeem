/**
 * BJmeem Admin — shell, access control, routing, realtime.
 *
 * Access is decided by the database. Everything here does is decide what to
 * *show*; every RPC re-checks is_staff()/has_permission() server-side, and RLS
 * blocks the underlying tables regardless of what this file does.
 */
import { supabase, isConfigured } from '../js/supabase/client.js';
import { loginUser, logoutUser, getSession, onAuthChange } from '../js/supabase/auth.js';
import * as api from '../js/supabase/admin.js';
import { $, esc, ok, fail, showError, toast, kwd } from './ui.js';

import * as ordersViews from './views-orders.js';
import * as catalogViews from './views-catalog.js';
import * as peopleViews from './views-people.js';

/** route → { title, render, perm } */
const ROUTES = {
  dashboard: { title: 'Dashboard',  render: ordersViews.dashboard,  perm: null },
  orders:    { title: 'Orders',     render: ordersViews.orders,     perm: 'orders' },
  order:     { title: 'Order',      render: ordersViews.orderDetail, perm: 'orders', hidden: true },
  delivery:  { title: 'Delivery',   render: ordersViews.delivery,   perm: 'delivery' },
  products:  { title: 'Products',   render: catalogViews.products,  perm: 'products' },
  product:   { title: 'Product',    render: catalogViews.productDetail, perm: 'products', hidden: true },
  inventory: { title: 'Inventory',  render: catalogViews.inventory, perm: 'inventory' },
  customers: { title: 'Customers',  render: peopleViews.customers,  perm: 'customers' },
  customer:  { title: 'Customer',   render: peopleViews.customerDetail, perm: 'customers', hidden: true },
  loyalty:   { title: 'Cozy Club',  render: peopleViews.loyalty,    perm: 'loyalty' },
  coupons:   { title: 'Coupons',    render: peopleViews.coupons,    perm: 'coupons' },
  reports:   { title: 'Reports',    render: peopleViews.reports,    perm: 'reports' },
  settings:  { title: 'Settings',   render: peopleViews.settings,   perm: 'settings' },
};

/** Shared context handed to every view. */
export const ctx = {
  me: null,           // identity from getAdminIdentity()
  lowStock: 5,        // refreshed from app_settings
  refresh: () => router(),
};

let unsubscribeRealtime = null;

/* ===================================================================
   BOOT
   =================================================================== */

const show = (id) => {
  for (const g of ['setupGate', 'loginGate', 'deniedGate', 'app']) {
    const el = $('#' + g);
    if (el) el.hidden = g !== id;
  }
};

async function boot() {
  // 1. Not connected to Supabase yet → setup instructions, no crash.
  if (!isConfigured) {
    show('setupGate');
    return;
  }

  // 2. Not signed in → login.
  const session = await getSession();
  if (!session) {
    show('loginGate');
    return;
  }

  // 3. Signed in — is this a staff account? The server decides.
  await enterApp();
}

async function enterApp() {
  let me;
  try {
    me = await api.getAdminIdentity();
  } catch (e) {
    showError(e);
    show('loginGate');
    return;
  }

  if (!me.signedIn || !me.isStaff) {
    $('#deniedWho').textContent =
      `${me.email ?? 'This account'} is signed in as “${me.role ?? 'customer'}”, ` +
      'which has no dashboard access.';
    show('deniedGate');
    return;
  }

  ctx.me = me;
  paintIdentity(me);
  applyPermissionsToNav(me);
  show('app');

  // Low-stock threshold is configurable (§6).
  try {
    const rows = await api.getSettings();
    const s = rows.find((r) => r.key === 'inventory.low_stock_threshold');
    if (s) ctx.lowStock = Number(s.value) || 5;
  } catch { /* non-fatal: fall back to 5 */ }

  startRealtime();
  router();
}

function paintIdentity(me) {
  $('#whoName').textContent = me.name || me.email;
  $('#whoRole').textContent = me.role;
  $('#whoAvatar').textContent = (me.name || me.email || 'B').trim()[0].toUpperCase();
}

/** Hide nav items this account cannot use. The server enforces it too. */
function applyPermissionsToNav(me) {
  document.querySelectorAll('#nav a[data-perm]').forEach((a) => {
    const perm = a.dataset.perm;
    a.hidden = Boolean(perm) && !me.can[perm];
  });
}

/* ===================================================================
   LOGIN
   =================================================================== */

$('#loginForm')?.addEventListener('submit', async (e) => {
  e.preventDefault();
  const btn = $('#loginBtn');
  const err = $('#loginError');
  err.hidden = true;
  btn.disabled = true;
  btn.textContent = 'Signing in…';
  try {
    await loginUser($('#loginEmail').value, $('#loginPass').value);
    $('#loginPass').value = '';
    await enterApp();
  } catch (e2) {
    err.textContent = e2?.message || 'Could not sign in.';
    err.hidden = false;
  } finally {
    btn.disabled = false;
    btn.textContent = 'Sign in';
  }
});

async function signOut() {
  try { await logoutUser(); } catch { /* ignore */ }
  unsubscribeRealtime?.();
  unsubscribeRealtime = null;
  ctx.me = null;
  location.hash = '';
  show('loginGate');
}

$('#signOutBtn')?.addEventListener('click', signOut);
$('#deniedSignOut')?.addEventListener('click', signOut);

// A session that expires elsewhere should not leave a stale dashboard open.
if (isConfigured) {
  onAuthChange((event) => {
    if (event === 'SIGNED_OUT') { ctx.me = null; show('loginGate'); }
  });
}

/* ===================================================================
   ROUTER
   =================================================================== */

function parseHash() {
  const raw = (location.hash || '#/dashboard').replace(/^#\/?/, '');
  const [name, ...rest] = raw.split('/');
  return { name: name || 'dashboard', param: rest.join('/') || null };
}

async function router() {
  if (!ctx.me) return;

  const { name, param } = parseHash();
  const route = ROUTES[name] ?? ROUTES.dashboard;

  // Permission check before rendering. Server-side checks still apply.
  if (route.perm && !ctx.me.can[route.perm]) {
    $('#pageTitle').textContent = 'No access';
    $('#view').innerHTML = `
      <div class="panel"><div class="panel-body">
        <div class="empty"><span class="bear">🔒</span>
          <h3>You do not have access to ${esc(route.title)}</h3>
          <p>Ask the store owner to grant the “${esc(route.perm)}” permission.</p>
        </div></div></div>`;
    return;
  }

  $('#pageTitle').textContent = route.title;
  document.querySelectorAll('#nav a').forEach((a) => {
    a.classList.toggle('active', a.dataset.nav === name ||
      (name === 'order' && a.dataset.nav === 'orders') ||
      (name === 'product' && a.dataset.nav === 'products') ||
      (name === 'customer' && a.dataset.nav === 'customers'));
  });

  closeSidebar();
  const view = $('#view');
  view.scrollTop = 0;
  window.scrollTo(0, 0);

  try {
    await route.render(view, param, ctx);
  } catch (e) {
    showError(e);
    view.innerHTML = `
      <div class="panel"><div class="panel-body">
        <div class="empty"><span class="bear">🧸</span>
          <h3>Could not load ${esc(route.title)}</h3>
          <p>${esc(e?.message || 'Please try again.')}</p>
        </div></div></div>`;
  }
}

addEventListener('hashchange', router);

/* ===================================================================
   REALTIME  (§22)
   =================================================================== */

function setLive(state, text) {
  const dot = $('#liveDot');
  dot.className = `live ${state}`;
  $('#liveText').textContent = text;
}

function startRealtime() {
  unsubscribeRealtime?.();
  setLive('', 'connecting…');

  try {
    unsubscribeRealtime = api.onOrderActivity({
      onInsert: (order) => {
        toast(`${order.order_number} · ${kwd(order.total_amount)}`,
              { title: 'New Order 🧸', tone: 'ok', ms: 8000 });
        try { chime(); } catch { /* audio is a nicety, never a failure */ }
        // Refresh counts without a full page reload.
        const { name } = parseHash();
        if (name === 'dashboard' || name === 'orders') router();
      },
      onUpdate: (order, old) => {
        if (order.order_status === old?.order_status) return;
        const { name } = parseHash();
        if (name === 'dashboard' || name === 'orders' || name === 'delivery') router();
      },
    });
    setLive('on', 'live');
  } catch {
    setLive('off', 'offline');
  }
}

/** Short, soft two-note chime for a new order. */
function chime() {
  const Ctx = window.AudioContext || window.webkitAudioContext;
  if (!Ctx) return;
  const ac = new Ctx();
  [880, 1174].forEach((f, i) => {
    const o = ac.createOscillator();
    const g = ac.createGain();
    o.type = 'sine';
    o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, ac.currentTime + i * 0.14);
    g.gain.exponentialRampToValueAtTime(0.05, ac.currentTime + i * 0.14 + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, ac.currentTime + i * 0.14 + 0.22);
    o.connect(g); g.connect(ac.destination);
    o.start(ac.currentTime + i * 0.14);
    o.stop(ac.currentTime + i * 0.14 + 0.24);
  });
  setTimeout(() => ac.close(), 800);
}

/* ===================================================================
   SIDEBAR (mobile)
   =================================================================== */

const openSidebar  = () => { $('#sidebar').classList.add('open'); $('#overlay').hidden = false; };
const closeSidebar = () => { $('#sidebar').classList.remove('open'); $('#overlay').hidden = true; };

$('#menuBtn')?.addEventListener('click', openSidebar);
$('#sidebarClose')?.addEventListener('click', closeSidebar);
$('#overlay')?.addEventListener('click', closeSidebar);

/* ===================================================================
   Delegated actions shared by several views
   =================================================================== */

document.addEventListener('click', async (e) => {
  // Visibility toggle appears in both the product table and product detail.
  const vis = e.target.closest('[data-toggle-vis]');
  if (vis) {
    const id = vis.dataset.toggleVis;
    const turningOn = !vis.classList.contains('on');
    const { confirmAction } = await import('./ui.js');
    if (!turningOn) {
      const yes = await confirmAction({
        title: 'Hide this product from BJmeem?',
        body: 'It will disappear from the customer store immediately. Nothing is deleted — ' +
              'the product, its stock and its order history stay saved.',
        confirm: 'Hide product', danger: false,
      });
      if (!yes) return;
    }
    try {
      await api.setProductVisibility(id, turningOn);
      ok(turningOn ? 'Product is now visible on the store.' : 'Product hidden successfully.');
      router();
    } catch (err) { showError(err); }
  }
});

boot();
