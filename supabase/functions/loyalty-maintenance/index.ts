// Nightly Cozy Club housekeeping: expire lapsed points, warn customers 30 days
// out, and grant birthday bonuses. All three are idempotent, so a double run
// on the same day is harmless.
//
//   supabase functions deploy loyalty-maintenance --no-verify-jwt
//   schedule: 0 3 * * *  (03:00 Kuwait)

import { createClient } from 'jsr:@supabase/supabase-js@2';

Deno.serve(async (req) => {
  const auth = req.headers.get('Authorization') ?? '';
  const secret = Deno.env.get('CRON_SECRET');
  const serviceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!;
  if (!auth.includes(serviceKey) && (!secret || auth !== `Bearer ${secret}`)) {
    return new Response('Forbidden', { status: 403 });
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, serviceKey, {
    auth: { persistSession: false },
  });

  const results: Record<string, unknown> = {};

  for (const fn of ['expire_loyalty_points', 'notify_expiring_points', 'grant_birthday_bonus']) {
    const { data, error } = await db.rpc(fn);
    results[fn] = error ? { error: error.message } : data;
  }

  return Response.json({ ran_at: new Date().toISOString(), ...results });
});
