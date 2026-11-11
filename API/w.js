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
function template() {
  if (!TEMPLATE) TEMPLATE = fs.readFileSync(path.join(process.cwd(), 'w.html'), 'utf8');
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
  let html = template();
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
