/* SoundsCare admin: Profile settings (set / change password, set / test / remove passkey).
   Drop into EVERY admin page, just before </body>:
     <script src="config.js"></script>
     <script src="admin-profile.js"></script>
   It reuses the page's own Supabase client when there is one (window.__adminSb or a global `sb`),
   otherwise it builds one from config.js with the same sessionStorage session as the login page.
   It adds a "Profile settings" button to the sidebar footer and opens a modal. Pages can also call
   window.openProfileSettings(). Styles live in admin-theme.css (.ap-*). */
(function () {
  'use strict';

  function getClient() {
    if (window.__adminSb) return window.__adminSb;
    try { if (typeof sb !== 'undefined' && sb && sb.auth) return sb; } catch (e) {}
    var C = window.SOUNDS_CONFIG;
    if (C && C.supabaseUrl && window.supabase) {
      return window.supabase.createClient(C.supabaseUrl, C.supabaseKey, {
        auth: { persistSession: true, autoRefreshToken: true, storage: window.sessionStorage }
      });
    }
    return null;
  }

  var client = null, row = null, pendingPw = null;

  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function initials(n) { return (n || 'AD').trim().split(/\s+/).slice(0, 2).map(function (w) { return w[0]; }).join('').toUpperCase() || 'AD'; }
  function msg(kind, text) { var m = $('apMsg'); if (!m) return; m.className = 'ap-msg ' + kind; m.textContent = text; m.style.display = text ? 'block' : 'none'; }
  var b64u = {
    enc: function (b) { return btoa(String.fromCharCode.apply(null, new Uint8Array(b))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); },
    dec: function (s) { return Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), function (c) { return c.charCodeAt(0); }); }
  };

  async function deviceLockOk() {
    try { return !!(window.PublicKeyCredential && window.isSecureContext && await PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable()); }
    catch (e) { return false; }
  }
  // Best-effort audit trail (same table the admin dashboard writes to); never blocks the action.
  async function audit(type, text) {
    try { await client.from('admin_audit_logs').insert({ admin_id: row.user_id, action_type: type, action_description: text, target_table: 'admin_users', target_id: row.user_id }); }
    catch (e) { /* ignore */ }
  }

  /* ---------------- rendering ---------------- */
  function renderPasskey() {
    var has = !!(row && row.passkey_id);
    $('apPkStatus').innerHTML = has
      ? '<i class="bi bi-shield-check" style="color:var(--green)"></i><div><strong>Passkey is on</strong><span>Sign in with your fingerprint, pattern or device password.</span></div>'
      : '<i class="bi bi-shield-exclamation" style="color:var(--gold)"></i><div><strong>No passkey yet</strong><span>Set one up to sign in with your device lock.</span></div>';
    $('apPkSet').innerHTML = '<i class="bi bi-shield-plus"></i> ' + (has ? 'Replace with this device' : 'Set up on this device');
    $('apPkTest').style.display = has ? '' : 'none';
    $('apPkRemove').style.display = has ? '' : 'none';
    var chip = document.querySelector('.ap-sidebtn .ap-chip');
    if (chip) chip.style.display = has ? 'none' : '';
  }

  function build() {
    var name = row.username || row.email;
    var role = String(row.role || row.access_level || 'Admin').replace(/_/g, ' ');

    var ov = document.createElement('div');
    ov.id = 'apOverlay'; ov.className = 'ap-overlay';
    ov.innerHTML =
      '<div class="ap-card" role="dialog" aria-modal="true" aria-label="Profile settings">' +
        '<div class="ap-head"><div class="ap-av">' + esc(initials(name)) + '</div>' +
          '<div class="ap-who"><h2>Profile settings</h2><p>' + esc(name) + ' &middot; ' + esc(row.email) + ' &middot; ' + esc(role) + '</p></div>' +
          '<button class="ap-x" id="apClose" type="button" aria-label="Close"><i class="bi bi-x-lg"></i></button></div>' +

        '<h3>Password</h3>' +
        '<p class="ap-note">Set a password to sign in with your email on the login page. Use at least 8 characters.</p>' +
        '<label for="apPwCur">Current password <em>(only if you already have one)</em></label>' +
        '<input id="apPwCur" type="password" autocomplete="current-password">' +
        '<label for="apPw1">New password</label>' +
        '<input id="apPw1" type="password" autocomplete="new-password" placeholder="At least 8 characters">' +
        '<label for="apPw2">Confirm new password</label>' +
        '<input id="apPw2" type="password" autocomplete="new-password">' +
        '<div id="apNonceRow" style="display:none"><label for="apNonce">Code we emailed you</label>' +
          '<input id="apNonce" inputmode="numeric" autocomplete="one-time-code"></div>' +
        '<div class="ap-row"><button class="ap-b" id="apPwSave" type="button"><i class="bi bi-key"></i> Save password</button></div>' +

        '<h3>Passkey: fingerprint, pattern or device password</h3>' +
        '<div class="ap-status" id="apPkStatus"></div>' +
        '<p class="ap-note">Checked on your device and never sent to us. One passkey per account: setting it on a new device replaces the old one. ' +
          'To replace or remove it from a different device, fill in your current password above.</p>' +
        '<div class="ap-row"><button class="ap-b" id="apPkSet" type="button"></button>' +
          '<button class="ap-b sec" id="apPkTest" type="button"><i class="bi bi-check2-circle"></i> Test it</button>' +
          '<button class="ap-b dng" id="apPkRemove" type="button"><i class="bi bi-trash3"></i> Remove</button></div>' +

        '<div class="ap-msg" id="apMsg" style="display:none"></div>' +
        '<div class="ap-foot"><button class="ap-b sec" id="apSignOut" type="button"><i class="bi bi-box-arrow-left"></i> Sign out</button>' +
          '<button class="ap-b sec" id="apDone" type="button">Close</button></div>' +
      '</div>';
    document.body.appendChild(ov);

    function open() { ov.classList.add('show'); msg('', ''); renderPasskey(); }
    function close() { ov.classList.remove('show'); }
    ov.addEventListener('click', function (e) { if (e.target === ov) close(); });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape') close(); });
    $('apClose').onclick = close; $('apDone').onclick = close;
    $('apPwSave').onclick = savePassword;
    $('apPkSet').onclick = setPasskey;
    $('apPkTest').onclick = testPasskey;
    $('apPkRemove').onclick = removePasskey;
    $('apSignOut').onclick = signOut;
    window.openProfileSettings = open;

    // Sidebar entry. Fallback: a small floating button at the bottom-left if the page has no known footer.
    var btn = document.createElement('button');
    btn.type = 'button'; btn.className = 'ap-sidebtn';
    btn.innerHTML = '<i class="bi bi-person-gear"></i><span>Profile settings</span><span class="ap-chip">No passkey</span>';
    btn.onclick = function () { open(); var sbEl = document.getElementById('sidebar') || document.getElementById('sdSidebar'); if (sbEl) sbEl.classList.remove('open'); if (typeof closeSidebarOnMobile === 'function') closeSidebarOnMobile(); };
    var host = document.querySelector('.sb-footer') || document.querySelector('.sd-presence');
    if (host) host.insertBefore(btn, host.firstChild);
    else { btn.classList.add('ap-float'); document.body.appendChild(btn); }
    renderPasskey();
  }

  /* ---------------- identity check ---------------- */
  async function verifyCurrentPassword(pw) {
    var r = await client.auth.signInWithPassword({ email: row.email, password: pw });
    return !r.error;
  }
  // Replacing or removing a passkey needs proof it's really the admin: the device passkey, or the current password.
  async function confirmIdentity() {
    if (row.passkey_id) {
      try {
        await navigator.credentials.get({ publicKey: {
          challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
          allowCredentials: [{ type: 'public-key', id: b64u.dec(row.passkey_id) }], userVerification: 'required', timeout: 60000 } });
        return true;
      } catch (e) { /* not the registered device: fall back to password */ }
    }
    var cur = $('apPwCur').value;
    if (!cur) { msg('err', 'Enter your current password above to confirm it is you, or do this on the device where the passkey was set up.'); return false; }
    if (!(await verifyCurrentPassword(cur))) { msg('err', 'Current password is incorrect.'); return false; }
    return true;
  }

  /* ---------------- password ---------------- */
  async function savePassword() {
    var cur = $('apPwCur').value, p1 = $('apPw1').value, p2 = $('apPw2').value, nonce = $('apNonce').value.trim();
    if (p1.length < 8) return msg('err', 'Use at least 8 characters.');
    if (p1 !== p2) return msg('err', 'The two passwords do not match.');
    var btn = $('apPwSave'); btn.disabled = true; msg('', '');
    try {
      if (cur && !(await verifyCurrentPassword(cur))) throw new Error('Current password is incorrect.');
      var payload = { password: p1 };
      if (pendingPw === p1 && nonce) payload.nonce = nonce;
      var r = await client.auth.updateUser(payload);
      if (r.error) {
        // Projects with "secure password change" on ask for a code emailed to the admin first.
        if (/reauth|nonce/i.test(r.error.message || '')) {
          await client.auth.reauthenticate();
          pendingPw = p1; $('apNonceRow').style.display = '';
          msg('ok', 'We emailed you a code. Enter it above, then press Save password again.');
          btn.disabled = false; return;
        }
        throw r.error;
      }
      pendingPw = null; $('apNonceRow').style.display = 'none';
      ['apPwCur', 'apPw1', 'apPw2', 'apNonce'].forEach(function (id) { $(id).value = ''; });
      if (row.must_change_password) {
        var u = await client.from('admin_users').update({ must_change_password: false }).eq('user_id', row.user_id);
        if (!u.error) row.must_change_password = false;
      }
      audit('set_password', 'Admin set or changed their password');
      msg('ok', 'Password saved. You can now sign in with your email and password.');
    } catch (e) { msg('err', e.message || 'Could not save the password.'); }
    btn.disabled = false;
  }

  /* ---------------- passkey ---------------- */
  async function setPasskey() {
    var btn = $('apPkSet'); btn.disabled = true; msg('', '');
    try {
      if (!(await deviceLockOk())) throw new Error('This device or page cannot use a screen lock. Open the page over https on a device with a fingerprint, pattern or password lock.');
      if (row.passkey_id && !(await confirmIdentity())) { btn.disabled = false; return; }
      var cred = await navigator.credentials.create({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: 'SoundsCare Admin', id: location.hostname },
        user: { id: new TextEncoder().encode(row.user_id), name: row.email, displayName: row.username || row.email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }, { type: 'public-key', alg: -257 }],
        authenticatorSelection: { authenticatorAttachment: 'platform', userVerification: 'required', residentKey: 'required' },
        timeout: 60000 } });
      var id = b64u.enc(cred.rawId);
      var pub = cred.response.getPublicKey ? b64u.enc(cred.response.getPublicKey()) : '';
      var r = await client.rpc('replace_admin_passkey', { cred_id: id, pub_key: pub });
      if (r.error) throw r.error;
      row.passkey_id = id; renderPasskey();
      audit('set_passkey', 'Admin set up a passkey');
      msg('ok', 'Passkey saved. Any earlier passkey was replaced.');
    } catch (e) {
      msg('err', e.name === 'NotAllowedError' ? 'Cancelled or timed out. Make sure this device has a screen lock, then try again.' : (e.message || 'Could not create the passkey.'));
    }
    btn.disabled = false;
  }

  async function testPasskey() {
    if (!row.passkey_id) return;
    try {
      await navigator.credentials.get({ publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)), rpId: location.hostname,
        allowCredentials: [{ type: 'public-key', id: b64u.dec(row.passkey_id) }], userVerification: 'required', timeout: 60000 } });
      msg('ok', 'Your passkey works on this device.');
    } catch (e) { msg('err', "Couldn't confirm it. This may not be the device you set the passkey up on."); }
  }

  async function removePasskey() {
    if (!row.passkey_id) return;
    if (!confirm('Remove your passkey? Make sure you have a password set, or you will need an email code to get back in.')) return;
    if (!(await confirmIdentity())) return;
    var r = await client.rpc('remove_admin_passkey');
    if (r.error) return msg('err', r.error.message || 'Could not remove the passkey.');
    row.passkey_id = null; renderPasskey();
    audit('remove_passkey', 'Admin removed their passkey');
    msg('ok', 'Passkey removed.');
  }

  async function signOut() {
    try { await client.auth.signOut(); } catch (e) {}
    location.href = 'admin-login.html';
  }

  /* ---------------- boot ---------------- */
  async function init() {
    client = getClient();
    if (!client) return;
    var s = await client.auth.getSession();
    if (!s.data || !s.data.session) return;          // each page's own gate sends signed-out users to the login page
    var r = await client.from('admin_users')
      .select('*')
      .eq('user_id', s.data.session.user.id).maybeSingle();
    if (r.error || !r.data) return;
    row = r.data; build();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init); else init();
})();
