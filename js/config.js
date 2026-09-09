/**
 * BJmeem — public runtime configuration.
 *
 * These two values are PUBLIC by design. The anon key is safe to ship in the
 * browser: every table is protected by Row Level Security and all money and
 * inventory logic runs in SECURITY DEFINER functions on the server.
 *
 *   NEVER put SUPABASE_SERVICE_ROLE_KEY in this file. It belongs only in
 *   Supabase Edge Function secrets. See supabase/README.md.
 *
 * Fill these in from Supabase → Project Settings → API.
 * While they are blank the storefront runs on its built-in demo catalogue and
 * the admin dashboard shows a setup screen instead of failing.
 */
window.BJMEEM_CONFIG = {
  supabaseUrl: '',      // e.g. 'https://abcdefgh.supabase.co'
  supabaseAnonKey: '',  // e.g. 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...'
  siteUrl: typeof location !== 'undefined' ? location.origin : '',
};

/** True once the owner has filled in the two values above. */
window.BJMEEM_CONFIGURED = Boolean(
  window.BJMEEM_CONFIG.supabaseUrl && window.BJMEEM_CONFIG.supabaseAnonKey);
