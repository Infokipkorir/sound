// ════════════════════════════════════════════════════════
//  CONFIG
// ════════════════════════════════════════════════════════
const SUPABASE_URL = 'https://phoahudvrcelfrykoeuo.supabase.co';
const SUPABASE_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InBob2FodWR2cmNlbGZyeWtvZXVvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Nzg4NDY0MTMsImV4cCI6MjA5NDQyMjQxM30.xBKbHIttK__d_jQFLavYyJQilUGUFISiWrh8-hgIA9Y';

let sb, currentUser;
// DB fields confirmed live:
// worker_profiles: id, email, full_name, profile_visible, status, account_number,
//   interview_fee_paid, first_salary_fee_paid, payment_status, account_deactivated, deactivation_reason
// MESSAGING (rebuilt on the new chat_threads / chat_messages schema — see
// send_chat_message / mark_chat_thread_read RPCs; old conversations/messages
// stay mirrored via DB sync triggers for employer-dashboard.html).
// chat_threads: id, employer_id, employee_id, is_admin_thread, status,
//   employer_blocked, employee_blocked, employer_whitelisted, not_interested_*,
//   last_message_preview, last_message_at, employer_unread, employee_unread, is_deleted
// chat_messages: id, thread_id, sender_id, sender_role, body, msg_type,
//   receiver_id, created_at, msg_type, is_deleted
// conversations: id, employer_id, employee_id, last_message_text, last_message_at, employee_unread, status
// wallets: user_id, balance, account_number, interview_fee_paid, first_salary_fee_paid, refund_balance
//   (outstanding_balance exists on this table but is intentionally not read/written from this page — employees never owe a balance)
// payments: id, user_id, amount, fee_type, payment_method, status, mpesa_phone, airtel_phone,
//   bank_account, phone_used, paybill_number, created_at, transaction_id, account_number
// job_postings: id, title, description, location, county, salary_range, job_type, work_type (Onsite/Remote/Hybrid),
//   duration_type, duration_value, status, is_urgent, created_at, job_role, company_name, company_verified,
//   employer_avg_rating, employer_rating_count, loves_count, employer_id
// job_applications: id, job_id, worker_id, cover_letter, status, applied_at
// employer_profiles: id, user_id, full_name, company_name, location, is_verified, avg_rating, rating_count
// saved_jobs: id, job_id, worker_id, created_at (whitelist / bookmark)
// job_loves: id, job_id, worker_id, created_at (heart / like)
// job_reports: id, job_id, worker_id, reason, details, status, created_at
// employer_ratings: id, employer_id, worker_id, interview_id, job_id, rating, review_text, created_at
// notifications: id, user_id, type, title, message, is_read, created_at

let workerProfile = null;
let connectsTariffs = null; // loaded once in loadDashboard(); { message_cost, voice_cost_per_min, video_cost_per_min, daily_free_connects, reset_hour_local }
let allConversations = [];
let activeConvId = null;
let activeConvMeta = null;
let mediaRecorder = null, recordedChunks = [], recordingTimer = null, recordingSeconds = 0;
let typingChannel = null, typingTimeout = null, presenceChannel = null;
let allJobs = [];
let savedJobIds = new Set();
let lovedJobIds = new Set();
let myApplications = [];
let reportingJobId = null;
let jobEscrowStatus = {}; // job_id -> 'held' | 'released' | ... — payment-verified badge on job cards
let jobApplicantCounts = {}; // job_id -> number of applications — best-effort, see loadDashboard() 3a-ii
let allOngoingJobs = [];  // { application, job, escrow, employerProfile, alreadyRated } — set in loadDashboard(), rendered by renderOngoingJobs()
let bidCtx = { jobId: null, title: '', pricingMode: 'fixed', fixedAmount: 0 }; // active job in the Bid modal
let callAudioCtx = null; // for voice message recording audio ctx (separate from ringtone)

// ════════════════════════════════════════════════════════
//  MULTI-PAGE ROUTER
//  Each standalone page (findjobs.html, profile.html, messages.html,
//  index.html) sets window.PAGE_MODE in an inline <script> BEFORE this
//  file loads. Everything else about the app (data loading, all other
//  modals) stays identical across pages — only which section is shown
//  as the "main" full-screen view on load differs. This is what lets
//  "My Profile" / "Find Jobs" / "Messages" live as their own files
//  while every other modal (Wallet, Applications, Notifications, etc.)
//  keeps working unchanged from any of them.
// ════════════════════════════════════════════════════════
const PAGE_ROUTES = {
  overview:  { modalId: 'overview',        title: 'Overview',     linkMatch: null },
  profile:   { modalId: 'modal-account',   title: 'My Profile',   linkMatch: 'modal-account' },
  findjobs:  { modalId: 'modal-jobs',      title: 'Find Jobs',    linkMatch: 'modal-jobs' },
  messages:  { modalId: 'modal-messages',  title: 'Messages',     linkMatch: 'modal-messages' },
};
const PAGE_FILES = { overview: 'index.html', profile: 'profile.html', findjobs: 'findjobs.html', messages: 'messages.html' };
// Nav buttons/quick-nav cards call this instead of navTo() directly for the
// three pages that now live in their own file: if we're already on that
// page it just switches the panel in place, otherwise it does a real page
// navigation so the URL, back button, and bookmarking all behave normally.
function goToSection(section) {
  const mode = window.PAGE_MODE || 'overview';
  if (mode === section) { navTo(PAGE_ROUTES[section].modalId); return; }
  window.location.href = PAGE_FILES[section] || 'index.html';
}
function initPageRouter() {
  const mode = window.PAGE_MODE || 'overview';
  const route = PAGE_ROUTES[mode] || PAGE_ROUTES.overview;
  navTo(route.modalId);
  document.title = route.title + ' · SoundsCare';
}

// ════════════════════════════════════════════════════════
//  PROFILE COMPLETENESS GATE
//  "Complete" = email verified + CV uploaded + all ID/selfie documents
//  uploaded. Used to gate messaging (see sendMessageReply / sendEmployeeFile
//  / startCall) until the worker has finished the essentials.
// ════════════════════════════════════════════════════════
function getProfileCompletionGaps() {
  const p = (typeof edFullProfile !== 'undefined' && edFullProfile) || workerProfile || {};
  const gaps = [];
  const emailVerified = !!(p.email_verified || currentUser?.email_confirmed_at);
  if (!emailVerified) gaps.push('Verify your email address');
  if (!p.cv_url) gaps.push('Upload your CV');
  if (!p.id_front_url || !p.id_back_url) gaps.push('Upload your ID (front & back)');
  if (!p.selfie_url) gaps.push('Upload a selfie for identity verification');
  return gaps;
}
function isProfileComplete() { return getProfileCompletionGaps().length === 0; }

// Canonical job categories — kept short and matched case-insensitively
// against job_postings.category (which has messier free-text values like
// "Domestic Work" / "Domestic worker" / "mama_fua_digital") so recommendations
// still work even where the wording doesn't match exactly.
const WORKER_CATEGORIES = [
  'Domestic Work', 'Nanny / Childcare', 'House Manager', 'Cleaning / Mama Fua',
  'Cooking / Chef', 'Gardening', 'Driving', 'Security', 'Elderly Care', 'Other',
];
function categoriesLooselyMatch(a, b) {
  if (!a || !b) return false;
  const norm = s => String(s).toLowerCase().replace(/[^a-z]+/g, ' ').trim();
  const na = norm(a), nb = norm(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na) ||
    na.split(' ').some(w => w.length > 3 && nb.includes(w));
}

// ════════════════════════════════════════════════════════
//  INIT
// ════════════════════════════════════════════════════════
document.addEventListener('DOMContentLoaded', async () => {
  sb = supabase.createClient(SUPABASE_URL, SUPABASE_KEY);

  // Auth check — getUser() gives server-verified identity (not just local session cache)
  const { data: { session } } = await sb.auth.getSession();
  if (!session?.user) { window.location.href = 'login.html'; return; }

  const { data: { user }, error: authErr } = await sb.auth.getUser();
  console.log('AUTH USER:', user);
  console.log('AUTH ERROR:', authErr);
  if (!user) { console.error('getUser() returned null — redirecting'); window.location.href = 'login.html'; return; }
  currentUser = user;

  // ── ROLE GUARD ──
  // public.users.role is the single source of truth for account type. Without
  // this check, any logged-in user (employer, agent, admin, abroad worker)
  // could open this URL and get treated as an employee.
  const { data: acct, error: acctErr } = await sb.from('users').select('role').eq('id', currentUser.id).maybeSingle();
  if (acctErr || !acct || acct.role !== 'employee') {
    await sb.auth.signOut();
    window.location.href = 'login.html?error=wrong_dashboard';
    return;
  }

  // Update presence
  console.log('📍 Updating user_presence…');
  const { error: presenceErr } = await sb.from('user_presence').upsert(
    { user_id: currentUser.id, is_online: true, last_seen: new Date().toISOString() },
    { onConflict: 'user_id' }
  );
  if (presenceErr) {
    console.warn('⚠️  user_presence upsert error:', presenceErr.message);
    console.warn('   (This table may not exist, but it\'s non-critical)');
  } else {
    console.log('✅ user_presence updated');
  }

  try {
    await loadDashboard();
  } catch (err) {
    console.error('Top-level dashboard crash:', err);
    showToast('err', 'bi-exclamation-circle', 'Dashboard failed to load', err.message);
  }
  try {
    // initEmployeeDetailsSection is `async` — calling it without `await`
    // meant this try/catch could only ever catch a *synchronous* throw
    // before its first `await`. Any error after that (in renderEdProfileTab,
    // a bad DOM lookup, a failed fetch inside it, etc.) became an unhandled
    // promise rejection: no catch fired, nothing was shown, and the whole
    // My Profile / Hiring History / Documents section could silently stop
    // populating with zero feedback to the user. This is the page "failing
    // in silence" — add the missing await so real errors surface here.
    await initEmployeeDetailsSection();
  } catch (edErr) {
    console.error('Employee Details section failed to init:', edErr.message);
    showToast('err', 'bi-exclamation-circle', 'Profile section failed to load', edErr.message);
  }
  try {
    subscribeToRealtime();
    subscribeIncomingCalls();
    console.log('✅ Realtime subscriptions active');
  } catch (err) {
    console.warn('⚠️  Realtime subscription error:', err.message);
  }
  requestNotifPermission();
  try { initPageRouter(); } catch (err) { console.warn('⚠️  Page router error:', err.message); }
});

// ════════════════════════════════════════════════════════
//  LOAD DASHBOARD
// ════════════════════════════════════════════════════════
async function loadDashboard() {
  console.group("🚀 DASHBOARD LOAD TRACE");
  try {
    console.log('🚀 Dashboard loading…');
    console.log('📌 currentUser.id:', currentUser.id);
    console.log('📧 currentUser.email:', currentUser.email);

    // 1. worker_profiles — try session_id (= auth.uid()) first, then fall back to email
    // DB reality: no user_id column exists on worker_profiles; link is via session_id (uuid text) OR email
    let wp = null, wpErr = null;

    // Attempt 1: session_id match — use limit(2) so duplicate rows never cause a 406 crash
    console.log('🔍 Attempt 1: Querying worker_profiles.session_id =', currentUser.id);
    const { data: bySessionRows, error: e1 } = await sb.from('worker_profiles')
      .select('id, full_name, pending_full_name, identity_change_status, email, profile_visible, status, account_number, interview_fee_paid, first_salary_fee_paid, payment_status, account_deactivated, deactivation_reason, verification_stage, phone, phone_number, profile_setup_completed, created_at')
      .eq('session_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(2);

    if (e1) console.warn('❌ Attempt 1 error:', e1.message);
    const bySession = bySessionRows?.[0] || null;
    if (bySessionRows?.length > 1) console.warn('⚠️  Duplicate session_id rows detected — using most recent');
    if (bySession) {
      console.log('✅ Attempt 1 SUCCESS:', bySession);
      wp = bySession;
    } else {
      console.log('⚠️  No session_id match. Trying email…');
      // Attempt 2: email match (RLS policy: email = auth.jwt()->>'email')
      console.log('🔍 Attempt 2: Querying worker_profiles.email =', currentUser.email);
      const { data: byEmailRows, error: e2 } = await sb.from('worker_profiles')
        .select('id, full_name, pending_full_name, identity_change_status, email, profile_visible, status, account_number, interview_fee_paid, first_salary_fee_paid, payment_status, account_deactivated, deactivation_reason, verification_stage, phone, phone_number, profile_setup_completed, created_at')
        .eq('email', currentUser.email)
        .order('created_at', { ascending: false })
        .limit(2);

      if (e2) console.warn('❌ Attempt 2 error:', e2.message);
      const byEmail = byEmailRows?.[0] || null;
      if (byEmail) {
        console.log('✅ Attempt 2 SUCCESS:', byEmail);
      } else {
        console.log('⚠️  No worker_profile found at all for', currentUser.email);
      }

      wp = byEmail || null;
      wpErr = e2;

      // If we found a profile by email but session_id is missing/wrong, backfill it
      if (wp && !bySession) {
        console.log('🔧 Backfilling session_id on row', wp.id);
        sb.from('worker_profiles')
          .update({ session_id: currentUser.id })
          .eq('id', wp.id)
          .then(() => console.log('✅ Backfill done')).catch(e => console.warn('Backfill error:', e.message));
      }
    }

    if (wpErr) console.warn('worker_profiles final error:', wpErr?.message);
    workerProfile = wp || null;
    console.log('📋 workerProfile now:', workerProfile);

    // Gate: this dashboard is only for workers who've finished initial
    // profile setup. No row yet, or setup started but not finished —
    // send them to the setup wizard instead of a half-empty dashboard.
    if (!workerProfile || !workerProfile.profile_setup_completed) {
      console.log('⏩ Profile setup incomplete — redirecting to setup wizard');
      window.location.href = 'employee-profile-setup.html';
      return;
    }

    // Welcome banner
    const name = workerProfile?.full_name || currentUser.email?.split('@')[0] || 'Worker';
    document.getElementById('welcome-name').innerHTML = 'Welcome back, ' + esc(name) + ' <i class="bi bi-emoji-smile-fill" style="font-size:0.75em;vertical-align:middle;"></i>';
    document.getElementById('nav-avatar-init').textContent = name[0].toUpperCase();
    const acctAvatarInit = document.getElementById('account-avatar-init');
    if (acctAvatarInit) acctAvatarInit.textContent = name[0].toUpperCase();
    document.getElementById('account-name').textContent = name;
    document.getElementById('account-email').textContent = currentUser.email;
    document.getElementById('account-role').textContent = 'Employee · ' + (workerProfile?.verification_stage || 'unverified');
    // Verification badge on welcome banner — reflects worker_profiles.verification_stage from DB
    const isWorkerVerified = (workerProfile?.verification_stage || '').toLowerCase() === 'verified';
    document.getElementById('welcome-verify-badge').classList.toggle('show', isWorkerVerified);
    // New account modal info badges
    const verifEl = document.getElementById('acct-verif-badge');
    const payEl = document.getElementById('acct-pay-badge');
    if (verifEl) {
      const vStage = (workerProfile?.verification_stage || 'unverified').toLowerCase();
      const vColor = vStage === 'verified' ? 'var(--ds-status-success-text)'
        : vStage.includes('pending') ? 'var(--ds-status-warning-text)'
        : vStage.includes('reject') ? 'var(--ds-status-danger-text)'
        : 'var(--ds-text-secondary)';
      verifEl.textContent = workerProfile?.verification_stage || 'Unverified';
      verifEl.style.color = vColor;
    }
    if (payEl) payEl.textContent = workerProfile?.payment_status || 'Pending';

    // Profile completeness
    const fields = ['full_name','email','profile_visible','status','account_number','interview_fee_paid','first_salary_fee_paid'];
    const filled = fields.filter(f => workerProfile?.[f] !== null && workerProfile?.[f] !== undefined && workerProfile?.[f] !== '').length;
    const pct = Math.round((filled / fields.length) * 100);
    document.getElementById('profile-pct').textContent = pct + '%';
    document.getElementById('progress-fill').style.width = pct + '%';

    // Account status
    if (workerProfile?.account_deactivated) {
      document.getElementById('account-status-bar').style.display = 'block';
      document.getElementById('account-status-msg').textContent = 'Account deactivated: ' + (workerProfile.deactivation_reason || 'Contact support');
    }

    // Welcome sub
    const statusMap = {
      approved: '<i class="bi bi-check-circle-fill"></i> Profile approved & visible',
      pending: '<i class="bi bi-hourglass-split"></i> Profile under review',
      rejected: '<i class="bi bi-x-circle-fill"></i> Profile needs attention',
    };
    document.getElementById('welcome-sub').innerHTML = statusMap[workerProfile?.status] || 'Complete your profile to get hired faster.';

    // Profile visibility toggle
    const visible = workerProfile?.profile_visible !== false;
    document.getElementById('visibility-toggle').checked = visible;
    document.getElementById('visibility-label').textContent = visible ? 'Profile is Visible to Employers' : 'Profile is Hidden';
    document.getElementById('visibility-sub').textContent = visible
      ? 'Employers can find you in search results'
      : 'You are not appearing in employer searches';

    // 2. conversations (RLS: employee_id = auth.uid()) — get threads
    await refreshEmployeeMessages();
    await loadRecentInterviews();

    // 3. job_postings (public read policy on status='active')
    console.log('🔍 Loading active job_postings');
    const { data: jobs, error: jobErr } = await sb.from('job_postings')
      .select('id, title, description, location, county, salary_range, salary_min, salary_max, job_type, work_type, duration_type, duration_value, is_urgent, created_at, job_role, company_name, company_verified, employer_avg_rating, employer_rating_count, loves_count, employer_id, pricing_mode, is_mama_fua, category')
      .eq('status', 'active')
      .order('created_at', { ascending: false })
      .limit(30);

    if (jobErr) {
      console.error('❌ JOB_POSTINGS ERROR:', jobErr.message, '—', jobErr.code);
      console.error('   This blocks job listings. Check if job_postings table exists and is readable.');
    }
    console.log('✅ jobs loaded:', jobs?.length || 0, 'postings');
    allJobs = jobs || [];

    // 3a. Payment-verified badge — has the employer already funded escrow for
    // this job? Best-effort: some RLS setups may not let a worker read escrow
    // rows for jobs they haven't applied to yet, so this fails soft.
    jobEscrowStatus = {};
    try {
      const visibleJobIds = allJobs.map(j => j.id);
      if (visibleJobIds.length) {
        const { data: escRows, error: escErr } = await sb.from('job_escrow_payments')
          .select('job_id, status')
          .in('job_id', visibleJobIds);
        if (escErr) throw escErr;
        (escRows || []).forEach(r => {
          // A job can have more than one escrow row over its life (e.g. a
          // rejected hold followed by a new one) — 'held' always wins so the
          // badge reflects money that is actually sitting in escrow right now.
          if (r.status === 'held' || jobEscrowStatus[r.job_id] === undefined) {
            jobEscrowStatus[r.job_id] = r.status;
          }
        });
      }
    } catch (escLoadErr) {
      console.warn('⚠️ Could not load employer payment-verification status:', escLoadErr.message);
    }

    // 3a-ii. Applicant counts per job — fetched separately (not selected as a
    // column on job_postings, since that column doesn't exist in this schema;
    // pulling it into the main select above previously broke the ENTIRE jobs
    // query for everyone whenever Postgrest rejected the unknown column, which
    // is why jobs stopped loading). Best-effort + fails soft to 0 per job.
    jobApplicantCounts = {};
    try {
      const visibleJobIds = allJobs.map(j => j.id);
      if (visibleJobIds.length) {
        const { data: appRows, error: appCountErr } = await sb.from('job_applications')
          .select('job_id')
          .in('job_id', visibleJobIds);
        if (appCountErr) throw appCountErr;
        (appRows || []).forEach(r => {
          jobApplicantCounts[r.job_id] = (jobApplicantCounts[r.job_id] || 0) + 1;
        });
      }
    } catch (appCountLoadErr) {
      console.warn('⚠️ Could not load applicant counts (RLS likely restricts this to the job owner):', appCountLoadErr.message);
    }

    // 3b. saved_jobs + job_loves + applications + interviews for this worker
    //     (fetched BEFORE renderJobs so love/save/applied states are correct on first paint)
    if (workerProfile?.id) {
      try {
        const [{ data: saved }, { data: loved }, { data: apps }, { count: interviewCount }] = await Promise.all([
          sb.from('saved_jobs').select('job_id').eq('worker_id', workerProfile.id),
          sb.from('job_loves').select('job_id').eq('worker_id', workerProfile.id),
          sb.from('job_applications').select('id, job_id, status, applied_at, bid_amount').eq('worker_id', workerProfile.id),
          sb.from('interviews').select('id', { count: 'exact', head: true }).eq('worker_id', workerProfile.id),
        ]);
        savedJobIds = new Set((saved || []).map(r => r.job_id));
        lovedJobIds = new Set((loved || []).map(r => r.job_id));
        myApplications = apps || [];
        // Loves count — shown as a pill inside the welcome banner
        document.getElementById('welcome-loves-count').textContent = lovedJobIds.size;
        // Saved Jobs dashboard section preview
        loadSavedJobs();
        // Bided Jobs dashboard section preview
        renderBidedJobs();
      } catch (statErr) {
        console.error('❌ Could not load saved/loved/applications/interview stats:', statErr.message);
      }
    } else {
      renderBidedJobs();
    }

    try {
      renderJobs(allJobs);
      populateCountyFilter(allJobs);
      console.log('✅ Jobs rendered');
      handleJobDeepLink();
    } catch (jobRenderErr) {
      console.error('❌ renderJobs failed:', jobRenderErr.message);
      document.getElementById('jobs-list').innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i><p>Could not load jobs</p></div>';
    }

    // 4. wallets (RLS: user_id = auth.uid())
    console.log('🔍 4️⃣ Loading wallet for user_id =', currentUser.id);
    const { data: walletData, error: wErr } = await sb.from('wallets')
      .select('balance, account_number, interview_fee_paid, first_salary_fee_paid, interview_fee_expires_at, first_salary_fee_expires_at, refund_balance, connects_balance, connects_reset_date')
      .eq('user_id', currentUser.id)
      .limit(1);
    const wallet = walletData?.[0] || null;

    // 4b. connects_tariffs — pricing config, readable by any authenticated
    // user (not just admins), needed client-side to show the pre-flight
    // "you can't afford this call" check and to render costs in the UI.
    const { data: tariffData, error: tErr } = await sb.from('connects_tariffs').select('*').eq('id', 1).maybeSingle();
    if (tErr) console.warn('⚠️ connects_tariffs load failed:', tErr.message);
    connectsTariffs = tariffData || null;
    if (wallet) {
      renderConnectsWidget(wallet);
    } else {
      // No wallet row yet — ensureAccountNumber() (called below for the KES
      // wallet) will upsert one shortly with connects_balance/reset_date
      // defaulting to 100/today per the column defaults, but show a sane
      // placeholder now rather than a blank "—" until the next page load.
      updateConnectsWidget(0);
      updateConnectsPricingHint();
    }

    console.log('WALLET DATA:', wallet);
    console.log('WALLET ERROR:', wErr);
    if (wErr) console.warn('❌ wallets error:', wErr.message);
    if (!wallet) {
      console.log('⚠️  No wallet record exists for this user yet');
    }
    if (wallet) {
      const bal = (wallet.balance || 0);
      document.getElementById('wallet-balance').textContent = 'KES ' + bal.toLocaleString('en-KE');
      document.getElementById('wallet-acct').textContent = 'Acct: ' + (wallet.account_number || '—');
      updateFeeStatus(wallet);
      if (!wallet.account_number) {
        // Every user needs an account number for wallet/reconciliation purposes — generate one now.
        ensureAccountNumber();
      }
    } else {
      // Try worker_profiles for fee status fallback
      if (workerProfile) updateFeeStatus(workerProfile);
    }
    document.getElementById('wd-avail-balance').textContent = 'KES ' + ((wallet?.balance || 0)).toLocaleString('en-KE');

    // 4c. Ongoing jobs — hired applications + Mama Fua Mtaani escrow status.
    // job_applications.worker_id references worker_profiles.id, but
    // job_escrow_payments.worker_id references auth.uid() directly — two
    // different identity spaces, so each query uses the right key.
    //
    // Employer ratings: only a worker with a *confirmed hire* (status='hired'
    // AND hired_at set) for a job may rate that job's employer — this is the
    // fraud guard, so a rating can never be submitted from just an interview
    // or application with no hire on record. employer_id/employer profile and
    // existing employer_ratings are fetched here so ongoingJobCardHtml can
    // show "Rate Employer" only where that's actually true.
    console.log('🔍 4️⃣c Loading ongoing jobs…');
    try {
      const hiredApps = (myApplications || []).filter(a => a.status === 'hired' && a.hired_at);
      const jobIds = [...new Set(hiredApps.map(a => a.job_id))];
      let ongoingJobsData = [];
      if (jobIds.length) {
        const [{ data: jobRows }, escRes, ratedRes] = await Promise.all([
          sb.from('job_postings')
            .select('id,title,company_name,is_mama_fua,salary_min,salary_max,duration_type,is_closed,is_paused,county,employer_id')
            .in('id', jobIds),
          sb.from('job_escrow_payments')
            .select('id,job_id,amount,service_fee,tax_amount,net_amount,status,release_requested_at,created_at')
            .eq('worker_id', currentUser.id)
            .in('job_id', jobIds),
          sb.from('employer_ratings')
            .select('job_id')
            .eq('worker_id', workerProfile.id)
            .in('job_id', jobIds),
        ]);
        const jobById = {}; (jobRows || []).forEach(j => { jobById[j.id] = j; });
        const ratedJobIds = new Set((ratedRes?.data || []).map(r => r.job_id));

        // job_postings.employer_id stores employer_profiles.id (the profile's
        // own PK) — NOT the employer's auth user_id, despite the column name.
        // Confirmed against live data: 0 jobs match by user_id, all matched
        // rows match by profile id. Matching against user_id here silently
        // returned no employer profile for every real hired job, which hid
        // the "Rate Employer" button (canRate requires employerProfile?.id).
        const employerProfileIds = [...new Set((jobRows || []).map(j => j.employer_id).filter(Boolean))];
        let employerByProfileId = {};
        if (employerProfileIds.length) {
          const { data: empRows } = await sb.from('employer_profiles')
            .select('id, user_id, full_name, company_name')
            .in('id', employerProfileIds);
          (empRows || []).forEach(ep => { employerByProfileId[ep.id] = ep; });
        }

        ongoingJobsData = hiredApps
          .filter(a => jobById[a.job_id] && !jobById[a.job_id].is_closed)
          .map(a => {
            const job = jobById[a.job_id];
            const employerProfile = job.employer_id ? employerByProfileId[job.employer_id] : null;
            return {
              application: a,
              job,
              escrow: (escRes?.data || [])
                .filter(e => e.job_id === a.job_id)
                .sort((x, y) => new Date(y.created_at) - new Date(x.created_at))[0] || null,
              employerProfile,
              alreadyRated: ratedJobIds.has(a.job_id),
            };
          });
      }
      ongoingJobsData.sort((a, b) => new Date(b.application.hired_at || b.application.applied_at) - new Date(a.application.hired_at || a.application.applied_at));
      allOngoingJobs = ongoingJobsData;
      renderOngoingJobs();
    } catch (ogErr) {
      console.error('❌ Ongoing jobs load failed:', ogErr.message);
    }

    // 4d. withdrawal history (worker_withdrawals)
    try {
      await loadWithdrawalHistory();
      console.log('✅ Withdrawal history loaded');
    } catch (wdErr) {
      console.error('❌ loadWithdrawalHistory failed:', wdErr.message);
      document.getElementById('withdrawal-history-list').innerHTML = '<div class="empty-state"><i class="bi bi-cash-coin"></i><p>Could not load withdrawals</p></div>';
    }

    // 5. payments (RLS: user_id = auth.uid())
    console.log('🔍 5️⃣ Loading payments for user_id =', currentUser.id);
    const { data: payments, error: pErr } = await sb.from('payments')
      .select('id, amount, fee_type, payment_method, status, created_at, transaction_id')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(20);

    if (pErr) {
      console.error('❌ PAYMENTS ERROR:', pErr.message, '—', pErr.code);
      console.warn('   Payments table may not exist. Using empty list.');
    }
    try {
      renderPaymentHistory(payments || []);
      console.log('✅ Payment history rendered');
    } catch (payErr) {
      console.error('❌ renderPaymentHistory failed:', payErr.message);
      document.getElementById('payment-list').innerHTML = '<div class="empty-state"><i class="bi bi-receipt"></i><p>Could not load payment history</p></div>';
    }

    // 6. notifications
    console.log('🔍 6️⃣ Loading notifications…');
    try {
      await loadNotifications();
      console.log('✅ Notifications loaded');
    } catch (notifErr) {
      console.error('❌ loadNotifications failed:', notifErr.message);
      document.getElementById('notif-list').innerHTML = '<div class="empty-state"><i class="bi bi-bell"></i><p>Could not load notifications</p></div>';
    }

  } catch (e) {
    console.error('❌ loadDashboard CRASHED:', e.message);
    console.error('Stack:', e.stack);
    console.groupEnd();
    showToast('err', 'bi-exclamation-circle', 'Dashboard Error', e.message);
  }
  console.groupEnd();
}

// ════════════════════════════════════════════════════════
//  CONVERSATIONS / MESSAGES
// ════════════════════════════════════════════════════════
let employerCache = {}; // user_id -> {name, photo, is_admin_thread}

function twoWordName(full) {
  if (!full) return 'Employer';
  const parts = full.trim().split(/\s+/);
  return parts.slice(0, 2).join(' ');
}

// ════════════════════════════════════════════════════════
//  MESSAGES REFRESH — fetches conversations fresh from the DB.
//  Called on dashboard init, on opening the Messages modal, and after
//  Realtime events that touch the conversation list — so the UI never
//  relies solely on a possibly-stale in-memory allConversations.
// ════════════════════════════════════════════════════════
async function refreshEmployeeMessages() {
  console.log('[MESSAGES] refreshEmployeeMessages: loading conversations for', currentUser?.id);
  if (!currentUser?.id) { console.error('[MESSAGES] refreshEmployeeMessages: no currentUser, aborting'); return; }

  const { data: convs, error: convErr } = await sb.from('chat_threads')
    .select('id, employer_id, employee_id, last_message_preview, last_message_at, employee_unread, status, is_admin_thread, employer_blocked, employee_blocked, not_interested_at, employer_whitelisted')
    .eq('employee_id', currentUser.id)
    .eq('is_deleted', false)
    .order('last_message_at', { ascending: false })
    .limit(30);

  if (convErr) {
    console.error('[MESSAGES] CHAT_THREADS ERROR:', convErr);
    showToast('err', 'bi-exclamation-circle', 'Could not load messages', convErr.message || 'Check your connection and try again.');
    return;
  }
  console.log('[MESSAGES] threads loaded:', convs?.length || 0);
  // Normalize last_message_preview -> last_message_text so the rest of the
  // UI (built around the old field name) doesn't need touching everywhere.
  allConversations = (convs || []).map(c => ({ ...c, last_message_text: c.last_message_preview }));

  // Recalculate the badge from scratch every time — this is the single
  // source of truth for its visible state, so it correctly shows AND
  // hides/resets to 0, instead of only ever being set upward.
  const badge = document.getElementById('msg-badge');
  if (badge) {
    const totalUnread = allConversations.reduce((s, c) => s + (c.employee_unread || 0), 0);
    badge.textContent = totalUnread;
    badge.classList.toggle('show', totalUnread > 0);
  }

  // Catch-up: flip any messages still stuck at delivery_status='sent' to
  // 'delivered' now that we know this device has actually loaded them.
  // Realtime only flips this live if the employee was connected at the
  // exact moment the message was inserted — this covers everyone else
  // (closed tab, dead connection, phone locked) without needing them to
  // open the specific conversation first. Fire-and-forget: never block
  // rendering on it, and a failure here shouldn't surface as a toast.
  sb.rpc('mark_employee_messages_delivered').then(({ data, error }) => {
    if (error) console.error('[MESSAGES] mark_employee_messages_delivered failed:', error);
    else if (data?.updated) console.log('[MESSAGES] marked delivered:', data.updated);
  });

  try {
    await renderConversationList();
    renderRecentMessagesPreview();
    console.log('[MESSAGES] Conversation list rendered, count:', allConversations.length);
  } catch (renderErr) {
    console.error('[MESSAGES] renderConversationList failed:', renderErr);
    const inbox = document.getElementById('messages-inbox');
    if (inbox) inbox.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i><p>Could not load messages</p></div>';
  }
}

async function renderConversationList() {
  const inbox = document.getElementById('messages-inbox');

  if (!allConversations.length) {
    const empty = '<div class="empty-state"><i class="bi bi-chat-dots"></i><p>No messages yet. Employers will contact you here.</p></div>';
    inbox.innerHTML = empty;
    return;
  }

  // Fetch employer names/photos for all convs
  // Uses RPC to bypass RLS on employer_profiles (workers can't read other users' rows directly)
  const employerIds = [...new Set(allConversations.map(c => c.employer_id).filter(Boolean))];
  if (employerIds.length) {
    // Try RPC first (security definer — bypasses RLS)
    const { data: rpcData, error: rpcErr } = await sb.rpc('get_employer_names', { employer_ids: employerIds });
    if (!rpcErr && rpcData) {
      (rpcData || []).forEach(e => {
        employerCache[e.user_id] = {
          name: twoWordName(e.company_name || e.full_name || 'Employer'),
          photo: e.profile_photo_url || null,
          is_verified: !!e.is_verified,
          ringback_tone_url: e.ringback_tone_url || null,
        };
      });
    } else {
      // Fallback: direct query (works if RLS allows it or is disabled)
      console.warn('get_employer_names RPC failed, falling back to direct query:', rpcErr?.message);
      const { data } = await sb.from('employer_profiles')
        .select('user_id, full_name, company_name, profile_photo_url, is_verified, ringback_tone_url')
        .in('user_id', employerIds);
      (data || []).forEach(e => {
        employerCache[e.user_id] = {
          name: twoWordName(e.company_name || e.full_name || 'Employer'),
          photo: e.profile_photo_url || null,
          is_verified: !!e.is_verified,
          ringback_tone_url: e.ringback_tone_url || null,
        };
      });
    }
  }

  const html = allConversations.map((conv) => {
    const isSupport = conv.is_admin_thread;
    const emp = employerCache[conv.employer_id] || { name: 'Employer', photo: null };
    const from = isSupport ? 'Support' : emp.name;
    const init = (from[0] || '?').toUpperCase();
    const preview = (conv.last_message_text || 'No messages yet').substring(0, 50);
    const unread = conv.employee_unread > 0;
    const time = conv.last_message_at ? timeAgo(new Date(conv.last_message_at)) : '';
    const avatarInner = emp.photo && !isSupport ? `<img src="${emp.photo}">` : esc(init);

    // Determine role label and verification
    const roleLabel = isSupport ? 'Support' : 'Employer';
    const isVerified = emp.is_verified || isSupport;
    const isCurrentUser = (emp.name || '').toLowerCase().includes('amos ngeno') || (emp.name || '').toLowerCase() === 'amos';
    const showVerifyBadge = isVerified || isCurrentUser;
    const isActive = activeConvId === conv.id;

    return `
    <div class="sidebar-msg-item ${unread ? 'unread' : ''} ${isActive ? 'active' : ''}" onclick="openConversation('${conv.id}')">
      <div class="sidebar-avatar ${isSupport ? 'is-support' : ''}">
        ${avatarInner}
        ${unread ? '<div class="unread-dot"></div>' : ''}
      </div>
      <div class="sidebar-msg-info">
        <div style="display:flex; align-items:center; gap:5px; margin-bottom:2px;">
          <span class="sidebar-name">${esc(from)}</span>
          ${showVerifyBadge ? '<span class="verify-badge"><i class="bi bi-patch-check-fill"></i></span>' : ''}
        </div>
        <div style="display:flex; align-items:center; gap:4px; margin-bottom:2px;">
          <span style="font-size:9px; background:${isSupport ? 'var(--sky)' : 'var(--accent)'}; color:#fff; padding:1px 5px; border-radius:4px; font-weight:700;">${roleLabel}</span>
        </div>
        <div class="sidebar-preview">${esc(preview)}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
        <span class="sidebar-time">${time}</span>
        ${unread ? `<span style="min-width:18px; height:18px; background:var(--brand); color:#fff; border-radius:50%; font-size:9px; font-weight:700; display:flex; align-items:center; justify-content:center;">${conv.employee_unread > 9 ? '9+' : conv.employee_unread}</span>` : ''}
      </div>
    </div>`;
  }).join('');

  inbox.innerHTML = html;
}

// ════════════════════════════════════════════════════════
//  RECENT MESSAGES PREVIEW (dashboard section)
// ════════════════════════════════════════════════════════
function renderRecentMessagesPreview() {
  const el = document.getElementById('recent-messages');
  if (!el) return;

  if (!allConversations.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-chat-dots"></i><p>No messages yet. Employers will contact you here.</p></div>';
    return;
  }

  const recent = [...allConversations]
    .sort((a, b) => new Date(b.last_message_at || 0) - new Date(a.last_message_at || 0))
    .slice(0, 3);

  el.innerHTML = recent.map(conv => {
    const isSupport = conv.is_admin_thread;
    const emp = employerCache[conv.employer_id] || { name: 'Employer', photo: null };
    const name = isSupport ? 'Support' : emp.name;
    const init = (name[0] || '?').toUpperCase();
    const preview = (conv.last_message_text || 'No messages yet').substring(0, 70);
    const unread = conv.employee_unread > 0;
    const time = conv.last_message_at ? timeAgo(new Date(conv.last_message_at)) : '';
    const avatarInner = emp.photo && !isSupport ? `<img src="${esc(emp.photo)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : esc(init);
    const badgeColor = isSupport ? 'var(--sky)' : 'var(--accent)';
    const roleLabel = isSupport ? 'Support' : 'Employer';

    return `
    <div class="msg-item ${unread ? 'unread' : ''}" onclick="navTo('modal-messages'); openConversation('${conv.id}');" style="cursor:pointer;">
      <div class="msg-avatar is-employer" style="background:linear-gradient(135deg,var(--brand),#2a9961);">${avatarInner}</div>
      <div class="msg-content">
        <div class="msg-header">
          <span class="msg-from">${esc(name)}</span>
          <span class="msg-badge employer" style="background:${badgeColor};"><i class="bi bi-${isSupport ? 'headset' : 'building'}"></i> ${roleLabel}</span>
        </div>
        <div class="msg-preview">${esc(preview)}</div>
      </div>
      <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px; flex-shrink:0;">
        <span class="msg-time">${time}</span>
        ${unread ? `<span style="min-width:18px; height:18px; background:var(--brand); color:#fff; border-radius:50%; font-size:9px; font-weight:700; display:flex; align-items:center; justify-content:center;">${conv.employee_unread > 9 ? '9+' : conv.employee_unread}</span>` : ''}
      </div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════
//  INTERVIEWS
// ════════════════════════════════════════════════════════
async function loadRecentInterviews() {
  const recentEl = document.getElementById('recent-interviews');
  const listEl   = document.getElementById('interviews-list');
  if (!currentUser) return;

  // Interviews = conversations where status = 'active' (i.e. employer is actively engaging)
  // We re-use allConversations if already loaded, else fetch
  const convs = allConversations.length
    ? allConversations
    : ((await sb.from('chat_threads')
        .select('id, employer_id, employee_id, last_message_preview, last_message_at, status, is_admin_thread')
        .eq('employee_id', currentUser.id)
        .order('last_message_at', { ascending: false })
        .limit(10)
      ).data || []).map(c => ({ ...c, last_message_text: c.last_message_preview }));

  // Filter to active (not closed / blocked) and non-admin threads as "interviews"
  const interviews = convs.filter(c => !c.is_admin_thread && c.status !== 'closed');

  function renderInterviewCard(conv, short) {
    const emp = employerCache[conv.employer_id] || { name: 'Employer', photo: null };
    const name = emp.name;
    const init = (name[0] || '?').toUpperCase();
    const preview = (conv.last_message_text || 'No messages yet').substring(0, short ? 60 : 100);
    const time = conv.last_message_at ? timeAgo(new Date(conv.last_message_at)) : '';
    const avatarInner = emp.photo ? `<img src="${esc(emp.photo)}" style="width:100%;height:100%;border-radius:50%;object-fit:cover;">` : esc(init);
    return `
    <div class="msg-item" onclick="openConversation('${conv.id}'); navTo('overview'); navTo('modal-messages');" style="cursor:pointer;">
      <div class="msg-avatar is-employer" style="background:linear-gradient(135deg,var(--brand),#2a9961);">${avatarInner}</div>
      <div class="msg-content">
        <div class="msg-header">
          <span class="msg-from">${esc(name)}</span>
          <span class="msg-badge employer"><i class="bi bi-building"></i> Employer</span>
        </div>
        <div class="msg-preview">${esc(preview)}</div>
      </div>
      <div class="msg-time" style="flex-shrink:0;">${time}</div>
    </div>`;
  }

  if (!interviews.length) {
    const empty = '<div class="empty-state"><i class="bi bi-calendar-check"></i><p>No active interviews yet. Employers will contact you here.</p></div>';
    if (recentEl) recentEl.innerHTML = empty;
    if (listEl) listEl.innerHTML = empty;
    return;
  }

  if (recentEl) recentEl.innerHTML = interviews.slice(0, 2).map(c => renderInterviewCard(c, true)).join('');
  if (listEl) listEl.innerHTML = interviews.map(c => renderInterviewCard(c, false)).join('');
}

// ════════════════════════════════════════════════════════
//  RATE EMPLOYER — fraud guard: the ONLY place that can open this modal is
//  the "Rate Employer" button rendered in ongoingJobCardHtml(), which itself
//  only appears when the worker has a confirmed hire on record
//  (job_applications.status === 'hired' AND hired_at is set) for that job —
//  see allOngoingJobs / loadDashboard step 4c. There is no path here from a
//  mere application or interview, so a rating can never be submitted before
//  an actual hire.
// ════════════════════════════════════════════════════════
let ratingContext = { interviewId: null, employerProfileId: null, jobId: null, stars: 0 };

function openRateEmployerModal(interviewId, employerProfileId, jobId, employerName) {
  if (!employerProfileId) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'This employer profile could not be found.');
    return;
  }
  ratingContext = { interviewId, employerProfileId, jobId: jobId || null, stars: 0 };
  document.getElementById('rate-employer-name').textContent = employerName || 'this employer';
  document.getElementById('rate-review-text').value = '';
  setRatingStars(0);
  openModal('modal-rate-employer');
}

function setRatingStars(n) {
  ratingContext.stars = n;
  document.querySelectorAll('#rate-star-picker i').forEach(star => {
    star.classList.toggle('selected', parseInt(star.dataset.star) <= n);
  });
}

async function submitEmployerRating() {
  if (!ratingContext.stars) {
    showToast('err', 'bi-exclamation-circle', 'Select a Rating', 'Please choose 1–5 stars first.');
    return;
  }
  if (!workerProfile?.id || !ratingContext.employerProfileId) return;

  const btn = document.getElementById('submit-rating-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Submitting…';

  const { error } = await sb.from('employer_ratings').insert({
    employer_id: ratingContext.employerProfileId,
    worker_id: workerProfile.id,
    interview_id: ratingContext.interviewId || null,
    job_id: ratingContext.jobId,
    rating: ratingContext.stars,
    review_text: document.getElementById('rate-review-text').value.trim() || null,
  });

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-star-fill"></i> Submit Rating';

  if (error) {
    showToast('err', 'bi-exclamation-circle', 'Error', error.message);
  } else {
    showToast('ok', 'bi-check-circle', 'Thank You!', 'Your rating has been submitted.');
    closeModal('modal-rate-employer');
    // Mark this job as rated in-memory and re-render so the "Rate Employer"
    // button on its ongoing-job card immediately flips to "Rated" without a
    // full dashboard reload.
    (allOngoingJobs || []).forEach(o => {
      if (o.application?.job_id === ratingContext.jobId) o.alreadyRated = true;
    });
    renderOngoingJobs();
    // Keep the Hiring History tab's feedback/rating block in sync if it's
    // already been loaded this session (rating can be submitted from either tab).
    if (edLoaded?.hiringHistory) loadEdHiringHistoryDetailed();
  }
}

function renderTick(m) {
  if (m.sender_id !== currentUser.id) return '';
  if (m._pending === 'waiting') return '<i class="bi bi-clock tick waiting" title="Waiting for network"></i>';
  if (m._pending === 'sending') return '<i class="bi bi-clock tick waiting" title="Sending"></i>';
  const ds = m.delivery_status;
  if (ds === 'seen' || m.is_read) return '<i class="bi bi-check2-all tick blue" title="Seen"></i>';
  if (ds === 'delivered') return '<i class="bi bi-check2-all tick grey" title="Delivered"></i>';
  return '<i class="bi bi-check2 tick grey" title="Sent"></i>';
}

function renderBubbleContent(m) {
  if (m.msg_type === 'call') {
    return renderCallBubbleContent(m);
  }
  if (m.msg_type === 'audio' && m.file_url) {
    return `<div class="bubble-audio"><audio controls src="${m.file_url}"></audio></div>`;
  }
  if (m.msg_type === 'file' && m.file_url) {
    const fname = m.file_name || 'Attachment';
    return `<div style="display:flex;align-items:center;gap:7px;padding:6px 10px;background:rgba(255,255,255,.15);border-radius:8px;font-size:12px;"><i class="bi bi-paperclip"></i><a href="${m.file_url}" target="_blank" style="color:inherit;text-decoration:underline;">${esc(fname)}</a></div>`;
  }
  const text = m.content || m.body || m.message || '';
  return `<span class="bubble-text">${esc(text)}</span>`;
}

// ────────────────────────────────────────────────────────
//  CALL MESSAGE BUBBLE — voice/video call events shown in chat
// ────────────────────────────────────────────────────────
function renderCallBubbleContent(m) {
  // call_type/status live on the `calls` row (joined by call_id), not on the
  // chat message itself — refreshCallBubbleStatuses() fills in the real
  // icon/label/status right after this initial render.
  const callKey = m.call_id || m.id || '';
  return `
    <div class="bubble-call" id="call-bubble-${callKey}" data-call-id="${m.call_id || ''}" onclick="joinCallFromMessage('${m.call_id || ''}')">
      <div class="bubble-call-icon" id="call-icon-${callKey}"><i class="bi bi-telephone-fill"></i></div>
      <div class="bubble-call-info">
        <div class="bubble-call-label" id="call-label-${callKey}">Call</div>
        <div class="bubble-call-status" id="call-status-${callKey}"><i class="bi bi-arrow-repeat spin"></i> Checking status…</div>
      </div>
    </div>`;
}

function formatCallDuration(sec) {
  sec = parseInt(sec) || 0;
  const mins = Math.floor(sec / 60);
  const secs = sec % 60;
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

// Batch-refresh call status/duration labels for all call bubbles in a message set,
// reading live truth from the `calls` table (the chat message itself is never updated).
async function refreshCallBubbleStatuses(msgs) {
  const callIds = [...new Set((msgs || []).filter(m => m.msg_type === 'call' && m.call_id).map(m => m.call_id))];
  if (!callIds.length) return;
  const { data, error } = await sb.from('calls').select('id, status, duration, call_type').in('id', callIds);
  if (error) { console.warn('refreshCallBubbleStatuses error:', error.message); return; }
  const byId = {};
  (data || []).forEach(c => { byId[c.id] = c; });

  callIds.forEach(id => {
    const statusEl = document.getElementById('call-status-' + id);
    const bubbleEl = document.getElementById('call-bubble-' + id);
    if (!statusEl) return;
    const call = byId[id];
    if (call?.call_type) {
      const isVideo = call.call_type === 'video';
      const iconEl = document.getElementById('call-icon-' + id);
      const labelEl = document.getElementById('call-label-' + id);
      if (iconEl) iconEl.innerHTML = `<i class="bi bi-${isVideo ? 'camera-video-fill' : 'telephone-fill'}"></i>`;
      if (labelEl) labelEl.textContent = isVideo ? 'Video Call' : 'Voice Call';
    }
    let html = '<i class="bi bi-telephone"></i> Call';
    let joinable = false;
    if (!call) {
      html = '<i class="bi bi-question-circle"></i> Unavailable';
    } else if (call.status === 'ringing') {
      html = '<i class="bi bi-telephone-outbound"></i> Ringing — tap to join';
      joinable = true;
    } else if (call.status === 'accepted' || call.status === 'connected') {
      html = '<i class="bi bi-telephone"></i> In progress — tap to join';
      joinable = true;
    } else if (call.status === 'ended') {
      html = `<i class="bi bi-check2"></i> Call ended${call.duration ? ' · ' + formatCallDuration(call.duration) : ''}`;
    } else if (call.status === 'missed') {
      html = '<i class="bi bi-telephone-x"></i> Missed call';
    } else if (call.status === 'rejected') {
      html = '<i class="bi bi-telephone-x"></i> Declined';
    }
    statusEl.innerHTML = html;
    if (bubbleEl) bubbleEl.classList.toggle('joinable', joinable);
  });
}

// Rejoin a still-active call directly from a chat call-bubble
async function joinCallFromMessage(callId) {
  if (!callId) return;
  if (activeCallId) { showToast('info', 'bi-telephone', 'Already in a Call', 'End the current call first.'); return; }

  const { data: callRow, error } = await sb.from('calls')
    .select('id, status, caller_id, receiver_id, call_type, room_id')
    .eq('id', callId).maybeSingle();

  if (error || !callRow) { showToast('err', 'bi-exclamation-circle', 'Unavailable', 'This call is no longer available.'); return; }
  if (!['ringing', 'accepted', 'connected'].includes(callRow.status)) {
    showToast('info', 'bi-telephone-x', 'Call Ended', 'This call has already ended.'); return;
  }
  if (callRow.caller_id === currentUser.id) {
    showToast('info', 'bi-telephone', 'Outgoing Call', 'You started this call — check your active call screen.'); return;
  }

  const conv = allConversations.find(c => c.id === activeConvId) || {};
  const emp = employerCache[callRow.caller_id] || { name: conv.is_admin_thread ? 'Support' : 'Employer' };
  incomingCallData = { callerName: emp.name, callType: callRow.call_type, convId: activeConvId, callId: callRow.id, roomId: callRow.room_id };
  await acceptIncomingCall();
}

function renderMessageBubble(m) {
  const sent = m.sender_id === currentUser.id;
  const text = m.content || m.body || m.message || '';
  const replyBtn = `<button class="bubble-reply-btn" onclick="setReply('${esc(text.replace(/'/g,'&apos;').substring(0,80))}', '${m.id || ''}')" title="Reply"><i class="bi bi-reply"></i></button>`;
  return `
  <div class="msg-bubble ${sent ? 'sent' : 'received'}" data-id="${m.id || ''}">
    <div class="bubble ${sent ? 'sent' : 'received'}">
      ${renderBubbleContent(m)}
      <div class="bubble-meta">${timeAgo(new Date(m.created_at))} ${renderTick(m)}</div>
      ${replyBtn}
    </div>
  </div>`;
}

async function updateChatHeaderStatus() {
  const isSupport = !!activeConvMeta?.is_admin_thread;
  const dotEl = document.getElementById('conv-online-dot');
  const statusWrap = document.getElementById('conv-status');
  const statusText = document.getElementById('conv-status-text');

  if (isSupport) {
    dotEl.classList.add('show');
    statusWrap.classList.add('online');
    statusText.textContent = 'Always online';
    return;
  }

  const employerId = activeConvMeta?.employer_id;
  if (!employerId) { statusText.textContent = ''; return; }

  const { data } = await sb.from('user_presence').select('is_online, last_seen').eq('user_id', employerId).maybeSingle();
  if (data?.is_online) {
    dotEl.classList.add('show');
    statusWrap.classList.add('online');
    statusText.textContent = 'Online';
  } else {
    dotEl.classList.remove('show');
    statusWrap.classList.remove('online');
    statusText.textContent = data?.last_seen ? 'last seen ' + timeAgo(new Date(data.last_seen)) : 'offline';
  }
}

function subscribePresenceFor(employerId) {
  if (presenceChannel) { sb.removeChannel(presenceChannel); presenceChannel = null; }
  if (!employerId) return;
  presenceChannel = sb.channel('presence-' + employerId)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'user_presence', filter: `user_id=eq.${employerId}` }, () => {
      updateChatHeaderStatus();
    })
    .subscribe();
}

function subscribeTypingFor(convId) {
  if (typingChannel) { sb.removeChannel(typingChannel); typingChannel = null; }
  typingChannel = sb.channel('typing-' + convId)
    .on('broadcast', { event: 'typing' }, (payload) => {
      if (payload.payload?.from === currentUser.id) return;
      const ind = document.getElementById('typing-indicator');
      ind.classList.add('show');
      document.getElementById('conversation-messages').scrollTop = document.getElementById('conversation-messages').scrollHeight;
      clearTimeout(window._typingHideTimer);
      window._typingHideTimer = setTimeout(() => ind.classList.remove('show'), 3000);
    })
    .subscribe();
}

let lastTypingSent = 0;
function notifyTyping() {
  if (!typingChannel || !activeConvId) return;
  const now = Date.now();
  if (now - lastTypingSent < 1500) return;
  lastTypingSent = now;
  typingChannel.send({ type: 'broadcast', event: 'typing', payload: { from: currentUser.id } });
}

function toggleChatMenu() {
  document.getElementById('chat-menu').classList.toggle('show');
}
document.addEventListener('click', (e) => {
  const menu = document.getElementById('chat-menu');
  if (menu && !e.target.closest('.chat-menu-wrap') && menu.classList.contains('show')) menu.classList.remove('show');
});

function applyChatLockState() {
  const banner = document.getElementById('chat-blocked-banner');
  const bar = document.getElementById('chat-input-bar');
  const closed = activeConvMeta?.status === 'closed' || activeConvMeta?.employer_blocked || activeConvMeta?.employee_blocked;
  if (closed) {
    banner.classList.add('show');
    bar.style.display = 'none';
  } else {
    banner.classList.remove('show');
    bar.style.display = 'flex';
  }
}

async function openConversation(convId) {
  activeConvId = convId;
  const conv = allConversations.find(c => c.id === convId) || {};
  activeConvMeta = conv;
  const isSupport = !!conv.is_admin_thread;
  const emp = employerCache[conv.employer_id] || { name: isSupport ? 'Support' : 'Employer', photo: null };
  const displayName = isSupport ? 'Support' : emp.name;

  // Update chat header
  document.getElementById('conv-from').textContent = displayName;
  document.getElementById('conv-avatar').innerHTML = (emp.photo && !isSupport) ? `<img src="${emp.photo}">` : esc((displayName[0] || '?').toUpperCase());
  document.getElementById('conv-status-text').textContent = 'Loading…';
  applyChatLockState();
  const existingGateBanner = document.getElementById('msg-gate-inline-banner');
  if (existingGateBanner) existingGateBanner.remove();
  if (!isSupport) { const gaps = getProfileCompletionGaps(); if (gaps.length) showMsgGateBanner(gaps); }

  subscribePresenceFor(isSupport ? null : conv.employer_id);
  subscribeTypingFor(convId);
  updateChatHeaderStatus();

  // Show chat panel, hide empty placeholder
  document.getElementById('chat-active').style.display = 'flex';
  document.getElementById('chat-no-conv').style.display = 'none';

  // On desktop: hide sidebar when conversation is open
  const sidebar = document.getElementById('chat-sidebar');
  const isDesktop = window.innerWidth > 700;
  if (isDesktop) {
    sidebar.classList.add('hidden-desktop');
  }
  // Mobile: flip to the "conversation open" layout (see common.css's
  // @media (max-width:700px) rules) — this is what actually reveals the
  // chat pane and hides the list on phone-width screens. Previously the
  // list was hidden unconditionally on mobile with nothing to reverse it.
  document.querySelector('.chat-split')?.classList.add('conv-active');

  // Mark active in sidebar
  document.querySelectorAll('.sidebar-msg-item').forEach(el => el.classList.remove('active'));
  document.querySelector(`.sidebar-msg-item[onclick*="${convId}"]`)?.classList.add('active');

  console.log('[MESSAGES] Loading conversation:', convId);

  const { data: msgs, error } = await sb.from('chat_messages')
    .select('id, sender_id, sender_role, body, is_read, delivery_status, created_at, msg_type, file_url, file_name, call_id, reply_to_id')
    .eq('thread_id', convId)
    .eq('is_deleted', false)
    .order('created_at', { ascending: true });

  console.log('[MESSAGES] Messages returned:', msgs?.length);

  if (error) {
    console.error('[MESSAGES] Failed to load messages for conversation', convId, error);
    showToast('err', 'bi-exclamation-circle', 'Could not load messages', error.message || 'Please try again.');
    return;
  }

  const convEl = document.getElementById('conversation-messages');
  if (!convEl) {
    console.error('[MESSAGES] #conversation-messages element is missing from the DOM — cannot render messages.');
    showToast('err', 'bi-exclamation-circle', 'Display error', 'Messages area not found on this page.');
    return;
  }
  convEl.innerHTML = (msgs || []).map(renderMessageBubble).join('');
  convEl.scrollTop = convEl.scrollHeight;
  refreshCallBubbleStatuses(msgs);

  // Mark as read + clear unread atomically (one RPC, one transaction) —
  // only after messages have successfully loaded and rendered above (never
  // before, so a failed/slow load can't clear a badge for content the
  // employee hasn't actually seen).
  const { data: markRead, error: markErr } = await sb.rpc('mark_chat_thread_read', { p_thread_id: convId });
  if (markErr) console.error('[MESSAGES] mark_chat_thread_read failed:', markErr);

  // Reflect the clear locally too — the DB row alone doesn't update the
  // in-memory allConversations copy or the visible #msg-badge, which
  // previously left the badge stuck showing stale unread counts.
  if (!markErr && markRead?.success) {
    const convObj = allConversations.find(c => c.id === convId);
    if (convObj) convObj.employee_unread = 0;
    const badge = document.getElementById('msg-badge');
    if (badge) {
      const totalUnread = allConversations.reduce((s, c) => s + (c.employee_unread || 0), 0);
      badge.textContent = totalUnread;
      badge.classList.toggle('show', totalUnread > 0);
    }
    try { await renderConversationList(); } catch (renderErr) { console.error('[MESSAGES] renderConversationList failed after mark-as-read:', renderErr); }
  }

  if (!document.getElementById('modal-messages').classList.contains('open')) {
    navTo('modal-messages');
  }

  // Clear reply preview
  clearReply();
}

function closeChatSplit() {
  // Show sidebar again (back button on mobile, or show-sidebar on desktop)
  const sidebar = document.getElementById('chat-sidebar');
  sidebar.classList.remove('hidden-desktop');
  document.getElementById('chat-active').style.display = 'none';
  document.getElementById('chat-no-conv').style.display = 'flex';
  activeConvId = null;
  document.querySelectorAll('.sidebar-msg-item').forEach(el => el.classList.remove('active'));
  // Mobile: flip back to the "list" layout.
  document.querySelector('.chat-split')?.classList.remove('conv-active');
}

// ── VOICE NOTES ──
async function toggleRecording() {
  if (mediaRecorder && mediaRecorder.state === 'recording') { stopRecording(); return; }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    recordedChunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };
    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      clearInterval(recordingTimer);
      document.getElementById('recording-bar').classList.remove('show');
      document.getElementById('mic-btn').classList.remove('recording');
      if (mediaRecorder._cancelled) return;
      const blob = new Blob(recordedChunks, { type: 'audio/webm' });
      await uploadVoiceNote(blob);
    };
    mediaRecorder.start();
    recordingSeconds = 0;
    document.getElementById('recording-bar').classList.add('show');
    document.getElementById('mic-btn').classList.add('recording');
    document.getElementById('rec-timer').textContent = '0:00';
    recordingTimer = setInterval(() => {
      recordingSeconds++;
      const m = Math.floor(recordingSeconds / 60), s = recordingSeconds % 60;
      document.getElementById('rec-timer').textContent = `${m}:${s.toString().padStart(2, '0')}`;
    }, 1000);
  } catch (err) {
    showToast('err', 'bi-mic-mute', 'Microphone blocked', 'Please allow microphone access to record a voice message.');
  }
}
function stopRecording() { mediaRecorder._cancelled = false; mediaRecorder.stop(); }
function cancelRecording() {
  if (mediaRecorder) { mediaRecorder._cancelled = true; mediaRecorder.stop(); }
  clearInterval(recordingTimer);
  document.getElementById('recording-bar').classList.remove('show');
  document.getElementById('mic-btn').classList.remove('recording');
}
// Blocks messaging/calling until the profile is complete. Admin/support
// threads are exempt — a worker should always be able to reach support.
function blockIfProfileIncomplete() {
  if (activeConvMeta?.is_admin_thread) return false;
  const gaps = getProfileCompletionGaps();
  if (!gaps.length) return false;
  showMsgGateBanner(gaps);
  showToast('err', 'bi-lock-fill', 'Finish your profile first', 'Complete the items highlighted below to start messaging employers.');
  return true;
}
function showMsgGateBanner(gaps) {
  const bar = document.getElementById('chat-input-bar');
  let banner = document.getElementById('msg-gate-inline-banner');
  if (!banner && bar?.parentElement) {
    banner = document.createElement('div');
    banner.id = 'msg-gate-inline-banner';
    banner.className = 'msg-gate-banner';
    bar.parentElement.insertBefore(banner, bar);
  }
  if (banner) {
    banner.innerHTML = `<strong><i class="bi bi-exclamation-circle"></i> Complete your profile to message employers</strong>
      <ul>${gaps.map(g => `<li>${esc(g)}</li>`).join('')}</ul>
      <button class="btn btn-secondary btn-sm" onclick="navTo('modal-account')">Complete Profile</button>`;
  }
}
async function uploadVoiceNote(blob) {
  if (!activeConvId) return;
  if (blockIfProfileIncomplete()) return;
  showToast('info', 'bi-mic', 'Uploading', 'Sending voice message…');
  // Storage RLS on Media (media_own_folder_insert) requires the first path
  // segment to be the uploader's own auth.uid() — folder must be the uid.
  const path = `${currentUser.id}/voice-notes/${activeConvId}/${Date.now()}.webm`;
  const { error: upErr } = await sb.storage.from('Media').upload(path, blob, { contentType: 'audio/webm' });
  if (upErr) { showToast('err', 'bi-exclamation-circle', 'Upload failed', upErr.message); return; }
  const { data: pub } = sb.storage.from('Media').getPublicUrl(path);
  const { error } = await sb.from('chat_messages').insert({
    thread_id: activeConvId,
    sender_id: currentUser.id,
    sender_role: (allConversations.find(c => c.id === activeConvId)?.employer_id === currentUser.id) ? 'employer' : 'employee',
    body: '[Voice message]',
    msg_type: 'audio', file_url: pub.publicUrl, file_name: 'voice-note.webm', file_type: 'audio/webm',
    is_read: false, delivery_status: 'sent',
  });
  // Thread preview/last_message_at/unread are updated automatically by the
  // trg_update_chat_thread_on_message DB trigger — no manual follow-up needed.
  if (error) { showToast('err', 'bi-exclamation-circle', 'Error', error.message); return; }
  await openConversation(activeConvId);
}

// ════════════════════════════════════════════════════════════════════
//  SOUNDSCARE IN-APP CALL ENGINE
//  WebRTC peer-to-peer + Supabase Realtime signaling
// ════════════════════════════════════════════════════════════════════

// ── State ──
let activeCallId     = null;   // calls.id
let activeCallType   = null;   // 'voice' | 'video'
let activeCallRole   = null;   // 'caller' | 'callee'
let activeCallPeer   = null;   // remote user name
let callTimer        = null;
let callSeconds      = 0;
let isMuted          = false;
let isCamOff         = false;
let isSpeakerOn      = true;
let localStream      = null;
let remoteStream     = null;
let peerConnection   = null;
let incomingCallData = null;
let callSignalChan   = null;   // Supabase realtime channel for this call
let ringtoneCtx      = null;
let ringtoneNode     = null;
let missedCallTimeout = null;
let currentCameraFacing = 'user';

// ── ICE / STUN-TURN servers ──
const ICE_SERVERS = {
  iceServers: [
    { urls: 'stun:stun.l.google.com:19302' },
    { urls: 'stun:stun1.l.google.com:19302' },
    // Free TURN via metered.ca (replace with own creds for production)
    {
      urls: 'turn:a.relay.metered.ca:80',
      username: 'soundscare',
      credential: 'soundscare2026'
    }
  ]
};

// ────────────────────────────────────────────────────────
//  1. INITIATE CALL (caller side)
// ────────────────────────────────────────────────────────
async function startCall(type) {
  if (!activeConvId) { showToast('err', 'bi-exclamation-circle', 'No Conversation', 'Open a conversation first.'); return; }
  if (blockIfProfileIncomplete()) return;
  if (activeCallId)  { showToast('info', 'bi-telephone', 'Already in a Call', 'End the current call first.'); return; }

  const conv = allConversations.find(c => c.id === activeConvId) || {};
  const emp  = employerCache[conv.employer_id] || { name: 'Employer' };
  const name = conv.is_admin_thread ? 'Support' : emp.name;
  const receiverId = conv.is_admin_thread ? null : conv.employer_id;

  if (!receiverId) { showToast('err', 'bi-exclamation-circle', 'Cannot Call', 'Cannot call Support via this channel.'); return; }

  // 1a0. Pre-flight balance check. This does NOT charge anything — actual
  // duration isn't known until the call ends, so the real debit happens in
  // endCall(). This just stops someone starting a call they can't afford
  // even one minute of. connectsTariffs is loaded on dashboard init.
  const perMinCost = type === 'video' ? connectsTariffs?.video_cost_per_min : connectsTariffs?.voice_cost_per_min;
  if (perMinCost != null) {
    const canAfford = await canAffordConnects(perMinCost);
    if (!canAfford) {
      showToast('err', 'bi-wallet2', 'Out of Connects', `You need at least ${perMinCost} Connect(s) to start a ${type} call. Buy more from your wallet.`);
      return;
    }
  }

  // 1a. Request media
  const constraints = type === 'video' ? { audio: true, video: { facingMode: 'user' } } : { audio: true };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    showToast('err', 'bi-mic-mute', 'Permission Denied', 'Allow microphone access and try again.');
    return;
  }

  // 1b. Create calls record in DB
  const roomId = crypto.randomUUID ? crypto.randomUUID() : 'r-' + Date.now();
  const { data: callRow, error: callErr } = await sb.from('calls').insert({
    caller_id: currentUser.id,
    receiver_id: receiverId,
    call_type: type,
    status: 'ringing',
    room_id: roomId,
    started_at: new Date().toISOString(),
  }).select().single();

  if (callErr) { showToast('err', 'bi-exclamation-circle', 'Call Failed', callErr.message); stopLocalStream(); return; }

  activeCallId   = callRow.id;
  activeCallType = type;
  activeCallRole = 'caller';
  activeCallPeer = name;

  // 1c. Show outgoing call screen
  showCallScreen(type, name, emp.photo || null, 'Calling…', 'caller');

  // 1d. Subscribe to signaling channel for this call
  subscribeCallSignaling(callRow.id, roomId);

  // 1e. Create WebRTC peer + send offer after a tick
  await createPeerConnection(type);

  const offer = await peerConnection.createOffer({ offerToReceiveAudio: true, offerToReceiveVideo: type === 'video' });
  await peerConnection.setLocalDescription(offer);

  // 1f. Send signal row (offer) — receiver picks this up via realtime
  await sb.from('calls').update({
    sdp_offer: JSON.stringify(offer)
  }).eq('id', callRow.id);

  // 1g. Also send a chat message so realtime reaches the other user.
  // call_type/status/room_id live on the `calls` row (call_id) now, not on
  // the message itself — see renderCallBubbleContent/refreshCallBubbleStatuses.
  await sb.from('chat_messages').insert({
    thread_id: activeConvId, sender_id: currentUser.id,
    sender_role: conv.is_admin_thread ? 'employee' : (conv.employer_id === currentUser.id ? 'employer' : 'employee'),
    msg_type: 'call', call_id: callRow.id,
    body: `${type === 'video' ? '🎥' : '📞'} ${type === 'video' ? 'Video' : 'Voice'} call — tap to join`,
  });

  // Use the employer's own ringback tone if they've set one in the DB,
  // otherwise fall back to the default local ringback.mp3
  playRingtone('outgoing', emp.ringback_tone_url);

  // Auto-cancel after 30s if not answered
  missedCallTimeout = setTimeout(() => missedCall(), 30000);
}

// ────────────────────────────────────────────────────────
//  2. SHOW CALL SCREEN
// ────────────────────────────────────────────────────────
function showCallScreen(type, name, photo, statusText, role) {
  if (type === 'voice') {
    const ov = document.getElementById('voice-call-overlay');
    const init = (name[0] || '?').toUpperCase();
    document.getElementById('vc-avatar-init').textContent = init;
    document.getElementById('vc-name').textContent = name;
    document.getElementById('vc-role').textContent = role === 'caller' ? 'Outgoing Call' : 'Incoming Call';
    document.getElementById('vc-label').textContent = statusText;
    document.getElementById('vc-timer').classList.remove('show');
    ov.classList.add('open');
  } else {
    const ov = document.getElementById('video-call-overlay');
    const init = (name[0] || '?').toUpperCase();
    document.getElementById('vid-remote-avatar').textContent = init;
    document.getElementById('vid-name').textContent = name;
    document.getElementById('vid-status-text').textContent = statusText;
    document.getElementById('vid-top-name').textContent = name;
    document.getElementById('vid-top-status').textContent = type === 'video' ? 'Video Call' : 'Voice Call';
    document.getElementById('vid-top-avatar').textContent = init;
    document.getElementById('vid-timer').textContent = '0:00';
    ov.classList.add('open');

    // Attach local stream to local video pip
    if (localStream) {
      const lv = document.getElementById('video-local');
      lv.srcObject = localStream;
    }
  }
  updateUserCallStatus('in_call');
}

// ────────────────────────────────────────────────────────
//  3. SHOW INCOMING CALL TOAST (callee side)
// ────────────────────────────────────────────────────────
function showIncomingCall(callerName, callType, convId, callId, roomId, photo) {
  incomingCallData = { callerName, callType, convId, callId, roomId };

  const toast = document.getElementById('incoming-call-bar');
  const init = (callerName[0] || '?').toUpperCase();
  document.getElementById('ic-avatar-init').textContent = init;
  document.getElementById('ic-name').textContent = callerName;
  document.getElementById('ic-calling-label').textContent = `Incoming ${callType === 'video' ? 'Video' : 'Voice'} Call`;
  document.getElementById('ic-sub').textContent = 'SoundsCare';
  document.getElementById('ic-type-badge').innerHTML = `<i class="bi bi-${callType === 'video' ? 'camera-video' : 'telephone'}-fill"></i>`;

  // Reset countdown bar
  const fill = document.getElementById('ic-timer-fill');
  fill.style.animation = 'none';
  fill.offsetHeight; // reflow
  fill.style.animation = '';

  toast.classList.add('show');
  playRingtone('incoming');
  notifyIncomingCallOutsidePage(callerName, callType);

  // Auto-dismiss as missed after 30s
  missedCallTimeout = setTimeout(() => { declineIncomingCall(); missedCallNotify(callerName); }, 30000);
}

// Pop the call to the user's attention even when they're not looking at this tab/window:
// an OS-level Notification (works even minimized, needs permission) plus a flashing tab
// title (works even if Notification permission was denied). Both are cleared as soon as
// the call is answered, declined, or times out — see stopIncomingCallAttention().
let __titleFlashTimer = null;
let __titleFlashOriginal = null;
function notifyIncomingCallOutsidePage(callerName, callType) {
  stopIncomingCallAttention(); // clear any stale flash/notification from a previous call
  if (document.hidden) {
    __titleFlashOriginal = document.title;
    let on = false;
    __titleFlashTimer = setInterval(() => {
      document.title = on ? __titleFlashOriginal : `📞 ${callerName} is calling…`;
      on = !on;
    }, 1000);
  }
  if ('Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`${callType === 'video' ? '🎥' : '📞'} Incoming ${callType} call`, {
        body: `${callerName} · SoundsCare — tap to answer`,
        icon: '/favicon.ico',
        tag: 'soundscare-incoming-call',
        requireInteraction: true,
        vibrate: [300, 150, 300, 150, 300],
      });
      n.onclick = () => { window.focus(); n.close(); };
    } catch (e) { console.warn('[notify] failed:', e); }
  }
}
function stopIncomingCallAttention() {
  if (__titleFlashTimer) { clearInterval(__titleFlashTimer); __titleFlashTimer = null; }
  if (__titleFlashOriginal != null) { document.title = __titleFlashOriginal; __titleFlashOriginal = null; }
}

// ────────────────────────────────────────────────────────
//  4. ACCEPT INCOMING CALL
// ────────────────────────────────────────────────────────
async function acceptIncomingCall() {
  if (!incomingCallData) return;
  document.getElementById('incoming-call-bar').classList.remove('show');
  clearTimeout(missedCallTimeout);
  stopRingtone();
  stopIncomingCallAttention();

  const { callerName, callType, convId, callId, roomId } = incomingCallData;
  incomingCallData = null;

  activeCallId   = callId;
  activeCallType = callType;
  activeCallRole = 'callee';
  activeCallPeer = callerName;
  activeConvId   = convId;

  // Get media
  const constraints = callType === 'video' ? { audio: true, video: { facingMode: 'user' } } : { audio: true };
  try {
    localStream = await navigator.mediaDevices.getUserMedia(constraints);
  } catch (err) {
    showToast('err', 'bi-mic-mute', 'Permission Denied', 'Allow microphone access to answer.'); return;
  }

  showCallScreen(callType, callerName, null, 'Connecting…', 'callee');
  subscribeCallSignaling(callId, roomId);
  await createPeerConnection(callType);

  // Fetch the offer from DB
  const { data: callRow } = await sb.from('calls').select('sdp_offer').eq('id', callId).single();
  if (callRow?.sdp_offer) {
    const offer = JSON.parse(callRow.sdp_offer);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    await sb.from('calls').update({
      status: 'accepted',
      sdp_answer: JSON.stringify(answer),
    }).eq('id', callId);
  }

  updateUserCallStatus('in_call');
}

// ────────────────────────────────────────────────────────
//  5. DECLINE INCOMING CALL
// ────────────────────────────────────────────────────────
async function declineIncomingCall() {
  document.getElementById('incoming-call-bar').classList.remove('show');
  clearTimeout(missedCallTimeout);
  stopRingtone();
  stopIncomingCallAttention();

  if (incomingCallData?.callId) {
    await sb.from('calls').update({ status: 'rejected', ended_at: new Date().toISOString() }).eq('id', incomingCallData.callId);
  }
  incomingCallData = null;
}

// ────────────────────────────────────────────────────────
//  6. END ACTIVE CALL
// ────────────────────────────────────────────────────────
async function endCall(type) {
  clearInterval(callTimer); callTimer = null;
  clearTimeout(missedCallTimeout);
  stopRingtone();

  // Update DB
  if (activeCallId) {
    await sb.from('calls').update({
      status: 'ended',
      ended_at: new Date().toISOString(),
      duration: callSeconds,
    }).eq('id', activeCallId);

    // Update participant left_at
    await sb.from('call_participants').update({ left_at: new Date().toISOString() })
      .eq('call_id', activeCallId).eq('user_id', currentUser.id);

    // Charge Connects for the actual call duration, rounded up to the
    // nearest minute (so a 61-second call costs 2 minutes, not 1 — matches
    // how the tariff is priced per-minute). Only the caller is billed here;
    // the callee side wires the same debit in its own endCall(). A 0-second
    // call (rejected/missed before connecting) isn't charged at all.
    if (callSeconds > 0) {
      const minutes = Math.ceil(callSeconds / 60);
      const debit = await debitConnects(type, minutes, 'call', activeCallId);
      if (debit.success) {
        updateConnectsWidget(debit.balance);
      } else {
        // The call already happened — we can't un-happen it, so this is a
        // billing reconciliation problem, not something to block the UI on.
        // Surface it clearly rather than silently losing the charge.
        console.error('Connects debit failed after call ended:', debit);
        showToast('err', 'bi-exclamation-triangle', 'Billing Issue', `Couldn't charge Connects for this call (${minutes} min). Contact support if this keeps happening.`);
      }
    }
  }

  // Cleanup WebRTC
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  stopLocalStream();

  // Close overlay
  document.getElementById(type === 'voice' ? 'voice-call-overlay' : 'video-call-overlay').classList.remove('open');

  // Toast with duration
  const dur = callSeconds > 0 ? `${Math.floor(callSeconds/60)}m ${callSeconds%60}s` : '';
  showToast('ok', 'bi-telephone-x', 'Call Ended', dur ? `Duration: ${dur}` : 'Call ended.');
  callSeconds = 0;

  // Unsubscribe signal channel
  if (callSignalChan) { sb.removeChannel(callSignalChan); callSignalChan = null; }

  activeCallId = null; activeCallType = null; activeCallRole = null;
  isMuted = false; isCamOff = false; isSpeakerOn = true;
  updateUserCallStatus('online');
}

async function missedCall() {
  if (!activeCallId) return;
  await sb.from('calls').update({ status: 'missed', ended_at: new Date().toISOString() }).eq('id', activeCallId);
  const type = activeCallType || 'voice';
  document.getElementById(type === 'voice' ? 'voice-call-overlay' : 'video-call-overlay').classList.remove('open');
  stopLocalStream(); stopRingtone();
  showToast('info', 'bi-telephone-missed', 'No Answer', `${activeCallPeer || 'User'} didn't answer.`);
  activeCallId = null; activeCallType = null; activeCallRole = null;
  updateUserCallStatus('online');
}

function missedCallNotify(name) {
  showToast('info', 'bi-telephone-missed', 'Missed Call', `Missed ${activeCallType || 'voice'} call from ${name}.`);
}

// ────────────────────────────────────────────────────────
//  7. WEBRTC PEER CONNECTION
// ────────────────────────────────────────────────────────
async function createPeerConnection(type) {
  peerConnection = new RTCPeerConnection(ICE_SERVERS);

  // Add local tracks
  if (localStream) {
    localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));
  }

  // ICE candidates — send via Supabase
  peerConnection.onicecandidate = async (evt) => {
    if (evt.candidate && activeCallId) {
      await sb.from('call_ice_candidates').insert({
        call_id: activeCallId,
        user_id: currentUser.id,
        candidate: JSON.stringify(evt.candidate),
      }).then(() => {}).catch(() => {});
    }
  };

  // Remote stream received
  peerConnection.ontrack = (evt) => {
    remoteStream = evt.streams[0];
    if (type === 'video') {
      const rv = document.getElementById('video-remote');
      rv.srcObject = remoteStream;
      document.getElementById('vid-remote-placeholder').style.display = 'none';
    }
    // Start call timer when remote track arrives
    if (!callTimer) startCallTimer(type);
  };

  peerConnection.onconnectionstatechange = () => {
    const s = peerConnection?.connectionState;
    if (s === 'connected') {
      if (type === 'voice') {
        document.getElementById('vc-label').textContent = 'Connected';
        document.getElementById('vc-status-dot').style.background = 'var(--green)';
      }
    } else if (s === 'failed' || s === 'disconnected') {
      showToast('err', 'bi-wifi-off', 'Connection Lost', 'The call was interrupted.');
      endCall(type);
    }
  };
}

// ────────────────────────────────────────────────────────
//  8. SUPABASE SIGNALING SUBSCRIPTION
// ────────────────────────────────────────────────────────
function subscribeCallSignaling(callId, roomId) {
  callSignalChan = sb.channel(`call-signal-${callId}`)
    // Listen for call status changes (accepted/rejected/ended)
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'calls', filter: `id=eq.${callId}` }, async (payload) => {
      const row = payload.new;

      if (row.status === 'accepted' && activeCallRole === 'caller' && row.sdp_answer) {
        // Caller receives the answer
        const answer = JSON.parse(row.sdp_answer);
        if (peerConnection && peerConnection.signalingState !== 'stable') {
          await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
        }
      }

      if (row.status === 'rejected') {
        stopRingtone();
        const overlay = document.getElementById(activeCallType === 'voice' ? 'voice-call-overlay' : 'video-call-overlay');
        overlay.classList.remove('open');
        showToast('info', 'bi-telephone-x', 'Call Declined', `${activeCallPeer} declined the call.`);
        stopLocalStream(); clearInterval(callTimer); callTimer = null;
        activeCallId = null; activeCallType = null; activeCallRole = null;
        updateUserCallStatus('online');
      }

      if (row.status === 'ended' && activeCallRole === 'callee') {
        endCall(activeCallType || 'voice');
      }
    })
    // ICE candidates from the other side
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'call_ice_candidates',
        filter: `call_id=eq.${callId}` }, async (payload) => {
      const row = payload.new;
      if (row.user_id === currentUser.id) return; // skip own candidates
      if (peerConnection && row.candidate) {
        try {
          await peerConnection.addIceCandidate(new RTCIceCandidate(JSON.parse(row.candidate)));
        } catch (e) { console.warn('ICE candidate error:', e); }
      }
    })
    .subscribe();
}

// ────────────────────────────────────────────────────────
//  9. CALL TIMER
// ────────────────────────────────────────────────────────
function startCallTimer(type) {
  stopRingtone();
  callSeconds = 0;
  if (type === 'voice') {
    document.getElementById('vc-label').textContent = 'Connected';
    const timerEl = document.getElementById('vc-timer');
    timerEl.classList.add('show');
    callTimer = setInterval(() => {
      callSeconds++;
      const m = Math.floor(callSeconds/60), s = callSeconds%60;
      timerEl.textContent = `${m}:${s.toString().padStart(2,'0')}`;
    }, 1000);
  } else {
    callTimer = setInterval(() => {
      callSeconds++;
      const m = Math.floor(callSeconds/60), s = callSeconds%60;
      document.getElementById('vid-timer').textContent = `${m}:${s.toString().padStart(2,'0')}`;
    }, 1000);
  }
}

// ────────────────────────────────────────────────────────
//  10. MIC / CAMERA / SPEAKER TOGGLES
// ────────────────────────────────────────────────────────
function toggleMute(type) {
  isMuted = !isMuted;
  if (localStream) {
    localStream.getAudioTracks().forEach(t => { t.enabled = !isMuted; });
  }
  const btnId = type === 'voice' ? 'vc-mute' : 'vid-mute';
  const btn = document.getElementById(btnId);
  btn.classList.toggle('active', isMuted);
  btn.innerHTML = `<i class="bi bi-mic${isMuted ? '-mute' : ''}-fill"></i>`;
  showToast('info', isMuted ? 'bi-mic-mute-fill' : 'bi-mic-fill', isMuted ? 'Microphone Muted' : 'Microphone On', '');
}

function toggleCamera() {
  isCamOff = !isCamOff;
  if (localStream) {
    localStream.getVideoTracks().forEach(t => { t.enabled = !isCamOff; });
  }
  const btn = document.getElementById('vid-cam');
  btn.classList.toggle('active', isCamOff);
  btn.innerHTML = `<i class="bi bi-camera-video${isCamOff ? '-off' : ''}-fill"></i>`;
  document.getElementById('pip-cam-off').style.display = isCamOff ? 'flex' : 'none';
}

function toggleSpeaker() {
  isSpeakerOn = !isSpeakerOn;
  const btn = document.getElementById('vc-speaker');
  btn.classList.toggle('active', !isSpeakerOn);
  btn.innerHTML = `<i class="bi bi-volume-${isSpeakerOn ? 'up' : 'mute'}-fill"></i>`;
  showToast('info', isSpeakerOn ? 'bi-volume-up-fill' : 'bi-volume-mute-fill', isSpeakerOn ? 'Speaker On' : 'Speaker Off', '');
}

function toggleSpeakerVideo() {
  isSpeakerOn = !isSpeakerOn;
  const rv = document.getElementById('video-remote');
  if (rv) rv.muted = !isSpeakerOn;
  const btn = document.getElementById('vid-speaker');
  btn.classList.toggle('active', !isSpeakerOn);
  btn.innerHTML = `<i class="bi bi-volume-${isSpeakerOn ? 'up' : 'mute'}-fill"></i>`;
}

// Switch camera (front/back) during video call
async function switchCamera() {
  if (!localStream) return;
  currentCameraFacing = currentCameraFacing === 'user' ? 'environment' : 'user';
  const newStream = await navigator.mediaDevices.getUserMedia({
    audio: true, video: { facingMode: currentCameraFacing }
  }).catch(() => null);
  if (!newStream) return;
  const videoTrack = newStream.getVideoTracks()[0];
  localStream.getVideoTracks().forEach(t => t.stop());
  localStream = new MediaStream([...newStream.getAudioTracks(), videoTrack]);
  document.getElementById('video-local').srcObject = localStream;
  // Replace track in peer connection
  if (peerConnection) {
    const sender = peerConnection.getSenders().find(s => s.track?.kind === 'video');
    if (sender) sender.replaceTrack(videoTrack);
  }
  showToast('info', 'bi-arrow-repeat', `Camera Switched`, `Now using ${currentCameraFacing === 'user' ? 'front' : 'rear'} camera.`);
}

// Switch from voice call to video call mid-call
async function switchToVideo() {
  if (activeCallType === 'video') return;
  try {
    const newStream = await navigator.mediaDevices.getUserMedia({ audio: true, video: true });
    localStream = newStream;
    document.getElementById('voice-call-overlay').classList.remove('open');
    showCallScreen('video', activeCallPeer, null, 'Connected', activeCallRole);
    activeCallType = 'video';
    if (peerConnection) {
      const videoTrack = newStream.getVideoTracks()[0];
      peerConnection.addTrack(videoTrack, newStream);
    }
    document.getElementById('video-local').srcObject = newStream;
  } catch (e) {
    showToast('err', 'bi-camera-video-off', 'Camera Unavailable', 'Could not switch to video.');
  }
}

function toggleKeypad() {
  showToast('info', 'bi-grid-3x3-gap', 'Keypad', 'Dial-pad — coming soon.');
}

// ────────────────────────────────────────────────────────
//  11. USER STATUS
// ────────────────────────────────────────────────────────
const USER_STATUSES = {
  online:  { label: 'Online',           color: '#22c55e' },
  offline: { label: 'Offline',          color: '#9ca3af' },
  away:    { label: 'Away',             color: '#E8A040' },
  busy:    { label: 'Busy',             color: '#f43f5e' },
  in_call: { label: 'In Call',          color: '#8b5cf6' },
  dnd:     { label: 'Do Not Disturb',   color: '#fb7185' },
};

let myStatus = 'online';

async function updateUserCallStatus(status) {
  myStatus = status;
  const def = USER_STATUSES[status] || USER_STATUSES.online;
  // Update pill in nav
  const pill = document.getElementById('online-status');
  if (pill) {
    pill.className = `status-pill status-${status}`;
    pill.innerHTML = `<span class="status-dot"></span>${def.label}`;
  }
  // Push to DB
  await sb.from('user_presence').upsert({
    user_id: currentUser.id,
    status,
    is_online: status !== 'offline',
    last_seen: new Date().toISOString(),
  }, { onConflict: 'user_id' }).catch(() => {});
}

// Helper: render a status pill HTML string
function renderStatusPill(status, lastSeen) {
  const def = USER_STATUSES[status] || USER_STATUSES.offline;
  if (status === 'offline' && lastSeen) {
    const ago = timeAgo(new Date(lastSeen));
    return `<span class="status-pill status-offline"><span class="status-dot"></span>Last seen ${ago}</span>`;
  }
  return `<span class="status-pill status-${status}"><span class="status-dot"></span>${def.label}</span>`;
}

// ────────────────────────────────────────────────────────
//  12. RINGTONE / RINGBACK (real audio files, with synth fallback)
//  - Incoming calls (callee hears): local file  ringtone.mp3
//  - Outgoing calls (caller hears): employer's custom ringback
//    (employer_profiles.ringback_tone_url, fetched from DB via
//    get_employer_names RPC into employerCache) — falls back to
//    the default local file  ringback.mp3  if the employer has
//    not set one, or to the Web Audio synth tone if playback fails.
// ────────────────────────────────────────────────────────
let ringtoneAudioEl = null;

function playRingtone(mode, customUrl) {
  stopRingtone();

  const src = mode === 'incoming'
    ? 'ringtone.mp3'
    : (customUrl || 'ringback.mp3');

  try {
    ringtoneAudioEl = new Audio(src);
    ringtoneAudioEl.loop = true;
    ringtoneAudioEl.volume = 0.7;
    ringtoneAudioEl.preload = 'auto';

    // If the file 404s / can't decode / can't autoplay, fall back to the
    // synthesized tone so the call still rings audibly.
    ringtoneAudioEl.addEventListener('error', () => playSynthRingtone(mode), { once: true });

    const playPromise = ringtoneAudioEl.play();
    if (playPromise && typeof playPromise.catch === 'function') {
      playPromise.catch(() => playSynthRingtone(mode));
    }
  } catch (e) {
    console.warn('Ringtone audio error, falling back to synth:', e);
    playSynthRingtone(mode);
  }
}

function playSynthRingtone(mode) {
  try {
    if (ringtoneCtx) { try { ringtoneCtx.close(); } catch(e) {} }
    ringtoneCtx = new (window.AudioContext || window.webkitAudioContext)();
    const masterGain = ringtoneCtx.createGain();
    masterGain.gain.value = 0.18;
    masterGain.connect(ringtoneCtx.destination);

    function beep(freq, startT, dur) {
      const osc = ringtoneCtx.createOscillator();
      const g   = ringtoneCtx.createGain();
      osc.type = 'sine';
      osc.frequency.value = freq;
      g.gain.setValueAtTime(0, startT);
      g.gain.linearRampToValueAtTime(1, startT + 0.02);
      g.gain.linearRampToValueAtTime(0, startT + dur - 0.02);
      osc.connect(g); g.connect(masterGain);
      osc.start(startT); osc.stop(startT + dur);
    }

    if (mode === 'incoming') {
      // Two-tone ring pattern
      for (let i = 0; i < 20; i++) {
        const t = ringtoneCtx.currentTime + i * 1.8;
        beep(480, t, 0.4);
        beep(620, t + 0.04, 0.4);
      }
    } else {
      // Outgoing: gentle single tone repeating
      for (let i = 0; i < 20; i++) {
        const t = ringtoneCtx.currentTime + i * 1.5;
        beep(520, t, 0.5);
      }
    }
    ringtoneNode = masterGain;
  } catch (e) { console.warn('Synth ringtone error:', e); }
}

function stopRingtone() {
  try {
    if (ringtoneAudioEl) {
      ringtoneAudioEl.pause();
      ringtoneAudioEl.src = '';
      ringtoneAudioEl = null;
    }
  } catch(e) {}
  try { if (ringtoneCtx) { ringtoneCtx.close(); ringtoneCtx = null; ringtoneNode = null; } } catch(e) {}
}

// ────────────────────────────────────────────────────────
//  13. CLEANUP
// ────────────────────────────────────────────────────────
function stopLocalStream() {
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
}

// Request notification permission on load
async function requestNotifPermission() {
  if ('Notification' in window && Notification.permission === 'default') {
    await Notification.requestPermission().catch(() => {});
  }
}

// ────────────────────────────────────────────────────────
//  PUSH NOTIFICATIONS (foreground browser notifications)
// ────────────────────────────────────────────────────────
async function enablePushNotifications() {
  if (!('Notification' in window)) {
    showToast('err', 'bi-exclamation-circle', 'Not Supported', 'Push notifications are not supported in this browser.');
    return;
  }
  const perm = await Notification.requestPermission().catch(() => 'denied');
  updatePushBanner();
  if (perm === 'granted') {
    showToast('ok', 'bi-bell-fill', 'Notifications Enabled', 'You\'ll now get push notifications for messages and updates.');
    pushNotify('🔔 Notifications On', 'You will now receive push notifications from SoundsCare.', { tag: 'push-enabled' });
  } else if (perm === 'denied') {
    showToast('err', 'bi-exclamation-circle', 'Blocked', 'Notifications are blocked in your browser settings.');
  }
}

function updatePushBanner() {
  const banner = document.getElementById('push-notif-banner');
  if (!banner) return;
  banner.style.display = ('Notification' in window && Notification.permission !== 'granted') ? 'flex' : 'none';
}

function pushNotify(title, body, opts = {}) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  // Avoid duplicate popups when the user is already looking at the tab and the modal in question
  if (document.hasFocus() && opts.skipIfFocused) return;
  try {
    const n = new Notification(title, {
      body,
      icon: 'https://sounds.co.ke/favicon.ico',
      tag: opts.tag || undefined,
    });
    n.onclick = () => {
      window.focus();
      if (opts.onClick) opts.onClick();
      n.close();
    };
  } catch (e) { console.warn('pushNotify error:', e); }
}

// ────────────────────────────────────────────────────────
//  14. SUBSCRIBE TO INCOMING CALLS VIA REALTIME
// ────────────────────────────────────────────────────────
// Calls can be "not ringing" for two very different reasons: (a) the realtime channel
// never delivers the INSERT event (Supabase Realtime replication not enabled on `calls`,
// RLS blocking the row, a dropped websocket, etc.) or (b) it delivers fine but this tab
// was in the background and nothing drew the user's eye to it. We fix (a) with a DB
// polling fallback that catches anything realtime misses, and (b) with the popup/title
// flash added in notifyIncomingCallOutsidePage() above. _shownCallIds dedupes so a call
// caught by both paths only pops once.
let incomingCallsChan = null;
const _shownCallIds = new Set();

async function _resolveCallerNameAndConv(row) {
  const { data: callerProfile } = await sb.from('worker_profiles').select('full_name').eq('session_id', row.caller_id).maybeSingle()
    .catch(() => ({ data: null }));
  const { data: empProfile } = await sb.from('employer_profiles').select('full_name, company_name').eq('user_id', row.caller_id).maybeSingle()
    .catch(() => ({ data: null }));
  const callerName = callerProfile?.full_name || empProfile?.full_name || empProfile?.company_name || 'Unknown Caller';
  const conv = allConversations.find(c => c.employer_id === row.caller_id || c.employee_id === row.caller_id);
  return { callerName, convId: conv?.id || null };
}

async function _handleIncomingCallRow(row) {
  if (row.status !== 'ringing' || _shownCallIds.has(row.id)) return;
  if (activeCallId || incomingCallData) {
    // Already in (or already being offered) a call — auto-reject
    await sb.from('calls').update({ status: 'rejected' }).eq('id', row.id).catch(() => {});
    return;
  }
  _shownCallIds.add(row.id);
  const { callerName, convId } = await _resolveCallerNameAndConv(row);
  showIncomingCall(callerName, row.call_type || 'voice', convId, row.id, row.room_id, null);
}

function subscribeIncomingCalls() {
  // Listen for new calls where I am the receiver
  if (incomingCallsChan) { try { sb.removeChannel(incomingCallsChan); } catch (e) {} }
  incomingCallsChan = sb.channel('incoming-calls')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'calls',
      filter: `receiver_id=eq.${currentUser.id}` }, (payload) => {
      _handleIncomingCallRow(payload.new);
    })
    .subscribe((status) => {
      console.log('[incoming-calls] status:', status);
      if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        console.warn('[incoming-calls] realtime subscription failed — incoming calls may not be delivered. Retrying…');
        setTimeout(subscribeIncomingCalls, 3000);
      }
    });
  startIncomingCallPolling();
}

// Polling fallback: every 3s, ask the DB directly for a fresh 'ringing' call addressed
// to us. This is what makes calls ring even if the realtime channel above is silently
// broken — it's the DB source of truth, not an event stream that can be missed.
let _incomingCallPollTimer = null;
function startIncomingCallPolling() {
  if (_incomingCallPollTimer) return;
  _incomingCallPollTimer = setInterval(async () => {
    if (!currentUser?.id || activeCallId || incomingCallData) return;
    const since = new Date(Date.now() - 30000).toISOString();
    const { data: rows, error } = await sb.from('calls')
      .select('*')
      .eq('receiver_id', currentUser.id)
      .eq('status', 'ringing')
      .gte('started_at', since)
      .order('started_at', { ascending: false })
      .limit(1);
    if (error) { console.warn('[incoming-call-poll]', error.message); return; }
    if (rows && rows[0]) await _handleIncomingCallRow(rows[0]);
  }, 3000);
}

// SQL for new tables (for reference / run in Supabase SQL editor):
/*
CREATE TABLE IF NOT EXISTS calls (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id uuid REFERENCES auth.users(id),
  receiver_id uuid REFERENCES auth.users(id),
  call_type text CHECK (call_type IN ('voice','video')) DEFAULT 'voice',
  status text CHECK (status IN ('ringing','accepted','rejected','ended','missed')) DEFAULT 'ringing',
  room_id text,
  sdp_offer text,
  sdp_answer text,
  started_at timestamptz DEFAULT now(),
  ended_at timestamptz,
  duration integer DEFAULT 0,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE calls ENABLE ROW LEVEL SECURITY;
CREATE POLICY "users_own_calls" ON calls USING (caller_id = auth.uid() OR receiver_id = auth.uid());

CREATE TABLE IF NOT EXISTS call_participants (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  joined_at timestamptz DEFAULT now(),
  left_at timestamptz,
  microphone_enabled boolean DEFAULT true,
  camera_enabled boolean DEFAULT true
);
ALTER TABLE call_participants ENABLE ROW LEVEL SECURITY;
CREATE POLICY "participants_own" ON call_participants USING (user_id = auth.uid());

CREATE TABLE IF NOT EXISTS call_ice_candidates (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id uuid REFERENCES calls(id) ON DELETE CASCADE,
  user_id uuid REFERENCES auth.users(id),
  candidate text NOT NULL,
  created_at timestamptz DEFAULT now()
);
ALTER TABLE call_ice_candidates ENABLE ROW LEVEL SECURITY;
CREATE POLICY "ice_by_call_members" ON call_ice_candidates
  USING (EXISTS (SELECT 1 FROM calls WHERE id = call_id AND (caller_id = auth.uid() OR receiver_id = auth.uid())));

CREATE TABLE IF NOT EXISTS call_settings (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  allow_voice_calls boolean DEFAULT true,
  allow_video_calls boolean DEFAULT true,
  auto_accept_calls boolean DEFAULT false,
  do_not_disturb boolean DEFAULT false,
  blocked_users uuid[] DEFAULT '{}',
  updated_at timestamptz DEFAULT now()
);
ALTER TABLE call_settings ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own_call_settings" ON call_settings USING (user_id = auth.uid());
*/

// ── CHAT ACTIONS ──
async function markNotInterested() {
  if (!activeConvId) return;
  toggleChatMenu();
  const reason = prompt('You\'re marking this employer as Not Interested. Please give a brief reason:');
  if (reason === null) return;
  await sb.from('chat_threads').update({ not_interested_at: new Date().toISOString(), not_interested_by: currentUser.id, not_interested_reason: reason || null, status: 'closed' }).eq('id', activeConvId);
  showToast('ok', 'bi-check-circle', 'Noted', 'Marked as not interested. Conversation closed.');
  activeConvMeta.status = 'closed';
  applyChatLockState();
  await loadDashboard();
}
async function endInterview() {
  if (!activeConvId) return;
  toggleChatMenu();
  if (!confirm('End this interview? Communication with this employer will stop.')) return;
  await sb.from('chat_threads').update({ status: 'closed' }).eq('id', activeConvId);
  showToast('ok', 'bi-door-closed', 'Ended', 'Interview ended. Conversation closed.');
  activeConvMeta.status = 'closed';
  applyChatLockState();
  await loadDashboard();
}
async function reportFraud() {
  if (!activeConvId) return;
  toggleChatMenu();
  const reason = prompt('Describe the fraudulent behavior you experienced:');
  if (!reason) return;
  // message_reports.conversation_id still points at the legacy conversations
  // table's id column, but that id is kept identical to chat_threads.id by
  // the bridge sync triggers, so activeConvId is valid here unchanged.
  const { error } = await sb.from('message_reports').insert({
    reported_by: currentUser.id, reported_user: activeConvMeta?.employer_id,
    conversation_id: activeConvId, reason: 'fraud', details: reason, status: 'pending',
  });
  if (error) { showToast('err', 'bi-exclamation-circle', 'Error', error.message); return; }
  showToast('ok', 'bi-flag-fill', 'Reported', 'Our team will review this report.');
}
async function whitelistEmployer() {
  if (!activeConvId) return;
  toggleChatMenu();
  if (!confirm('Whitelist this employer as trusted?')) return;
  await sb.from('chat_threads').update({ employer_whitelisted: true }).eq('id', activeConvId);
  showToast('ok', 'bi-shield-check', 'Whitelisted', 'Employer marked as trusted.');
}
async function blockEmployer() {
  if (!activeConvId) return;
  toggleChatMenu();
  if (!confirm('Block this employer? They will no longer be able to message you.')) return;
  await sb.from('chat_threads').update({ employee_blocked: true, status: 'closed' }).eq('id', activeConvId);
  showToast('ok', 'bi-slash-circle', 'Blocked', 'Employer has been blocked.');
  activeConvMeta.employee_blocked = true; activeConvMeta.status = 'closed';
  applyChatLockState();
  await loadDashboard();
}

// ════════════════════════════════════════════════════════
//  JOBS
// ════════════════════════════════════════════════════════
function populateCountyFilter(jobs) {
  const counties = [...new Set(jobs.map(j => j.county).filter(Boolean))].sort();
  const sel = document.getElementById('job-county');
  counties.forEach(c => {
    const opt = document.createElement('option');
    opt.value = c; opt.textContent = c;
    sel.appendChild(opt);
  });
}

function filterJobs() {
  const q = document.getElementById('job-search').value.toLowerCase();
  const county = document.getElementById('job-county').value;
  const filtered = allJobs.filter(j => {
    const matchQ = !q || (j.title + j.description + j.job_role).toLowerCase().includes(q);
    const matchC = !county || j.county === county;
    return matchQ && matchC;
  });
  renderJobs(filtered);
}

// ── small render helpers ──────────────────────────────────
function workTypeChip(workType) {
  if (!workType) return '';
  const key = workType.toLowerCase();
  const iconMap = { onsite: 'bi-building', remote: 'bi-house-door', hybrid: 'bi-arrow-left-right' };
  const cls = key === 'onsite' ? 'type-onsite' : key === 'remote' ? 'type-remote' : key === 'hybrid' ? 'type-hybrid' : '';
  const icon = iconMap[key] || 'bi-briefcase';
  return `<span class="job-chip ${cls}"><i class="bi ${icon}"></i> ${esc(workType)}</span>`;
}

function durationChip(j) {
  if (!j.duration_value && !j.duration_type) return '';
  const label = j.duration_value || ({ ongoing: 'Ongoing', fixed_term: 'Fixed Term', one_time: 'One-time', recurring: 'Recurring' })[j.duration_type] || '';
  if (!label) return '';
  return `<span class="job-chip duration"><i class="bi bi-clock-history"></i> ${esc(label)}</span>`;
}

function renderStars(avg, count) {
  const rating = Math.round(avg || 0);
  let stars = '';
  for (let i = 1; i <= 5; i++) {
    stars += `<i class="bi ${i <= rating ? 'bi-star-fill' : 'bi-star empty'}"></i>`;
  }
  return `<span class="job-rating-stars">${stars}<span class="job-rating-count">${count ? `(${count})` : 'No ratings yet'}</span></span>`;
}

function renderJobsVerifyBanner() {
  const el = document.getElementById('jobs-verify-email-banner');
  if (!el) return;
  const emailVerified = !!(workerProfile?.email_verified || currentUser?.email_confirmed_at);
  el.innerHTML = emailVerified ? '' : `
    <div class="verify-email-banner">
      <span><i class="bi bi-envelope-exclamation"></i> Your email isn't verified yet — some employers only consider verified profiles.</span>
      <button class="btn btn-primary btn-sm" onclick="navTo('modal-account'); switchEdTab('ed-verification', document.querySelector('[data-ed-tab=\\'ed-verification\\']'))">Verify Email</button>
    </div>`;
}
function renderJobs(jobs) {
  renderJobsVerifyBanner();
  const el = document.getElementById('jobs-list');
  if (!jobs.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-briefcase"></i><p>No jobs match your search</p></div>';
    return;
  }
  // Recommend jobs that match the worker's chosen category by floating them
  // to the top of the list (stable otherwise) — this is what "category can
  // be changed by user / helps place & recommend them for employers" drives.
  const myCategory = workerProfile?.category;
  const scored = jobs.map((j, i) => ({ j, i, match: myCategory ? categoriesLooselyMatch(myCategory, j.category) : false }));
  scored.sort((a, b) => (b.match - a.match) || (a.i - b.i));
  el.innerHTML = scored.map(({ j, match }) => jobCardHtml(j, match)).join('');
}

// ════════════════════════════════════════════════════════
//  BID ON A JOB (replaces the old plain "Apply Now" flow)
//  Fixed-price jobs: worker just confirms the posted price.
//  Negotiable jobs: worker enters their own asking price.
// ════════════════════════════════════════════════════════
function openBidModal(jobId) {
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Profile Required', 'Complete your profile first to bid on jobs.');
    return;
  }
  const job = allJobs.find(j => j.id === jobId);
  if (!job) { showToast('err', 'bi-exclamation-circle', 'Not Found', 'Could not find that job.'); return; }
  if (myApplications.some(a => a.job_id === jobId)) {
    showToast('info', 'bi-info-circle', 'Already Bid', 'You have already placed a bid on this job.');
    return;
  }

  const negotiable = job.pricing_mode === 'negotiable';
  const fixedAmount = +job.salary_min || 0;
  bidCtx = { jobId, title: job.title || 'Job', pricingMode: negotiable ? 'negotiable' : 'fixed', fixedAmount };

  document.getElementById('bid-job-title').textContent = job.title || 'Job';
  document.getElementById('bid-job-sub').textContent = [job.company_name, job.county].filter(Boolean).join(' · ') || '—';

  const typeBadge = document.getElementById('bid-type-badge');
  typeBadge.className = 'badge ' + (negotiable ? 'text-bg-info' : 'text-bg-secondary');
  typeBadge.innerHTML = `<i class="bi ${negotiable ? 'bi-chat-left-text-fill' : 'bi-tag-fill'}"></i> ${negotiable ? 'Negotiable' : 'Fixed Price'}`;

  document.getElementById('bid-fixed-wrap').style.display = negotiable ? 'none' : 'block';
  document.getElementById('bid-negotiable-wrap').style.display = negotiable ? 'block' : 'none';
  if (!negotiable) {
    document.getElementById('bid-fixed-amount').textContent = 'KES ' + fixedAmount.toLocaleString('en-KE');
  } else {
    document.getElementById('bid-price-input').value = job.salary_min ? job.salary_min : '';
  }
  document.getElementById('bid-error').style.display = 'none';
  document.getElementById('bid-submit-btn').disabled = false;
  document.getElementById('bid-submit-btn').innerHTML = '<i class="bi bi-send-fill"></i> Submit Bid';

  openModal('modal-bid');
}

async function submitBid() {
  const errEl = document.getElementById('bid-error');
  errEl.style.display = 'none';
  const { jobId, pricingMode, fixedAmount } = bidCtx;
  if (!jobId) return;

  let bidAmount = fixedAmount;
  if (pricingMode === 'negotiable') {
    const raw = document.getElementById('bid-price-input').value;
    bidAmount = parseFloat(raw);
    if (!raw || isNaN(bidAmount) || bidAmount <= 0) {
      errEl.textContent = 'Enter a valid price for your bid.';
      errEl.style.display = 'block';
      return;
    }
  }

  const btn = document.getElementById('bid-submit-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Submitting…';

  // Re-check for an existing application — RLS uses worker_id = auth.uid()
  const { data: existing } = await sb.from('job_applications')
    .select('id')
    .eq('job_id', jobId)
    .eq('worker_id', currentUser.id)
    .maybeSingle();

  if (existing) {
    showToast('info', 'bi-info-circle', 'Already Bid', 'You have already placed a bid on this job.');
    closeModal('modal-bid');
    return;
  }

  const { error } = await sb.from('job_applications').insert({
    job_id: jobId,
    worker_id: workerProfile.id,
    worker_name: workerProfile.full_name || '',
    worker_phone: workerProfile.phone || workerProfile.phone_number || '',
    status: 'pending',
    bid_amount: bidAmount,
    applied_at: new Date().toISOString(),
  });

  if (error) {
    errEl.textContent = error.message;
    errEl.style.display = 'block';
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-send-fill"></i> Submit Bid';
    return;
  }

  showToast('ok', 'bi-check-circle', 'Bid Submitted!', `Your ${pricingMode === 'negotiable' ? 'offer of KES ' + bidAmount.toLocaleString('en-KE') : 'bid'} has been sent to the employer.`);
  myApplications.push({ job_id: jobId, status: 'pending', bid_amount: bidAmount, applied_at: new Date().toISOString() });
  closeModal('modal-bid');
  renderJobs(allJobs);
  renderBidedJobs();
}

// ════════════════════════════════════════════════════════
//  SAVE / WHITELIST JOBS (bookmark)
// ════════════════════════════════════════════════════════
async function toggleSaveJob(jobId, btn) {
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Profile Required', 'Complete your profile first.');
    return;
  }
  const wasSaved = savedJobIds.has(jobId);
  btn.disabled = true;
  try {
    if (wasSaved) {
      const { error } = await sb.from('saved_jobs').delete().eq('job_id', jobId).eq('worker_id', workerProfile.id);
      if (error) throw error;
      savedJobIds.delete(jobId);
      showToast('info', 'bi-bookmark', 'Removed', 'Job removed from saved jobs.');
    } else {
      const { error } = await sb.from('saved_jobs').insert({ job_id: jobId, worker_id: workerProfile.id });
      if (error) throw error;
      savedJobIds.add(jobId);
      showToast('ok', 'bi-bookmark-check-fill', 'Saved', 'Job added to your saved jobs.');
    }
    btn.classList.toggle('active', !wasSaved);
    btn.querySelector('i').className = `bi ${!wasSaved ? 'bi-bookmark-check-fill' : 'bi-bookmark'}`;
  } catch (err) {
    showToast('err', 'bi-exclamation-circle', 'Error', err.message);
  } finally {
    btn.disabled = false;
  }
}

async function loadSavedJobs() {
  const el = document.getElementById('saved-jobs-list');
  if (!workerProfile?.id) {
    if (el) el.innerHTML = '<div class="empty-state"><i class="bi bi-bookmark"></i><p>Complete your profile to save jobs.</p></div>';
    return;
  }
  el.innerHTML = '<div class="empty-state"><i class="bi bi-bookmark"></i><p>Loading saved jobs…</p></div>';
  const { data, error } = await sb.from('saved_jobs')
    .select('job_id, created_at, job_postings(id, title, description, location, county, salary_range, job_type, work_type, duration_type, duration_value, is_urgent, created_at, job_role, company_name, company_verified, employer_avg_rating, employer_rating_count, loves_count)')
    .eq('worker_id', workerProfile.id)
    .order('created_at', { ascending: false });

  if (error) {
    console.error('❌ loadSavedJobs error:', error.message);
    el.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i><p>Could not load saved jobs</p></div>';
    return;
  }
  const jobs = (data || []).map(r => r.job_postings).filter(Boolean);
  if (!jobs.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-bookmark"></i><p>You haven\'t saved any jobs yet.</p></div>';
    return;
  }
  el.innerHTML = jobs.map(j => jobCardHtml(j)).join('');
}

function jobCardHtml(j, recommended) {
  const isSaved = savedJobIds.has(j.id);
  const isLoved = lovedJobIds.has(j.id);
  const myApp = myApplications.find(a => a.job_id === j.id);
  const applied = !!myApp;
  const negotiable = j.pricing_mode === 'negotiable';
  const paymentVerified = jobEscrowStatus[j.id] === 'held' || jobEscrowStatus[j.id] === 'released';
  const appsCount = jobApplicantCounts[j.id] || 0;
  const priceLabel = negotiable
    ? 'Open to offers'
    : (j.salary_range || (j.salary_min ? `KES ${(+j.salary_min).toLocaleString('en-KE')}` : ''));

  return `
    <div class="job-card" data-job-id="${j.id}">
      <div style="display:flex; align-items:flex-start; justify-content:space-between; gap:8px; margin-bottom:6px;">
        <div>
          ${recommended ? `<span class="job-recommended-badge"><i class="bi bi-stars"></i> Recommended for you</span><br>` : ''}
          <div style="display:flex; align-items:center; gap:6px; margin-bottom:4px; flex-wrap:wrap;">
            <div style="font-weight:700; font-size:14px;">${esc(j.title || 'Untitled Job')}</div>
            ${j.company_verified ? '<span class="employer-verified-badge"><i class="bi bi-patch-check-fill"></i> Verified</span>' : ''}
          </div>
          ${j.company_name ? `<div style="font-size:12px; color:var(--muted); margin-bottom:4px;">${esc(j.company_name)}</div>` : ''}
          <div style="margin-bottom:4px;">${renderStars(j.employer_avg_rating, j.employer_rating_count)}</div>
          <div style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;">
            ${j.is_urgent ? '<span class="job-chip urgent"><i class="bi bi-lightning-fill"></i> Urgent</span>' : ''}
            ${j.job_type ? `<span class="job-chip">${esc(j.job_type)}</span>` : ''}
            ${workTypeChip(j.work_type)}
            ${durationChip(j)}
            ${j.county ? `<span class="job-chip"><i class="bi bi-geo-alt"></i> ${esc(j.county)}</span>` : ''}
          </div>
          <!-- Bootstrap badges: pricing mode / employer payment verification / applicant count -->
          <div class="d-flex gap-1 flex-wrap">
            <span class="badge ${negotiable ? 'text-bg-info' : 'text-bg-secondary'}">
              <i class="bi ${negotiable ? 'bi-chat-left-text-fill' : 'bi-tag-fill'}"></i> ${negotiable ? 'Negotiable' : 'Fixed Price'}
            </span>
            ${paymentVerified ? `<span class="badge text-bg-success"><i class="bi bi-patch-check-fill"></i> Payment Verified</span>` : ''}
            <span class="badge text-bg-light border text-dark"><i class="bi bi-people-fill"></i> ${appsCount} Applicant${appsCount === 1 ? '' : 's'}</span>
          </div>
        </div>
        ${priceLabel ? `<div style="font-size:12px; color:var(--brand); font-weight:700; white-space:nowrap;">${esc(priceLabel)}</div>` : ''}
      </div>
      <div style="font-size:12px; color:var(--muted); line-height:1.6; margin-bottom:10px;">${esc((j.description || '').substring(0, 160))}${j.description?.length > 160 ? '…' : ''}</div>
      <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; flex-wrap:wrap;">
        <div style="font-size:11px; color:var(--muted);">
          ${j.created_at ? timeAgo(new Date(j.created_at)) + ' ago' : ''}
          ${applied && myApp?.status ? ` · <span class="badge text-bg-warning-subtle text-warning-emphasis text-capitalize">${esc(myApp.status)}</span>` : ''}
        </div>
        <div class="job-action-row">
          <span class="job-love-count">${j.loves_count || 0}</span>
          <button class="job-action-icon-btn love ${isLoved ? 'active' : ''}" title="Love this job" onclick="toggleLoveJob('${j.id}', this)">
            <i class="bi ${isLoved ? 'bi-heart-fill' : 'bi-heart'}"></i>
          </button>
          <button class="job-action-icon-btn save ${isSaved ? 'active' : ''}" title="Save / Whitelist job" onclick="toggleSaveJob('${j.id}', this)">
            <i class="bi ${isSaved ? 'bi-bookmark-check-fill' : 'bi-bookmark'}"></i>
          </button>
          <button class="job-action-icon-btn share" title="Share job" onclick="shareJob('${j.id}', ${JSON.stringify(j.title || 'Job').replace(/"/g, '&quot;')})">
            <i class="bi bi-share"></i>
          </button>
          <button class="job-action-icon-btn whatsapp" title="Share via WhatsApp" onclick="shareJobWhatsapp('${j.id}', ${JSON.stringify(j.title || 'Job').replace(/"/g, '&quot;')})">
            <i class="bi bi-whatsapp"></i>
          </button>
          <button class="job-action-icon-btn report" title="Report job" onclick="openReportModal('${j.id}', ${JSON.stringify(j.title || 'this job').replace(/"/g, '&quot;')})">
            <i class="bi bi-flag"></i>
          </button>
          <button class="btn btn-primary btn-sm" onclick='openBidModal(${JSON.stringify(j.id)})' ${applied ? 'disabled' : ''}>
            <i class="bi ${applied ? 'bi-check' : 'bi-tag'}"></i> ${applied ? 'Bid Placed' : 'Bid'}
          </button>
        </div>
      </div>
    </div>`;
}

// ════════════════════════════════════════════════════════
//  LOVE JOBS (heart / like)
// ════════════════════════════════════════════════════════
async function toggleLoveJob(jobId, btn) {
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Profile Required', 'Complete your profile first.');
    return;
  }
  const wasLoved = lovedJobIds.has(jobId);
  btn.disabled = true;
  try {
    if (wasLoved) {
      const { error } = await sb.from('job_loves').delete().eq('job_id', jobId).eq('worker_id', workerProfile.id);
      if (error) throw error;
      lovedJobIds.delete(jobId);
    } else {
      const { error } = await sb.from('job_loves').insert({ job_id: jobId, worker_id: workerProfile.id });
      if (error) throw error;
      lovedJobIds.add(jobId);
    }
    btn.classList.toggle('active', !wasLoved);
    btn.querySelector('i').className = `bi ${!wasLoved ? 'bi-heart-fill' : 'bi-heart'}`;
    const countEl = btn.parentElement.querySelector('.job-love-count');
    const job = allJobs.find(j => j.id === jobId);
    if (job) {
      job.loves_count = Math.max((job.loves_count || 0) + (wasLoved ? -1 : 1), 0);
      if (countEl) countEl.textContent = job.loves_count;
    }
    const welcomeLovesEl = document.getElementById('welcome-loves-count');
    if (welcomeLovesEl) welcomeLovesEl.textContent = lovedJobIds.size;
  } catch (err) {
    showToast('err', 'bi-exclamation-circle', 'Error', err.message);
  } finally {
    btn.disabled = false;
  }
}

// ════════════════════════════════════════════════════════
//  REPORT JOB
// ════════════════════════════════════════════════════════
function openReportModal(jobId, jobTitle) {
  reportingJobId = jobId;
  document.getElementById('report-job-title').textContent = jobTitle || 'this job';
  document.getElementById('report-reason').value = 'fraud';
  document.getElementById('report-details').value = '';
  openModal('modal-report-job');
}

async function submitJobReport() {
  if (!reportingJobId) return;
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Profile Required', 'Complete your profile first to submit a report.');
    return;
  }
  const btn = document.getElementById('submit-report-btn');
  const reason = document.getElementById('report-reason').value;
  const details = document.getElementById('report-details').value.trim();
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Submitting…';

  const { error } = await sb.from('job_reports').insert({
    job_id: reportingJobId,
    worker_id: workerProfile.id,
    reason,
    details: details || null,
  });

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-flag-fill"></i> Submit Report';

  if (error) {
    showToast('err', 'bi-exclamation-circle', 'Error', error.message);
  } else {
    showToast('ok', 'bi-check-circle', 'Report Submitted', 'Thank you — our team will review this job.');
    closeModal('modal-report-job');
    reportingJobId = null;
  }
}

// ════════════════════════════════════════════════════════
//  DEEP LINK — open a shared job (?job=ID) once the dashboard loads
//  NOTE: newly-shared links now point to /job/slug--id → jobs.html
//  (public, no login needed), so they no longer land here at all.
//  This stays only to support any old ?job=/#employee-dashboard?job=
//  links already circulating before this change.
// ════════════════════════════════════════════════════════
function handleJobDeepLink() {
  // Supports both ?job=ID (query) and #employee-dashboard?job=ID (hash) formats
  let jobId = new URLSearchParams(location.search).get('job');
  if (!jobId && location.hash) {
    const hashQuery = location.hash.split('?')[1] || '';
    jobId = new URLSearchParams(hashQuery).get('job');
  }
  if (!jobId) return;

  const job = allJobs.find(j => String(j.id) === String(jobId));

  // Clean the param out of the URL so refreshing/sharing again doesn't re-trigger this
  const cleanUrl = location.origin + location.pathname;
  history.replaceState(null, '', cleanUrl);

  if (!job) {
    showToast('err', 'bi-exclamation-circle', 'Job Not Found', 'This job may have expired or is no longer available.');
    return;
  }

  navTo('modal-jobs');

  // Wait for the modal to open and the card to be in the DOM, then scroll to + highlight it
  setTimeout(() => {
    const card = document.querySelector(`#jobs-list .job-card[data-job-id="${CSS.escape(String(jobId))}"]`);
    if (!card) return;
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
    card.style.transition = 'box-shadow .3s ease';
    card.style.boxShadow = '0 0 0 3px var(--brand)';
    setTimeout(() => { card.style.boxShadow = ''; }, 2200);
  }, 250);
}

// ════════════════════════════════════════════════════════
//  SHARE JOB (public, ungated link) — same clean /job/slug--id
//  format as jobs.html, so both share paths produce one working
//  link that Vercel's /job/:slug rewrite actually catches.
//  (The old hash-based #employee-dashboard?job=ID link never
//  reached the server — Vercel rewrites can't see URL fragments —
//  so it landed on the site root instead of opening anything.)
// ════════════════════════════════════════════════════════
function slugify(s) {
  return String(s || 'job').toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-+|-+$)/g, '')
    .slice(0, 60) || 'job';
}
function buildJobShareUrl(jobId, jobTitle) {
  return `https://www.sounds.co.ke/job/${slugify(jobTitle)}--${jobId}`;
}

function shareJobWhatsapp(jobId, jobTitle) {
  const url = buildJobShareUrl(jobId, jobTitle);
  const text = encodeURIComponent(`Check out this job on SoundsCare: ${jobTitle || 'Job'}\n${url}`);
  window.open(`https://wa.me/?text=${text}`, '_blank', 'noopener');
}

async function shareJob(jobId, jobTitle) {
  const url = buildJobShareUrl(jobId, jobTitle);
  const shareData = { title: jobTitle || 'Job on SoundsCare', text: `Check out this job: ${jobTitle || ''}`, url };
  try {
    if (navigator.share) {
      await navigator.share(shareData);
      return;
    }
  } catch (shareErr) {
    // user cancelled share sheet or it failed — fall through to clipboard copy
  }
  try {
    await navigator.clipboard.writeText(url);
    showToast('ok', 'bi-link-45deg', 'Link Copied', 'Job link copied to clipboard — share it anywhere.');
  } catch (copyErr) {
    showToast('info', 'bi-link-45deg', 'Job Link', url);
  }
}

// ════════════════════════════════════════════════════════
//  MY APPLICATIONS
// ════════════════════════════════════════════════════════
async function loadApplications() {
  const el = document.getElementById('applications-list');
  if (!workerProfile?.id) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-send-check"></i><p>Complete your profile to see applications.</p></div>';
    return;
  }
  el.innerHTML = '<div class="empty-state"><i class="bi bi-send-check"></i><p>Loading applications…</p></div>';

  const { data, error } = await sb.from('job_applications')
    .select('id, job_id, status, applied_at, updated_at, bid_amount, job_postings(id, title, company_name, county, salary_range, pricing_mode, is_mama_fua, employer_id)')
    .eq('worker_id', workerProfile.id)
    .order('applied_at', { ascending: false });

  if (error) {
    console.error('❌ loadApplications error:', error.message);
    el.innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i><p>Could not load applications</p></div>';
    return;
  }

  myApplications = data || [];

  if (!myApplications.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-send-check"></i><p>You haven\'t applied to any jobs yet.</p></div>';
    return;
  }

  const statusColor = { pending: 'var(--sky)', reviewed: 'var(--accent)', shortlisted: '#7c3aed', hired: 'var(--green)', rejected: 'var(--rose)' };
  el.innerHTML = myApplications.map(a => {
    const job = a.job_postings || {};
    const color = statusColor[a.status] || 'var(--muted)';
    return `
    <div class="job-card clickable" onclick="openApplicationDetail('${a.id}')">
      <div style="display:flex; justify-content:space-between; align-items:flex-start; gap:8px;">
        <div>
          <div style="font-weight:700; font-size:14px; margin-bottom:2px;">${esc(job.title || 'Job')}</div>
          <div style="font-size:12px; color:var(--muted);">${esc(job.company_name || '')} ${job.county ? '· ' + esc(job.county) : ''}</div>
        </div>
        <span class="job-chip" style="background:${color}1a; color:${color}; text-transform:capitalize;">${esc(a.status)}</span>
      </div>
      <div style="font-size:11px; color:var(--muted); margin-top:8px;">Applied ${a.applied_at ? timeAgo(new Date(a.applied_at)) + ' ago' : ''} · <i class="bi bi-eye"></i> View details</div>
    </div>`;
  }).join('');
}

// ════════════════════════════════════════════════════════
//  BIDED JOBS — applications where the worker submitted a price
//  (negotiable-job bids, or a confirmed bid on a fixed-price job)
// ════════════════════════════════════════════════════════
function bidCardHtml(a) {
  // myApplications entries can come from either the lightweight dashboard
  // load (job info looked up in allJobs) or loadApplications() (job info
  // already joined as a.job_postings) — support both shapes.
  const job = a.job_postings || allJobs.find(j => j.id === a.job_id) || {};
  const negotiable = job.pricing_mode === 'negotiable';
  const statusMap = {
    pending: 'text-bg-warning-subtle text-warning-emphasis',
    reviewed: 'text-bg-info-subtle text-info-emphasis',
    shortlisted: 'text-bg-primary-subtle text-primary-emphasis',
    hired: 'text-bg-success-subtle text-success-emphasis',
    rejected: 'text-bg-danger-subtle text-danger-emphasis',
  };
  const statusCls = statusMap[a.status] || 'text-bg-secondary-subtle';
  return `
    <div class="card mb-2" onclick="openApplicationDetail('${a.id}')" style="cursor:pointer;" role="button">
      <div class="card-body py-2 px-3">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div>
            <div class="fw-bold" style="font-size:14px;">${esc(job.title || 'Job')}</div>
            <div class="small" style="color:var(--muted);">${esc(job.company_name || '')}${job.county ? ' · ' + esc(job.county) : ''}</div>
          </div>
          <span class="badge ${statusCls} text-capitalize">${esc(a.status || 'pending')}</span>
        </div>
        <div class="d-flex align-items-center gap-2 mt-2 flex-wrap">
          <span class="badge ${negotiable ? 'text-bg-info' : 'text-bg-secondary'}">
            <i class="bi ${negotiable ? 'bi-chat-left-text-fill' : 'bi-tag-fill'}"></i> ${negotiable ? 'Negotiable' : 'Fixed Price'}
          </span>
          <span class="badge text-bg-light border text-dark"><i class="bi bi-cash-coin"></i> ${a.bid_amount != null ? 'KES ' + (+a.bid_amount).toLocaleString('en-KE') : 'No bid amount on file'}</span>
          <span class="small ms-auto" style="color:var(--muted);">${a.applied_at ? timeAgo(new Date(a.applied_at)) + ' ago' : ''}</span>
        </div>
      </div>
    </div>`;
}

function renderBidedJobs() {
  const el = document.getElementById('bided-jobs-list');
  if (!workerProfile?.id) {
    if (el) el.innerHTML = '<div class="empty-state"><i class="bi bi-tag"></i><p>Complete your profile to place bids.</p></div>';
    return;
  }
  const bids = (myApplications || []).slice().sort((x, y) => new Date(y.applied_at) - new Date(x.applied_at));
  if (!bids.length) {
    if (el) el.innerHTML = '<div class="empty-state"><i class="bi bi-tag"></i><p>You haven\'t placed any bids yet.</p></div>';
    return;
  }
  if (el) el.innerHTML = bids.map(bidCardHtml).join('');
}

// ════════════════════════════════════════════════════════
//  ONGOING JOBS — hired applications + their escrow (Payment Held) status
//  allOngoingJobs is populated in loadDashboard() as:
//    { application, job, escrow } where escrow may be null
// ════════════════════════════════════════════════════════
function ongoingJobCardHtml(o) {
  const { application: a, job, escrow, employerProfile, alreadyRated } = o;
  const escMap = {
    pending: { cls: 'text-bg-warning', icon: 'bi-hourglass-split', label: 'Verifying Payment' },
    held: { cls: 'text-bg-info', icon: 'bi-shield-lock-fill', label: 'Payment Held' },
    released: { cls: 'text-bg-success', icon: 'bi-check-circle-fill', label: 'Released' },
    rejected_pending_investigation: { cls: 'text-bg-danger', icon: 'bi-flag-fill', label: 'Under Review' },
    refunded: { cls: 'text-bg-secondary', icon: 'bi-arrow-counterclockwise', label: 'Refunded' },
    cancelled: { cls: 'text-bg-secondary', icon: 'bi-x-circle', label: 'Cancelled' },
  };
  const badge = escrow ? (escMap[escrow.status] || { cls: 'text-bg-secondary', icon: 'bi-question-circle', label: escrow.status })
                       : { cls: 'text-bg-secondary', icon: 'bi-hourglass', label: 'Awaiting Payment' };
  const amount = escrow ? (+escrow.net_amount || +escrow.amount || 0) : 0;

  // "Rate Employer" only ever renders here: a.status === 'hired' with a.hired_at
  // set is guaranteed by the query that builds allOngoingJobs (see loadDashboard
  // 4c), so this button can never appear from a mere application or interview —
  // only a confirmed hire. Also hidden once employer_ratings already has a row
  // for this worker+job, and hidden if we couldn't resolve an employer profile.
  const canRate = !!(a.status === 'hired' && a.hired_at && employerProfile?.id && !alreadyRated);
  const employerName = employerProfile?.company_name || employerProfile?.full_name || 'Employer';
  const rateBtn = canRate
    ? `<button class="btn btn-sm" style="background:#f59e0b; color:#fff;" onclick="openRateEmployerModal('', '${employerProfile.id}', '${a.job_id}', ${JSON.stringify(employerName).replace(/"/g, '&quot;')})"><i class="bi bi-star-fill"></i> Rate Employer</button>`
    : (alreadyRated ? `<span class="small" style="color:var(--muted);"><i class="bi bi-star-fill" style="color:#f59e0b;"></i> Rated</span>` : '');

  return `
    <div class="card mb-2">
      <div class="card-body py-2 px-3">
        <div class="d-flex justify-content-between align-items-start gap-2">
          <div>
            <div class="fw-bold" style="font-size:14px;">${esc(job.title || 'Job')}${job.is_mama_fua ? ' <span class="badge text-bg-primary ms-1">Mama Fua Mtaani</span>' : ''}</div>
            <div class="small" style="color:var(--muted);">${esc(job.company_name || '')}${job.county ? ' · ' + esc(job.county) : ''}</div>
          </div>
          <span class="badge ${badge.cls}"><i class="bi ${badge.icon}"></i> ${badge.label}</span>
        </div>
        <div class="d-flex align-items-center gap-2 mt-2 flex-wrap">
          ${amount ? `<span class="badge text-bg-light border text-dark"><i class="bi bi-cash-coin"></i> KES ${amount.toLocaleString('en-KE')}</span>` : ''}
          <span class="small ms-auto" style="color:var(--muted);">Hired ${a.hired_at ? timeAgo(new Date(a.hired_at)) + ' ago' : (a.applied_at ? timeAgo(new Date(a.applied_at)) + ' ago' : '')}</span>
        </div>
        ${rateBtn ? `<div class="d-flex mt-2">${rateBtn}</div>` : ''}
      </div>
    </div>`;
}

function renderOngoingJobs() {
  const el = document.getElementById('ongoing-jobs-list');
  if (!allOngoingJobs.length) {
    if (el) el.innerHTML = '<div class="empty-state"><i class="bi bi-activity"></i><p>No ongoing jobs right now.</p></div>';
  } else {
    if (el) el.innerHTML = allOngoingJobs.map(ongoingJobCardHtml).join('');
  }
  updateHeldFundsUI();
}

// ════════════════════════════════════════════════════════
//  HELD FUNDS — total currently sitting in escrow for this worker
//  across all ongoing jobs (shown as a stat card + in the Wallet modal)
// ════════════════════════════════════════════════════════
function updateHeldFundsUI() {
  const held = (allOngoingJobs || [])
    .filter(o => o.escrow && o.escrow.status === 'held')
    .reduce((sum, o) => sum + (+o.escrow.net_amount || +o.escrow.amount || 0), 0);
  const text = 'KES ' + held.toLocaleString('en-KE');
  const walletEl = document.getElementById('wallet-held');
  if (walletEl) walletEl.textContent = text;
  // Welcome banner pill — real data from job_escrow_payments (via
  // allOngoingJobs, loaded in loadDashboard() step 4c). Only shown when
  // the worker actually has funds held in escrow right now.
  const welcomeHeldEl = document.getElementById('welcome-held');
  const welcomeHeldAmountEl = document.getElementById('welcome-held-amount');
  if (welcomeHeldEl && welcomeHeldAmountEl) {
    welcomeHeldAmountEl.textContent = text;
    welcomeHeldEl.style.display = held > 0 ? 'inline-flex' : 'none';
  }
}

// ════════════════════════════════════════════════════════
//  APPLICATION DETAIL MODAL
// ════════════════════════════════════════════════════════
let activeApplication = null;

function openApplicationDetail(appId) {
  const app = myApplications.find(a => a.id === appId);
  if (!app) { showToast('err', 'bi-exclamation-circle', 'Not Found', 'Could not find that application.'); return; }
  activeApplication = app;

  const job = app.job_postings || {};
  document.getElementById('ad-job-title').textContent = job.title || 'Job';
  document.getElementById('ad-job-sub').textContent = [job.company_name, job.county].filter(Boolean).join(' · ') || '—';
  document.getElementById('ad-job-id').textContent = app.job_id || '—';
  document.getElementById('ad-employer-id').textContent = job.employer_id || '—';
  document.getElementById('ad-date-applied').textContent = app.applied_at
    ? new Date(app.applied_at).toLocaleString('en-KE', { dateStyle: 'medium', timeStyle: 'short' })
    : '—';

  const statusColor = { pending: 'var(--sky)', reviewed: 'var(--accent)', shortlisted: '#7c3aed', hired: 'var(--green)', rejected: 'var(--rose)' };
  const color = statusColor[app.status] || 'var(--muted)';
  const statusEl = document.getElementById('ad-status');
  statusEl.textContent = app.status || 'pending';
  statusEl.style.background = `${color}1a`;
  statusEl.style.color = color;

  document.getElementById('ad-reapply-btn').style.display = app.status === 'rejected' ? 'flex' : 'none';

  openModal('modal-application-detail');
}

async function reapplyToApplication() {
  if (!activeApplication) return;
  const btn = document.getElementById('ad-reapply-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Reapplying…';

  const { error } = await sb.from('job_applications')
    .update({ status: 'pending', applied_at: new Date().toISOString() })
    .eq('id', activeApplication.id)
    .eq('worker_id', workerProfile.id);

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-arrow-repeat"></i> Reapply';

  if (error) {
    showToast('err', 'bi-exclamation-circle', 'Reapply Failed', error.message);
    return;
  }

  activeApplication.status = 'pending';
  activeApplication.applied_at = new Date().toISOString();
  showToast('ok', 'bi-check-circle', 'Reapplied', 'Your application was resubmitted.');
  closeModal('modal-application-detail');
  loadApplications();
}

async function openApplicationMessages() {
  if (!activeApplication) return;
  // job_postings.employer_id is employer_profiles.id (the profile's own PK),
  // NOT the employer's auth user_id — see the matching note in
  // loadEdHiringHistoryDetailed. conversations.employer_id IS the auth
  // user_id (that's what RLS checks against auth.uid() everywhere in
  // messages/conversations). Comparing the two directly, as this used to do,
  // meant a matching conversation could never be found even when message
  // history with this employer already existed.
  const employerProfileId = activeApplication.job_postings?.employer_id;
  if (!employerProfileId) {
    showToast('err', 'bi-exclamation-circle', 'Unavailable', 'No employer is linked to this application yet.');
    return;
  }

  const { data: mapRows, error: mapErr } = await sb.rpc('get_employer_user_id_by_profile_id', { profile_ids: [employerProfileId] });
  if (mapErr) {
    console.error('❌ get_employer_user_id_by_profile_id failed:', mapErr.message);
    showToast('err', 'bi-exclamation-circle', 'Error', 'Could not look up this employer. Please try again.');
    return;
  }
  const employerUserId = mapRows?.[0]?.user_id;
  if (!employerUserId) {
    showToast('err', 'bi-exclamation-circle', 'Unavailable', 'No employer is linked to this application yet.');
    return;
  }

  const conv = allConversations.find(c => c.employer_id === employerUserId && !c.is_admin_thread);
  if (!conv) {
    showToast('info', 'bi-chat-dots', 'No Conversation Yet', 'This employer hasn\'t messaged you yet. They\'ll reach out here once they review your application.');
    return;
  }
  closeModal('modal-application-detail');
  openConversation(conv.id);
  navTo('modal-messages');
}

function sendApplicationToSupport() {
  if (!activeApplication) return;
  const job = activeApplication.job_postings || {};
  const summary = `Application support — Job: ${job.title || activeApplication.job_id} | Job ID: ${activeApplication.job_id} | Application ID: ${activeApplication.id} | Status: ${activeApplication.status}`;

  // Copy the application summary so it's easy to paste into the support
  // chat, then open support.html — the main support channel on this page.
  navigator.clipboard?.writeText(summary).catch(() => {});
  try {
    window.sscOpenSupportPanel?.();
  } catch (e) { console.warn('Could not open support panel:', e); }

  showToast('info', 'bi-headset', 'Support Chat Opened', 'Application details were copied — paste them in to give our support agent context.');
}

// ════════════════════════════════════════════════════════
//  PROFILE VISIBILITY
// ════════════════════════════════════════════════════════
let visibilityUpdating = false;
async function toggleVisibility() {
  if (visibilityUpdating) return;
  const checkbox = document.getElementById('visibility-toggle');
  const newVal = checkbox.checked; // onclick fires AFTER checked changes — reliable

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why toggling this could appear to do nothing even
  // though no error was returned.
  if (!workerProfile?.id) {
    checkbox.checked = !newVal; // revert the checkbox — we're not going to save this
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  visibilityUpdating = true;

  // Optimistic UI update
  document.getElementById('visibility-label').textContent = newVal ? 'Profile is Visible to Employers' : 'Profile is Hidden';
  document.getElementById('visibility-sub').textContent = newVal
    ? 'Employers can find you in search results'
    : 'You are not appearing in employer searches';

  const { error } = await sb.from('worker_profiles')
    .update({ profile_visible: newVal })
    .eq(matchCol, matchVal);

  if (error) {
    // Revert on failure
    checkbox.checked = !newVal;
    document.getElementById('visibility-label').textContent = !newVal ? 'Profile is Visible to Employers' : 'Profile is Hidden';
    document.getElementById('visibility-sub').textContent = !newVal
      ? 'Employers can find you in search results'
      : 'You are not appearing in employer searches';
    showToast('err', 'bi-exclamation-circle', 'Update Failed', error.message);
  } else {
    showToast('ok', 'bi-check-circle', newVal ? 'Profile Visible' : 'Profile Hidden',
      newVal ? 'Employers can now find you.' : 'Your profile is now hidden from searches.');
  }
  visibilityUpdating = false;
}

// ════════════════════════════════════════════════════════
//  WALLET / PAYMENTS
// ════════════════════════════════════════════════════════
function updateFeeStatus(data) {
  // data can be wallet or worker_profiles — both have interview_fee_paid, first_salary_fee_paid
  const i = data.interview_fee_paid;
  const s = data.first_salary_fee_paid;

  const fmtUntil = (iso) => {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    return ' <span style="color:var(--muted);font-weight:500;">(until ' + d.toLocaleDateString('en-KE') + ')</span>';
  };

  document.getElementById('fee-interview').innerHTML = i
    ? '<span style="color:var(--green)"><i class="bi bi-check-circle-fill"></i> Paid</span>' + fmtUntil(data.interview_fee_expires_at)
    : '<span style="color:var(--rose)"><i class="bi bi-exclamation-triangle-fill"></i> Pending</span>';
  document.getElementById('fee-salary').innerHTML = s
    ? '<span style="color:var(--green)"><i class="bi bi-check-circle-fill"></i> Paid</span>' + fmtUntil(data.first_salary_fee_expires_at)
    : '<span style="color:var(--rose)"><i class="bi bi-exclamation-triangle-fill"></i> Pending</span>';
}

function selectPayMethod(method) {
  const select = document.getElementById('pay-method');
  select.value = method;
  document.querySelectorAll('.pay-method-card').forEach(card => {
    card.classList.toggle('active', card.dataset.method === method);
  });
  updatePaymentUI();
}

function updatePaymentUI() {
  const method = document.getElementById('pay-method').value;
  document.getElementById('mpesa-form').style.display = method === 'mpesa' ? 'block' : 'none';
  document.getElementById('airtel-form').style.display = method === 'airtel' ? 'block' : 'none';
  document.getElementById('wallet-form').style.display = method === 'wallet' ? 'block' : 'none';
  document.getElementById('card-form').style.display = method === 'card' ? 'block' : 'none';

  if (method === 'wallet') {
    // Show current balance so user can confirm they have enough
    const balText = document.getElementById('wallet-balance').textContent;
    document.getElementById('wallet-pay-balance').textContent = balText;
  }
}

function formatCard(el) {
  let v = el.value.replace(/\D/g, '').slice(0, 16);
  el.value = v.replace(/(.{4})/g, '$1 ').trim();
}
function formatExpiry(el) {
  let v = el.value.replace(/\D/g, '');
  if (v.length > 2) v = v.slice(0, 2) + '/' + v.slice(2, 4);
  el.value = v;
}

async function submitCardPayment() {
  const amount = document.getElementById('pay-amount').value;
  const feeType = document.getElementById('fee-type').value;
  const num = document.getElementById('card-number').value.replace(/\s/g, '');
  const expiry = document.getElementById('card-expiry').value.trim();
  const cvv = document.getElementById('card-cvv').value.trim();
  const name = document.getElementById('card-name').value.trim();

  if (!amount || amount <= 0) { showToast('err', 'bi-exclamation-circle', 'Missing', 'Select a fee type and enter an amount'); return; }
  if (num.length < 16) { showToast('err', 'bi-exclamation-circle', 'Invalid Card', 'Enter a valid 16-digit card number.'); return; }
  if (!/^\d{2}\/\d{2}$/.test(expiry)) { showToast('err', 'bi-exclamation-circle', 'Invalid Expiry', 'Enter expiry as MM/YY.'); return; }
  if (cvv.length < 3) { showToast('err', 'bi-exclamation-circle', 'Invalid CVV', 'Enter a valid CVV.'); return; }
  if (!name) { showToast('err', 'bi-exclamation-circle', 'Missing', 'Enter the cardholder name.'); return; }

  const btn = document.querySelector('#card-form .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Processing…';

  const ref = await createPayment(parseFloat(amount), 'card', feeType);

  btn.disabled = false;
  btn.innerHTML = '<i class="bi bi-credit-card"></i> Pay Now';

  showToast('ok', 'bi-check-circle', 'Payment Submitted', `Ref: ${ref || '—'}`);
  navTo('overview');
}

async function payFromWallet() {
  const amount = parseFloat(document.getElementById('pay-amount').value);
  const feeType = document.getElementById('fee-type').value;

  if (!amount || amount <= 0) {
    showToast('err', 'bi-exclamation-circle', 'Missing', 'Select a fee type and enter an amount');
    return;
  }

  // Fetch live wallet balance first
  console.log("📍 4️⃣ Fetching wallet for payFromWallet…");
  const { data: wallet, error: wErr } = await sb.from('wallets')
    .select('balance, account_number')
    .eq('user_id', currentUser.id)
    .limit(1);
  const walletRow = wallet?.[0] || null;

  if (wErr || !walletRow) {
    showToast('err', 'bi-exclamation-circle', 'Wallet Error', 'Could not read your wallet. Please try another payment method.');
    return;
  }

  const balance = parseFloat(walletRow.balance || 0);
  if (balance < amount) {
    showToast('err', 'bi-exclamation-circle', 'Insufficient Balance',
      `Your wallet has KES ${balance.toLocaleString('en-KE')} but KES ${amount.toLocaleString('en-KE')} is required.`);
    return;
  }

  // Every user must have an account number before a payment can be recorded/reconciled
  const acctNumber = walletRow.account_number || await ensureAccountNumber();
  const txnRef = generateTransactionRef();

  const btn = document.querySelector('#wallet-form .btn-primary');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Processing…';

  try {
    // 1. Deduct from wallet.
    const newBalance = balance - amount;
    const { error: updateErr } = await sb.from('wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id);

    if (updateErr) throw new Error(updateErr.message);

    // 2. Create payment record (status = completed, method = wallet)
    //    BUG FIX: this used to reference `wallet.account_number` where `wallet` was
    //    the raw Supabase array response (always undefined) instead of `walletRow`.
    const { error: payErr } = await sb.from('payments').insert({
      user_id: currentUser.id,
      amount,
      fee_type: feeType,
      payment_method: 'wallet',
      status: 'completed',
      account_number: acctNumber || null,
      transaction_id: txnRef,
    });

    if (payErr) {
      // Rollback wallet deduction on payment insert failure
      await sb.from('wallets').update({ balance }).eq('user_id', currentUser.id);
      throw new Error(payErr.message);
    }

    // 3. Update fee flags on wallets table — this marks the fee "paid" until the
    //    next cycle (interview fee valid 30 days, first salary fee valid 180 days).
    const feeUpdate = {};
    if (feeType === 'interview_fee') {
      feeUpdate.interview_fee_paid = true;
      feeUpdate.interview_fee_paid_at = new Date().toISOString();
      feeUpdate.interview_fee_expires_at = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
    } else if (feeType === 'first_salary_fee') {
      feeUpdate.first_salary_fee_paid = true;
      feeUpdate.first_salary_fee_paid_at = new Date().toISOString();
      feeUpdate.first_salary_fee_expires_at = new Date(Date.now() + 180 * 24 * 60 * 60 * 1000).toISOString();
    }
    if (Object.keys(feeUpdate).length) {
      await sb.from('wallets').update(feeUpdate).eq('user_id', currentUser.id);
      // Mirror on worker_profiles
      const wpUpdate = {};
      if (feeType === 'interview_fee') { wpUpdate.interview_fee_paid = true; wpUpdate.payment_status = 'partial'; }
      if (feeType === 'first_salary_fee') { wpUpdate.first_salary_fee_paid = true; wpUpdate.payment_status = 'paid'; }
      if (Object.keys(wpUpdate).length && workerProfile?.id) {
        await sb.from('worker_profiles').update(wpUpdate).eq('id', workerProfile.id);
      }
    }

    // 4. Update local UI
    document.getElementById('wallet-balance').textContent = 'KES ' + newBalance.toLocaleString('en-KE');
    document.getElementById('wallet-pay-balance').textContent = 'KES ' + newBalance.toLocaleString('en-KE');
    updateFeeStatus({
      interview_fee_paid: feeType === 'interview_fee' || workerProfile?.interview_fee_paid,
      first_salary_fee_paid: feeType === 'first_salary_fee' || workerProfile?.first_salary_fee_paid,
      interview_fee_expires_at: feeUpdate.interview_fee_expires_at,
      first_salary_fee_expires_at: feeUpdate.first_salary_fee_expires_at,
    });

    // 5. Refresh payment history
    const { data: payments } = await sb.from('payments')
      .select('id, amount, fee_type, payment_method, status, created_at, transaction_id')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(20);
    try {
      renderPaymentHistory(payments || []);
      console.log('✅ Payment history rendered');
    } catch (payErr) {
      console.error('❌ renderPaymentHistory failed:', payErr.message);
      document.getElementById('payment-list').innerHTML = '<div class="empty-state"><i class="bi bi-receipt"></i><p>Could not load payment history</p></div>';
    }

    showToast('ok', 'bi-check-circle', 'Payment Successful',
      `KES ${amount.toLocaleString('en-KE')} deducted from your wallet. Ref: ${txnRef}`);
    navTo('overview');

  } catch (e) {
    showToast('err', 'bi-exclamation-circle', 'Payment Failed', e.message);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="bi bi-wallet2"></i> Pay from Balance';
  }
}

async function sendMpesaSTK() {
  const phone = document.getElementById('mpesa-phone').value.trim();
  const amount = document.getElementById('pay-amount').value;
  const feeType = document.getElementById('fee-type').value;
  if (!phone || !amount) { showToast('err', 'bi-exclamation-circle', 'Missing', 'Enter phone and amount'); return; }

  showToast('info', 'bi-hourglass-split spin', 'Processing', 'Sending STK Push to ' + phone);
  setTimeout(async () => {
    const ref = await createPayment(parseFloat(amount), 'mpesa', feeType, { mpesa_phone: phone, phone_used: phone });
    showToast('ok', 'bi-check-circle', 'STK Sent', `Check your phone for the M-Pesa prompt. Ref: ${ref || '—'}`);
  }, 1200);
}

async function sendAirtelRequest() {
  const phone = document.getElementById('airtel-phone').value.trim();
  const amount = document.getElementById('pay-amount').value;
  const feeType = document.getElementById('fee-type').value;
  if (!phone || !amount) { showToast('err', 'bi-exclamation-circle', 'Missing', 'Enter phone and amount'); return; }

  showToast('info', 'bi-hourglass-split spin', 'Processing', 'Requesting Airtel payment…');
  setTimeout(async () => {
    const ref = await createPayment(parseFloat(amount), 'airtel', feeType, { airtel_phone: phone, phone_used: phone });
    showToast('ok', 'bi-check-circle', 'Sent', `Check your Airtel Money app. Ref: ${ref || '—'}`);
  }, 1200);
}

// Generates a unique, human-readable reference number for every transaction so
// each payment (wallet / M-Pesa / Airtel / Card) can be tracked and reconciled.
function generateTransactionRef() {
  const ts = Date.now().toString(36).toUpperCase();
  const rand = Math.random().toString(36).substring(2, 7).toUpperCase();
  return `SC-${ts}-${rand}`;
}

// ────────────────────────────────────────────────────────
//  WITHDRAWALS — worker_withdrawals table.
//  RLS: user_id = auth.uid(). Columns used: id, user_id, amount, method,
//  phone, status ('pending' | 'processing' | 'paid' | 'rejected'),
//  transaction_id, created_at.
// ────────────────────────────────────────────────────────
function showWithdrawError(msg) {
  const el = document.getElementById('wd-error');
  if (!msg) { el.style.display = 'none'; el.textContent = ''; return; }
  el.textContent = msg;
  el.style.display = 'block';
}

async function requestWithdrawal() {
  showWithdrawError(null);

  const amount = parseFloat(document.getElementById('wd-amount').value);
  const method = document.getElementById('wd-method').value;
  const phoneDigits = document.getElementById('wd-phone').value.trim().replace(/\D/g, '');

  if (!amount || amount <= 0) {
    showWithdrawError('Enter a valid amount to withdraw.');
    return;
  }
  if (!phoneDigits || phoneDigits.length !== 9) {
    showWithdrawError('Enter a valid phone number (e.g. 712345678).');
    return;
  }
  const fullPhone = '254' + phoneDigits;

  const btn = document.getElementById('wd-submit-btn');
  const originalBtnHtml = btn.innerHTML;
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Processing…';

  try {
    // Fetch a live balance right before withdrawing — the balance shown on
    // screen may be stale if it changed since the dashboard last loaded.
    console.log('📍 Fetching wallet for requestWithdrawal…');
    const { data: walletRows, error: wErr } = await sb.from('wallets')
      .select('balance')
      .eq('user_id', currentUser.id)
      .limit(1);
    const walletRow = walletRows?.[0] || null;

    if (wErr || !walletRow) {
      console.error('❌ requestWithdrawal: could not read wallet:', wErr?.message);
      showWithdrawError('Could not read your wallet balance. Please try again.');
      return;
    }

    const balance = parseFloat(walletRow.balance || 0);
    if (amount > balance) {
      showWithdrawError(`Insufficient balance. You have KES ${balance.toLocaleString('en-KE')} available.`);
      return;
    }

    const txnRef = generateTransactionRef();

    // 1. Hold the funds immediately so the same balance can't be withdrawn twice.
    const newBalance = balance - amount;
    const { error: balErr } = await sb.from('wallets')
      .update({ balance: newBalance, updated_at: new Date().toISOString() })
      .eq('user_id', currentUser.id);
    if (balErr) {
      console.error('❌ requestWithdrawal: wallet deduction failed:', balErr.message);
      showWithdrawError('Could not process your request. Please try again.');
      return;
    }

    // 2. Record the withdrawal request.
    const { error: wdErr } = await sb.from('worker_withdrawals').insert({
      user_id: currentUser.id,
      amount,
      method,
      phone: fullPhone,
      status: 'pending',
      transaction_id: txnRef,
    });

    if (wdErr) {
      // Rollback the wallet deduction if the request couldn't be recorded.
      console.error('❌ requestWithdrawal: insert failed, rolling back wallet deduction:', wdErr.message);
      await sb.from('wallets').update({ balance }).eq('user_id', currentUser.id);
      showWithdrawError('Could not submit your withdrawal request. Please try again.');
      return;
    }

    // 3. Reflect the new balance across the UI (wallet modal, withdraw form).
    document.getElementById('wallet-balance').textContent = 'KES ' + newBalance.toLocaleString('en-KE');
    document.getElementById('wd-avail-balance').textContent = 'KES ' + newBalance.toLocaleString('en-KE');

    document.getElementById('wd-amount').value = '';
    document.getElementById('wd-phone').value = '';

    showToast('ok', 'bi-check-circle', 'Withdrawal Requested', `KES ${amount.toLocaleString('en-KE')} · Ref: ${txnRef}`);
    await loadWithdrawalHistory();
  } catch (e) {
    console.error('❌ requestWithdrawal crashed:', e.message);
    showWithdrawError('Something went wrong. Please try again.');
  } finally {
    btn.disabled = false;
    btn.innerHTML = originalBtnHtml;
  }
}

async function loadWithdrawalHistory() {
  const el = document.getElementById('withdrawal-history-list');
  console.log('📍 Loading withdrawal history for user_id =', currentUser.id);
  const { data: withdrawals, error } = await sb.from('worker_withdrawals')
    .select('id, amount, method, phone, status, transaction_id, created_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.error('❌ WITHDRAWALS ERROR:', error.message, '—', error.code);
    console.error('   worker_withdrawals table may not exist or RLS blocks access.');
    el.innerHTML = '<div class="empty-state"><i class="bi bi-cash-coin"></i><p>Could not load withdrawals</p></div>';
    return;
  }

  if (!withdrawals?.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-cash-coin"></i><p>No withdrawal requests yet</p></div>';
    return;
  }

  const statusColors = { paid: 'var(--green)', processing: 'var(--sky)', pending: 'var(--accent)', rejected: 'var(--rose)' };
  el.innerHTML = withdrawals.map(w => `
    <div style="background:var(--surface); border-radius:10px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <div style="font-weight:700; font-size:13px; margin-bottom:2px;">KES ${parseFloat(w.amount || 0).toLocaleString('en-KE')}</div>
        <div style="font-size:11px; color:var(--muted);">${(w.method || '').toUpperCase()}${w.phone ? ' · ' + w.phone : ''}</div>
        <div style="font-size:10px; color:var(--muted);">${w.transaction_id ? 'Ref: ' + w.transaction_id : ''}</div>
      </div>
      <div>
        <div style="font-size:12px; font-weight:700; color:${statusColors[w.status] || 'var(--muted)'}; text-transform:capitalize;">${w.status || '—'}</div>
        <div style="font-size:10px; color:var(--muted); text-align:right;">${w.created_at ? new Date(w.created_at).toLocaleDateString('en-KE') : ''}</div>
      </div>
    </div>`).join('');
}

// ────────────────────────────────────────────────────────
//  CONNECTS — spend helper. Always goes through the debit_connects()
//  RPC (server-side, SECURITY DEFINER) — never write connects_balance
//  from the client directly; that column is locked down at the DB level.
// ────────────────────────────────────────────────────────
// ────────────────────────────────────────────────────────
//  CONNECTS — wallet widget (nav pill + wallet modal section)
// ────────────────────────────────────────────────────────
let connectsResetDate = null; // 'YYYY-MM-DD', from wallets.connects_reset_date — used by the live countdown
let connectsCountdownTimer = null;

// Called once on dashboard load with the fetched wallet row.
function renderConnectsWidget(wallet) {
  connectsResetDate = wallet?.connects_reset_date || null;
  updateConnectsWidget(wallet?.connects_balance ?? 0);
  updateConnectsPricingHint();
  updateConnectsCountdown();
  if (connectsCountdownTimer) clearInterval(connectsCountdownTimer);
  connectsCountdownTimer = setInterval(updateConnectsCountdown, 60000); // refresh every minute
}

// Called after every debit (and can be called any time the balance changes)
// to keep the nav pill and modal in sync without a full reload.
function updateConnectsWidget(balance) {
  const bal = Math.max(0, Number(balance) || 0);
  const lowThreshold = connectsTariffs?.message_cost != null ? connectsTariffs.message_cost * 3 : 5;
  document.getElementById('connects-balance-display')?.replaceChildren(document.createTextNode(bal));
  document.getElementById('connects-balance-full')?.replaceChildren(document.createTextNode(bal + ' Connects'));
  document.querySelector('.connects-pill')?.classList.toggle('low', bal < lowThreshold);
}

function updateConnectsPricingHint() {
  const el = document.getElementById('connects-pricing-hint');
  if (!el || !connectsTariffs) return;
  el.innerHTML = `Message: ${connectsTariffs.message_cost}/msg<br>Voice: ${connectsTariffs.voice_cost_per_min}/min<br>Video: ${connectsTariffs.video_cost_per_min}/min`;
}

// Live "resets in Xh Ym" countdown, respecting connects_tariffs.reset_hour_local
// in Africa/Nairobi time — matches the boundary logic in the debit_connects() RPC.
function updateConnectsCountdown() {
  const el = document.getElementById('connects-reset-hint');
  if (!el) return;
  const resetHour = connectsTariffs?.reset_hour_local ?? 0;

  // Current time in Nairobi, computed via Intl so it's correct regardless
  // of the device's own timezone.
  const nowNairobi = new Date(new Date().toLocaleString('en-US', { timeZone: 'Africa/Nairobi' }));
  const nextReset = new Date(nowNairobi);
  nextReset.setHours(resetHour, 0, 0, 0);
  if (nextReset <= nowNairobi) nextReset.setDate(nextReset.getDate() + 1);

  const diffMs = nextReset - nowNairobi;
  const h = Math.floor(diffMs / 3600000);
  const m = Math.floor((diffMs % 3600000) / 60000);
  el.textContent = `Resets in ${h}h ${m}m`;
}

// Buy-more-Connects — only ever show providers that are actually wired up.
// Right now that's none (M-Pesa/Airtel Edge Functions pending Daraja
// credentials), so this correctly tells the user there's nothing to buy
// through yet rather than showing a payment form that silently can't work.
async function openBuyConnects() {
  const { data: providers, error } = await sb.from('payment_provider_settings')
    .select('provider, is_enabled')
    .eq('is_enabled', true);
  if (error) { showToast('err', 'bi-exclamation-circle', 'Error', 'Could not load payment options.'); return; }
  if (!providers || providers.length === 0) {
    showToast('info', 'bi-hourglass-split', 'Coming Soon', 'Buying extra Connects isn\'t available yet — check back soon.');
    return;
  }
  // TODO: once a provider is enabled, render its actual purchase flow here.
  showToast('info', 'bi-wallet2', 'Buy Connects', `Available: ${providers.map(p => p.provider).join(', ')}`);
}

async function debitConnects(type, units, referenceType, referenceId) {
  const { data, error } = await sb.rpc('debit_connects', {
    p_type: type,
    p_units: units,
    p_reference_type: referenceType || null,
    p_reference_id: referenceId ? String(referenceId) : null,
  });
  if (error) {
    console.error('debitConnects RPC error:', error.message);
    return { success: false, error: 'rpc_error', message: error.message };
  }
  return data; // { success, balance, charged } or { success:false, error:'insufficient_balance', balance, required }
}

// Quick read-only balance check, used before starting a call so we don't
// let someone start a call they can't afford even one minute of. This does
// NOT charge anything — it's purely informational, the real charge happens
// in debitConnects() at call end once actual duration is known.
async function canAffordConnects(costPerUnit) {
  const { data: wallet } = await sb.from('wallets')
    .select('connects_balance, connects_reset_date')
    .eq('user_id', currentUser.id)
    .maybeSingle();
  if (!wallet) return false;
  // If a reset is due, the real balance the RPC will see is the daily
  // free amount, not whatever's stored right now — so don't block someone
  // who's just past midnight but hasn't triggered a reset yet today.
  const today = new Date().toISOString().slice(0, 10);
  if (wallet.connects_reset_date < today) return true;
  return (wallet.connects_balance || 0) >= costPerUnit;
}

// Every user gets an account number for wallet identification/reconciliation.
// If the wallet doesn't have one yet, generate one deterministically from their
// user id, save it to both `wallets` and `worker_profiles`, and reflect it in the UI.
function generateAccountNumber(userId) {
  const clean = (userId || '').replace(/-/g, '').toUpperCase();
  return 'SC' + (clean.substring(0, 8) || Date.now().toString(36).toUpperCase());
}

async function ensureAccountNumber() {
  try {
    const { data: walletRow } = await sb.from('wallets')
      .select('account_number')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    if (walletRow?.account_number) return walletRow.account_number;

    const newAcct = generateAccountNumber(currentUser.id);
    // upsert in case the user doesn't have a wallet row yet
    const { error: upsertErr } = await sb.from('wallets')
      .upsert({ user_id: currentUser.id, account_number: newAcct }, { onConflict: 'user_id' });
    if (upsertErr) { console.warn('ensureAccountNumber upsert failed:', upsertErr.message); }

    if (workerProfile?.id) {
      await sb.from('worker_profiles').update({ account_number: newAcct }).eq('id', workerProfile.id);
    }

    const acctEl = document.getElementById('wallet-acct');
    if (acctEl) acctEl.textContent = 'Acct: ' + newAcct;

    return newAcct;
  } catch (e) {
    console.warn('ensureAccountNumber failed:', e.message);
    return null;
  }
}

async function createPayment(amount, method, feeType, extra = {}) {
  try {
    // Fetch account_number from wallet first — auto-generate one if missing.
    const { data: wallet } = await sb.from('wallets')
      .select('account_number')
      .eq('user_id', currentUser.id)
      .maybeSingle();

    const acctNumber = wallet?.account_number || workerProfile?.account_number || await ensureAccountNumber();
    const txnRef = generateTransactionRef();

    const payload = {
      user_id: currentUser.id,
      amount,
      fee_type: feeType,
      payment_method: method,
      status: 'pending',
      account_number: acctNumber || null,
      transaction_id: txnRef,
      ...extra,
    };

    const { error } = await sb.from('payments').insert(payload);
    if (error) console.error('payment insert:', error.message);

    // Reload payment history
    const { data: payments } = await sb.from('payments')
      .select('id, amount, fee_type, payment_method, status, created_at, transaction_id')
      .eq('user_id', currentUser.id)
      .order('created_at', { ascending: false })
      .limit(20);
    try {
      renderPaymentHistory(payments || []);
      console.log('✅ Payment history rendered');
    } catch (payErr) {
      console.error('❌ renderPaymentHistory failed:', payErr.message);
      document.getElementById('payment-list').innerHTML = '<div class="empty-state"><i class="bi bi-receipt"></i><p>Could not load payment history</p></div>';
    }
    return txnRef;
  } catch (e) {
    console.warn(e);
    return null;
  }
}

function renderPaymentHistory(payments) {
  const el = document.getElementById('payment-list');
  if (!payments.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-receipt"></i><p>No payment history yet</p></div>';
    return;
  }
  const feeLabels = { interview_fee: 'Interview Fee', first_salary_fee: 'First Salary Fee' };
  const statusColors = { completed: 'var(--green)', failed: 'var(--rose)', processing: 'var(--sky)', pending: 'var(--accent)' };
  el.innerHTML = payments.map(p => `
    <div style="background:var(--surface); border-radius:10px; padding:12px; margin-bottom:8px; display:flex; justify-content:space-between; align-items:center;">
      <div>
        <div style="font-weight:700; font-size:13px; margin-bottom:2px;">KES ${parseFloat(p.amount || 0).toLocaleString('en-KE')}</div>
        <div style="font-size:11px; color:var(--muted);">${feeLabels[p.fee_type] || p.fee_type} · ${(p.payment_method || '').toUpperCase()}</div>
        <div style="font-size:10px; color:var(--muted);">${p.transaction_id ? 'Ref: ' + p.transaction_id : ''}</div>
      </div>
      <div>
        <div style="font-size:12px; font-weight:700; color:${statusColors[p.status] || 'var(--muted)'}; text-transform:capitalize;">${p.status || '—'}</div>
        <div style="font-size:10px; color:var(--muted); text-align:right;">${p.created_at ? new Date(p.created_at).toLocaleDateString('en-KE') : ''}</div>
      </div>
    </div>`).join('');
}

// ════════════════════════════════════════════════════════
//  NOTIFICATIONS
// ════════════════════════════════════════════════════════
async function loadNotifications() {
  // notifications SELECT: user_id = auth.uid()
  console.log('📍 Loading notifications…');
  const { data: notifs, error } = await sb.from('notifications')
    .select('id, type, title, message, is_read, created_at')
    .eq('user_id', currentUser.id)
    .order('created_at', { ascending: false })
    .limit(20);

  console.log('NOTIFICATIONS DATA:', notifs);
  console.log('NOTIFICATIONS ERROR:', error);
  if (error) { 
    console.error('❌ NOTIFICATIONS ERROR:', error.message, '—', error.code);
    console.error('   Notifications table may not exist or RLS blocks access.');
    return; 
  }

  const unread = (notifs || []).filter(n => !n.is_read).length;
  if (unread) {
    document.getElementById('notif-badge').textContent = unread;
    document.getElementById('notif-badge').classList.add('show');
  }

  const el = document.getElementById('notif-list');
  if (!notifs?.length) {
    el.innerHTML = '<div class="empty-state"><i class="bi bi-bell"></i><p>No notifications</p></div>';
    return;
  }

  el.innerHTML = notifs.map(n => `
    <div class="notif-item ${n.is_read ? '' : 'unread'}" onclick="markNotifRead('${n.id}', this)">
      <div class="notif-title">${esc(n.title || n.type || 'Notification')}</div>
      <div class="notif-msg">${esc(n.message || '')}</div>
      <div class="notif-time">${timeAgo(new Date(n.created_at))}</div>
    </div>`).join('');
}

async function markNotifRead(id, el) {
  // notifications UPDATE RLS: user_id = auth.uid()
  await sb.from('notifications').update({ is_read: true }).eq('id', id).eq('user_id', currentUser.id);
  el.classList.remove('unread');
}

// ════════════════════════════════════════════════════════
//  REALTIME SUBSCRIPTIONS
// ════════════════════════════════════════════════════════
function subscribeToRealtime() {
  // Brand-new threads (e.g. an employer messaging this worker for the very
  // first time). Without this, allConversations only ever gets refreshed on
  // a full page load, so the emp-messages handler below has nothing to
  // attach the first message to and silently drops it (see !conv check).
  sb.channel('emp-new-conversations')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_threads', filter: `employee_id=eq.${currentUser.id}` }, async (payload) => {
      const t = payload.new;
      if (allConversations.some(c => c.id === t.id)) return; // already known
      allConversations.unshift({ ...t, last_message_text: t.last_message_preview });
      try {
        await renderConversationList();
        renderRecentMessagesPreview();
      } catch (renderErr) {
        console.error('❌ renderConversationList failed (new conversation):', renderErr.message);
      }
    })
    .subscribe();

  // New messages in threads the employee is part of
  sb.channel('emp-messages')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'chat_messages' }, async (payload) => {
      const msg = payload.new;
      // Only handle if this thread belongs to current user
      let conv = allConversations.find(c => c.id === msg.thread_id);
      if (!conv) {
        // Race fallback: the message event beat the chat_threads-INSERT
        // event above (or that channel hasn't finished subscribing yet).
        // RLS (employee_id = auth.uid()) means this fetch only ever returns
        // a row if it's actually this worker's thread.
        const { data: fetchedConv } = await sb.from('chat_threads')
          .select('id, employer_id, employee_id, last_message_preview, last_message_at, employee_unread, status, is_admin_thread, employer_blocked, employee_blocked, not_interested_at, employer_whitelisted')
          .eq('id', msg.thread_id).maybeSingle();
        if (!fetchedConv) return; // not this worker's thread
        fetchedConv.last_message_text = fetchedConv.last_message_preview;
        allConversations.unshift(fetchedConv);
        conv = fetchedConv;
      }

      // Update thread preview
      conv.last_message_text = msg.body || '';
      conv.last_message_at = msg.created_at;
      if (msg.sender_id !== currentUser.id) {
        conv.employee_unread = (conv.employee_unread || 0) + 1;
        const total = allConversations.reduce((s, c) => s + (c.employee_unread || 0), 0);
        document.getElementById('msg-badge').textContent = total;
        document.getElementById('msg-badge').classList.add('show');
        showToast('info', 'bi-chat-dots', 'New Message', (msg.body || '').substring(0, 60));
        const senderName = (conv.is_admin_thread ? 'Support' : (employerCache[conv.employer_id]?.name || 'Employer'));
        pushNotify(`💬 ${senderName}`, (msg.body || 'Sent you a message').substring(0, 100), {
          tag: 'msg-' + conv.id, skipIfFocused: true,
          onClick: () => { openConversation(conv.id); navTo('modal-messages'); },
        });
      }

      // If conversation is open, append message live — guarded against
      // duplicates (e.g. this same message already rendered by a
      // concurrent openConversation() DB fetch beating this event).
      if (activeConvId === msg.thread_id) {
        console.log('[MESSAGES] Realtime INSERT for open conversation, message id:', msg.id);
        const convEl = document.getElementById('conversation-messages');
        if (!convEl) {
          console.error('[MESSAGES] Realtime INSERT: #conversation-messages missing, cannot render.');
        } else if (convEl.querySelector(`.msg-bubble[data-id="${msg.id}"]`)) {
          console.log('[MESSAGES] Realtime INSERT: message', msg.id, 'already rendered, skipping duplicate.');
        } else {
          document.querySelector('.msg-bubble[data-id^="temp-"]')?.remove();
          convEl.insertAdjacentHTML('beforeend', renderMessageBubble(msg));
          convEl.scrollTop = convEl.scrollHeight;
          document.getElementById('typing-indicator').classList.remove('show');
          if (msg.msg_type === 'call') refreshCallBubbleStatuses([msg]);
        }
        // If this message is from the employer and the conversation is open, mark it seen immediately
        if (msg.sender_id !== currentUser.id) {
          await sb.from('chat_messages').update({ is_read: true, delivery_status: 'seen', read_at: new Date().toISOString() }).eq('id', msg.id);
        }
      } else if (msg.sender_id !== currentUser.id) {
        // Mark delivered (app received it) even if conversation isn't open
        await sb.from('chat_messages').update({ delivery_status: 'delivered' }).eq('id', msg.id).is('delivery_status', null);
        // Incoming calls are detected via their own dedicated `calls` table
        // subscription (subscribeIncomingCalls) — more reliable than trying
        // to infer it from a chat message, and doesn't depend on this
        // channel or on the message carrying call metadata.
      }

      try {
      await renderConversationList();
      console.log('✅ Conversation list rendered');
      renderRecentMessagesPreview();
    } catch (renderErr) {
      console.error('❌ renderConversationList failed:', renderErr.message);
      document.getElementById('messages-inbox').innerHTML = '<div class="empty-state"><i class="bi bi-exclamation-circle"></i><p>Could not load messages</p></div>';
    }
    })
    .subscribe();

  // Message status updates (delivered/seen ticks)
  sb.channel('emp-message-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'chat_messages' }, (payload) => {
      const msg = payload.new;
      if (activeConvId !== msg.thread_id) return;
      const el = document.querySelector(`.msg-bubble[data-id="${msg.id}"] .bubble-meta`);
      if (el) el.innerHTML = `${timeAgo(new Date(msg.created_at))} ${renderTick(msg)}`;
    })
    .subscribe();

  // New notifications
  sb.channel('emp-notifications')
    .on('postgres_changes', { event: 'INSERT', schema: 'public', table: 'notifications',
      filter: `user_id=eq.${currentUser.id}` }, (payload) => {
      const n = payload.new;
      showToast('info', 'bi-bell', n.title || 'Notification', n.message || '');
      const cur = parseInt(document.getElementById('notif-badge').textContent || '0');
      document.getElementById('notif-badge').textContent = cur + 1;
      document.getElementById('notif-badge').classList.add('show');
      pushNotify(n.title || '🔔 Notification', n.message || '', {
        tag: 'notif-' + n.id, skipIfFocused: true,
        onClick: () => navTo('modal-notifications'),
      });
    })
    .subscribe();

  // Application status changes (e.g. shortlisted, rejected, hired)
  // No server-side filter here (workerProfile.id isn't guaranteed set yet when this
  // subscription is created) — filter client-side against myApplications instead.
  sb.channel('emp-application-status')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'job_applications' }, (payload) => {
      const app = payload.new;
      const idx = myApplications.findIndex(a => a.id === app.id);
      if (idx === -1) return; // not one of this worker's applications (or not loaded yet)
      {
        myApplications[idx] = { ...myApplications[idx], ...app };
        if (document.getElementById('modal-applications')?.classList.contains('open')) loadApplications();
        if (activeApplication?.id === app.id) activeApplication = myApplications[idx];
      }
      const jobTitle = myApplications[idx]?.job_postings?.title || 'your application';
      showToast('info', 'bi-briefcase', 'Application Updated', `${jobTitle}: ${app.status}`);
      pushNotify('📋 Application Update', `${jobTitle} — status changed to ${app.status}`, {
        tag: 'app-' + app.id, skipIfFocused: true,
        onClick: () => { navTo('modal-applications'); openApplicationDetail(app.id); },
      });
    })
    .subscribe();

  // Wallet balance changes
  sb.channel('emp-wallet')
    .on('postgres_changes', { event: 'UPDATE', schema: 'public', table: 'wallets',
      filter: `user_id=eq.${currentUser.id}` }, (payload) => {
      const w = payload.new;
      document.getElementById('wallet-balance').textContent = 'KES ' + (w.balance || 0).toLocaleString('en-KE');
      updateFeeStatus(w);
    })
    .subscribe();

  // Update presence on window close
  window.addEventListener('beforeunload', () => {
    sb.from('user_presence').update({ is_online: false }).eq('user_id', currentUser.id);
  });
}

// ════════════════════════════════════════════════════════
//  AUTH
// ════════════════════════════════════════════════════════
async function signOut() {
  const btn = document.querySelector('#modal-account .btn-primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split spin"></i> Signing out…'; }

  try {
    // Presence update fire-and-forget
    sb.from('user_presence').update({ is_online: false, last_seen: new Date().toISOString() })
      .eq('user_id', currentUser.id).then(() => {}).catch(() => {});

    await sb.auth.signOut();
  } catch (e) {
    console.warn('signOut error:', e);
  }
  window.location.href = 'login.html';
}

// ════════════════════════════════════════════════════════
//  UI UTILITIES
// ════════════════════════════════════════════════════════
// Section tap-to-open: bound on each dashboard .section (see .tap-section
// in the page markup). Ignores clicks on interactive descendants — buttons,
// links, inputs, individual message/job/ongoing-job cards, the visibility
// toggle, and the Employee Details tab strip/panels — so their own
// click handlers (opening a conversation, saving a job, switching a tab,
// etc.) aren't hijacked by the section-level tap. Everything else in the
// section (empty states, plain text, whitespace) opens modalId.
function handleSectionTap(e, modalId, afterFn) {
  if (e.target.closest('a, button, input, label, .msg-item, .job-card, .card, .toggle-switch, .ed-tab-item, .ed-tab-panel')) return;
  navTo(modalId);
  if (afterFn) afterFn();
}

function openModal(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('open');
  // Briefly mark as just-opened so the overlay click listener won't immediately close it
  el.dataset.justOpened = '1';
  setTimeout(() => { delete el.dataset.justOpened; }, 300);
  if (id === 'modal-wallet') ensureAccountNumber();
  if (id === 'modal-applications') loadApplications();
  if (id === 'modal-saved-jobs') loadSavedJobs();
  if (id === 'modal-notifications') updatePushBanner();
  if (id === 'modal-bids') renderBidedJobs();
  if (id === 'modal-ongoing-jobs') renderOngoingJobs();
  if (id === 'modal-calls') loadCallHistory();
  if (id === 'modal-messages') refreshEmployeeMessages();
}
function closeModal(id) { document.getElementById(id)?.classList.remove('open'); }

async function loadCallHistory() {
  const listEl = document.getElementById('call-history-list');
  const emptyEl = document.getElementById('call-history-empty');
  if (!listEl) return;
  listEl.innerHTML = '<div class="calls-info"><i class="bi bi-hourglass-split"></i><p style="font-size:12.5px;">Loading calls…</p></div>';
  emptyEl.style.display = 'none';

  const { data: calls, error } = await sb.from('calls')
    .select('id, call_type, status, started_at, ended_at, duration, caller_id, receiver_id, caller_name, receiver_name, caller_avatar, receiver_avatar, is_missed, is_rejected')
    .or(`caller_id.eq.${currentUser.id},receiver_id.eq.${currentUser.id}`)
    .order('created_at', { ascending: false })
    .limit(50);

  if (error) {
    listEl.innerHTML = `<div class="calls-info"><i class="bi bi-exclamation-circle"></i><p style="font-size:12.5px;">DIAG: ${esc(error.message)}</p></div>`;
    return;
  }
  if (!calls || calls.length === 0) {
    listEl.innerHTML = '';
    emptyEl.style.display = '';
    return;
  }

  listEl.innerHTML = calls.map(c => {
    const isOutgoing = c.caller_id === currentUser.id;
    const otherName = isOutgoing ? (c.receiver_name || 'Employer') : (c.caller_name || 'Employer');
    const otherAvatar = isOutgoing ? c.receiver_avatar : c.caller_avatar;
    const icon = c.call_type === 'video' ? 'camera-video' : 'telephone';
    const dirIcon = isOutgoing ? 'arrow-up-right' : 'arrow-down-left';
    let statusLabel, statusClass;
    if (c.is_missed) { statusLabel = 'Missed'; statusClass = 'bad'; }
    else if (c.is_rejected) { statusLabel = 'Declined'; statusClass = 'bad'; }
    else if (c.status === 'ended' || c.status === 'completed') { statusLabel = 'Completed'; statusClass = 'ok'; }
    else { statusLabel = c.status ? c.status.charAt(0).toUpperCase() + c.status.slice(1) : 'Unknown'; statusClass = ''; }
    const durText = c.duration ? `${Math.floor(c.duration / 60)}m ${c.duration % 60}s` : '';
    const when = c.started_at ? new Date(c.started_at).toLocaleString() : '';
    return `
      <div class="ed-entry" style="display:flex;align-items:center;gap:12px;padding:12px 0;border-bottom:1px solid var(--line,#eee);">
        <div style="width:38px;height:38px;border-radius:50%;background:var(--line,#eee);flex-shrink:0;overflow:hidden;display:flex;align-items:center;justify-content:center;">
          ${otherAvatar ? `<img src="${esc(otherAvatar)}" style="width:100%;height:100%;object-fit:cover;">` : `<i class="bi bi-${icon}"></i>`}
        </div>
        <div style="flex:1;min-width:0;">
          <div style="font-weight:600;font-size:13.5px;display:flex;align-items:center;gap:6px;">
            <i class="bi bi-${dirIcon}"></i> ${esc(otherName)}
          </div>
          <div style="font-size:12px;color:var(--muted);">${when}${durText ? ' · ' + durText : ''}</div>
        </div>
        <span class="ed-pill ${statusClass}" style="font-size:11px;">${statusLabel}</span>
      </div>`;
  }).join('');
}

// ── SIDEBAR NAVIGATION ──
// The panels below are the SAME modal-overlay elements/functions as before
// (openModal/closeModal, and every data-loading side effect they trigger,
// are untouched) — navTo() just also hides the Overview page, closes any
// other open panel, and keeps the sidebar/top-bar in sync so only one
// section is visible at a time.
const SSC_PANEL_IDS = ['modal-notifications','modal-messages','modal-jobs','modal-saved-jobs',
  'modal-applications','modal-bids','modal-ongoing-jobs','modal-interviews','modal-wallet',
  'modal-account','modal-calls'];
const SSC_PANEL_TITLES = {
  overview: 'Overview', 'modal-account': 'My Profile', 'modal-jobs': 'Find Jobs',
  'modal-applications': 'My Applications', 'modal-saved-jobs': 'Saved Jobs', 'modal-bids': 'My Bids',
  'modal-ongoing-jobs': 'My Jobs', 'modal-interviews': 'Interviews', 'modal-messages': 'Messages',
  'modal-wallet': 'Wallet', 'modal-notifications': 'Notifications', 'modal-calls': 'Calls'
};
function navTo(id, btn) {
  SSC_PANEL_IDS.forEach(pid => { if (pid !== id) closeModal(pid); });
  const overview = document.getElementById('page-overview');
  if (overview) overview.style.display = (id === 'overview') ? '' : 'none';
  if (id !== 'overview') openModal(id);
  document.querySelectorAll('.sb-link').forEach(l => l.classList.remove('active'));
  if (btn) btn.classList.add('active');
  else {
    // Nav/stat-card shortcuts don't pass a button — highlight the matching sidebar link anyway
    document.querySelectorAll('.sb-link').forEach(l => {
      if (l.getAttribute('onclick')?.includes(`navTo('${id}'`)) l.classList.add('active');
    });
  }
  const t = document.getElementById('nav-section-title');
  if (t) t.textContent = SSC_PANEL_TITLES[id] || 'Overview';
  document.body.classList.toggle('ssc-hide-support-fab', id === 'modal-messages');
  if (window.innerWidth <= 900) {
    document.getElementById('sidebar')?.classList.remove('show');
    document.getElementById('sb-scrim')?.classList.remove('show');
  }
  window.scrollTo({ top: 0, behavior: 'instant' in window ? 'instant' : 'auto' });
}
function toggleSidebar() {
  document.getElementById('sidebar')?.classList.toggle('show');
  document.getElementById('sb-scrim')?.classList.toggle('show');
}

function switchTab(tabId, btn) {
  // Scope to the nearest .modal so sibling modals' tabs are not affected
  const modal = btn ? btn.closest('.modal') : null;
  if (modal) {
    modal.querySelectorAll('.tab-content').forEach(el => el.classList.remove('active'));
    modal.querySelectorAll('.tab').forEach(el => el.classList.remove('active'));
  }
  document.getElementById(tabId)?.classList.add('active');
  btn?.classList.add('active');
}

function timeAgo(d) {
  const diff = (Date.now() - d) / 1000;
  if (diff < 60) return 'now';
  if (diff < 3600) return Math.floor(diff / 60) + 'm ago';
  if (diff < 86400) return Math.floor(diff / 3600) + 'h ago';
  if (diff < 604800) return Math.floor(diff / 86400) + 'd ago';
  return d.toLocaleDateString('en-KE', { day: 'numeric', month: 'short' });
}

function esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function showToast(type, icon, title, body) {
  const stack = document.getElementById('toast-stack');
  const t = document.createElement('div');
  t.className = 'toast ' + type;
  t.innerHTML = `<i class="bi ${icon}" style="font-size:18px; flex-shrink:0;"></i>
    <div class="toast-msg"><strong>${esc(title)}</strong>${body ? '<br><span style="color:var(--muted);font-size:11px;">' + esc(body) + '</span>' : ''}</div>`;
  stack.appendChild(t);
  setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 300); }, 4500);
}

// Close modals on overlay click — only if clicking the overlay itself (not a button inside)
document.querySelectorAll('.modal-overlay:not(.panel-mode)').forEach(el => {
  el.addEventListener('click', e => {
    if (e.target === el && !el.dataset.justOpened) el.classList.remove('open');
  });
});

// Helper: open a modal without the click event bubbling to the overlay
function launchEditProfile(e) {
  if (e) { e.stopPropagation(); e.preventDefault(); }
  navTo('overview');
  // Wait for the account modal to fully close before opening edit modal.
  // The longer delay prevents the same click from immediately closing the newly-opened modal.
  setTimeout(() => openEditProfile(), 150);
}

function launchAccountSettings(e) {
  if (e) e.stopPropagation();
  navTo('overview');
  setTimeout(() => openModal('modal-account-settings'), 50);
}

// Password change from Account Settings modal
function checkPwStrengthAs(pw) {
  const bar = document.getElementById('as-pw-bar');
  const label = document.getElementById('as-pw-label');
  if (!pw) { bar.className = 'pw-strength'; label.textContent = ''; return; }
  const score = [pw.length >= 8, /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length;
  if (score <= 1) { bar.className = 'pw-strength weak'; label.textContent = 'Weak'; }
  else if (score <= 3) { bar.className = 'pw-strength fair'; label.textContent = 'Fair'; }
  else { bar.className = 'pw-strength strong'; label.textContent = 'Strong'; }
}

async function changePasswordAs() {
  const newPw = document.getElementById('as-new-pw').value;
  const confirmPw = document.getElementById('as-confirm-pw').value;
  if (!newPw || newPw.length < 8) { showToast('err', 'bi-lock', 'Too Short', 'Password must be at least 8 characters.'); return; }
  if (newPw !== confirmPw) { showToast('err', 'bi-lock', 'Mismatch', 'Passwords do not match.'); return; }
  const btn = document.querySelector('#modal-account-settings .btn-primary');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Updating…'; }
  const { error } = await sb.auth.updateUser({ password: newPw });
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-lock"></i> Update Password'; }
  if (error) { showToast('err', 'bi-exclamation-circle', 'Failed', error.message); return; }
  document.getElementById('as-new-pw').value = '';
  document.getElementById('as-confirm-pw').value = '';
  document.getElementById('as-pw-bar').className = 'pw-strength';
  document.getElementById('as-pw-label').textContent = '';
  showToast('ok', 'bi-shield-check', 'Password Changed', 'Your password has been updated successfully.');
}

// Confirm modal for deactivate / delete
let _pendingAction = null;
function openConfirmModal(action) {
  _pendingAction = action;
  const title = document.getElementById('confirm-title');
  const body = document.getElementById('confirm-body');
  const btn = document.getElementById('confirm-action-btn');
  const typeWrap = document.getElementById('confirm-type-wrap');
  const typeInput = document.getElementById('confirm-type-input');

  if (action === 'deactivate') {
    title.innerHTML = '<i class="bi bi-pause-circle-fill" style="color:var(--accent);"></i> Deactivate Account';
    body.innerHTML = 'Your profile will be <strong>hidden from employers</strong> and your account will be paused. You will not be able to log in again until you contact support to reactivate.<br><br>Are you sure you want to continue?';
    btn.style.background = 'var(--accent)';
    btn.style.color = '#fff';
    btn.style.border = 'none';
    btn.textContent = 'Yes, Deactivate';
    typeWrap.style.display = 'none';
    typeInput.value = '';
  } else {
    title.innerHTML = '<i class="bi bi-trash3-fill" style="color:var(--rose);"></i> Delete Account';
    body.innerHTML = '<strong style="color:var(--rose);">This is permanent and cannot be undone.</strong><br><br>All your profile data, messages, and application history will be marked for deletion. You will be signed out immediately.';
    btn.style.background = 'var(--rose)';
    btn.style.color = '#fff';
    btn.style.border = 'none';
    btn.textContent = 'Delete My Account';
    typeWrap.style.display = 'block';
    typeInput.value = '';
  }

  openModal('modal-confirm-action');
}

async function executeConfirmAction() {
  if (!_pendingAction) return;

  if (_pendingAction === 'delete') {
    const typed = document.getElementById('confirm-type-input').value.trim();
    if (typed !== 'DELETE') {
      showToast('err', 'bi-exclamation-circle', 'Type DELETE', 'Please type DELETE exactly to confirm deletion.');
      return;
    }
  }

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  const btn = document.getElementById('confirm-action-btn');
  btn.disabled = true;
  btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Processing…';

  if (_pendingAction === 'deactivate') {
    const reason = document.getElementById('as-deact-reason').value || 'User requested';
    const note = document.getElementById('as-deact-note').value.trim();
    const fullReason = note ? `${reason}: ${note}` : reason;

    const { error } = await sb.from('worker_profiles').update({
      account_deactivated: true,
      deactivation_reason: fullReason,
      profile_visible: false,
      deactivated_at: new Date().toISOString(),
    }).eq(matchCol, matchVal);

    if (error) {
      showToast('err', 'bi-exclamation-circle', 'Failed', error.message);
      btn.disabled = false;
      btn.textContent = 'Yes, Deactivate';
      return;
    }

    showToast('ok', 'bi-pause-circle', 'Account Deactivated', 'Your profile is now hidden. Contact support to reactivate.');
    document.getElementById('account-status-bar').style.display = 'block';
    document.getElementById('account-status-msg').textContent = 'Account deactivated: ' + fullReason;
    closeModal('modal-confirm-action');
    closeModal('modal-account-settings');

    // Sign out after short delay
    setTimeout(() => signOut(), 2200);

  } else if (_pendingAction === 'delete') {
    await sb.from('worker_profiles').update({
      account_deleted: true,
      deleted_at: new Date().toISOString(),
      profile_visible: false,
      account_deactivated: true,
      deactivation_reason: 'Deleted by user',
    }).eq(matchCol, matchVal);

    showToast('ok', 'bi-trash3', 'Account Deleted', 'Signing you out now…');
    closeModal('modal-confirm-action');
    setTimeout(() => signOut(), 2000);
  }

  _pendingAction = null;
}

// Enter key for message reply
document.addEventListener('keydown', e => {
  if (e.key === 'Enter' && document.getElementById('msg-reply') === document.activeElement) {
    sendMessageReply();
  }
});

// ════════════════════════════════════════════════════════
//  REPLY TO MESSAGE
// ════════════════════════════════════════════════════════
let replyToText = null;
let replyToId = null;
function setReply(text, msgId) {
  replyToText = text;
  replyToId = (msgId && !msgId.startsWith('temp-')) ? msgId : null;
  const preview = document.getElementById('reply-preview');
  document.getElementById('reply-preview-text').textContent = text;
  preview.classList.add('show');
  document.getElementById('msg-reply').focus();
}
function clearReply() {
  replyToText = null;
  replyToId = null;
  document.getElementById('reply-preview')?.classList.remove('show');
}

async function sendMessageReply() {
  const input = document.getElementById('msg-reply');
  const text = input.value.trim();

  if (!text) return;
  if (!activeConvId) { showToast('err', 'bi-exclamation-circle', 'Send Failed', 'DIAG: activeConvId is not set — no conversation is open'); return; }
  if (activeConvMeta?.status === 'closed') { showToast('err', 'bi-lock-fill', 'Conversation Closed', 'DIAG: blocked by status=closed guard'); return; }
  if (activeConvMeta?.employer_blocked || activeConvMeta?.employee_blocked) { showToast('err', 'bi-slash-circle-fill', 'Blocked', 'DIAG: blocked by employer_blocked/employee_blocked guard'); return; }
  if (blockIfProfileIncomplete()) return;

  const sendBtn = document.getElementById('send-btn');
  sendBtn.disabled = true;

  const fullText = replyToText
    ? `↩ "${replyToText.substring(0,40)}${replyToText.length > 40 ? '…' : ''}" \n${text}`
    : text;
  const pendingReplyId = replyToId;

  input.value = '';
  clearReply();

  const convEl = document.getElementById('conversation-messages');
  const tempId = 'temp-' + Date.now();

  convEl.insertAdjacentHTML('beforeend', renderMessageBubble({
    id: tempId,
    sender_id: currentUser.id,
    content: fullText,
    created_at: new Date().toISOString(),
    _pending: 'sending',
  }));
  convEl.scrollTop = convEl.scrollHeight;

  // send_chat_message does the Connects debit + message insert + thread
  // preview/unread update as ONE database transaction — if the insert
  // fails for any reason, the debit rolls back with it, so a message can
  // never be charged for and not actually sent (or vice versa).
  let result, rpcError;
  try {
    ({ data: result, error: rpcError } = await sb.rpc('send_chat_message', {
      p_thread_id: activeConvId, p_body: fullText, p_msg_type: 'text', p_reply_to_id: pendingReplyId,
    }));
  } catch (ex) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'DIAG: network/JS exception — ' + (ex?.message || String(ex)));
    document.querySelector(`[data-id="${tempId}"]`)?.remove();
    sendBtn.disabled = false;
    return;
  }

  if (rpcError) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'DIAG: ' + rpcError.message);
    document.querySelector(`[data-id="${tempId}"]`)?.remove();
  } else if (!result?.success) {
    if (result?.error === 'insufficient_balance') {
      showToast('err', 'bi-wallet2', 'Out of Connects', `You need ${result.required} Connect(s) to send this — you have ${result.balance}. Buy more from your wallet.`);
    } else {
      showToast('err', 'bi-exclamation-circle', 'Send Failed', result?.error || 'Could not send this message.');
    }
    document.querySelector(`[data-id="${tempId}"]`)?.remove();
  } else {
    if (result.balance != null) updateConnectsWidget(result.balance);
    document.querySelector(`[data-id="${tempId}"]`)?.remove();
    await openConversation(activeConvId);
  }

  sendBtn.disabled = false;
}

async function sendEmployeeFile() {
  const file = document.getElementById('emp-chat-file')?.files?.[0];
  if (!file || !activeConvId) return;
  if (activeConvMeta?.status === 'closed' || activeConvMeta?.employer_blocked || activeConvMeta?.employee_blocked) return;
  if (blockIfProfileIncomplete()) return;
  const sendBtn = document.getElementById('send-btn');
  if (sendBtn) sendBtn.disabled = true;
  try {
    // Storage RLS on Media (media_own_folder_insert) requires the first path
    // segment to be the uploader's own auth.uid() — folder must be the uid.
    const path = `${currentUser.id}/employee-files/${activeConvId}/${Date.now()}-${file.name}`;
    const { error: ue } = await sb.storage.from('Media').upload(path, file);
    if (ue) throw ue;
    const { data: { publicUrl } } = sb.storage.from('Media').getPublicUrl(path);
    const body = '📎 ' + file.name;
    // send_chat_message does the Connects debit + insert + thread update as
    // one transaction — if the insert fails, the debit rolls back with it.
    const { data: result, error } = await sb.rpc('send_chat_message', {
      p_thread_id: activeConvId, p_body: body, p_msg_type: 'file',
      p_file_url: publicUrl, p_file_name: file.name, p_file_type: file.type || null,
    });
    if (error) throw error;
    if (!result?.success) {
      if (result?.error === 'insufficient_balance') {
        showToast('err', 'bi-wallet2', 'Out of Connects', `You need ${result.required} Connect(s) to send this — you have ${result.balance}. Buy more from your wallet.`);
      } else {
        throw new Error(result?.error || 'Could not send this file.');
      }
      return;
    }
    if (result.balance != null) updateConnectsWidget(result.balance);
    await openConversation(activeConvId);
    showToast('ok', 'bi-paperclip', 'File Sent', '');
  } catch(err) { showToast('err', 'bi-exclamation-circle', 'Upload Failed', err.message); }
  finally { if (sendBtn) sendBtn.disabled = false; document.getElementById('emp-chat-file').value = ''; }
}

// ════════════════════════════════════════════════════════
//  EDIT PROFILE MODAL
// ════════════════════════════════════════════════════════
let selectedAvailability = 'available';

function openEditProfile() {
  if (!workerProfile) { showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.'); return; }

  // Reset any leftover save-confirmation state from a previous visit
  const saveConfirmOverlay = document.getElementById('ep-save-confirm-overlay');
  if (saveConfirmOverlay) saveConfirmOverlay.style.display = 'none';

  // Populate fields
  document.getElementById('ep-fullname').value = workerProfile.full_name || '';
  const fnPending = document.getElementById('ep-fullname-pending');
  const fnPendingVal = document.getElementById('ep-fullname-pending-value');
  const hasPendingNameChange = (workerProfile.identity_change_status || '').toLowerCase() === 'pending' && !!workerProfile.pending_full_name;
  fnPending.style.display = hasPendingNameChange ? 'block' : 'none';
  fnPendingVal.textContent = workerProfile.pending_full_name || '';
  document.getElementById('ep-email').value = currentUser.email || '';
  document.getElementById('ep-phone').value = workerProfile.phone || workerProfile.phone_number || '';
  document.getElementById('ep-location').value = workerProfile.location || '';
  document.getElementById('ep-bio').value = workerProfile.bio || workerProfile.skills_summary || '';
  document.getElementById('ep-job-seeking').value = workerProfile.job_seeking !== false ? 'true' : 'false';
  document.getElementById('ep-visibility').value = workerProfile.profile_visible !== false ? 'true' : 'false';
  document.getElementById('ep-pref-county').value = workerProfile.preferred_county || '';
  document.getElementById('ep-salary').value = workerProfile.expected_salary || '';
  document.getElementById('ep-notif-pref').value = workerProfile.notification_preference || 'all';
  document.getElementById('ep-job-type-pref').value = workerProfile.preferred_job_type || '';
  document.getElementById('ep-avail-from').value = workerProfile.available_from ? workerProfile.available_from.substring(0, 10) : '';
  document.getElementById('ep-work-hours').value = workerProfile.preferred_work_hours || 'fulltime';
  document.getElementById('ep-hired-status').checked = workerProfile.status === 'hired';
  document.getElementById('ep-avatar-init').textContent = (workerProfile.full_name || currentUser.email || 'W')[0].toUpperCase();
  document.getElementById('ep-acct-num').textContent = workerProfile.account_number || '—';
  document.getElementById('ep-verif-stage').textContent = workerProfile.verification_stage || '—';
  document.getElementById('ep-member-since').textContent = workerProfile.created_at ? new Date(workerProfile.created_at).toLocaleDateString('en-KE', { year:'numeric', month:'short', day:'numeric' }) : '—';
  document.getElementById('ep-pay-status').textContent = workerProfile.payment_status || '—';

  // Availability chips
  selectedAvailability = workerProfile.availability_status || workerProfile.status || 'available';
  document.querySelectorAll('.avail-chip').forEach(el => {
    el.classList.toggle('selected', el.dataset.val === selectedAvailability);
  });

  openModal('modal-edit-profile');
}

function selectAvail(el) {
  document.querySelectorAll('.avail-chip').forEach(c => c.classList.remove('selected'));
  el.classList.add('selected');
  selectedAvailability = el.dataset.val;
}

function checkPwStrength(pw) {
  const bar = document.getElementById('pw-strength-bar');
  const label = document.getElementById('pw-strength-label');
  if (!pw) { bar.className = 'pw-strength'; label.textContent = ''; return; }
  const score = [pw.length >= 8, /[A-Z]/.test(pw), /[0-9]/.test(pw), /[^A-Za-z0-9]/.test(pw)].filter(Boolean).length;
  if (score <= 1) { bar.className = 'pw-strength weak'; label.textContent = 'Weak'; }
  else if (score === 2 || score === 3) { bar.className = 'pw-strength fair'; label.textContent = 'Fair'; }
  else { bar.className = 'pw-strength strong'; label.textContent = 'Strong'; }
}

function confirmSavePersonalInfo() {
  const fullName = document.getElementById('ep-fullname').value.trim();
  if (!fullName) { showToast('err', 'bi-exclamation-circle', 'Required', 'Please enter your full name.'); return; }

  const nameChanging = !!(workerProfile?.full_name && fullName !== workerProfile.full_name);
  document.getElementById('ep-save-confirm-body').innerHTML = nameChanging
    ? 'Do you want to save these changes to your profile?<br><br><strong>Note:</strong> changing your name requires admin approval before it takes effect, and you can only request a name change once every 7 days.'
    : 'Do you want to save these changes to your profile?';

  document.getElementById('ep-save-confirm-overlay').style.display = 'flex';
}

function cancelSavePersonalInfo() {
  document.getElementById('ep-save-confirm-overlay').style.display = 'none';
}

async function proceedSavePersonalInfo() {
  document.getElementById('ep-save-confirm-overlay').style.display = 'none';
  await savePersonalInfo();
}

async function savePersonalInfo() {
  const fullName = document.getElementById('ep-fullname').value.trim();
  const phone = document.getElementById('ep-phone').value.trim();
  const location = document.getElementById('ep-location').value.trim();
  const bio = document.getElementById('ep-bio').value.trim();
  const jobSeeking = document.getElementById('ep-job-seeking').value === 'true';

  if (!fullName) { showToast('err', 'bi-exclamation-circle', 'Required', 'Please enter your full name.'); return; }

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }

  const update = { full_name: fullName, phone, phone_number: phone, location, bio, skills_summary: bio, job_seeking: jobSeeking };

  console.log('Personal info save:', { profileId: workerProfile.id, update });

  try {
    // .select() added so we can tell "update succeeded" apart from "update
    // succeeded but RLS's SELECT policy hides the row from us" apart from
    // "no row matched this id" — see note below on what each case means.
    const { data, error } = await sb
      .from('worker_profiles')
      .update(update)
      .eq('id', workerProfile.id)
      .select();

    if (error) {
      console.error('Personal info save failed:', error);
      // The identity_change_approval trigger raises a plain-English cooldown
      // message (see enforce_identity_change_approval in the DB) when a name
      // change is requested again within 7 days of the last request — surface
      // that distinctly instead of the generic "Save Failed" wording.
      const isCooldown = /once every 7 days/i.test(error.message || '');
      showToast('err', isCooldown ? 'bi-hourglass-split' : 'bi-exclamation-circle',
        isCooldown ? 'Too Soon' : 'Save Failed', error.message);
      return;
    }

    if (!data || data.length === 0) {
      // No error, but PostgREST returned zero rows for the update+select.
      // Two possible causes, and we can't tell which from here without a
      // schema/RLS change: (a) worker_profiles' UPDATE policy allows writing
      // this row but there's no matching SELECT policy, so Postgres applies
      // the update but the read-back is filtered out — the save still went
      // through; or (b) no row actually has this id (shouldn't happen since
      // workerProfile.id came from a row we just read, but flagging it).
      console.warn('Update returned no row for id', workerProfile.id, '— likely RLS SELECT policy hides the read-back; the write itself reported no error.');
    }

    // DB write succeeded (no error) — everything from here on is best-effort
    // UI refresh. It must NOT be able to turn a successful save into an
    // apparent failure, so it gets its own try/catch and never touches the
    // success toast's return path.
    try {
      // Prefer the row Supabase actually returned; fall back to what we sent
      // since the update reported no error either way.
      workerProfile = { ...workerProfile, ...(data?.[0] || update) };

      // The identity_change_status trigger intercepts full_name edits
      // server-side: if fullName differs from what's now on the row, the
      // trigger routed it into pending_full_name and left full_name (and
      // identity_change_status) reflecting that — it did NOT apply live.
      // Never optimistically paint the requested name into the header/
      // avatars in that case; only the row Postgres actually returned
      // decides what's displayed.
      const nameIsPending = (workerProfile.identity_change_status || '').toLowerCase() === 'pending'
        && !!workerProfile.pending_full_name;
      const displayName = nameIsPending ? (workerProfile.full_name || fullName) : fullName;

      const welcomeName = document.getElementById('welcome-name');
      if (welcomeName) {
        welcomeName.innerHTML = 'Welcome back, ' + esc(displayName) + ' <i class="bi bi-emoji-smile-fill" style="font-size:0.75em;vertical-align:middle;"></i>';
      }
      const accountName = document.getElementById('account-name');
      if (accountName) accountName.textContent = displayName;

      const navAvatarInit = document.getElementById('nav-avatar-init');
      if (navAvatarInit) navAvatarInit.textContent = displayName[0].toUpperCase();

      const accountAvatarInit = document.getElementById('account-avatar-init');
      if (accountAvatarInit) accountAvatarInit.textContent = displayName[0].toUpperCase();

      const epAvatarInit = document.getElementById('ep-avatar-init');
      if (epAvatarInit) epAvatarInit.textContent = displayName[0].toUpperCase();

      const edProfileName = document.getElementById('ed-profile-name');
      if (edProfileName?.childNodes[0]) edProfileName.childNodes[0].textContent = displayName + ' ';

      // Refresh the "Waiting Approval" indicator on the form itself, and
      // put the field back to the live value rather than leaving the
      // just-typed (unapproved) name sitting in the input.
      const fnPending = document.getElementById('ep-fullname-pending');
      const fnPendingVal = document.getElementById('ep-fullname-pending-value');
      if (fnPending && fnPendingVal) {
        fnPending.style.display = nameIsPending ? 'block' : 'none';
        fnPendingVal.textContent = nameIsPending ? workerProfile.pending_full_name : '';
      }
      const fnInput = document.getElementById('ep-fullname');
      if (fnInput && nameIsPending) fnInput.value = workerProfile.full_name || '';
    } catch (uiErr) {
      console.error('Personal info saved to the database, but refreshing the UI threw:', uiErr);
    }

    console.log('Personal info saved successfully');
    if ((workerProfile.identity_change_status || '').toLowerCase() === 'pending' && workerProfile.pending_full_name) {
      showToast('info', 'bi-hourglass-split', 'Submitted for Approval', 'Your name change is pending admin review; other fields were saved.');
    } else {
      showToast('ok', 'bi-check-circle', 'Saved', 'Personal info updated.');
    }
  } catch (err) {
    console.error('Personal info save — unexpected exception:', err);
    showToast('err', 'bi-exclamation-circle', 'Save Failed', err?.message || 'Unexpected error while saving.');
  }
}

async function changePassword() {
  const newPw = document.getElementById('ep-new-pw').value;
  const confirmPw = document.getElementById('ep-confirm-pw').value;
  if (!newPw || newPw.length < 8) { showToast('err', 'bi-lock', 'Too Short', 'Password must be at least 8 characters.'); return; }
  if (newPw !== confirmPw) { showToast('err', 'bi-lock', 'Mismatch', 'Passwords do not match.'); return; }

  const { error } = await sb.auth.updateUser({ password: newPw });
  if (error) { showToast('err', 'bi-exclamation-circle', 'Failed', error.message); return; }
  document.getElementById('ep-current-pw').value = '';
  document.getElementById('ep-new-pw').value = '';
  document.getElementById('ep-confirm-pw').value = '';
  showToast('ok', 'bi-shield-check', 'Password Changed', 'Your password has been updated.');
}

async function savePreferences() {
  const visible = document.getElementById('ep-visibility').value === 'true';
  const prefCounty = document.getElementById('ep-pref-county').value.trim();
  const notifPref = document.getElementById('ep-notif-pref').value;
  const jobTypePref = document.getElementById('ep-job-type-pref').value;

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  const { error } = await sb.from('worker_profiles').update({
    profile_visible: visible,
    preferred_county: prefCounty,
    notification_preference: notifPref,
    preferred_job_type: jobTypePref,
  }).eq(matchCol, matchVal);

  if (error) { showToast('err', 'bi-exclamation-circle', 'Save Failed', error.message); return; }
  workerProfile.profile_visible = visible;
  // Sync visibility toggle on dashboard
  document.getElementById('visibility-toggle').checked = visible;
  document.getElementById('visibility-label').textContent = visible ? 'Profile is Visible to Employers' : 'Profile is Hidden';
  document.getElementById('visibility-sub').textContent = visible
    ? 'Employers can find you in search results' : 'You are not appearing in employer searches';
  showToast('ok', 'bi-check-circle', 'Preferences Saved', '');
}

async function toggleHiredStatus() {
  const hired = document.getElementById('ep-hired-status').checked;
  const newStatus = hired ? 'hired' : 'approved';
  const newVisible = !hired; // Hide from public pages when hired

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  const update = {
    status: newStatus,
    profile_visible: newVisible,
    hired_at: hired ? new Date().toISOString() : null,
    is_currently_hired: hired,
    job_seeking: !hired,
    looking_for_job: !hired,
    last_hired_at: hired ? new Date().toISOString() : workerProfile.last_hired_at,
  };
  const { error } = await sb.from('worker_profiles').update(update).eq(matchCol, matchVal);

  if (error) { showToast('err', 'bi-exclamation-circle', 'Update Failed', error.message); return; }
  Object.assign(workerProfile, update);
  if (edFullProfile) Object.assign(edFullProfile, update);
  const edToggle = document.getElementById('ed-hired-toggle');
  if (edToggle) edToggle.checked = hired;
  showToast('ok', 'bi-check-circle', hired ? 'Marked as Hired' : 'Status Updated',
    hired ? 'Your profile is now hidden from public listings.' : 'Your profile is visible again.');
  if (typeof renderJobs === 'function' && Array.isArray(allJobs)) renderJobs(allJobs);
}

async function saveAvailability() {
  const availFrom = document.getElementById('ep-avail-from').value;
  const workHours = document.getElementById('ep-work-hours').value;
  const salary = document.getElementById('ep-salary').value;

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  const { error } = await sb.from('worker_profiles').update({
    availability_status: selectedAvailability,
    available_from: availFrom || null,
    preferred_work_hours: workHours,
    expected_salary: salary ? parseInt(salary) : null,
  }).eq(matchCol, matchVal);

  if (error) { showToast('err', 'bi-exclamation-circle', 'Save Failed', error.message); return; }
  showToast('ok', 'bi-calendar-check', 'Availability Saved', `Status: ${selectedAvailability}`);
}

async function uploadProfilePhoto(input) {
  const file = input.files[0];
  if (!file) return;
  showToast('info', 'bi-upload', 'Uploading photo…', '');
  const ext = file.name.split('.').pop();
  // Storage RLS on the Media bucket (media_own_folder_insert) requires the
  // FIRST path segment to equal the uploader's own auth.uid() — the old
  // 'profile-photos/<uid>.<ext>' path put 'profile-photos' there instead, so
  // the policy rejected every upload. Folder must be the uid.
  const path = `${currentUser.id}/profile-photos/photo.${ext}`;
  const { error: upErr } = await sb.storage.from('Media').upload(path, file, { contentType: file.type, upsert: true });
  if (upErr) { showToast('err', 'bi-exclamation-circle', 'Upload Failed', upErr.message); return; }
  const { data: pub } = sb.storage.from('Media').getPublicUrl(path);
  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;
  await sb.from('worker_profiles').update({ profile_photo_url: pub.publicUrl }).eq(matchCol, matchVal);
  workerProfile.profile_photo_url = pub.publicUrl;
  if (edFullProfile) edFullProfile.profile_photo_url = pub.publicUrl;
  const name = workerProfile.full_name || currentUser.email?.split('@')[0] || 'Worker';
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  const edAvatarEl = document.getElementById('ed-avatar');
  if (edAvatarEl) edAvatarEl.innerHTML = `<img src="${esc(pub.publicUrl)}" alt="${esc(name)}">`;
  syncProfileHeroAvatarAndVerification?.(name, initials);
  showToast('ok', 'bi-check-circle', 'Photo Updated', '');
}

async function deactivateAccount() {
  const reason = prompt('Please give a reason for deactivation (optional):');
  if (reason === null) return;
  if (!confirm('Deactivate your account? Your profile will be hidden until you reactivate.')) return;

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  const { error } = await sb.from('worker_profiles').update({
    account_deactivated: true,
    deactivation_reason: reason || 'User requested',
    profile_visible: false,
    deactivated_at: new Date().toISOString(),
  }).eq(matchCol, matchVal);

  if (error) { showToast('err', 'bi-exclamation-circle', 'Failed', error.message); return; }
  showToast('ok', 'bi-check-circle', 'Account Deactivated', 'Your profile is now hidden. Sign out and back in to reactivate.');
  document.getElementById('account-status-bar').style.display = 'block';
  document.getElementById('account-status-msg').textContent = 'Account deactivated: ' + (reason || 'User requested');
}

async function deleteAccount() {
  const confirm1 = prompt('This will permanently delete your account. Type DELETE to confirm:');
  if (confirm1 !== 'DELETE') { showToast('info', 'bi-info-circle', 'Cancelled', 'Account deletion cancelled.'); return; }

  // Always update by the row's own primary key (id) — this is the row we
  // already fetched for this session (via session_id or email lookup in
  // loadDashboard()), so 'id' is guaranteed correct and RLS is satisfied
  // because that row belongs to the signed-in user. Matching by email here
  // used to silently update zero rows whenever email lookup failed to line
  // up exactly, which is why saves/deactivate/delete could appear to do
  // nothing even though no error was returned.
  if (!workerProfile?.id) {
    showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.');
    return;
  }
  const matchCol = 'id';
  const matchVal = workerProfile.id;

  // Mark as deleted in DB (actual row deletion requires admin/service role)
  await sb.from('worker_profiles').update({
    account_deleted: true,
    deleted_at: new Date().toISOString(),
    profile_visible: false,
    account_deactivated: true,
    deactivation_reason: 'Deleted by user',
  }).eq(matchCol, matchVal);

  showToast('ok', 'bi-trash3', 'Account Deleted', 'Signing you out…');
  setTimeout(() => signOut(), 2000);
}

// ════════════════════════════════════════════════════════
//  EMPLOYEE DETAILS SECTION (merged from Demo UI)
//  5 tabs: Profile / Activity / Hiring History / Earnings / Documents.
//  Profile loads eagerly (needed for the header); the other four are
//  lazy-loaded on first click of their tab so dashboard load isn't
//  slowed down by data most sessions never open.
// ════════════════════════════════════════════════════════
let edFullProfile = null; // full worker_profiles row (loadDashboard() only selects a subset)
const edLoaded = { activity: false, hiring: false, earnings: false, documents: false, verification: false, hiringHistory: false };

function switchEdTab(tabId, btn) {
  document.querySelectorAll('.ed-tab-item').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.ed-tab-panel').forEach(el => el.classList.remove('active'));
  btn?.classList.add('active');
  document.getElementById(tabId)?.classList.add('active');

  if (tabId === 'ed-activity' && !edLoaded.activity) { edLoaded.activity = true; loadEdActivity(); }
  if (tabId === 'ed-hiring' && !edLoaded.hiring) { edLoaded.hiring = true; loadEdHiringHistory(); }
  if (tabId === 'ed-hiring-history' && !edLoaded.hiringHistory) { edLoaded.hiringHistory = true; loadEdHiringHistoryDetailed(); }
  if (tabId === 'ed-earnings' && !edLoaded.earnings) { edLoaded.earnings = true; loadEdEarnings(); }
  if (tabId === 'ed-documents' && !edLoaded.documents) { edLoaded.documents = true; loadEdDocuments(); }
  if (tabId === 'ed-verification' && !edLoaded.verification) { edLoaded.verification = true; renderEdVerificationTab(); }
  // Visibility tab has no async load — toggleVisibility()'s checkbox state is
  // already kept in sync by loadDashboard(), same as when it lived on Overview.
}

function edStatusPillClass(status) {
  const s = (status || '').toLowerCase();
  if (['hired', 'paid', 'approved', 'completed', 'verified'].includes(s)) return 'ok';
  if (['pending', 'processing', 'reviewing', 'submitted'].includes(s)) return 'pending';
  if (['interview', 'interview_requested', 'scheduled', 'background_check'].includes(s)) return 'info';
  if (['rejected', 'declined', 'failed', 'cancelled'].includes(s)) return 'bad';
  return 'neutral';
}

function edFmtDate(d) {
  if (!d) return '—';
  return new Date(d).toLocaleDateString('en-KE', { day: 'numeric', month: 'short', year: 'numeric' });
}

function edFmtMoney(n) {
  return 'KES ' + (Number(n) || 0).toLocaleString('en-KE');
}

async function initEmployeeDetailsSection() {
  if (!workerProfile?.id) return;

  // Header (avatar / name / role / location / rating) — uses whatever
  // loadDashboard() already fetched, so this paints instantly.
  const name = workerProfile.full_name || currentUser.email?.split('@')[0] || 'Worker';
  const initials = name.trim().split(/\s+/).filter(Boolean).slice(0, 2).map(w => w[0].toUpperCase()).join('');
  document.getElementById('ed-avatar').textContent = initials || '?';
  document.getElementById('ed-profile-name').childNodes[0].textContent = name + ' ';
  const isVerified = (workerProfile.verification_stage || '').toLowerCase() === 'verified';
  document.getElementById('ed-verify-badge').style.display = isVerified ? 'inline-block' : 'none';

  // Full row (extra columns loadDashboard() doesn't select) — fetched
  // once here and reused by every tab below.
  try {
    const { data: full, error } = await sb.from('worker_profiles').select('*').eq('id', workerProfile.id).single();
    if (error) throw error;
    edFullProfile = full;
  } catch (e) {
    console.warn('⚠️ Employee Details: full profile fetch failed:', e.message);
    edFullProfile = workerProfile; // fall back to the subset we already have
  }

  document.getElementById('ed-profile-role').textContent = edFullProfile.job_title || edFullProfile.preferred_role || 'Domestic Worker';
  document.getElementById('ed-profile-location').textContent = edFullProfile.current_town || edFullProfile.county || edFullProfile.location || '—';
  document.getElementById('ed-profile-rating').textContent = edFullProfile.avg_rating ? Number(edFullProfile.avg_rating).toFixed(1) + ' (' + (edFullProfile.rating_count || 0) + ')' : 'No ratings yet';
  if (edFullProfile.profile_photo_url) {
    document.getElementById('ed-avatar').innerHTML = `<img src="${esc(edFullProfile.profile_photo_url)}" alt="${esc(name)}">`;
  }
  syncProfileHeroAvatarAndVerification(name, initials);

  renderEdProfileTab();
}

// Keeps the big hero avatar/verified-badge at the top of the My Profile
// modal in sync with whatever the Profile/Documents tabs already know —
// called once on load and again after a photo upload or a verification
// stage change, so every place a "you are verified" signal shows agrees.
function syncProfileHeroAvatarAndVerification(name, initials) {
  const stageRaw = (edFullProfile?.verification_stage || workerProfile?.verification_stage || '').toLowerCase();
  const isVerified = stageRaw === 'verified';
  const isPending = stageRaw.includes('pending');
  const isRejected = stageRaw.includes('reject');

  const heroIcon = document.getElementById('account-verify-icon');
  if (heroIcon) heroIcon.style.display = isVerified ? 'inline-block' : 'none';

  const pill = document.getElementById('account-verif-pill');
  const pillText = document.getElementById('account-verif-pill-text');
  if (pill && pillText) {
    pill.classList.remove('is-verified', 'not-verified', 'pending', 'rejected');
    if (isVerified) { pill.classList.add('is-verified'); pillText.textContent = 'Verified'; pill.querySelector('i').className = 'bi bi-patch-check-fill'; }
    else if (isPending) { pill.classList.add('pending'); pillText.textContent = 'Pending Review'; pill.querySelector('i').className = 'bi bi-hourglass-split'; }
    else if (isRejected) { pill.classList.add('rejected'); pillText.textContent = 'Rejected'; pill.querySelector('i').className = 'bi bi-x-circle-fill'; }
    else { pill.classList.add('not-verified'); pillText.textContent = 'Unverified'; pill.querySelector('i').className = 'bi bi-shield'; }
  }

  const photoUrl = edFullProfile?.profile_photo_url;
  const accountAvatarEl = document.getElementById('account-avatar');
  if (accountAvatarEl) {
    if (photoUrl) {
      accountAvatarEl.innerHTML = `<img src="${esc(photoUrl)}" alt="${esc(name || '')}" style="width:100%;height:100%;object-fit:cover;border-radius:50%;">
        <input type="file" accept="image/*" onchange="uploadProfilePhoto(this)" title="Change profile photo">`;
    } else {
      accountAvatarEl.innerHTML = `<span id="account-avatar-init">${esc(initials || (name ? name[0].toUpperCase() : 'W'))}</span>
        <input type="file" accept="image/*" onchange="uploadProfilePhoto(this)" title="Change profile photo">`;
    }
  }
}

function renderEdProfileTab() {
  const p = edFullProfile || workerProfile;
  const el = document.getElementById('ed-profile-content');
  if (!p) { el.innerHTML = '<div class="ed-empty"><i class="bi bi-person"></i><p>Profile not available</p></div>'; return; }

  const dob = p.date_of_birth || p.dob;
  let age = '—';
  if (dob) {
    const diff = Date.now() - new Date(dob).getTime();
    age = Math.floor(diff / (365.25 * 24 * 3600 * 1000));
  }

  const skills = (p.key_skills || p.skills_summary || '').split(',').map(s => s.trim()).filter(Boolean);
  const languages = (p.languages || '').split(',').map(s => s.trim()).filter(Boolean);

  // work_experience / experiences / experience — schema has three jsonb
  // columns that have been used for this over time; show whichever is populated.
  let expList = p.work_experience || p.experiences || p.experience;
  if (typeof expList === 'string') { try { expList = JSON.parse(expList); } catch { expList = null; } }
  if (!Array.isArray(expList)) expList = [];

  const isHired = !!p.is_currently_hired;
  const gaps = getProfileCompletionGaps();

  el.innerHTML = `
    ${gaps.length ? `
    <div class="ed-detail-item" style="margin-bottom:1rem;background:rgba(232,160,64,.08);border:1px solid rgba(232,160,64,.25);border-radius:12px;padding:12px;">
      <div style="font-weight:700;font-size:12.5px;color:var(--accent);margin-bottom:4px;"><i class="bi bi-exclamation-circle"></i> Finish your profile to unlock messaging</div>
      <ul style="margin:4px 0 0 18px;padding:0;font-size:12px;color:var(--muted);line-height:1.7;">
        ${gaps.map(g => `<li>${esc(g)}</li>`).join('')}
      </ul>
    </div>` : ''}

    <!-- Job Status & Category -->
    <div class="ed-detail-item" style="margin-bottom:1rem;padding:12px;border:1px solid var(--border,#e5e7eb);border-radius:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;gap:12px;flex-wrap:wrap;margin-bottom:12px;">
        <div>
          <div style="font-weight:700;font-size:13px;">${isHired ? 'Currently Hired' : 'Looking for Job'}</div>
          <div style="font-size:11px;color:var(--muted);">Toggle this off once you've finished a placement.</div>
        </div>
        <label class="toggle-switch">
          <input type="checkbox" id="ed-hired-toggle" ${isHired ? 'checked' : ''} onchange="setHiredLookingStatus(this.checked)">
          <span class="toggle-track"></span>
        </label>
      </div>
      <div class="form-group" style="margin-bottom:8px;">
        <label style="font-size:11px;">Job Category</label>
        <select id="ed-category-select" onchange="saveWorkerCategory(this.value)">
          <option value="">Select a category…</option>
          ${WORKER_CATEGORIES.map(c => `<option value="${esc(c)}" ${p.category === c ? 'selected' : ''}>${esc(c)}</option>`).join('')}
        </select>
        <span class="form-hint">Used to recommend you for matching jobs on Find Jobs. Change it any time.</span>
      </div>
      <div class="form-group" style="margin-bottom:0;">
        <label style="font-size:11px;">WhatsApp Number</label>
        <div style="display:flex;gap:6px;">
          <input type="tel" id="ed-whatsapp-input" placeholder="+254 7XX XXX XXX" value="${esc(p.whatsapp_number || '')}" style="flex:1;">
          <button class="btn btn-secondary btn-sm" onclick="saveWhatsappNumber()"><i class="bi bi-check2"></i></button>
        </div>
      </div>
    </div>

    <div class="ed-stat-grid">
      <div class="ed-stat-box"><div class="n">${p.total_jobs_completed ?? 0}</div><div class="l">Jobs Completed</div></div>
      <div class="ed-stat-box"><div class="n">${p.profile_views ?? 0}</div><div class="l">Profile Views</div></div>
      <div class="ed-stat-box"><div class="n">${p.acceptance_rate != null ? p.acceptance_rate + '%' : '—'}</div><div class="l">Acceptance Rate</div></div>
    </div>
    <div class="ed-detail-grid">
      <div class="ed-detail-item"><div class="k">Full Name</div><div class="v">${esc(p.full_name || '—')}</div></div>
      <div class="ed-detail-item"><div class="k">Age</div><div class="v">${age}${p.gender ? ' · ' + esc(p.gender) : ''}</div></div>
      <div class="ed-detail-item"><div class="k">Phone</div><div class="v">${esc(p.phone || p.phone_number || '—')}</div></div>
      <div class="ed-detail-item"><div class="k">Email</div><div class="v">${esc(p.email || '—')}</div></div>
      <div class="ed-detail-item"><div class="k">Location</div><div class="v">${esc(p.current_town || p.county || '—')}</div></div>
      <div class="ed-detail-item"><div class="k">Availability</div><div class="v" style="text-transform:capitalize;">${esc(p.availability || p.work_arrangement || '—')}</div></div>
      <div class="ed-detail-item"><div class="k">Expected Salary</div><div class="v">${p.salary_min || p.salary_max ? edFmtMoney(p.salary_min) + ' – ' + edFmtMoney(p.salary_max) : esc(p.salary_range || '—')}</div></div>
      <div class="ed-detail-item"><div class="k">Education</div><div class="v">${esc(p.edu_level || p.education || '—')}${p.edu_institution ? ', ' + esc(p.edu_institution) : ''}</div></div>
    </div>
    ${skills.length ? `<div class="ed-detail-item" style="margin-bottom:1rem;"><div class="k">Key Skills</div><div class="ed-tags">${skills.map(s => `<span class="ed-tag">${esc(s)}</span>`).join('')}</div></div>` : ''}
    ${languages.length ? `<div class="ed-detail-item" style="margin-bottom:1rem;"><div class="k">Languages</div><div class="ed-tags">${languages.map(s => `<span class="ed-tag">${esc(s)}</span>`).join('')}</div></div>` : ''}
    ${p.about_text || p.bio ? `<div class="ed-detail-item"><div class="k">About</div><div class="ed-bio">${esc(p.about_text || p.bio)}</div></div>` : ''}
    ${expList.length ? `<div class="ed-detail-item" style="margin-top:1rem;"><div class="k">Work Experience</div>` +
      expList.map(x => `<div class="ed-entry"><div class="ed-entry-title">${esc(x.role || x.title || x.job_description || 'Role')}${x.employer_name || x.employer ? ' · ' + esc(x.employer_name || x.employer) : ''}</div>${x.years_worked || x.years ? `<div class="ed-entry-sub">${esc(String(x.years_worked || x.years))} year(s)</div>` : ''}</div>`).join('') +
      `</div>` : ''}
  `;
}

async function setHiredLookingStatus(hired) {
  try {
    const update = hired
      ? { is_currently_hired: true, job_seeking: false, looking_for_job: false, status: 'hired', profile_visible: false, hired_at: new Date().toISOString(), last_hired_at: new Date().toISOString() }
      : { is_currently_hired: false, job_seeking: true, looking_for_job: true, status: 'approved', profile_visible: true, hired_at: null };
    const { error } = await sb.from('worker_profiles').update(update).eq('id', workerProfile.id);
    if (error) throw error;
    Object.assign(workerProfile, update);
    if (edFullProfile) Object.assign(edFullProfile, update);
    // Keep the Edit Profile modal's own controls in sync if it happens to be open.
    const epHired = document.getElementById('ep-hired-status');
    if (epHired) epHired.checked = hired;
    const epJobSeeking = document.getElementById('ep-job-seeking');
    if (epJobSeeking) epJobSeeking.value = hired ? 'false' : 'true';
    showToast('ok', 'bi-check-circle', hired ? 'Marked as Hired' : 'Now Looking for a Job', hired ? 'Your profile is now hidden from public listings.' : 'Your profile is visible again.');
    if (typeof renderJobs === 'function' && Array.isArray(allJobs)) renderJobs(allJobs);
  } catch (e) {
    console.error('❌ setHiredLookingStatus failed:', e.message);
    showToast('err', 'bi-exclamation-circle', 'Update Failed', 'Could not update your status. Try again.');
    const toggle = document.getElementById('ed-hired-toggle');
    if (toggle) toggle.checked = !hired;
  }
}

async function saveWorkerCategory(category) {
  try {
    const { error } = await sb.from('worker_profiles').update({ category: category || null }).eq('id', workerProfile.id);
    if (error) throw error;
    workerProfile.category = category || null;
    if (edFullProfile) edFullProfile.category = category || null;
    showToast('ok', 'bi-check-circle', 'Category Updated', 'Find Jobs will now recommend accordingly.');
    if (typeof renderJobs === 'function' && Array.isArray(allJobs)) renderJobs();
  } catch (e) {
    console.error('❌ saveWorkerCategory failed:', e.message);
    showToast('err', 'bi-exclamation-circle', 'Update Failed', 'Could not save category. Try again.');
  }
}

async function saveWhatsappNumber() {
  const input = document.getElementById('ed-whatsapp-input');
  const value = input?.value.trim() || '';
  try {
    const { error } = await sb.from('worker_profiles').update({ whatsapp_number: value || null }).eq('id', workerProfile.id);
    if (error) throw error;
    workerProfile.whatsapp_number = value || null;
    if (edFullProfile) edFullProfile.whatsapp_number = value || null;
    showToast('ok', 'bi-check-circle', 'Saved', 'WhatsApp number saved.');
  } catch (e) {
    console.error('❌ saveWhatsappNumber failed:', e.message);
    showToast('err', 'bi-exclamation-circle', 'Update Failed', 'Could not save WhatsApp number. Try again.');
  }
}

async function loadEdActivity() {
  const el = document.getElementById('ed-activity-content');
  try {
    const [{ data: apps, error: appErr }, { data: interviews, error: intErr }] = await Promise.all([
      sb.from('job_applications')
        .select('id, job_id, status, applied_at, updated_at, interview_requested_at, background_check_at, hired_at')
        .eq('worker_id', workerProfile.id),
      sb.from('interviews')
        .select('id, job_id, scheduled_at, status, interview_type')
        .eq('worker_id', workerProfile.id),
    ]);
    if (appErr) throw appErr;
    if (intErr) throw intErr;

    const jobIds = [...new Set([...(apps || []).map(a => a.job_id), ...(interviews || []).map(i => i.job_id)])];
    let jobById = {};
    if (jobIds.length) {
      const { data: jobRows } = await sb.from('job_postings').select('id, title, company_name').in('id', jobIds);
      (jobRows || []).forEach(j => { jobById[j.id] = j; });
    }

    const events = [];
    (apps || []).forEach(a => {
      const title = jobById[a.job_id]?.title || 'a job';
      if (a.applied_at) events.push({ date: a.applied_at, title: `Applied for ${title}`, sub: jobById[a.job_id]?.company_name || '', status: 'submitted' });
      if (a.interview_requested_at) events.push({ date: a.interview_requested_at, title: `Interview requested — ${title}`, sub: '', status: 'interview_requested' });
      if (a.background_check_at) events.push({ date: a.background_check_at, title: `Background check — ${title}`, sub: '', status: 'background_check' });
      if (a.hired_at) events.push({ date: a.hired_at, title: `Hired for ${title}`, sub: jobById[a.job_id]?.company_name || '', status: 'hired' });
    });
    (interviews || []).forEach(i => {
      const title = jobById[i.job_id]?.title || 'a job';
      events.push({ date: i.scheduled_at, title: `${(i.interview_type || 'Interview')} scheduled — ${title}`, sub: '', status: i.status || 'scheduled' });
    });
    events.sort((x, y) => new Date(y.date) - new Date(x.date));

    if (!events.length) { el.innerHTML = '<div class="ed-empty"><i class="bi bi-activity"></i><p>No activity yet</p></div>'; return; }

    el.innerHTML = events.slice(0, 30).map(e => `
      <div class="ed-entry">
        <div class="ed-entry-top">
          <div>
            <div class="ed-entry-title">${esc(e.title)}</div>
            ${e.sub ? `<div class="ed-entry-sub">${esc(e.sub)}</div>` : ''}
          </div>
          <div class="ed-entry-date">${edFmtDate(e.date)}</div>
        </div>
        <span class="ed-pill ${edStatusPillClass(e.status)}">${esc((e.status || '').replace(/_/g, ' '))}</span>
      </div>`).join('');
  } catch (e) {
    console.error('❌ loadEdActivity failed:', e.message);
    el.innerHTML = '<div class="ed-empty"><i class="bi bi-exclamation-circle"></i><p>Could not load activity</p></div>';
  }
}

async function loadEdHiringHistory() {
  const el = document.getElementById('ed-hiring-content');
  try {
    const { data: apps, error } = await sb.from('job_applications')
      .select('id, job_id, status, applied_at, hired_at, bid_amount')
      .eq('worker_id', workerProfile.id)
      .order('applied_at', { ascending: false });
    if (error) throw error;

    if (!apps?.length) { el.innerHTML = '<div class="ed-empty"><i class="bi bi-briefcase"></i><p>No job applications yet</p></div>'; return; }

    const jobIds = [...new Set(apps.map(a => a.job_id))];
    const { data: jobRows } = await sb.from('job_postings').select('id, title, company_name, county, salary_range, job_type').in('id', jobIds);
    const jobById = {}; (jobRows || []).forEach(j => { jobById[j.id] = j; });

    el.innerHTML = apps.map(a => {
      const j = jobById[a.job_id] || {};
      return `
      <div class="ed-entry">
        <div class="ed-entry-top">
          <div>
            <div class="ed-entry-title">${esc(j.title || 'Job posting')}</div>
            <div class="ed-entry-sub">${esc(j.company_name || '')}${j.county ? ' · ' + esc(j.county) : ''}${a.bid_amount ? ' · Bid: ' + edFmtMoney(a.bid_amount) : ''}</div>
          </div>
          <div class="ed-entry-date">${a.status === 'hired' ? 'Hired ' + edFmtDate(a.hired_at) : 'Applied ' + edFmtDate(a.applied_at)}</div>
        </div>
        <span class="ed-pill ${edStatusPillClass(a.status)}">${esc(a.status || 'pending')}</span>
      </div>`;
    }).join('');
  } catch (e) {
    console.error('❌ loadEdHiringHistory failed:', e.message);
    el.innerHTML = '<div class="ed-empty"><i class="bi bi-exclamation-circle"></i><p>Could not load hiring history</p></div>';
  }
}

async function loadEdEarnings() {
  const el = document.getElementById('ed-earnings-content');
  try {
    const [{ data: wallet }, { data: withdrawals, error: wErr }] = await Promise.all([
      sb.from('wallets').select('balance, total_paid, outstanding_balance').eq('user_id', currentUser.id).maybeSingle(),
      sb.from('worker_withdrawals')
        .select('id, amount, method, phone_number, status, requested_at, processed_at, currency, mpesa_receipt_number, net_amount')
        .eq('worker_id', workerProfile.id)
        .order('requested_at', { ascending: false })
        .limit(20),
    ]);
    if (wErr) throw wErr;

    const totalEarnings = edFullProfile?.total_earnings ?? 0;
    const statsHtml = `
      <div class="ed-stat-grid">
        <div class="ed-stat-box"><div class="n">${edFmtMoney(totalEarnings)}</div><div class="l">Total Earnings</div></div>
        <div class="ed-stat-box"><div class="n">${edFmtMoney(wallet?.balance)}</div><div class="l">Wallet Balance</div></div>
        <div class="ed-stat-box"><div class="n">${edFmtMoney(wallet?.total_paid)}</div><div class="l">Total Paid Out</div></div>
      </div>`;

    if (!withdrawals?.length) {
      el.innerHTML = statsHtml + '<div class="ed-empty"><i class="bi bi-cash-coin"></i><p>No withdrawal requests yet</p></div>';
      return;
    }

    el.innerHTML = statsHtml + withdrawals.map(w => `
      <div class="ed-entry">
        <div class="ed-entry-top">
          <div>
            <div class="ed-entry-title">${edFmtMoney(w.net_amount || w.amount)}</div>
            <div class="ed-entry-sub">${esc((w.method || '').toUpperCase())}${w.phone_number ? ' · ' + esc(w.phone_number) : ''}${w.mpesa_receipt_number ? ' · Ref: ' + esc(w.mpesa_receipt_number) : ''}</div>
          </div>
          <div class="ed-entry-date">${edFmtDate(w.processed_at || w.requested_at)}</div>
        </div>
        <span class="ed-pill ${edStatusPillClass(w.status)}">${esc(w.status || 'pending')}</span>
      </div>`).join('');
  } catch (e) {
    console.error('❌ loadEdEarnings failed:', e.message);
    el.innerHTML = '<div class="ed-empty"><i class="bi bi-exclamation-circle"></i><p>Could not load earnings</p></div>';
  }
}

async function loadEdDocuments() {
  const el = document.getElementById('ed-documents-content');
  const p = edFullProfile || workerProfile;
  if (!p) { el.innerHTML = '<div class="ed-empty"><i class="bi bi-file-earmark"></i><p>No documents on file</p></div>'; return; }

  const images = [
    { url: p.profile_photo_url, label: 'Profile Photo' },
    { url: p.selfie_url, label: 'Selfie', status: p.selfie_status, note: p.selfie_review_note, reviewedAt: p.selfie_reviewed_at },
    { url: p.id_front_url, label: 'ID Front', status: p.id_status, note: p.id_review_note, reviewedAt: p.id_reviewed_at },
    { url: p.id_back_url, label: 'ID Back', status: p.id_status, note: p.id_review_note, reviewedAt: p.id_reviewed_at },
  ].filter(i => i.url);

  const docs = [
    { url: p.cv_url, label: p.cv_file_name || 'Curriculum Vitae', meta: p.cv_uploaded_at ? 'Uploaded ' + edFmtDate(p.cv_uploaded_at) : '', icon: 'bi-file-earmark-person-fill', status: p.cv_status, note: p.cv_review_note, reviewedAt: p.cv_reviewed_at },
    { url: p.edu_cert_url, label: 'Education Certificate', meta: p.edu_institution || '', icon: 'bi-file-earmark-check-fill' },
  ].filter(d => d.url);

  if (!images.length && !docs.length) {
    el.innerHTML = '<div class="ed-empty"><i class="bi bi-file-earmark"></i><p>No documents uploaded yet</p></div>';
    return;
  }

  // Admin (via the separate admin dashboard) reviews each document and sets
  // its *_status / *_review_note / *_reviewed_at columns on worker_profiles.
  // This just surfaces that review outcome to the employee.
  function reviewPillHtml(status, note, reviewedAt) {
    if (status === undefined) return ''; // no review concept for this doc type
    const s = (status || 'pending').toLowerCase();
    const cls = ['approved', 'verified', 'rejected', 'pending'].includes(s) ? s : 'none';
    const label = s === 'none' || !status ? 'Not yet reviewed' : s.charAt(0).toUpperCase() + s.slice(1);
    return `
      <div style="margin-top:4px;">
        <span class="doc-review-pill ${cls}"><i class="bi ${cls === 'approved' || cls === 'verified' ? 'bi-check-circle-fill' : cls === 'rejected' ? 'bi-x-circle-fill' : 'bi-hourglass-split'}"></i> ${esc(label)}</span>
        ${reviewedAt ? `<span style="font-size:10.5px;color:var(--muted);margin-left:6px;">${edFmtDate(reviewedAt)}</span>` : ''}
        ${note ? `<div class="doc-review-note"><i class="bi bi-chat-left-text"></i> ${esc(note)}</div>` : ''}
      </div>`;
  }

  const imagesHtml = images.length ? `<div class="ed-img-grid">${images.map(i => `
    <div>
      <a class="ed-img-item" href="${esc(i.url)}" target="_blank" rel="noopener"><img src="${esc(i.url)}" alt="${esc(i.label)}" loading="lazy"></a>
      <div class="ed-img-label">${esc(i.label)}</div>
      ${reviewPillHtml(i.status, i.note, i.reviewedAt)}
    </div>`).join('')}</div>` : '';

  const docsHtml = docs.length ? docs.map(d => `
    <div class="ed-doc-row" style="flex-direction:column;align-items:stretch;">
      <a href="${esc(d.url)}" target="_blank" rel="noopener" style="display:flex;align-items:center;gap:10px;text-decoration:none;color:inherit;">
        <div class="ed-doc-icon" style="background:${d.icon === 'bi-file-earmark-person-fill' ? '#DC2626' : '#2563EB'};"><i class="bi ${d.icon}"></i></div>
        <div class="ed-doc-info">
          <div class="ed-doc-name">${esc(d.label)}</div>
          <div class="ed-doc-meta">${esc(d.meta)}</div>
        </div>
        <i class="bi bi-box-arrow-up-right" style="color:var(--muted); font-size:12px;"></i>
      </a>
      ${reviewPillHtml(d.status, d.note, d.reviewedAt)}
    </div>`).join('') : '';

  el.innerHTML = imagesHtml + docsHtml;
}

// ════════════════════════════════════════════════════════
//  VERIFICATION TAB — status, "Request Verification", and
//  email verification via Supabase Auth's OTP flow.
//  NOTE ON EMAIL OTP: this calls the real Supabase Auth JS SDK
//  (auth.updateUser + auth.verifyOtp with type:'email_change'),
//  which is the correct API shape for a 6-digit email-change code.
//  It only works end-to-end if "Confirm email" / Email OTP is
//  enabled in this Supabase project's Auth settings — if the
//  project instead sends a confirmation *link*, the code input
//  below simply won't have a code to check against yet.
// ════════════════════════════════════════════════════════
let edOtpEmailPending = null;

function edVerifStageLabel(stage) {
  const s = (stage || '').toLowerCase();
  if (s === 'verified') return { label: 'Verified', cls: 'is-verified', icon: 'bi-patch-check-fill' };
  if (s.includes('pending')) return { label: 'Pending Review', cls: 'pending', icon: 'bi-hourglass-split' };
  if (s.includes('reject')) return { label: 'Rejected — please re-submit', cls: 'rejected', icon: 'bi-x-circle-fill' };
  return { label: 'Unverified', cls: 'not-verified', icon: 'bi-shield' };
}

function renderEdVerificationTab() {
  const el = document.getElementById('ed-verification-content');
  const p = edFullProfile || workerProfile;
  if (!el || !p) return;

  const stage = (p.verification_stage || '').toLowerCase();
  const info = edVerifStageLabel(stage);
  const canRequest = stage !== 'verified' && !stage.includes('pending');
  const email = currentUser?.email || '—';

  el.innerHTML = `
    <div class="verif-card">
      <div class="verif-card-head">
        <span class="verif-card-icon" style="background:${stage === 'verified' ? 'rgba(34,197,94,.12)' : 'var(--surface)'};">
          <i class="bi ${info.icon}" style="color:${stage === 'verified' ? 'var(--green)' : 'var(--muted)'};"></i>
        </span>
        <div>
          <strong>Account Verification</strong>
          <div style="font-size:12px;color:var(--muted);">Current status: <span class="verif-pill ${info.cls}" style="margin-left:2px;">${esc(info.label)}</span></div>
        </div>
      </div>
      <div style="font-size:12px;color:var(--muted);line-height:1.6;margin:8px 0;">
        Verified profiles get priority placement in employer searches and a checkmark badge next to your name.
        Verification reviews your ID documents and CV under the <strong>Documents</strong> tab.
      </div>
      <button class="btn btn-primary btn-full" id="ed-req-verif-btn" ${canRequest ? '' : 'disabled'} onclick="requestVerification()">
        <i class="bi bi-patch-check"></i> ${stage === 'verified' ? 'Already Verified' : stage.includes('pending') ? 'Request Pending…' : 'Request Verification'}
      </button>
      ${!p.id_front_url || !p.id_back_url ? '<div class="form-hint" style="margin-top:6px;"><i class="bi bi-exclamation-circle"></i> Upload your ID front/back in Documents before requesting verification.</div>' : ''}
    </div>

    <div class="verif-card">
      <div class="verif-card-head">
        <span class="verif-card-icon" style="background:var(--brand-soft);"><i class="bi bi-envelope-check" style="color:var(--brand);"></i></span>
        <div>
          <strong>Verify Email Address</strong>
          <div style="font-size:12px;color:var(--muted);">${esc(email)}</div>
        </div>
      </div>
      <div class="form-group" style="margin-top:10px;">
        <label>Email to verify</label>
        <input type="email" id="verif-email-input" value="${esc(email)}" placeholder="you@email.com">
      </div>
      <button class="btn btn-secondary btn-full" id="verif-send-otp-btn" onclick="sendEmailOtp()">
        <i class="bi bi-send"></i> Send Verification Code
      </button>
      <div id="verif-otp-section" style="display:none; margin-top:12px;">
        <label style="display:block;font-weight:600;font-size:13px;margin-bottom:6px;">Enter the 6-digit code</label>
        <div class="otp-row">
          ${[0,1,2,3,4,5].map(i => `<input class="otp-box" maxlength="1" inputmode="numeric" data-otp-idx="${i}" oninput="edOtpAdvance(this)">`).join('')}
        </div>
        <button class="btn btn-primary btn-full" onclick="verifyEmailOtp()"><i class="bi bi-check-circle"></i> Verify Code</button>
        <div class="form-hint">Didn't get it? <a href="javascript:void(0)" onclick="sendEmailOtp()">Resend code</a></div>
      </div>
    </div>`;
}

async function requestVerification() {
  if (!workerProfile?.id) { showToast('err', 'bi-exclamation-circle', 'Error', 'Profile not loaded yet.'); return; }
  const btn = document.getElementById('ed-req-verif-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Submitting…'; }
  const { error } = await sb.from('worker_profiles')
    .update({ verification_stage: 'pending_review' })
    .eq('id', workerProfile.id);
  if (error) {
    showToast('err', 'bi-exclamation-circle', 'Request Failed', error.message);
    if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-patch-check"></i> Request Verification'; }
    return;
  }
  workerProfile.verification_stage = 'pending_review';
  if (edFullProfile) edFullProfile.verification_stage = 'pending_review';
  const acctVerifBadge = document.getElementById('acct-verif-badge');
  if (acctVerifBadge) { acctVerifBadge.textContent = 'pending_review'; acctVerifBadge.style.color = 'var(--ds-status-warning-text)'; }
  syncProfileHeroAvatarAndVerification?.(workerProfile.full_name, null);
  renderEdVerificationTab();
  showToast('ok', 'bi-check-circle', 'Verification Requested', 'Our team will review your documents shortly.');
}

async function sendEmailOtp() {
  const input = document.getElementById('verif-email-input');
  const email = input?.value?.trim();
  if (!email || !email.includes('@')) { showToast('err', 'bi-exclamation-circle', 'Invalid Email', 'Enter a valid email address.'); return; }
  const btn = document.getElementById('verif-send-otp-btn');
  if (btn) { btn.disabled = true; btn.innerHTML = '<i class="bi bi-hourglass-split"></i> Sending…'; }
  const { error } = await sb.auth.updateUser({ email });
  if (btn) { btn.disabled = false; btn.innerHTML = '<i class="bi bi-send"></i> Resend Verification Code'; }
  if (error) { showToast('err', 'bi-exclamation-circle', 'Could Not Send Code', error.message); return; }
  edOtpEmailPending = email;
  document.getElementById('verif-otp-section').style.display = 'block';
  document.querySelector('[data-otp-idx="0"]')?.focus();
  showToast('ok', 'bi-envelope-check', 'Code Sent', `Check ${email} for a 6-digit verification code.`);
}

function edOtpAdvance(box) {
  box.value = box.value.replace(/[^0-9]/g, '').slice(0, 1);
  if (box.value && box.dataset.otpIdx !== '5') {
    const next = document.querySelector(`[data-otp-idx="${Number(box.dataset.otpIdx) + 1}"]`);
    next?.focus();
  }
}

async function verifyEmailOtp() {
  const boxes = document.querySelectorAll('.otp-box');
  const token = Array.from(boxes).map(b => b.value).join('');
  if (token.length !== 6) { showToast('err', 'bi-exclamation-circle', 'Incomplete Code', 'Enter all 6 digits.'); return; }
  if (!edOtpEmailPending) { showToast('err', 'bi-exclamation-circle', 'Error', 'Send a code first.'); return; }
  const { error } = await sb.auth.verifyOtp({ email: edOtpEmailPending, token, type: 'email_change' });
  if (error) { showToast('err', 'bi-exclamation-circle', 'Verification Failed', error.message); return; }
  showToast('ok', 'bi-check-circle', 'Email Verified', edOtpEmailPending + ' is now confirmed.');
  document.getElementById('account-email').textContent = edOtpEmailPending;
  document.getElementById('verif-otp-section').style.display = 'none';
  edOtpEmailPending = null;
}

// ════════════════════════════════════════════════════════
//  HIRING HISTORY TAB — hired applications matched with their
//  interview record (distinct from the "Applications" tab,
//  which lists every application + its current status).
// ════════════════════════════════════════════════════════
async function loadEdHiringHistoryDetailed() {
  const el = document.getElementById('ed-hiring-history-content');
  if (!el) return;
  try {
    const [{ data: apps, error: appErr }, { data: interviews, error: intErr }] = await Promise.all([
      sb.from('job_applications')
        .select('id, job_id, status, hired_at, bid_amount')
        .eq('worker_id', workerProfile.id)
        .eq('status', 'hired'),
      sb.from('interviews')
        .select('id, job_id, scheduled_at, status, interview_type')
        .eq('worker_id', workerProfile.id),
    ]);
    if (appErr) throw appErr;
    if (intErr) throw intErr;

    if (!apps?.length) { el.innerHTML = '<div class="ed-empty"><i class="bi bi-briefcase"></i><p>No hiring history yet</p></div>'; return; }

    const jobIds = [...new Set(apps.map(a => a.job_id))];

    // Employer profile + any feedback/rating the worker already left, fetched
    // alongside the job rows so each hiring-history entry can show either the
    // submitted rating/review or a "Rate Employer" prompt. Same eligibility
    // rule as the Ongoing Jobs tab: only a confirmed hire (status='hired' +
    // hired_at) can rate, enforced here in the UI and by RLS server-side.
    const [{ data: jobRows }, { data: ratingRows, error: ratingErr }] = await Promise.all([
      sb.from('job_postings').select('id, title, company_name, county, employer_id').in('id', jobIds),
      sb.from('employer_ratings').select('job_id, rating, review_text, created_at').eq('worker_id', workerProfile.id).in('job_id', jobIds),
    ]);
    if (ratingErr) console.error('❌ employer_ratings fetch failed:', ratingErr.message);

    const jobById = {}; (jobRows || []).forEach(j => { jobById[j.id] = j; });
    const interviewByJob = {}; (interviews || []).forEach(i => { interviewByJob[i.job_id] = i; });
    const ratingByJob = {}; (ratingRows || []).forEach(r => { ratingByJob[r.job_id] = r; });

    // job_postings.employer_id stores employer_profiles.id, not the
    // employer's auth user_id — see the matching note in loadDashboard's
    // Ongoing Jobs step. Must look up employer_profiles by .id here too.
    const employerProfileIds = [...new Set((jobRows || []).map(j => j.employer_id).filter(Boolean))];
    let employerByProfileId = {};
    if (employerProfileIds.length) {
      const { data: empRows } = await sb.from('employer_profiles').select('id, user_id, full_name, company_name').in('id', employerProfileIds);
      (empRows || []).forEach(ep => { employerByProfileId[ep.id] = ep; });
    }

    el.innerHTML = apps.map(a => {
      const j = jobById[a.job_id] || {};
      const iv = interviewByJob[a.job_id];
      const existingRating = ratingByJob[a.job_id];
      const employerProfile = j.employer_id ? employerByProfileId[j.employer_id] : null;
      const employerName = employerProfile?.company_name || employerProfile?.full_name || j.company_name || 'this employer';
      return `
      <div class="ed-entry">
        <div class="ed-entry-top">
          <div>
            <div class="ed-entry-title">${esc(j.title || 'Job posting')}</div>
            <div class="ed-entry-sub">${esc(j.company_name || '')}${j.county ? ' · ' + esc(j.county) : ''}${a.bid_amount ? ' · ' + edFmtMoney(a.bid_amount) : ''}</div>
          </div>
          <div class="ed-entry-date">Hired ${edFmtDate(a.hired_at)}</div>
        </div>
        <span class="ed-pill ok">hired</span>
        ${iv ? `<div style="font-size:12px;color:var(--muted);margin-top:6px;"><i class="bi bi-calendar-check"></i> ${esc((iv.interview_type || 'Interview'))} — ${esc(iv.status || 'scheduled')} on ${edFmtDate(iv.scheduled_at)}</div>` : ''}
        ${edHiringFeedbackHtml(a, employerProfile, employerName, existingRating)}
      </div>`;
    }).join('');
  } catch (e) {
    console.error('❌ loadEdHiringHistoryDetailed failed:', e.message);
    el.innerHTML = '<div class="ed-empty"><i class="bi bi-exclamation-circle"></i><p>Could not load hiring history</p></div>';
  }
}

// Renders either the worker's already-submitted employer rating/review, or a
// "Rate Employer" prompt when eligible. Reuses the existing modal-rate-employer
// flow (openRateEmployerModal / submitEmployerRating) so RLS eligibility —
// confirmed hire only, one rating per worker+job — stays enforced in one place.
function edHiringFeedbackHtml(app, employerProfile, employerName, existingRating) {
  if (existingRating) {
    const stars = [1,2,3,4,5].map(n =>
      `<i class="bi ${n <= existingRating.rating ? 'bi-star-fill' : 'bi-star'}" style="color:#f59e0b;font-size:13px;"></i>`
    ).join('');
    return `
      <div style="margin-top:8px;padding:8px 10px;background:var(--ds-brand-soft);border:1px solid var(--ds-brand-border);border-radius:10px;">
        <div style="display:flex;align-items:center;gap:6px;">
          <span style="font-size:11px;font-weight:600;color:var(--ds-text-secondary);">Your feedback for ${esc(employerName)}</span>
          <span style="display:flex;gap:1px;">${stars}</span>
        </div>
        ${existingRating.review_text ? `<div style="font-size:12px;color:var(--ds-text-secondary);margin-top:4px;font-style:italic;">"${esc(existingRating.review_text)}"</div>` : ''}
      </div>`;
  }
  const canRate = !!(app.status === 'hired' && app.hired_at && employerProfile?.id);
  if (!canRate) return '';
  return `
    <div style="margin-top:8px;">
      <button class="btn btn-sm" style="background:#f59e0b;color:#fff;" onclick="openRateEmployerModal('', '${employerProfile.id}', '${app.job_id}', ${JSON.stringify(employerName).replace(/"/g, '&quot;')})">
        <i class="bi bi-star-fill"></i> Rate &amp; Leave Feedback
      </button>
    </div>`;
}

// Opens the full Wallet modal and jumps straight to its Deposit
// ("Make Payment") or Withdraw tab, instead of duplicating the
// wallet forms inside the profile hub.
function launchWalletAction(mode) {
  navTo('modal-wallet');
  setTimeout(() => {
    const tabId = mode === 'withdraw' ? 'payment-withdraw' : 'payment-make';
    const btn = Array.from(document.querySelectorAll('#modal-wallet .tab')).find(b => b.getAttribute('onclick')?.includes(tabId));
    switchTab(tabId, btn);
    if (mode === 'withdraw') loadWithdrawalHistory();
  }, 60);
}

// ════════════════════════════════════════════════════════
//  WELCOME BANNER — rotating background photos
//  Free-to-use stock photos from Pexels (images.pexels.com), chosen to match
//  the job categories offered on this platform (domestic/caregiving, cooking,
//  gardening, security). NOT a live Google Images API call — that needs a
//  server-side API key + Custom Search Engine ID. Swap WELCOME_BG_PHOTOS for
//  a fetch() to your own backend/CSE proxy if a live rotating image feed
//  becomes available.
// ════════════════════════════════════════════════════════
const WELCOME_BG_PHOTOS = [
  'https://images.pexels.com/photos/6986435/pexels-photo-6986435.jpeg?auto=compress&cs=tinysrgb&w=1600',   // caregiver with child — domestic work / nanny / elderly care
  'https://images.pexels.com/photos/6372161/pexels-photo-6372161.jpeg?auto=compress&cs=tinysrgb&w=1600',   // chef at work — cooking
  'https://images.pexels.com/photos/7728874/pexels-photo-7728874.jpeg?auto=compress&cs=tinysrgb&w=1600',   // gardener planting — gardening
  'https://images.pexels.com/photos/31584595/pexels-photo-31584595.jpeg?auto=compress&cs=tinysrgb&w=1600', // security guard — security
];
function setupWelcomeBgRotation() {
  const slideA = document.getElementById('welcome-bg-slide-a');
  const slideB = document.getElementById('welcome-bg-slide-b');
  if (!slideA || !slideB || !WELCOME_BG_PHOTOS.length) return;
  let idx = 0;
  let showingA = true;
  slideA.style.backgroundImage = `url('${WELCOME_BG_PHOTOS[0]}')`;
  slideA.classList.add('active');
  const preload = new Image();
  setInterval(() => {
    idx = (idx + 1) % WELCOME_BG_PHOTOS.length;
    const nextUrl = WELCOME_BG_PHOTOS[idx];
    const incoming = showingA ? slideB : slideA;
    const outgoing = showingA ? slideA : slideB;
    preload.src = nextUrl;
    incoming.style.backgroundImage = `url('${nextUrl}')`;
    incoming.classList.add('active');
    outgoing.classList.remove('active');
    showingA = !showingA;
  }, 8000);
}
document.addEventListener('DOMContentLoaded', setupWelcomeBgRotation);
