/*!
 * SoundsCare — WhatsApp job application flow
 *
 * 1. Applicant enters WhatsApp country code + number
 * 2. Number is checked against WhatsApp (edge function `check-whatsapp`)
 * 3. Applicant enters official full names
 * 4. Support ticket + job application are created in one call (RPC `submit_whatsapp_job_application`)
 * 5. Applicant shares a prefilled WhatsApp message: full name, ticket number, follow-up note
 *
 * Usage (public jobs page):
 *   <script src="js/whatsapp-apply.js"></script>
 *   <button onclick="WhatsAppApply.open({ jobId: job.id, jobTitle: job.title })">Apply on WhatsApp</button>
 *
 * The Supabase client is auto-detected (dbClient / db / supabaseClient / sb) or passed as { client }.
 * The WhatsApp number the message is sent to comes from settings.job_apply_whatsapp_number
 * (returned by the RPC). If it is empty, WhatsApp opens and the applicant picks the contact.
 */
(function () {
  'use strict';

  var COUNTRIES = [
    ['+254', '🇰🇪 Kenya (+254)'], ['+256', '🇺🇬 Uganda (+256)'], ['+255', '🇹🇿 Tanzania (+255)'],
    ['+250', '🇷🇼 Rwanda (+250)'], ['+251', '🇪🇹 Ethiopia (+251)'], ['+234', '🇳🇬 Nigeria (+234)'],
    ['+27', '🇿🇦 South Africa (+27)'], ['+971', '🇦🇪 UAE (+971)'], ['+966', '🇸🇦 Saudi Arabia (+966)'],
    ['+974', '🇶🇦 Qatar (+974)'], ['+44', '🇬🇧 United Kingdom (+44)'], ['+1', '🇺🇸 US / Canada (+1)'],
    ['+91', '🇮🇳 India (+91)'], ['other', 'Other country…']
  ];

  var CSS =
    '.swa-ov{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px;font-family:"DM Sans",system-ui,sans-serif}' +
    '.swa-box{background:#fff;color:#1a1a1a;width:100%;max-width:420px;border-radius:16px;padding:22px;box-shadow:0 20px 60px rgba(0,0,0,.3);max-height:92vh;overflow:auto;position:relative}' +
    '.swa-x{position:absolute;top:10px;right:14px;border:0;background:none;font-size:26px;line-height:1;cursor:pointer;color:#666}' +
    '.swa-box h3{margin:0 0 4px;font-size:18px}.swa-sub{margin:0 0 16px;font-size:13px;color:#666}' +
    '.swa-box label{display:block;font-size:12px;font-weight:600;margin:12px 0 5px;color:#333}' +
    '.swa-box input,.swa-box select{width:100%;box-sizing:border-box;padding:11px 12px;border:1px solid #ccc;border-radius:10px;font:inherit;font-size:15px;background:#fff;color:#1a1a1a}' +
    '.swa-box input:focus,.swa-box select:focus{outline:2px solid #25D366;border-color:#25D366}' +
    '.swa-row{display:flex;gap:8px}.swa-row>*:first-child{flex:0 0 46%}' +
    '.swa-prev{font-size:12px;color:#666;margin-top:6px;min-height:16px}' +
    '.swa-err{display:none;background:#fdecea;color:#b3261e;border-radius:10px;padding:10px 12px;font-size:13px;margin-top:12px}' +
    '.swa-ok{background:#e8f8ee;color:#12663a;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:4px}' +
    '.swa-warn{background:#fff6e0;color:#8a5a00;border-radius:10px;padding:10px 12px;font-size:13px;margin-bottom:4px}' +
    '.swa-btn{display:block;width:100%;box-sizing:border-box;text-align:center;text-decoration:none;margin-top:16px;padding:13px;border:0;border-radius:12px;background:#25D366;color:#fff;font:inherit;font-weight:700;font-size:15px;cursor:pointer}' +
    '.swa-btn:disabled{opacity:.6;cursor:wait}.swa-btn.sec{background:#f0f0f0;color:#333}' +
    '.swa-link{display:block;margin:10px auto 0;border:0;background:none;color:#666;font:inherit;font-size:13px;cursor:pointer;text-decoration:underline}' +
    '.swa-tk{font-family:ui-monospace,Menlo,monospace;font-size:22px;font-weight:700;text-align:center;letter-spacing:.5px;background:#f4f4f4;border-radius:12px;padding:14px;margin:10px 0 4px;user-select:all}' +
    '.swa-note{font-size:13px;color:#555;margin:10px 0 0;line-height:1.45}';

  var HTML =
    '<div class="swa-box" role="dialog" aria-modal="true" aria-labelledby="swa-title">' +
    '<button class="swa-x" type="button" aria-label="Close">&times;</button>' +
    '<h3 id="swa-title">Apply on WhatsApp</h3><p class="swa-sub" id="swa-job"></p>' +
    /* step 1 */
    '<div data-step="1">' +
      '<label for="swa-cc">Country code</label>' +
      '<select id="swa-cc"></select>' +
      '<input id="swa-cc-other" placeholder="Country code e.g. +233" inputmode="tel" style="display:none;margin-top:8px">' +
      '<label for="swa-phone">WhatsApp number</label>' +
      '<input id="swa-phone" type="tel" inputmode="tel" autocomplete="tel-national" placeholder="e.g. 712 345 678">' +
      '<div class="swa-prev" id="swa-prev"></div>' +
      '<button class="swa-btn" type="button" id="swa-check">Check WhatsApp number</button>' +
    '</div>' +
    /* step 2 */
    '<div data-step="2" style="display:none">' +
      '<div id="swa-status"></div>' +
      '<label for="swa-name">Your official full names (as on your ID)</label>' +
      '<input id="swa-name" autocomplete="name" placeholder="e.g. Jane Wanjiru Mwangi">' +
      '<button class="swa-btn" type="button" id="swa-submit">Submit application</button>' +
      '<button class="swa-link" type="button" id="swa-back">Change number</button>' +
    '</div>' +
    /* step 3 */
    '<div data-step="3" style="display:none">' +
      '<div class="swa-ok" id="swa-done-msg"></div>' +
      '<label>Your support ticket number</label>' +
      '<div class="swa-tk" id="swa-ticket"></div>' +
      '<p class="swa-note"><strong>Use this ticket number to follow up</strong> on your application. Tap below to send it to us on WhatsApp.</p>' +
      '<a class="swa-btn" id="swa-share" target="_blank" rel="noopener">Share on WhatsApp</a>' +
      '<button class="swa-btn sec" type="button" id="swa-copy">Copy ticket number</button>' +
    '</div>' +
    '<div class="swa-err" id="swa-err" role="alert"></div>' +
    '</div>';

  function injectCss() {
    if (document.getElementById('swa-css')) return;
    var s = document.createElement('style'); s.id = 'swa-css'; s.textContent = CSS; document.head.appendChild(s);
  }

  function findClient(opts) {
    var c = opts.client || window.dbClient || window.db || window.supabaseClient || window.sb;
    if (c && typeof c.rpc === 'function' && c.functions) return c;
    throw new Error('WhatsAppApply: Supabase client not found. Pass it as WhatsAppApply.open({ client }).');
  }

  function digits(s) { return String(s || '').replace(/\D/g, ''); }
  function prettyPhone(cc, local) {
    var l = digits(local).replace(/^0+/, '');
    return (digits(cc) && l) ? '+' + digits(cc) + ' ' + l.replace(/(\d{3})(?=\d)/g, '$1 ') : '';
  }
  function capWords(s) { return s.replace(/(^|[\s-])([a-z\u00e0-\u00ff])/g, function (m, a, b) { return a + b.toUpperCase(); }); }

  function open(opts) {
    opts = opts || {};
    var client = findClient(opts);
    if (!opts.jobId) throw new Error('WhatsAppApply: jobId is required');
    injectCss();

    var ov = document.createElement('div'); ov.className = 'swa-ov'; ov.innerHTML = HTML;
    document.body.appendChild(ov);
    var prevOverflow = document.body.style.overflow; document.body.style.overflow = 'hidden';
    function $(id) { return ov.querySelector('#' + id); }

    $('swa-job').textContent = opts.jobTitle ? 'For: ' + opts.jobTitle : '';
    var sel = $('swa-cc');
    COUNTRIES.forEach(function (c) { var o = document.createElement('option'); o.value = c[0]; o.textContent = c[1]; sel.appendChild(o); });

    var state = { cc: '', local: '' };

    function close() { document.body.style.overflow = prevOverflow; document.removeEventListener('keydown', onKey); ov.remove(); }
    function onKey(e) { if (e.key === 'Escape') close(); }
    document.addEventListener('keydown', onKey);
    ov.addEventListener('mousedown', function (e) { if (e.target === ov) close(); });
    ov.querySelector('.swa-x').addEventListener('click', close);

    function showStep(n) {
      ov.querySelectorAll('[data-step]').forEach(function (d) { d.style.display = d.getAttribute('data-step') === String(n) ? '' : 'none'; });
      error('');
      var f = { 1: 'swa-phone', 2: 'swa-name' }[n]; if (f) $(f).focus();
    }
    function error(msg) { var e = $('swa-err'); e.textContent = msg; e.style.display = msg ? 'block' : 'none'; }
    function busy(btn, on, label) { btn.disabled = on; btn.textContent = on ? label : btn.getAttribute('data-label'); }
    ['swa-check', 'swa-submit'].forEach(function (id) { var b = $(id); b.setAttribute('data-label', b.textContent); });

    function currentCc() { return sel.value === 'other' ? $('swa-cc-other').value : sel.value; }
    function refreshPreview() {
      $('swa-cc-other').style.display = sel.value === 'other' ? '' : 'none';
      var p = prettyPhone(currentCc(), $('swa-phone').value);
      $('swa-prev').textContent = p ? 'We will check: ' + p : '';
    }
    sel.addEventListener('change', refreshPreview);
    $('swa-cc-other').addEventListener('input', refreshPreview);
    $('swa-phone').addEventListener('input', refreshPreview);
    $('swa-name').addEventListener('blur', function () { this.value = capWords(this.value.replace(/\s+/g, ' ').trim()); });

    /* STEP 1 -> check the number is on WhatsApp */
    $('swa-check').addEventListener('click', function () {
      var cc = digits(currentCc()), local = digits($('swa-phone').value).replace(/^0+/, '');
      if (!cc || local.length < 6 || local.length > 12) { error('Enter a valid country code and phone number.'); return; }
      error(''); var btn = this; busy(btn, true, 'Checking WhatsApp…');
      client.functions.invoke('check-whatsapp', { body: { country_code: cc, phone: local } }).then(function (r) {
        busy(btn, false);
        var d = r && r.data;
        if (r.error || !d || d.error) { error((d && d.error) || 'Could not check the number right now. Please try again.'); return; }
        if (d.status === 'not_registered') { error('This number is not on WhatsApp. Check the number or use another one.'); return; }
        state.cc = cc; state.local = local;
        var st = $('swa-status');
        st.className = d.status === 'registered' ? 'swa-ok' : 'swa-warn';
        st.textContent = d.status === 'registered'
          ? '✓ +' + cc + ' ' + local + ' is on WhatsApp.'
          : 'We could not confirm this number automatically. You can continue — our team will verify it.';
        showStep(2);
      }).catch(function () { busy(btn, false); error('Network problem. Please try again.'); });
    });
    $('swa-back').addEventListener('click', function () { showStep(1); });

    /* STEP 2 -> create ticket + application */
    $('swa-submit').addEventListener('click', function () {
      var name = capWords($('swa-name').value.replace(/\s+/g, ' ').trim()); $('swa-name').value = name;
      if (name.split(' ').length < 2 || name.length < 3) { error('Please enter your full official names (at least two names).'); return; }
      error(''); var btn = this; busy(btn, true, 'Submitting…');
      client.rpc('submit_whatsapp_job_application', {
        p_job_id: opts.jobId, p_country_code: '+' + state.cc, p_phone: state.local, p_full_name: name
      }).then(function (r) {
        busy(btn, false);
        if (r.error || !r.data) { error((r.error && r.error.message) || 'Could not submit your application. Please try again.'); return; }
        finish(r.data);
      }).catch(function () { busy(btn, false); error('Network problem. Please try again.'); });
    });

    /* STEP 3 -> share on WhatsApp */
    function finish(d) {
      var ticket = d.ticket_number, to = digits(opts.whatsappTo || d.whatsapp_to);
      $('swa-done-msg').textContent = d.already_applied
        ? 'You already applied for this job. Here is your existing ticket.'
        : '✓ Application received' + (d.job_title ? ' for ' + d.job_title : '') + '.';
      $('swa-ticket').textContent = ticket;
      var msg = 'Hello SoundsCare, I have applied for: ' + (d.job_title || opts.jobTitle || 'a job') + '.\n' +
                'Full name: ' + d.full_name + '\n' +
                'Ticket number: ' + ticket + '\n\n' +
                'Note: please use my ticket number to follow up on my application.';
      $('swa-share').href = 'https://wa.me/' + to + '?text=' + encodeURIComponent(msg);
      $('swa-copy').addEventListener('click', function () {
        var b = this;
        (navigator.clipboard ? navigator.clipboard.writeText(ticket) : Promise.reject()).then(function () { b.textContent = 'Copied ✓'; }, function () { b.textContent = ticket; });
      });
      showStep(3);
      if (typeof opts.onSubmitted === 'function') { try { opts.onSubmitted(d); } catch (e) { console.error(e); } }
    }

    showStep(1);
    return { close: close };
  }

  window.WhatsAppApply = { open: open };
})();
