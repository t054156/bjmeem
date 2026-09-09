/** BJmeem — profile, saved addresses, notifications. */
import { supabase, run, rpc, currentUserId, storageUrl, BJmeemError } from './client.js';

/* ------------------------------------------------------------------ profile */

export async function getProfile() {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');
  return run(supabase.from('profiles').select('*').eq('id', uid).single());
}

/**
 * Update the customer's own details. role / loyalty_points / total_spent /
 * total_orders are rejected by a database trigger, so they are stripped here
 * to give a clear client-side error rather than a server rejection.
 */
export async function updateProfile(patch = {}) {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');

  const allowed = ['first_name', 'last_name', 'phone_number', 'date_of_birth',
                   'gender', 'avatar_url', 'marketing_opt_in'];
  const body = {};
  for (const k of allowed) if (k in patch) body[k] = patch[k];
  if (Object.keys(body).length === 0) {
    throw new BJmeemError('Nothing to update.', 'NO_CHANGES');
  }

  return run(supabase.from('profiles').update(body).eq('id', uid).select().single());
}

/** Upload an avatar into avatars/<uid>/… and save the public URL. */
export async function uploadAvatar(file) {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');

  const ext = (file.name?.split('.').pop() || 'jpg').toLowerCase();
  const path = `${uid}/avatar-${Date.now()}.${ext}`;

  await run(supabase.storage.from('avatars')
    .upload(path, file, { upsert: true, contentType: file.type }));

  const url = storageUrl('avatars', path);
  await updateProfile({ avatar_url: url });
  return url;
}

/* ---------------------------------------------------------------- addresses */

export async function getAddresses() {
  return run(supabase.from('addresses').select('*')
    .order('is_default', { ascending: false })
    .order('created_at', { ascending: true }));
}

export async function getDefaultAddress() {
  const rows = await run(supabase.from('addresses').select('*').eq('is_default', true).limit(1));
  return rows[0] ?? null;
}

/**
 * @param {{label,fullName,phone,governorate,area,block,street,avenue,
 *          buildingNumber,floor,apartment,directions,latitude,longitude,
 *          isDefault,country}} a
 */
export async function createAddress(a = {}) {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');

  for (const [field, label] of [['fullName', 'full name'], ['phone', 'phone number'],
       ['governorate', 'governorate'], ['area', 'area'], ['block', 'block'],
       ['street', 'street'], ['buildingNumber', 'building number']]) {
    if (!a[field] || !String(a[field]).trim()) {
      throw new BJmeemError(`Please enter the ${label}.`, 'FIELD_REQUIRED');
    }
  }

  return run(supabase.from('addresses').insert({
    user_id: uid,
    label: a.label ?? 'home',
    full_name: a.fullName,
    phone_number: a.phone,
    country: a.country ?? 'Kuwait',
    governorate: a.governorate,
    area: a.area,
    block: a.block,
    street: a.street,
    avenue: a.avenue ?? null,
    building_number: a.buildingNumber,
    floor: a.floor ?? null,
    apartment: a.apartment ?? null,
    additional_directions: a.directions ?? null,
    // Coordinates are optional and only ever the delivery destination the
    // customer chose. The app does not track people.
    latitude: a.latitude ?? null,
    longitude: a.longitude ?? null,
    is_default: !!a.isDefault,
  }).select().single());
}

export async function updateAddress(id, patch = {}) {
  const map = {
    label: 'label', fullName: 'full_name', phone: 'phone_number', country: 'country',
    governorate: 'governorate', area: 'area', block: 'block', street: 'street',
    avenue: 'avenue', buildingNumber: 'building_number', floor: 'floor',
    apartment: 'apartment', directions: 'additional_directions',
    latitude: 'latitude', longitude: 'longitude', isDefault: 'is_default',
  };
  const body = {};
  for (const [k, col] of Object.entries(map)) if (k in patch) body[col] = patch[k];
  if (!Object.keys(body).length) throw new BJmeemError('Nothing to update.', 'NO_CHANGES');

  return run(supabase.from('addresses').update(body).eq('id', id).select().single());
}

export async function deleteAddress(id) {
  await run(supabase.from('addresses').delete().eq('id', id));
  return true;
}

/** The database clears the previous default automatically. */
export async function setDefaultAddress(id) {
  return run(supabase.from('addresses').update({ is_default: true }).eq('id', id).select().single());
}

/** Delivery fee + ETA for a governorate, so checkout can quote before saving. */
export async function getDeliveryZone(governorate) {
  return rpc('resolve_delivery_zone', { p_governorate: governorate });
}

export async function getDeliveryZones() {
  return run(supabase.from('delivery_zones').select('*').eq('is_active', true).order('name'));
}

/* ------------------------------------------------------------ notifications */

export async function getNotifications({ unreadOnly = false, limit = 30 } = {}) {
  let q = supabase.from('notifications').select('*')
    .order('created_at', { ascending: false }).limit(limit);
  if (unreadOnly) q = q.eq('is_read', false);
  return run(q);
}

export async function getUnreadCount() {
  const { count, error } = await supabase.from('notifications')
    .select('id', { count: 'exact', head: true }).eq('is_read', false);
  if (error) throw error;
  return count ?? 0;
}

export async function markNotificationRead(id) {
  return run(supabase.from('notifications').update({ is_read: true }).eq('id', id).select().single());
}

export async function markAllNotificationsRead() {
  const uid = await currentUserId();
  if (!uid) throw new BJmeemError('Please log in to continue.', 'AUTH_REQUIRED');
  await run(supabase.from('notifications').update({ is_read: true })
    .eq('user_id', uid).eq('is_read', false));
  return true;
}

/** Live notification stream. Returns an unsubscribe function. */
export function onNotification(handler) {
  const channel = supabase.channel('bjmeem-notifications')
    .on('postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'notifications' },
        (payload) => handler(payload.new))
    .subscribe();
  return () => supabase.removeChannel(channel);
}
