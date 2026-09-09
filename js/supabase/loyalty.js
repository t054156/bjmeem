/** BJmeem — Cozy Club: card, ledger, rewards, coupons, referrals. */
import { supabase, run, rpc, currentUserId, BJmeemError } from './client.js';

/**
 * Everything the digital loyalty card needs: member number, tier, balance and
 * progress to the next tier. Tier names and thresholds come from the database,
 * never hard-coded here.
 */
export async function getLoyaltyAccount() {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to see your card.', 'AUTH_REQUIRED');
  return rpc('get_loyalty_card');
}

export async function getLoyaltyTiers() {
  return run(supabase.from('loyalty_tiers').select('*')
    .eq('is_active', true).order('min_points'));
}

/**
 * Point history: "+15 points — Order BJ-2026-000123".
 */
export async function getLoyaltyTransactions({ limit = 50, offset = 0 } = {}) {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');

  const rows = await run(supabase.from('loyalty_transactions')
    .select('id, transaction_type, points, description, balance_after, expires_at, created_at, order_id')
    .order('created_at', { ascending: false })
    .range(offset, offset + limit - 1));

  return rows.map((t) => ({
    ...t,
    sign: t.points > 0 ? '+' : '',
    label: `${t.points > 0 ? '+' : ''}${t.points} points — ${t.description}`,
    isCredit: t.points > 0,
  }));
}

export async function getRewards() {
  return run(supabase.from('loyalty_rewards').select('*')
    .eq('is_active', true).order('points_required'));
}

/** Rewards annotated with whether this customer can actually afford them. */
export async function getAvailableRewards() {
  const [card, rewards] = await Promise.all([getLoyaltyAccount(), getRewards()]);
  const balance = card?.points_balance ?? 0;
  return rewards.map((r) => ({
    ...r,
    affordable: balance >= r.points_required,
    pointsShort: Math.max(r.points_required - balance, 0),
  }));
}

/**
 * Stake a reward against the cart. Points are only debited when the order is
 * actually placed, so abandoning the cart never costs the customer anything.
 * Pass null to clear.
 */
export async function redeemReward(rewardId) {
  const result = await rpc('redeem_loyalty_reward', { p_reward_id: rewardId ?? null });
  if (result && result.applied === false && result.reason !== 'CLEARED') {
    const messages = {
      REWARD_NOT_FOUND: 'That reward is no longer available.',
      INSUFFICIENT_POINTS: `You need ${result.required} points and have ${result.balance}.`,
      TIER_NOT_ELIGIBLE: 'That reward is for a higher Cozy Club tier.',
    };
    throw new BJmeemError(messages[result.reason] ?? 'That reward could not be applied.',
      result.reason);
  }
  return result;
}

/* ------------------------------------------------------------------ coupons */

/** Validate without applying — for instant feedback as the customer types. */
export async function validateCoupon(code, subtotal = null) {
  return rpc('validate_coupon', { p_code: code, p_subtotal: subtotal });
}

/** Apply to the cart so preview and checkout both see it. Pass null to clear. */
export async function applyCoupon(code) {
  const result = await rpc('apply_coupon_to_cart', { p_code: code ?? null });
  if (result && result.valid === false) {
    const messages = {
      NOT_FOUND: 'That code is not recognised.',
      INACTIVE: 'That code is no longer active.',
      EXPIRED: 'That code has expired.',
      NOT_STARTED: 'That code is not active yet.',
      USAGE_LIMIT_REACHED: 'That code has been fully claimed.',
      ALREADY_USED: 'You have already used that code.',
      FIRST_ORDER_ONLY: 'That code is for first orders only.',
      TIER_NOT_ELIGIBLE: 'That code is for a higher Cozy Club tier.',
      MEMBERS_ONLY: 'Please log in to use that code.',
      MINIMUM_NOT_MET: `Spend at least ${Number(result.minimum_order_amount).toFixed(3)} KWD to use that code.`,
    };
    throw new BJmeemError(messages[result.reason] ?? 'That code cannot be used.', result.reason);
  }
  return result;
}

export const clearCoupon = () => applyCoupon(null);

/** Publicly advertised offers. Targeted codes stay hidden until typed. */
export async function getAvailableCoupons() {
  return run(supabase.from('coupons')
    .select('code, description, discount_type, discount_value, minimum_order_amount, expires_at')
    .eq('is_active', true).eq('is_public', true)
    .order('expires_at', { ascending: true, nullsFirst: false }));
}

/* ---------------------------------------------------------------- referrals */

export async function getReferralInfo() {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');

  const [profile, referrals] = await Promise.all([
    run(supabase.from('profiles').select('referral_code').eq('id', uid).single()),
    run(supabase.from('referrals').select('id, status, reward_given, created_at')
      .eq('referrer_user_id', uid).order('created_at', { ascending: false })),
  ]);

  const site = window.BJMEEM_CONFIG?.siteUrl || window.location.origin;
  return {
    code: profile.referral_code,
    shareUrl: `${site}/#/signup?ref=${encodeURIComponent(profile.referral_code ?? '')}`,
    total: referrals.length,
    rewarded: referrals.filter((r) => r.reward_given).length,
    pending: referrals.filter((r) => r.status === 'pending').length,
    referrals,
  };
}
