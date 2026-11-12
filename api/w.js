// Serves /w/<slug>: returns w.html with the worker's real name / photo / description baked into the
// <head> so WhatsApp, Facebook, X, LinkedIn and Google previews work (those crawlers do not run JS).
// Needs two Vercel env vars:  SUPABASE_URL  and  SUPABASE_ANON_KEY  (the same public values as config.js).
const fs = require('fs');
const path = require('path');

const SITE = (process.env.SITE_URL || 'https://www.sounds.co.ke').replace(/\/$/, '');
const INDEXABLE = false;            // personal profiles are for sharing by link; set true to let Google index them
const COUNTRIES = { KE:'Kenya', UG:'Uganda', TZ:'Tanzania', RW:'Rwanda', BI:'Burundi', SS:'South Sudan', ET:'Ethiopia', SO:'Somalia', ZM:'Zambia', MW:'Malawi', NG:'Nigeria', GH:'Ghana', ZA:'South Africa' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
const absUrl = (u) => !u ? '' : /^https?:/i.test(u) ? u : SITE + '/' + String(u).replace(/^\//, '');
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');

let TEMPLATE;
async function template(req) {
  if (TEMPLATE) return TEMPLATE;
  try { TEMPLATE = fs.readFileSync(path.join(process.cwd(), 'w.html'), 'utf8'); return TEMPLATE; } catch (e) { /* not bundled, load it from the site */ }
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || new URL(SITE).host;
  const r = await fetch('https://' + host + '/w');          // /w serves w.html (cleanUrls); only /w/<slug> is rewritten to this function
  if (!r.ok) throw new Error('template fetch ' + r.status);
  TEMPLATE = await r.text();
  return TEMPLATE;
}

async function fetchWorker(slug) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set');
  const r = await fetch(url.replace(/\/$/, '') + '/rest/v1/rpc/get_public_worker', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_slug: slug }),
  });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  return r.json();                       // jsonb object, or null when hidden / not found
}

function setTag(html, re, replacement) { return re.test(html) ? html.replace(re, replacement) : html; }

function buildHead(html, W, slug) {
  const first = String(W.name || 'Worker').split(' ')[0];
  const place = W.location || COUNTRIES[W.country_code] || '';
  const title = `${W.name || 'Worker'}${W.title ? ' – ' + W.title : ''}${place && !W.title ? ' – Domestic worker in ' + place : ''} | SoundsCare`;
  const desc = String(W.bio || `${first} is available for hire on SoundsCare${place ? ' in ' + place : ''}. View the profile, skills and experience.`).replace(/\s+/g, ' ').slice(0, 200);
  const url = `${SITE}/w/${encodeURIComponent(W.slug || slug)}`;
  const img = absUrl(W.photo) || SITE + '/sound_logo.jpg';

  html = setTag(html, /<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = setTag(html, /<meta name="description"[^>]*>/, `<meta name="description" content="${esc(desc)}">`);
  html = setTag(html, /<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(title)}">`);
  html = setTag(html, /<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(desc)}">`);
  html = setTag(html, /<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${esc(img)}">\n<meta property="og:image:alt" content="${esc(W.name || 'Worker')} on SoundsCare">`);
  html = setTag(html, /<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${esc(url)}">`);
  html = setTag(html, /<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${esc(url)}">`);
  html = setTag(html, /<meta name="twitter:card"[^>]*>/, `<meta name="twitter:card" content="summary">\n<meta name="twitter:title" content="${esc(title)}">\n<meta name="twitter:description" content="${esc(desc)}">\n<meta name="twitter:image" content="${esc(img)}">`);
  html = setTag(html, /<meta name="robots"[^>]*>/, `<meta name="robots" content="${INDEXABLE ? 'index,follow' : 'noindex,follow'}">`);

  const ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', url, name: title,
    mainEntity: { '@type': 'Person', name: W.name, jobTitle: W.title || undefined, image: W.photo ? absUrl(W.photo) : undefined, description: desc,
      address: place ? { '@type': 'PostalAddress', addressLocality: place, addressCountry: W.country_code || 'KE' } : undefined } };
  const inject = `<script type="application/ld+json">${jsonForScript(ld)}</script>\n<script>window.__WORKER__=${jsonForScript(W)};</script>\n`;
  return html.replace('</head>', inject + '</head>');
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.slug) || '';
  const slug = decodeURIComponent(Array.isArray(raw) ? raw[0] : raw).trim().slice(0, 120);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let html;
  try { html = await template(req); } catch (e) { console.error('w api template:', e.message); res.statusCode = 500; return res.end('Profile page is temporarily unavailable.'); }
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    res.statusCode = 404; res.setHeader('Cache-Control', 'no-store');
    return res.end(html.replace('</head>', '<script>window.__WORKER__=false;</script>\n</head>'));
  }
  try {
    const W = await fetchWorker(slug);
    if (!W) {                              // hidden, deleted, banned or wrong link
      res.statusCode = 404; res.setHeader('Cache-Control', 'public, s-maxage=30');
      html = setTag(html, /<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex,nofollow">');
      return res.end(html.replace('</head>', '<script>window.__WORKER__=false;</script>\n</head>'));
    }
    res.statusCode = 200;
    // short edge cache: previews stay fast, but a worker hiding their profile disappears within a minute
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.end(buildHead(html, W, slug));
  } catch (e) {
    // never break the page: serve the plain template, the browser then loads the profile itself
    console.error('w api:', e.message);
    res.statusCode = 200; res.setHeader('Cache-Control', 'no-store');
    return res.end(html);
  }
};
// Serves /w/<slug>: returns w.html with the worker's real name / photo / description baked into the
// <head> so WhatsApp, Facebook, X, LinkedIn and Google previews work (those crawlers do not run JS).
// Needs two Vercel env vars:  SUPABASE_URL  and  SUPABASE_ANON_KEY  (the same public values as config.js).
const fs = require('fs');
const path = require('path');

const SITE = (process.env.SITE_URL || 'https://www.sounds.co.ke').replace(/\/$/, '');
const INDEXABLE = false;            // personal profiles are for sharing by link; set true to let Google index them
const COUNTRIES = { KE:'Kenya', UG:'Uganda', TZ:'Tanzania', RW:'Rwanda', BI:'Burundi', SS:'South Sudan', ET:'Ethiopia', SO:'Somalia', ZM:'Zambia', MW:'Malawi', NG:'Nigeria', GH:'Ghana', ZA:'South Africa' };

const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (m) => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' }[m]));
const absUrl = (u) => !u ? '' : /^https?:/i.test(u) ? u : SITE + '/' + String(u).replace(/^\//, '');
const jsonForScript = (v) => JSON.stringify(v).replace(/</g, '\\u003c').replace(/\u2028|\u2029/g, '');


// Small branded error page for the rare case where the page template cannot be loaded.
function errorPage(title, msg) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<meta name="robots" content="noindex"><title>' + esc(title) + ' | SoundsCare</title>'
    + '<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#f5f7fb;color:#101828;font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;padding:20px}'
    + '.c{max-width:440px;background:#fff;border:1px solid #e2e7f0;border-radius:20px;padding:30px 24px;text-align:center;box-shadow:0 14px 40px rgba(16,24,40,.08)}'
    + 'h1{margin:0 0 8px;font-size:22px}p{margin:0 0 20px;color:#5b6678;line-height:1.6}'
    + 'a{display:inline-block;background:#1a6cf0;color:#fff;text-decoration:none;font-weight:700;padding:12px 20px;border-radius:12px}</style></head>'
    + '<body><div class="c"><h1>' + esc(title) + '</h1><p>' + esc(msg) + '</p><a href="/">Go to SoundsCare</a></div></body></html>';
}

let TEMPLATE;
async function template(req) {
  if (TEMPLATE) return TEMPLATE;
  try { TEMPLATE = fs.readFileSync(path.join(process.cwd(), 'w.html'), 'utf8'); return TEMPLATE; } catch (e) { /* not bundled, load it from the site */ }
  const host = (req.headers && (req.headers['x-forwarded-host'] || req.headers.host)) || new URL(SITE).host;
  const r = await fetch('https://' + host + '/w');          // /w serves w.html (cleanUrls); only /w/<slug> is rewritten to this function
  if (!r.ok) throw new Error('template fetch ' + r.status);
  TEMPLATE = await r.text();
  return TEMPLATE;
}

async function fetchWorker(slug) {
  const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_ANON_KEY || process.env.SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) throw new Error('SUPABASE_URL / SUPABASE_ANON_KEY not set');
  const r = await fetch(url.replace(/\/$/, '') + '/rest/v1/rpc/get_public_worker', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ p_slug: slug }),
  });
  if (!r.ok) throw new Error('Supabase ' + r.status);
  return r.json();                       // jsonb object, or null when hidden / not found
}

function setTag(html, re, replacement) { return re.test(html) ? html.replace(re, replacement) : html; }

function buildHead(html, W, slug) {
  const first = String(W.name || 'Worker').split(' ')[0];
  const place = W.location || COUNTRIES[W.country_code] || '';
  const title = `${W.name || 'Worker'}${W.title ? ' – ' + W.title : ''}${place && !W.title ? ' – Domestic worker in ' + place : ''} | SoundsCare`;
  const desc = String(W.bio || `${first} is available for hire on SoundsCare${place ? ' in ' + place : ''}. View the profile, skills and experience.`).replace(/\s+/g, ' ').slice(0, 200);
  const url = `${SITE}/w/${encodeURIComponent(W.slug || slug)}`;
  const img = absUrl(W.photo) || SITE + '/sound_logo.jpg';

  html = setTag(html, /<title>[\s\S]*?<\/title>/, `<title>${esc(title)}</title>`);
  html = setTag(html, /<meta name="description"[^>]*>/, `<meta name="description" content="${esc(desc)}">`);
  html = setTag(html, /<meta property="og:title"[^>]*>/, `<meta property="og:title" content="${esc(title)}">`);
  html = setTag(html, /<meta property="og:description"[^>]*>/, `<meta property="og:description" content="${esc(desc)}">`);
  html = setTag(html, /<meta property="og:image"[^>]*>/, `<meta property="og:image" content="${esc(img)}">\n<meta property="og:image:alt" content="${esc(W.name || 'Worker')} on SoundsCare">`);
  html = setTag(html, /<meta property="og:url"[^>]*>/, `<meta property="og:url" content="${esc(url)}">`);
  html = setTag(html, /<link rel="canonical"[^>]*>/, `<link rel="canonical" href="${esc(url)}">`);
  html = setTag(html, /<meta name="twitter:card"[^>]*>/, `<meta name="twitter:card" content="summary">\n<meta name="twitter:title" content="${esc(title)}">\n<meta name="twitter:description" content="${esc(desc)}">\n<meta name="twitter:image" content="${esc(img)}">`);
  html = setTag(html, /<meta name="robots"[^>]*>/, `<meta name="robots" content="${INDEXABLE ? 'index,follow' : 'noindex,follow'}">`);

  const ld = { '@context': 'https://schema.org', '@type': 'ProfilePage', url, name: title,
    mainEntity: { '@type': 'Person', name: W.name, jobTitle: W.title || undefined, image: W.photo ? absUrl(W.photo) : undefined, description: desc,
      address: place ? { '@type': 'PostalAddress', addressLocality: place, addressCountry: W.country_code || 'KE' } : undefined } };
  const inject = `<script type="application/ld+json">${jsonForScript(ld)}</script>\n<script>window.__WORKER__=${jsonForScript(W)};</script>\n`;
  return html.replace('</head>', inject + '</head>');
}

module.exports = async (req, res) => {
  const raw = (req.query && req.query.slug) || '';
  const slug = decodeURIComponent(Array.isArray(raw) ? raw[0] : raw).trim().slice(0, 120);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  let html;
  try { html = await template(req); } catch (e) { console.error('w api template:', e.message); res.statusCode = 500; res.setHeader('Cache-Control', 'no-store'); return res.end(errorPage('Something went wrong', 'This profile page is temporarily unavailable. Please try again in a moment.')); }
  if (!slug || !/^[a-z0-9][a-z0-9-]*$/i.test(slug)) {
    res.statusCode = 404; res.setHeader('Cache-Control', 'no-store');
    return res.end(html.replace('</head>', '<script>window.__WORKER__=false;</script>\n</head>'));
  }
  try {
    const W = await fetchWorker(slug);
    if (!W) {                              // hidden, deleted, banned or wrong link
      res.statusCode = 404; res.setHeader('Cache-Control', 'public, s-maxage=30');
      html = setTag(html, /<meta name="robots"[^>]*>/, '<meta name="robots" content="noindex,nofollow">');
      return res.end(html.replace('</head>', '<script>window.__WORKER__=false;</script>\n</head>'));
    }
    res.statusCode = 200;
    // short edge cache: previews stay fast, but a worker hiding their profile disappears within a minute
    res.setHeader('Cache-Control', 'public, s-maxage=60, stale-while-revalidate=300');
    return res.end(buildHead(html, W, slug));
  } catch (e) {
    // never break the page: serve the plain template, the browser then loads the profile itself
    console.error('w api:', e.message);
    res.statusCode = 200; res.setHeader('Cache-Control', 'no-store');
    return res.end(html);
  }
};
