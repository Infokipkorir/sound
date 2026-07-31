/**
 * auth.js — shared session guard for every admin page.
 *
 * AUTH MODEL (post-migration): this dashboard authenticates against real
 * Supabase Auth (sb.auth.signInWithPassword, in admin-login.html). A
 * Supabase Auth session is the source of truth for "is this person signed
 * in"; `admin_users` is now a *profile* table keyed by id = auth.users.id
 * (role, badge, status) and should be RLS-locked to `auth.uid() = id`.
 * Because `auth.uid()` is now populated on every request, RLS policies
 * elsewhere (e.g. private storage buckets) can finally key off it too.
 */
window.adminRecord = null;
window.currentUser = null;

/** Call at the top of every protected page. Redirects to admin-login.html if not signed in. */
async function requireAuth() {
  const { data: { session }, error: sessionErr } = await sb.auth.getSession();
  if (sessionErr || !session) {
    redirectToLogin();
    return null;
  }
  try {
    const { data, error } = await sb.from('admin_users')
      .select('*')
      .eq('id', session.user.id)
      .eq('status', 'Active')
      .maybeSingle();
    if (error || !data) {
      // Authenticated with Supabase, but not an active admin — don't leave
      // a dangling auth session sitting around for a deactivated account.
      await sb.auth.signOut();
      redirectToLogin();
      return null;
    }
    window.adminRecord = data;
    window.currentUser = { id: session.user.id, email: session.user.email, role: data.role };
    renderTopbarUser(data);
    return data;
  } catch (err) {
    console.error('requireAuth failed', err);
    redirectToLogin();
    return null;
  }
}

function redirectToLogin() {
  const here = encodeURIComponent(location.pathname + location.search);
  location.href = `admin-login.html?next=${here}`;
}

function renderTopbarUser(data) {
  const nameEl = document.getElementById('sb-admin-name');
  const avatarEl = document.getElementById('sb-avatar');
  if (nameEl) nameEl.textContent = data.username;
  if (avatarEl) avatarEl.textContent = getInitials(data.username);
}

async function handleLogout() {
  if (typeof teardownRealtimeSubscriptions === 'function') teardownRealtimeSubscriptions();
  window.adminRecord = null;
  window.currentUser = null;
  await sb.auth.signOut();
  location.href = 'admin-login.html';
}
