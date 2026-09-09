// Drains public.email_queue. Schedule every minute (pg_cron or an external
// scheduler). Mail is sent outside the database transaction on purpose: a
// flaky provider must never be able to roll back an order.
//
//   supabase functions deploy process-email-queue --no-verify-jwt
//   supabase secrets set RESEND_API_KEY=... EMAIL_FROM='BJmeem <hello@bjmeem.com>'

import { createClient } from 'jsr:@supabase/supabase-js@2';
import { render, deliver } from '../_shared/email.ts';

const BATCH = 25;
const MAX_ATTEMPTS = 5;

Deno.serve(async (req) => {
  // Callable only with the service-role key or the cron secret.
  const auth = req.headers.get('Authorization') ?? '';
  const secret = Deno.env.get('CRON_SECRET');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (!auth.includes(serviceKey) && (!secret || auth !== `Bearer ${secret}`)) {
    return new Response('Forbidden', { status: 403 });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, {
    auth: { persistSession: false },
  });
  const siteUrl = Deno.env.get('SITE_URL') ?? 'https://bjmeem.com';

  // Claim a batch so two concurrent runs cannot send the same mail twice.
  const { data: claimed, error: claimErr } = await db
    .from('email_queue')
    .update({ status: 'sending' })
    .eq('status', 'pending')
    .lte('scheduled_at', new Date().toISOString())
    .lt('attempts', MAX_ATTEMPTS)
    .select('id, to_email, to_name, template, subject, payload, attempts')
    .limit(BATCH);

  if (claimErr) {
    return Response.json({ error: claimErr.message }, { status: 500 });
  }

  let sent = 0, failed = 0;

  for (const row of claimed ?? []) {
    try {
      const { subject, html } = render(row as any, siteUrl);
      const res = await deliver(row.to_email, row.to_name, subject, html);

      if (res.ok) {
        await db.from('email_queue')
          .update({ status: 'sent', sent_at: new Date().toISOString(),
                    attempts: row.attempts + 1, last_error: null })
          .eq('id', row.id);
        sent++;
      } else {
        throw new Error(res.error ?? 'unknown provider error');
      }
    } catch (e) {
      const attempts = row.attempts + 1;
      // Exponential backoff, then park it as failed for a human to look at.
      await db.from('email_queue').update({
        status: attempts >= MAX_ATTEMPTS ? 'failed' : 'pending',
        attempts,
        last_error: String((e as Error).message).slice(0, 500),
        scheduled_at: new Date(Date.now() + Math.min(2 ** attempts, 60) * 60_000).toISOString(),
      }).eq('id', row.id);
      failed++;
    }
  }

  return Response.json({ claimed: claimed?.length ?? 0, sent, failed });
});
