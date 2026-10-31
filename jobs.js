/* ==========================================================
   js/jobs.js — SoundsCare Admin: Job Postings page
   Provides: initJobsPage, filterJobs, postJobAsAdmin
   ========================================================== */
(function () {
  'use strict';

  /* ---------- SETTINGS (edit here if your database differs) ---------- */
  const WHATSAPP_NUMBER = '254738123425';   // international format, no "+"
  const TABLE = 'jobs';
  const PAGE_SIZE = 15;

  // Left = name used in this file, Right = your actual column name in Supabase
  const COL = {
    id: 'id',
    title: 'title',
    role: 'role',
    location: 'location',
    county: 'county',
    jobType: 'job_type',
    workType: 'work_type',
    salMin: 'salary_min',
    salMax: 'salary_max',
    description: 'description',
    requirements: 'requirements',
    deadline: 'deadline',
    slots: 'slots',
    featured: 'is_featured',
    urgent: 'is_urgent',
    status: 'status',
    employer: 'employer_name',
    created: 'created_at',
    applications: 'applications_count'
  };

  let ALL = [];
  let FILTERED = [];
  let page = 1;

  /* ---------- helpers ---------- */
  function db() {
    if (window._soundsDb) return window._soundsDb;
    const c = window.sb || window.db || window.supabaseClient || window.sbClient;
    if (c && typeof c.from === 'function') return (window._soundsDb = c);
    if (window.supabase && typeof window.supabase.from === 'function') return (window._soundsDb = window.supabase);
    const cfg = window.SOUNDS_CONFIG || {};
    window._soundsDb = window.supabase.createClient(cfg.supabaseUrl, cfg.supabaseKey);
    return window._soundsDb;
  }

  function notify(msg, type) {
    if (typeof window.showToast === 'function') return window.showToast(msg, type);
    if (typeof window.toast === 'function') return window.toast(msg, type);
    console[type === 'error' ? 'error' : 'log'](msg);
    if (type === 'error') alert(msg);
  }

  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  const nl2br = (s) => esc(s).replace(/\n/g, '<br>');
  const num = (v) => (v === '' || v == null ? null : Number(v));

  function money(n) {
    return n == null || n === '' ? null : 'Ksh ' + Number(n).toLocaleString('en-KE');
  }
  function salary(j) {
    const a = money(j.salMin), b = money(j.salMax);
    if (a && b) return a + ' – ' + b;
    return a || b || '—';
  }
  function fmtDate(d) {
    if (!d) return '—';
    const x = new Date(d);
    return isNaN(x) ? '—' : x.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  }

  function normalise(r) {
    const j = {};
    Object.keys(COL).forEach((k) => { j[k] = r[COL[k]]; });
    j.status = (j.status || 'active').toString().toLowerCase();
    j.employer = j.employer || 'SoundsCare';
    j.applications = j.applications || 0;
    return j;
  }

  function statusBadge(s) {
    const colors = {
      active: ['#16a34a', 'rgba(22,163,74,.12)'],
      draft: ['#a1a1aa', 'rgba(161,161,170,.15)'],
      closed: ['#dc2626', 'rgba(220,38,38,.12)'],
      expired: ['#d97706', 'rgba(217,119,6,.14)']
    };
    const c = colors[s] || colors.draft;
    return '<span style="display:inline-block;padding:3px 10px;border-radius:20px;font-size:11px;font-weight:600;text-transform:capitalize;color:' +
      c[0] + ';background:' + c[1] + '">' + esc(s) + '</span>';
  }

  /* ---------- WhatsApp apply ---------- */
  function whatsappLink(j) {
    const where = j.location ? ' (' + j.location + ')' : '';
    const msg = 'Hi SoundsCare, I would like to apply for the job: ' + j.title + where + '. Job ID: ' + j.id;
    return 'https://wa.me/' + WHATSAPP_NUMBER + '?text=' + encodeURIComponent(msg);
  }
  function applyOnWhatsApp(id) {
    const j = ALL.find((x) => String(x.id) === String(id));
    if (!j) return;
    window.open(whatsappLink(j), '_blank', 'noopener');
  }

  /* ---------- load + render ---------- */
  async function loadJobs() {
    const tbody = $('jobs-tbody');
    const { data, error } = await db().from(TABLE).select('*').order(COL.created, { ascending: false });
    if (error) {
      console.error(error);
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;color:#dc2626">Could not load jobs: ' + esc(error.message) + '</td></tr>';
      return;
    }
    ALL = (data || []).map(normalise);
    filterJobs();
  }

  function filterJobs() {
    const q = ($('jobs-search').value || '').trim().toLowerCase();
    const st = $('jobs-status-filter').value;
    const ft = $('jobs-featured-filter').value;
    FILTERED = ALL.filter((j) => {
      if (st && j.status !== st) return false;
      if (ft === 'featured' && !j.featured) return false;
      if (q) {
        const hay = [j.title, j.role, j.location, j.county, j.employer].join(' ').toLowerCase();
        if (hay.indexOf(q) === -1) return false;
      }
      return true;
    });
    page = 1;
    render();
  }

  function render() {
    const tbody = $('jobs-tbody');
    if (!FILTERED.length) {
      tbody.innerHTML = '<tr><td colspan="9" style="text-align:center;padding:24px">No jobs found.</td></tr>';
      $('jobs-pagination').innerHTML = '';
      return;
    }
    const start = (page - 1) * PAGE_SIZE;
    const rows = FILTERED.slice(start, start + PAGE_SIZE);

    tbody.innerHTML = rows.map((j) => {
      const flags =
        (j.featured ? ' <i class="bi bi-star-fill" title="Featured" style="color:#e8a040"></i>' : '') +
        (j.urgent ? ' <span style="font-size:10px;font-weight:700;color:#dc2626">URGENT</span>' : '');
      return '<tr>' +
        '<td><strong>' + esc(j.title) + '</strong>' + flags + '</td>' +
        '<td>' + esc(j.employer) + '</td>' +
        '<td>' + esc(j.location || '—') + '</td>' +
        '<td style="text-transform:capitalize">' + esc(j.jobType || '—') + '</td>' +
        '<td>' + esc(salary(j)) + '</td>' +
        '<td>' + statusBadge(j.status) + '</td>' +
        '<td>' + esc(fmtDate(j.created)) + '</td>' +
        '<td>' + esc(j.applications) + '</td>' +
        '<td style="white-space:nowrap">' +
          '<button class="btn btn-secondary btn-sm" data-act="view" data-id="' + esc(j.id) + '" title="View description &amp; requirements"><i class="bi bi-eye"></i> View</button> ' +
          '<button class="btn btn-primary btn-sm" data-act="apply" data-id="' + esc(j.id) + '" title="Apply on WhatsApp"><i class="bi bi-whatsapp"></i> Apply</button> ' +
          '<button class="btn btn-secondary btn-sm" data-act="edit" data-id="' + esc(j.id) + '" title="Edit"><i class="bi bi-pencil"></i></button> ' +
          '<button class="btn btn-secondary btn-sm" data-act="delete" data-id="' + esc(j.id) + '" title="Delete"><i class="bi bi-trash"></i></button>' +
        '</td></tr>';
    }).join('');

    renderPagination();
  }

  function renderPagination() {
    const pages = Math.ceil(FILTERED.length / PAGE_SIZE);
    const el = $('jobs-pagination');
    if (pages <= 1) { el.innerHTML = ''; return; }
    let h = '';
    for (let i = 1; i <= pages; i++) {
      h += '<button class="btn btn-sm ' + (i === page ? 'btn-primary' : 'btn-secondary') + '" data-page="' + i + '">' + i + '</button> ';
    }
    el.innerHTML = h;
  }

  /* ---------- details modal (description + requirements) ---------- */
  function ensureViewModal() {
    if ($('job-view-modal')) return;
    const div = document.createElement('div');
    div.id = 'job-view-modal';
    div.className = 'modal-overlay';
    div.innerHTML =
      '<div class="modal wide">' +
        '<div class="modal-header"><h2 id="jv-title"><i class="bi bi-briefcase-fill"></i> Job</h2>' +
        '<button class="modal-close" data-close="job-view-modal">×</button></div>' +
        '<div class="modal-body" id="jv-body"></div>' +
        '<div class="modal-footer">' +
          '<button class="btn btn-secondary" data-close="job-view-modal">Close</button>' +
          '<button class="btn btn-primary" id="jv-apply"><i class="bi bi-whatsapp"></i> Apply on WhatsApp</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(div);
    div.addEventListener('click', (e) => {
      if (e.target === div || e.target.closest('[data-close]')) doClose('job-view-modal');
    });
  }

  function doOpen(id) {
    if (typeof window.openModal === 'function') return window.openModal(id);
    $(id).classList.add('open', 'active', 'show');
    $(id).style.display = 'flex';
  }
  function doClose(id) {
    if (typeof window.closeModal === 'function') return window.closeModal(id);
    $(id).classList.remove('open', 'active', 'show');
    $(id).style.display = 'none';
  }

  function row(label, value) {
    return '<div style="margin-bottom:10px"><div style="font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:.05em;opacity:.65">' +
      esc(label) + '</div><div style="font-size:14px">' + value + '</div></div>';
  }

  function viewJob(id) {
    const j = ALL.find((x) => String(x.id) === String(id));
    if (!j) return;
    ensureViewModal();
    $('jv-title').innerHTML = '<i class="bi bi-briefcase-fill"></i> ' + esc(j.title);
    $('jv-body').innerHTML =
      '<div style="display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:4px 20px;margin-bottom:6px">' +
        row('Status', statusBadge(j.status)) +
        row('Location', esc([j.location, j.county].filter(Boolean).join(', ') || '—')) +
        row('Job type', esc(j.jobType || '—')) +
        row('Work type', esc(j.workType || '—')) +
        row('Salary', esc(salary(j))) +
        row('Slots', esc(j.slots != null ? j.slots : '—')) +
        row('Deadline', esc(fmtDate(j.deadline))) +
        row('Posted', esc(fmtDate(j.created))) +
      '</div>' +
      '<hr style="border:none;border-top:1px solid rgba(128,128,128,.2);margin:12px 0">' +
      row('Job description', j.description ? nl2br(j.description) : '<em style="opacity:.6">No description added.</em>') +
      row('Requirements', j.requirements ? nl2br(j.requirements) : '<em style="opacity:.6">No requirements added.</em>');
    $('jv-apply').onclick = function () { applyOnWhatsApp(j.id); };
    doOpen('job-view-modal');
  }

  /* ---------- post / edit ---------- */
  function resetForm() {
    ['edit-job-id', 'job-title', 'job-role', 'job-location', 'job-county', 'job-sal-min', 'job-sal-max',
      'job-description', 'job-requirements', 'job-deadline'].forEach((id) => { if ($(id)) $(id).value = ''; });
    $('job-slots').value = 1;
    $('job-type').value = 'full-time';
    $('job-work-type').value = 'Live-In';
    $('job-featured').checked = false;
    $('job-urgent').checked = false;
    $('post-job-title').innerHTML = '<i class="bi bi-briefcase-fill"></i> Post Job (Admin)';
    $('post-job-save-btn').innerHTML = '<i class="bi bi-briefcase"></i> Post Job';
  }

  function editJob(id) {
    const j = ALL.find((x) => String(x.id) === String(id));
    if (!j) return;
    resetForm();
    $('edit-job-id').value = j.id;
    $('job-title').value = j.title || '';
    $('job-role').value = j.role || '';
    $('job-location').value = j.location || '';
    $('job-county').value = j.county || '';
    if (j.jobType) $('job-type').value = j.jobType;
    if (j.workType) $('job-work-type').value = j.workType;
    $('job-sal-min').value = j.salMin != null ? j.salMin : '';
    $('job-sal-max').value = j.salMax != null ? j.salMax : '';
    $('job-description').value = j.description || '';
    $('job-requirements').value = j.requirements || '';
    $('job-deadline').value = j.deadline ? String(j.deadline).slice(0, 10) : '';
    $('job-slots').value = j.slots != null ? j.slots : 1;
    $('job-featured').checked = !!j.featured;
    $('job-urgent').checked = !!j.urgent;
    $('post-job-title').innerHTML = '<i class="bi bi-pencil-square"></i> Edit Job';
    $('post-job-save-btn').innerHTML = '<i class="bi bi-check-lg"></i> Save Changes';
    $('edit-job-id').dataset.keep = '1';   // stop the openModal wrapper resetting the form
    doOpen('post-job-modal');
    delete $('edit-job-id').dataset.keep;
  }

  async function postJobAsAdmin() {
    const title = $('job-title').value.trim();
    if (!title) { notify('Job title is required', 'error'); return; }

    const min = num($('job-sal-min').value), max = num($('job-sal-max').value);
    if (min != null && max != null && min > max) { notify('Salary min cannot be higher than max', 'error'); return; }

    const payload = {};
    payload[COL.title] = title;
    payload[COL.role] = $('job-role').value.trim() || null;
    payload[COL.location] = $('job-location').value.trim() || null;
    payload[COL.county] = $('job-county').value.trim() || null;
    payload[COL.jobType] = $('job-type').value;
    payload[COL.workType] = $('job-work-type').value;
    payload[COL.salMin] = min;
    payload[COL.salMax] = max;
    payload[COL.description] = $('job-description').value.trim() || null;
    payload[COL.requirements] = $('job-requirements').value.trim() || null;
    payload[COL.deadline] = $('job-deadline').value || null;
    payload[COL.slots] = num($('job-slots').value) || 1;
    payload[COL.featured] = $('job-featured').checked;
    payload[COL.urgent] = $('job-urgent').checked;

    const editId = $('edit-job-id').value;
    const btn = $('post-job-save-btn');
    btn.disabled = true;

    let res;
    if (editId) {
      res = await db().from(TABLE).update(payload).eq(COL.id, editId);
    } else {
      payload[COL.status] = 'active';
      payload[COL.employer] = 'SoundsCare';
      res = await db().from(TABLE).insert(payload);
    }
    btn.disabled = false;

    if (res.error) {
      console.error(res.error);
      notify('Could not save job: ' + res.error.message, 'error');
      return;
    }
    notify(editId ? 'Job updated' : 'Job posted', 'success');
    doClose('post-job-modal');
    resetForm();
    await loadJobs();
  }

  async function deleteJob(id) {
    const j = ALL.find((x) => String(x.id) === String(id));
    if (!j || !confirm('Delete "' + j.title + '"? This cannot be undone.')) return;
    const { error } = await db().from(TABLE).delete().eq(COL.id, id);
    if (error) { notify('Could not delete: ' + error.message, 'error'); return; }
    notify('Job deleted', 'success');
    await loadJobs();
  }

  /* ---------- init ---------- */
  async function initJobsPage() {
    ensureViewModal();

    $('jobs-tbody').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const id = b.dataset.id;
      if (b.dataset.act === 'view') viewJob(id);
      else if (b.dataset.act === 'apply') applyOnWhatsApp(id);
      else if (b.dataset.act === 'edit') editJob(id);
      else if (b.dataset.act === 'delete') deleteJob(id);
    });

    $('jobs-pagination').addEventListener('click', (e) => {
      const b = e.target.closest('button[data-page]');
      if (!b) return;
      page = Number(b.dataset.page);
      render();
    });

    // make "Post Job" always open a clean form (not leftover edit data)
    const origOpen = window.openModal;
    window.openModal = function (id) {
      if (id === 'post-job-modal' && !$('edit-job-id').dataset.keep) resetForm();
      return typeof origOpen === 'function' ? origOpen.apply(this, arguments) : doOpen(id);
    };

    await loadJobs();
  }

  // editJob opens the modal directly (doOpen) so it keeps the filled-in values
  window.initJobsPage = initJobsPage;
  window.filterJobs = filterJobs;
  window.postJobAsAdmin = postJobAsAdmin;
})();
