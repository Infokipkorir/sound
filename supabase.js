/**
 * supabase.js — single shared Supabase client.
 * Every page loads @supabase/supabase-js from CDN (or inlined, on pages that
 * embed it directly) first, then this file, so `window.sb` is available to
 * auth.js, api.js, delete-engine.js, and every page-specific script.
 *
 * Two separate values make up the connection, and this file keeps them
 * distinct rather than hardcoding one combined URL string:
 *
 *   - PROJECT_REF: the project's identifier (the "project key"), e.g.
 *     "phoahudvrcelfrykoeuo" — this is what's embedded in the project URL
 *     (https://<PROJECT_REF>.supabase.co) and is also what you'd use to
 *     build links to the Supabase dashboard or reference the project from
 *     other tooling (Edge Function URLs, CLI commands, etc).
 *
 *   - PUBLISHABLE_KEY: the public/anon key (Supabase's newer "sb_publishable_"
 *     naming — this replaces what used to be called the "anon key"). It's
 *     safe to ship in client-side code; it only grants what your RLS
 *     policies allow. This is NOT the secret/service_role key — that one
 *     must never appear in any file that reaches the browser.
 */
const SUPABASE_PROJECT_REF = 'phoahudvrcelfrykoeuo';
const SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_s4Wljr3TEtjLRxNJ9DzRSw_17gtvoAb';
const SUPABASE_URL = `https://${SUPABASE_PROJECT_REF}.supabase.co`;

if (!SUPABASE_PROJECT_REF || !SUPABASE_PUBLISHABLE_KEY) {
  console.error(
    'Supabase config is incomplete — SUPABASE_PROJECT_REF and/or ' +
    'SUPABASE_PUBLISHABLE_KEY is missing in js/supabase.js. The app cannot ' +
    'connect to the database until both are set.'
  );
}

// Exposed for any code that needs the raw values (e.g. building an Edge
// Function URL, or a link back to the Supabase dashboard) without having to
// parse them back out of the client instance.
window.SUPABASE_CONFIG = {
  projectRef: SUPABASE_PROJECT_REF,
  url: SUPABASE_URL,
  publishableKey: SUPABASE_PUBLISHABLE_KEY,
};

window.sb = supabase.createClient(SUPABASE_URL, SUPABASE_PUBLISHABLE_KEY);
