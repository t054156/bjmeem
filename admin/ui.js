/** BJmeem Admin — shared UI helpers. No Supabase imports here on purpose. */

export const $  = (s, r = document) => r.querySelector(s);
export const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

/** Escape anything interpolated into innerHTML. */
export const esc = (v) => String(v ?? '').replace(/[&<>"']/g,
  (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

export const kwd = (n) => `${Number(n ?? 0).toFixed(3)} KWD`;
export const num = (n) => Number(n ?? 0).toLocaleString();

export function fmtDate(d, withTime = false) {
  if (!d) return '—';
  const dt = new Date(d);
  const date = dt.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
  return withTime
    ? `${date}, ${dt.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' })}`
    : date;
}

export function timeAgo(d) {
  if (!d) return '';
  const s = Math.floor((Date.now() - new Date(d)) / 1000);
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/* --------------------------------------------------------------- status */

export const ORDER_FLOW = [
  'pending', 'confirmed', 'preparing', 'packed', 'out_for_delivery', 'delivered',
];

export const ORDER_STATUSES = [
  ...ORDER_FLOW, 'cancelled', 'returned', 'refunded',
];

export const STATUS_LABEL = {
  pending: 'Pending', confirmed: 'Confirmed', preparing: 'Preparing', packed: 'Packed',
  out_for_delivery: 'Out for Delivery', delivered: 'Delivered', cancelled: 'Cancelled',
  returned: 'Returned', refunded: 'Refunded',
};

const STATUS_TONE = {
  pending: 'grey', confirmed: 'info', preparing: 'info', packed: 'pink',
  out_for_delivery: 'warn', delivered: 'good', cancelled: 'bad',
  returned: 'bad', refunded: 'bad',
};

export const statusTag = (s) =>
  `<span class="tag ${STATUS_TONE[s] ?? 'grey'}">${esc(STATUS_LABEL[s] ?? s)}</span>`;

export const payTag = (s) => {
  const tone = { paid: 'good', unpaid: 'grey', refunded: 'bad', failed: 'bad' }[s] ?? 'grey';
  return `<span class="tag ${tone}">${esc(s ?? '—')}</span>`;
};

/** In Stock / Low Stock / Out of Stock (§6). Threshold comes from settings. */
export function stockTag(available, low = 5) {
  if (available <= 0) return '<span class="tag bad">Out of Stock</span>';
  if (available <= low) return `<span class="tag warn">Low Stock</span>`;
  return '<span class="tag good">In Stock</span>';
}

export const visToggle = (isActive, id) => `
  <button class="vis ${isActive ? 'on' : ''}" data-toggle-vis="${esc(id)}"
          title="${isActive ? 'Visible on the store — click to hide' : 'Hidden — click to show'}">
    <span class="bulb"></span>${isActive ? 'Visible' : 'Hidden'}
  </button>`;

/* --------------------------------------------------------------- toasts */

export function toast(message, { title = null, tone = 'ok', ms = 3600 } = {}) {
  const wrap = $('#toasts');
  if (!wrap) return;
  const t = document.createElement('div');
  t.className = `toast ${tone}`;
  t.innerHTML = title
    ? `<div><b>${esc(title)}</b><small>${esc(message)}</small></div>`
    : `<div>${esc(message)}</div>`;
  wrap.appendChild(t);
  setTimeout(() => t.remove(), ms);
}

export const ok   = (m, t) => toast(m, { title: t, tone: 'ok' });
export const fail = (m, t) => toast(m, { title: t ?? 'Something went wrong', tone: 'bad', ms: 6000 });
export const info = (m, t) => toast(m, { title: t, tone: 'info' });

/** Show a caught error without leaking internals. */
export function showError(e) {
  const msg = e?.message || 'Unexpected error.';
  fail(msg);
  if (e?.code !== 'NOT_CONFIGURED') console.error('[BJmeem admin]', e);
}

/* ------------------------------------------------------------ dialogues */

/** Confirmation before anything destructive (§19). Resolves true/false. */
export function confirmAction({ title = 'Are you sure?', body = '', confirm = 'Confirm',
                                danger = true } = {}) {
  return new Promise((resolve) => {
    const modal = $('#confirmModal');
    $('#confirmTitle').textContent = title;
    $('#confirmBody').textContent = body;
    const okBtn = $('#confirmOk');
    okBtn.textContent = confirm;
    okBtn.className = `btn ${danger ? 'btn-danger' : 'btn-primary'}`;
    modal.hidden = false;

    const done = (v) => {
      modal.hidden = true;
      okBtn.removeEventListener('click', yes);
      $('#confirmCancel').removeEventListener('click', no);
      modal.removeEventListener('click', backdrop);
      document.removeEventListener('keydown', onKey);
      resolve(v);
    };
    const yes = () => done(true);
    const no = () => done(false);
    const backdrop = (e) => { if (e.target === modal) done(false); };
    const onKey = (e) => { if (e.key === 'Escape') done(false); };

    okBtn.addEventListener('click', yes);
    $('#confirmCancel').addEventListener('click', no);
    modal.addEventListener('click', backdrop);
    document.addEventListener('keydown', onKey);
    setTimeout(() => okBtn.focus(), 40);
  });
}

/**
 * Open the generic form modal.
 * @param {{title:string, body:string, submit?:string, wide?:boolean,
 *          onMount?:(card:HTMLElement)=>void,
 *          onSubmit?:(form:HTMLFormElement, card:HTMLElement)=>Promise<boolean|void>}} opts
 */
export function openForm({ title, body, submit = 'Save', wide = false, onMount, onSubmit }) {
  const modal = $('#formModal');
  const card = $('#formModalCard');
  card.style.width = wide ? 'min(100%, 920px)' : '';
  card.innerHTML = `
    <div class="modal-head">
      <h2>${esc(title)}</h2>
      <span class="spacer"></span>
      <button class="icon-btn" data-close aria-label="Close">&times;</button>
    </div>
    <form id="modalForm" novalidate>
      ${body}
      <p class="form-error" id="modalError" hidden></p>
      <div class="modal-actions">
        <button type="button" class="btn btn-ghost" data-close>Cancel</button>
        <button type="submit" class="btn btn-primary" id="modalSubmit">${esc(submit)}</button>
      </div>
    </form>`;
  modal.hidden = false;

  const close = () => {
    modal.hidden = true;
    card.innerHTML = '';
    document.removeEventListener('keydown', onKey);
  };
  const onKey = (e) => { if (e.key === 'Escape') close(); };
  document.addEventListener('keydown', onKey);

  card.querySelectorAll('[data-close]').forEach((b) => b.addEventListener('click', close));
  modal.onclick = (e) => { if (e.target === modal) close(); };

  const form = card.querySelector('#modalForm');
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const btn = card.querySelector('#modalSubmit');
    const errBox = card.querySelector('#modalError');
    errBox.hidden = true;
    btn.disabled = true;
    const original = btn.textContent;
    btn.textContent = 'Saving…';
    try {
      const keepOpen = await onSubmit?.(form, card);
      if (keepOpen !== true) close();
    } catch (err) {
      errBox.textContent = err?.message || 'Could not save.';
      errBox.hidden = false;
      if (err?.code !== 'NOT_CONFIGURED') console.error('[BJmeem admin]', err);
    } finally {
      btn.disabled = false;
      btn.textContent = original;
    }
  });

  onMount?.(card);
  setTimeout(() => card.querySelector('input,select,textarea')?.focus(), 50);
  return { close };
}

export const closeForm = () => { $('#formModal').hidden = true; $('#formModalCard').innerHTML = ''; };

/** Read a form into a plain object; checkboxes become booleans. */
export function formData(form) {
  const out = {};
  for (const el of form.elements) {
    if (!el.name) continue;
    out[el.name] = el.type === 'checkbox' ? el.checked
                 : el.type === 'number' ? (el.value === '' ? null : Number(el.value))
                 : el.value.trim();
  }
  return out;
}

/* -------------------------------------------------------------- states */

export const skeleton = (rows = 5) =>
  `<div class="panel"><div class="panel-body">${
    Array.from({ length: rows }, (_, i) =>
      `<div class="skeleton" style="width:${100 - i * 7}%"></div>`).join('')
  }</div></div>`;

export const emptyState = (title, note = '', bear = '🧸') => `
  <div class="empty"><span class="bear">${bear}</span>
    <h3>${esc(title)}</h3>${note ? `<p>${esc(note)}</p>` : ''}</div>`;

/** Horizontal bar chart for the reports screen. */
export function barChart(rows, valueKey = 'units', labelKey = 'name') {
  if (!rows?.length) return emptyState('No data yet', 'Sales will appear here.', '📊');
  const max = Math.max(...rows.map((r) => Number(r[valueKey]) || 0), 1);
  return `<div class="bars">${rows.map((r) => `
    <div class="bar-row">
      <span class="lbl">${esc(r[labelKey])}</span>
      <span class="track"><span class="fill" style="width:${
        Math.max((Number(r[valueKey]) || 0) / max * 100, 2)}%"></span></span>
      <span class="val">${num(r[valueKey])}</span>
    </div>`).join('')}</div>`;
}

/** Column chart of a sales time series. */
export function sparkChart(series) {
  if (!series?.length) return emptyState('No sales in this period', '', '📈');
  const max = Math.max(...series.map((s) => Number(s.revenue) || 0), 1);
  return `<div class="spark">${series.map((s) => `
    <i style="height:${Math.max((Number(s.revenue) || 0) / max * 100, 2)}%"
       title="${esc(fmtDate(s.bucket))} — ${esc(kwd(s.revenue))} (${s.orders} orders)"></i>
  `).join('')}</div>`;
}
