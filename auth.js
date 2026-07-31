/**
 * auth.js — shared session guard for every admin page.
 *
 * NOTE ON THE CURRENT AUTH MODEL: this dashboard authenticates against a
 * plain `admin_users` table (username/password columns), NOT Supabase Auth.
 * That means `sb.auth` never has a real session and `auth.uid()` is always
 * null for every request this dashboard makes — which is also why private
 * storage buckets (id_verification, selfie-verification, Certificate)
 * can't be read from here yet (see the document-viewer conversation).
 * This file preserves that existing behaviour as-is during the refactor;
 * it does not change the auth model. If/when you move to real Supabase
 * Auth for admins, this is the one file that needs to change.
 */
window.adminRecord = null;
window.currentUser = null;

/** Call at the top of every protected page. Redirects to admin-login.html if not signed in. */
async function requireAuth() {
  const stored = localStorage.getItem('sc_admin_session');
  if (!stored) {
    redirectToLogin();
    return null;
  }
  try {
    const sess = JSON.parse(stored);
    const { data, error } = await sb.from('admin_users')
      .select('*')
      .eq('id', sess.id)
      .eq('status', 'Active')
      .maybeSingle();
    if (error || !data) {
      redirectToLogin();
      return null;
    }
    window.adminRecord = data;
    window.currentUser = { id: data.id, email: data.username + '@soundscare.admin', role: data.role };
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
  localStorage.removeItem('sc_admin_session');
  location.href = 'admin-login.html';
}
