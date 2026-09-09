/** BJmeem — authentication. Supabase Auth handles verification + reset email. */
import { supabase, run, toError, BJmeemError } from './client.js';

const SITE = () => (window.BJMEEM_CONFIG?.siteUrl || window.location.origin);

/**
 * Register. Profile, loyalty account, member number, referral code and the
 * signup bonus are all created server-side by the on_auth_user_created trigger,
 * so there is nothing to insert from here.
 *
 * @param {{email,password,firstName,lastName,phone,dateOfBirth,gender,referralCode}} input
 */
export async function signUpUser({
  email, password, firstName, lastName, phone, dateOfBirth, gender, referralCode,
} = {}) {
  if (!email) throw new BJmeemError('Please enter your email address.', 'EMAIL_REQUIRED');
  if (!password || password.length < 6) {
    throw new BJmeemError('Password must be at least 6 characters.', 'WEAK_PASSWORD');
  }

  const data = await run(supabase.auth.signUp({
    email: email.trim(),
    password,
    options: {
      emailRedirectTo: `${SITE()}/#/account`,
      data: {
        first_name: firstName ?? null,
        last_name: lastName ?? null,
        phone_number: phone ?? null,
        date_of_birth: dateOfBirth ?? null,
        gender: gender ?? null,
        referral_code: referralCode ? referralCode.toUpperCase().trim() : null,
      },
    },
  }));

  return {
    user: data.user,
    session: data.session,
    // With email confirmation on, session is null until the link is clicked.
    needsEmailVerification: !data.session,
  };
}

export async function loginUser(email, password) {
  if (!email) throw new BJmeemError('Please enter your email address.', 'EMAIL_REQUIRED');
  if (!password) throw new BJmeemError('Please enter your password.', 'PASSWORD_REQUIRED');

  const data = await run(supabase.auth.signInWithPassword({
    email: email.trim(), password,
  }));
  return { user: data.user, session: data.session };
}

export async function logoutUser() {
  const { error } = await supabase.auth.signOut();
  if (error) throw toError(error);
  return true;
}

/** Sends the reset link. The user lands on #/reset-password with a session. */
export async function resetPassword(email) {
  if (!email) throw new BJmeemError('Please enter your email address.', 'EMAIL_REQUIRED');
  await run(supabase.auth.resetPasswordForEmail(email.trim(), {
    redirectTo: `${SITE()}/#/reset-password`,
  }));
  return true;
}

/** Call after the user follows the reset link. */
export async function updatePassword(newPassword) {
  if (!newPassword || newPassword.length < 6) {
    throw new BJmeemError('Password must be at least 6 characters.', 'WEAK_PASSWORD');
  }
  return run(supabase.auth.updateUser({ password: newPassword }));
}

export async function resendVerification(email) {
  await run(supabase.auth.resend({
    type: 'signup', email: email.trim(),
    options: { emailRedirectTo: `${SITE()}/#/account` },
  }));
  return true;
}

export async function getSession() {
  const { data } = await supabase.auth.getSession();
  return data.session ?? null;
}

export async function getCurrentUser() {
  const { data } = await supabase.auth.getUser();
  return data.user ?? null;
}

export async function isLoggedIn() {
  return (await getSession()) !== null;
}

/**
 * Subscribe to login/logout. Returns an unsubscribe function.
 * @param {(event: string, session: object|null) => void} handler
 */
export function onAuthChange(handler) {
  const { data } = supabase.auth.onAuthStateChange((event, session) => handler(event, session));
  return () => data.subscription.unsubscribe();
}
