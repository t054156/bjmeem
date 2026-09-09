/**
 * BJmeem — Supabase browser client.
 *
 * Only the anon (publishable) key belongs here. It is safe to ship: every table
 * is protected by Row Level Security, and everything that decides money or
 * entitlement runs inside SECURITY DEFINER functions on the server.
 *
 * NEVER put the service-role key in this file or anywhere else the browser can
 * reach it. Privileged work belongs in supabase/functions/*.
 *
 * Configure by defining window.BJMEEM_CONFIG before loading this module:
 *
 *   <script>
 *     window.BJMEEM_CONFIG = {
 *       supabaseUrl: 'https://xxxx.supabase.co',
 *       supabaseAnonKey: 'eyJhbGciOi...'
 *     };
 *   </script>
 *   <script type="module" src="js/supabase/index.js"></script>
 */
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

const cfg = (typeof window !== 'undefined' && window.BJMEEM_CONFIG) || {};

/**
 * True once js/config.js has real values. Importing this module before the
 * owner has connected a Supabase project must NOT throw: the storefront falls
 * back to its built-in catalogue, and the admin dashboard shows a setup screen.
 */
export const isConfigured = Boolean(cfg.supabaseUrl && cfg.supabaseAnonKey);

export const supabase = isConfigured
  ? createClient(cfg.supabaseUrl, cfg.supabaseAnonKey, {
      auth: {
        persistSession: true,      // "stay logged in"
        autoRefreshToken: true,
        detectSessionInUrl: true,  // email-verification and reset links land here
        storageKey: 'bjmeem.auth',
      },
      global: { headers: { 'x-application-name': 'bjmeem-web' } },
    })
  // Any call on the stub rejects with a clear, catchable error rather than
  // "cannot read property of undefined" three frames deep.
  : new Proxy({}, {
      get() {
        return () => {
          throw new BJmeemError(
            'BJmeem is not connected to Supabase yet. Add your project URL and ' +
            'anon key to js/config.js.', 'NOT_CONFIGURED');
        };
      },
    });

/* ------------------------------------------------------------------ errors */

/** Error with a stable `code` the UI can branch on, plus a human message. */
export class BJmeemError extends Error {
  constructor(message, code = 'UNKNOWN', cause = null) {
    super(message);
    this.name = 'BJmeemError';
    this.code = code;
    this.cause = cause;
  }
}

// Postgres RAISE messages arrive as "CODE: human readable detail".
const MESSAGES = {
  AUTH_REQUIRED:        'Please log in to continue.',
  ADDRESS_NOT_FOUND:    'We could not find that delivery address.',
  ORDER_NOT_FOUND:      'We could not find that order.',
  CART_EMPTY:           'Your bag is empty.',
  CHECKOUT_BLOCKED:     'Some items in your bag are no longer available.',
  NOT_CANCELLABLE:      'This order has already been dispatched and cannot be cancelled here.',
  INSUFFICIENT_POINTS:  'You do not have enough Cozy Points for that reward.',
  PRIVILEGED_COLUMN:    'That field cannot be changed from here.',
  ORDER_READONLY:       'Orders cannot be edited directly.',
  LEDGER_APPEND_ONLY:   'Loyalty history cannot be modified.',
  FORBIDDEN:            'You do not have permission to do that.',
  STOCK_BELOW_RESERVED: 'There are live orders holding more stock than that.',
  VARIANT_NOT_FOUND:    'That size and colour is no longer available.',
};

/** Normalise a PostgREST / GoTrue error into a BJmeemError. */
export function toError(error) {
  if (!error) return null;
  const raw = error.message || String(error);
  const match = raw.match(/^([A-Z][A-Z0-9_]{2,}):?\s*(.*)$/);
  const code = match ? match[1] : (error.code || 'UNKNOWN');
  const detail = match && match[2] ? match[2] : raw;
  return new BJmeemError(MESSAGES[code] || detail || 'Something went wrong.', code, error);
}

/** Await a Supabase call and throw a normalised error instead of returning one. */
export async function run(promise) {
  const { data, error } = await promise;
  if (error) throw toError(error);
  return data;
}

/** Call a database function (RPC). */
export async function rpc(fn, args = {}) {
  return run(supabase.rpc(fn, args));
}

/** Resolve the current user id, or null when signed out. */
export async function currentUserId() {
  const { data } = await supabase.auth.getUser();
  return data?.user?.id ?? null;
}

/** Public URL for an object in a storage bucket. */
export function storageUrl(bucket, path) {
  if (!path) return null;
  if (/^https?:\/\//i.test(path)) return path;
  return supabase.storage.from(bucket).getPublicUrl(path).data.publicUrl;
}
