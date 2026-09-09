// Transactional email: provider adapter + BJmeem templates.
// The provider key lives only in Edge Function secrets, never in the browser.

export const BRAND = {
  name: 'BJmeem',
  tagline: 'Made for cozy nights.',
  cream: '#FDF8F3',
  ink: '#4A3B36',
  pink: '#E17E9C',
  mocha: '#B98457',
  line: '#EFE3D8',
};

export interface EmailPayload {
  to_email: string;
  to_name?: string | null;
  template: string;
  subject: string;
  payload: Record<string, unknown>;
}

const money = (n: unknown) => Number(n ?? 0).toFixed(3);

function layout(title: string, bodyHtml: string, footerNote?: string) {
  return `<!doctype html><html><body style="margin:0;background:${BRAND.cream};
    font-family:'Segoe UI',Helvetica,Arial,sans-serif;color:${BRAND.ink}">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
         style="background:${BRAND.cream};padding:28px 12px">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0"
             style="max-width:560px;background:#fff;border:1px solid ${BRAND.line};
                    border-radius:20px;overflow:hidden">
        <tr><td style="padding:26px 28px 8px;text-align:center">
          <div style="font-size:26px;font-weight:700;color:${BRAND.mocha}">🧸 ${BRAND.name}</div>
        </td></tr>
        <tr><td style="padding:6px 28px 4px">
          <h1 style="margin:0 0 12px;font-size:21px;color:${BRAND.ink}">${title}</h1>
          ${bodyHtml}
        </td></tr>
        <tr><td style="padding:22px 28px 28px;border-top:1px solid ${BRAND.line};
                       color:#94807A;font-size:12px;text-align:center">
          ${footerNote ? `<p style="margin:0 0 8px">${footerNote}</p>` : ''}
          <p style="margin:0">Packed with love from ${BRAND.name} ♡ &middot; ${BRAND.tagline}</p>
        </td></tr>
      </table>
    </td></tr>
  </table></body></html>`;
}

function itemsTable(items: any[]) {
  if (!Array.isArray(items) || items.length === 0) return '';
  const rows = items.map((i) => `
    <tr>
      <td style="padding:8px 0;border-bottom:1px solid ${BRAND.line}">
        <b>${i.name ?? i.product_name ?? ''}</b><br>
        <span style="color:#94807A;font-size:13px">${i.size ?? ''} · ${i.color ?? ''} × ${i.quantity ?? 1}</span>
      </td>
      <td style="padding:8px 0;border-bottom:1px solid ${BRAND.line};text-align:right;white-space:nowrap">
        ${money(i.total_price)} KWD
      </td>
    </tr>`).join('');
  return `<table role="presentation" width="100%" style="margin:14px 0;font-size:14px">${rows}</table>`;
}

function addressBlock(a: any) {
  if (!a || typeof a !== 'object') return '';
  const parts = [a.area, a.block && `Block ${a.block}`, a.street && `Street ${a.street}`,
                 a.building_number && `Building ${a.building_number}`,
                 a.floor && `Floor ${a.floor}`, a.apartment && `Apt ${a.apartment}`,
                 a.governorate].filter(Boolean).join(', ');
  return `<p style="margin:12px 0 0;font-size:13px;color:#6E5A52">
            <b>Delivering to</b><br>${a.full_name ?? ''}<br>${parts}</p>`;
}

const trackButton = (orderNumber: string, siteUrl: string) => `
  <p style="margin:20px 0 4px">
    <a href="${siteUrl}/#/track?order=${encodeURIComponent(orderNumber)}"
       style="display:inline-block;background:${BRAND.pink};color:#fff;text-decoration:none;
              padding:12px 26px;border-radius:999px;font-weight:700">Track your order</a>
  </p>`;

const STATUS_COPY: Record<string, string> = {
  order_received:    'We have your order and will confirm it shortly.',
  order_confirmed:   'Your order is confirmed and heading into production.',
  order_preparing:   'We are folding and wrapping your pieces right now.',
  order_packed:      'Your parcel is packed and waiting for the courier.',
  order_out_for_delivery: 'Your order is out for delivery today.',
  order_delivered:   'Delivered. We hope it is as soft as it looks.',
  order_cancelled:   'Your order has been cancelled. No charge has been made.',
  order_returned:    'We have received your return.',
  order_refunded:    'Your refund has been processed and is on its way back to you.',
};

/** Render one queued row into a subject + HTML body. */
export function render(row: EmailPayload, siteUrl: string): { subject: string; html: string } {
  const p = row.payload ?? {} as any;
  const name = (p.customer_name ?? p.first_name ?? row.to_name ?? 'there') as string;

  if (row.template === 'welcome') {
    return {
      subject: row.subject,
      html: layout(`Welcome to BJmeem, ${name} 🧸`, `
        <p style="margin:0 0 10px">Your Cozy Club account is ready.</p>
        <p style="margin:0 0 10px">Member number <b>${p.member_number ?? ''}</b></p>
        ${p.signup_bonus ? `<p style="margin:0">We have added <b>${p.signup_bonus} Cozy Points</b>
          to get you started.</p>` : ''}
        <p style="margin:20px 0 4px">
          <a href="${siteUrl}/#/shop" style="display:inline-block;background:${BRAND.pink};
             color:#fff;text-decoration:none;padding:12px 26px;border-radius:999px;
             font-weight:700">Start browsing</a></p>`),
    };
  }

  if (row.template === 'points_expiring') {
    return {
      subject: row.subject,
      html: layout('Your Cozy Points are expiring', `
        <p style="margin:0 0 10px">Hi ${name},</p>
        <p style="margin:0 0 10px"><b>${p.points} Cozy Points</b> expire in ${p.days} days.</p>
        <p style="margin:0">Use them on your next order before they go.</p>`),
    };
  }

  if (row.template === 'birthday_bonus') {
    return {
      subject: row.subject,
      html: layout('Happy birthday 🎀', `
        <p style="margin:0 0 10px">Hi ${name},</p>
        <p style="margin:0">Enjoy <b>${p.points} Cozy Points</b> from all of us at BJmeem.</p>`),
    };
  }

  // Order lifecycle
  const orderNumber = String(p.order_number ?? '');
  const line = STATUS_COPY[row.template] ?? 'There is an update on your order.';
  return {
    subject: row.subject,
    html: layout(`${p.status_label ?? 'Order update'} — ${orderNumber}`, `
      <p style="margin:0 0 10px">Hi ${name},</p>
      <p style="margin:0 0 10px">${line}</p>
      ${itemsTable(p.items as any[])}
      <table role="presentation" width="100%" style="font-size:14px;margin-top:6px">
        ${p.subtotal !== undefined ? `<tr><td>Subtotal</td><td align="right">${money(p.subtotal)} KWD</td></tr>` : ''}
        ${Number(p.discount_amount ?? 0) > 0 ? `<tr><td>Discount</td><td align="right">−${money(p.discount_amount)} KWD</td></tr>` : ''}
        ${Number(p.loyalty_discount ?? 0) > 0 ? `<tr><td>Cozy Points</td><td align="right">−${money(p.loyalty_discount)} KWD</td></tr>` : ''}
        ${p.delivery_fee !== undefined ? `<tr><td>Delivery</td><td align="right">${Number(p.delivery_fee) === 0 ? 'FREE' : money(p.delivery_fee) + ' KWD'}</td></tr>` : ''}
        <tr><td style="padding-top:8px;border-top:1px dashed ${BRAND.line}"><b>Total</b></td>
            <td align="right" style="padding-top:8px;border-top:1px dashed ${BRAND.line}">
            <b>${money(p.total_amount)} KWD</b></td></tr>
      </table>
      ${addressBlock(p.shipping_address)}
      ${p.courier_name ? `<p style="margin:10px 0 0;font-size:13px;color:#6E5A52">
        Courier: ${p.courier_name}${p.tracking_reference ? ` · Ref ${p.tracking_reference}` : ''}</p>` : ''}
      ${trackButton(orderNumber, siteUrl)}`),
  };
}

/** Send through the configured provider. Resend by default; swap here only. */
export async function deliver(
  to: string, toName: string | null, subject: string, html: string,
): Promise<{ ok: boolean; error?: string }> {
  const provider = Deno.env.get('EMAIL_PROVIDER') ?? 'resend';
  const from = Deno.env.get('EMAIL_FROM') ?? 'BJmeem <hello@bjmeem.com>';

  if (provider === 'log') {                       // local development
    console.log('[email:log]', { to, subject });
    return { ok: true };
  }

  if (provider === 'resend') {
    const key = Deno.env.get('RESEND_API_KEY');
    if (!key) return { ok: false, error: 'RESEND_API_KEY is not set' };

    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to: [toName ? `${toName} <${to}>` : to], subject, html }),
    });
    if (!res.ok) return { ok: false, error: `${res.status} ${await res.text()}` };
    return { ok: true };
  }

  return { ok: false, error: `Unknown EMAIL_PROVIDER "${provider}"` };
}
