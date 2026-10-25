// Supabase Edge Function: admin-passkey
// Verifies a WebAuthn assertion (fingerprint / pattern / device password) and,
// if it matches an Active admin's registered passkey, returns a one-time token
// the browser exchanges for a normal Supabase session (sb.auth.verifyOtp).
//
// Deploy:  supabase functions deploy admin-passkey --no-verify-jwt
// Secrets: supabase secrets set PASSKEY_SECRET=<long random string> \
//          ALLOWED_ORIGINS=https://www.sounds.co.ke,https://sounds.co.ke
// (SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are provided automatically.)

import { createClient } from "npm:@supabase/supabase-js@2";

const SECRET = Deno.env.get("PASSKEY_SECRET")!;
const ORIGINS = (Deno.env.get("ALLOWED_ORIGINS") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
const enc = new TextEncoder();

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });

const b64uEnc = (b: ArrayBuffer | Uint8Array) =>
  btoa(String.fromCharCode(...new Uint8Array(b))).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const b64uDec = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/")), (c) => c.charCodeAt(0));

async function hmac(data: string) {
  const key = await crypto.subtle.importKey("raw", enc.encode(SECRET), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64uEnc(await crypto.subtle.sign("HMAC", key, enc.encode(data)));
}

// Stateless challenge: <random>.<timestamp>.<hmac>, valid for 2 minutes.
async function makeChallenge() {
  const rnd = b64uEnc(crypto.getRandomValues(new Uint8Array(32)));
  const ts = Date.now().toString();
  return `${rnd}.${ts}.${await hmac(`${rnd}.${ts}`)}`;
}
async function challengeValid(token: string) {
  const [rnd, ts, sig] = token.split(".");
  if (!rnd || !ts || !sig) return false;
  if (Date.now() - Number(ts) > 120_000) return false;
  return (await hmac(`${rnd}.${ts}`)) === sig;
}

function derToRaw(der: Uint8Array): Uint8Array {
  let o = 2;
  if (der[1] & 0x80) o += der[1] & 0x7f;
  const rLen = der[o + 1]; const r = der.slice(o + 2, o + 2 + rLen); o = o + 2 + rLen;
  const sLen = der[o + 1]; const s = der.slice(o + 2, o + 2 + sLen);
  const fix = (x: Uint8Array) => {
    while (x.length > 32 && x[0] === 0) x = x.slice(1);
    const out = new Uint8Array(32); out.set(x, 32 - x.length); return out;
  };
  const out = new Uint8Array(64); out.set(fix(r), 0); out.set(fix(s), 32); return out;
}

async function verifySignature(spki: Uint8Array, signature: Uint8Array, data: Uint8Array) {
  try { // ES256 (-7)
    const k = await crypto.subtle.importKey("spki", spki, { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    return await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, k, derToRaw(signature), data);
  } catch (_) { /* not an EC key, try RSA */ }
  const k = await crypto.subtle.importKey("spki", spki, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["verify"]);
  return await crypto.subtle.verify("RSASSA-PKCS1-v1_5", k, signature, data);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const body = await req.json();

    if (body.action === "challenge") return json({ challenge: await makeChallenge() });

    if (body.action === "login") {
      const clientDataJSON = b64uDec(body.clientDataJSON);
      const authData = b64uDec(body.authenticatorData);
      const signature = b64uDec(body.signature);
      const clientData = JSON.parse(new TextDecoder().decode(clientDataJSON));

      if (clientData.type !== "webauthn.get") return json({ error: "Invalid request." }, 400);
      if (!ORIGINS.includes(clientData.origin)) return json({ error: "Origin not allowed." }, 403);
      const token = new TextDecoder().decode(b64uDec(clientData.challenge));
      if (!(await challengeValid(token))) return json({ error: "Sign-in expired. Please try again." }, 400);

      // rpIdHash must match this site's hostname; UP (0x01) and UV (0x04) flags must be set.
      const rpId = new URL(clientData.origin).hostname;
      const rpHash = new Uint8Array(await crypto.subtle.digest("SHA-256", enc.encode(rpId)));
      if (!rpHash.every((v, i) => v === authData[i])) return json({ error: "Invalid request." }, 400);
      if ((authData[32] & 0x05) !== 0x05) return json({ error: "Screen lock verification is required." }, 400);

      const { data: row } = await admin.from("admin_users")
        .select("user_id,status,passkey_public_key").eq("passkey_id", body.id).maybeSingle();
      if (!row || row.status !== "Active" || !row.passkey_public_key) {
        return json({ error: "This device is not registered. Sign in with email, then enable it in Settings." }, 401);
      }

      const clientHash = new Uint8Array(await crypto.subtle.digest("SHA-256", clientDataJSON));
      const signed = new Uint8Array(authData.length + clientHash.length);
      signed.set(authData, 0); signed.set(clientHash, authData.length);
      const ok = await verifySignature(b64uDec(row.passkey_public_key), signature, signed);
      if (!ok) return json({ error: "Could not verify this device." }, 401);

      const { data: u } = await admin.auth.admin.getUserById(row.user_id);
      const email = u?.user?.email;
      if (!email) return json({ error: "Account not found." }, 404);
      const { data: link, error } = await admin.auth.admin.generateLink({ type: "magiclink", email });
      if (error || !link?.properties?.hashed_token) return json({ error: "Could not start a session." }, 500);
      return json({ token_hash: link.properties.hashed_token });
    }

    return json({ error: "Unknown action." }, 400);
  } catch (_) {
    return json({ error: "Something went wrong." }, 500);
  }
});
