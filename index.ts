// Supabase Edge Function: phone-verify  (Twilio Verify, SMS channel)
// Deploy with verify_jwt = true. Secrets needed:
//   TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, TWILIO_VERIFY_SERVICE_SID
// (SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY are provided automatically.)
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, "Content-Type": "application/json" } });

// 0712345678 / 712345678 / 254712345678 / +254712345678 -> +254712345678
function toE164(raw: string): string | null {
  const d = (raw || "").replace(/[^\d+]/g, "");
  if (d.startsWith("+")) return /^\+\d{9,15}$/.test(d) ? d : null;
  if (d.startsWith("00")) return "+" + d.slice(2);
  if (d.startsWith("254")) return "+" + d;
  if (d.startsWith("0") && d.length === 10) return "+254" + d.slice(1);
  if (/^[71]\d{8}$/.test(d)) return "+254" + d;
  return null;
}

async function twilio(path: string, params: Record<string, string>) {
  const sid = Deno.env.get("TWILIO_ACCOUNT_SID")!, token = Deno.env.get("TWILIO_AUTH_TOKEN")!;
  const svc = Deno.env.get("TWILIO_VERIFY_SERVICE_SID")!;
  const r = await fetch(`https://verify.twilio.com/v2/Services/${svc}/${path}`, {
    method: "POST",
    headers: { Authorization: "Basic " + btoa(`${sid}:${token}`), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params),
  });
  return { ok: r.ok, data: await r.json() };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: cors });
  try {
    const url = Deno.env.get("SUPABASE_URL")!;
    const userClient = createClient(url, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: req.headers.get("Authorization") ?? "" } },
    });
    const { data: { user } } = await userClient.auth.getUser();
    if (!user) return json({ error: "Not signed in" }, 401);

    const admin = createClient(url, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
    const { data: wp } = await admin.from("worker_profiles")
      .select("id, phone, phone_number, phone_verified, phone_verification_requested_at")
      .eq("session_id", user.id).maybeSingle();
    if (!wp) return json({ error: "Worker profile not found" }, 404);

    // Always verify the number saved on the profile (never a number sent by the browser).
    const { action, code } = await req.json();
    const to = toE164(wp.phone || wp.phone_number || "");
    if (!to) return json({ error: "Enter a valid phone number" }, 400);

    if (action === "start") {
      const last = wp.phone_verification_requested_at ? Date.parse(wp.phone_verification_requested_at) : 0;
      if (Date.now() - last < 30_000) return json({ error: "Please wait 30 seconds before requesting another code" }, 429);
      const t = await twilio("Verifications", { To: to, Channel: "sms" });
      if (!t.ok) return json({ error: t.data?.message || "Could not send SMS" }, 400);
      await admin.from("worker_profiles").update({
        phone_verification_status: "pending",
        phone_verification_requested_at: new Date().toISOString(),
        phone_verification_code: null, // old manual SUNSET-xxxx codes are no longer used
      }).eq("id", wp.id);
      return json({ ok: true, phone: to });
    }

    if (action === "check") {
      if (!/^\d{4,10}$/.test(String(code || ""))) return json({ error: "Enter the code from the SMS" }, 400);
      const t = await twilio("VerificationCheck", { To: to, Code: String(code) });
      if (!t.ok || t.data?.status !== "approved") return json({ ok: false, error: "Wrong or expired code" }, 400);
      await admin.from("worker_profiles").update({
        phone_verified: true,
        phone_verification_status: "verified",
        phone_verification_code: null,
      }).eq("id", wp.id);
      return json({ ok: true, verified: true, phone: to });
    }
    return json({ error: "Unknown action" }, 400);
  } catch (e) {
    return json({ error: String(e) }, 500);
  }

import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.45.4';

// Checks whether a phone number has WhatsApp (Green API: checkWhatsapp) and records the
// result in public.whatsapp_number_checks, which submit_whatsapp_job_application() relies on.
// Secrets (Edge Functions > Secrets): GREEN_API_ID_INSTANCE, GREEN_API_TOKEN, optional GREEN_API_URL.
// Deployed with verify_jwt = true.

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
};
const json = (b: unknown, s = 200) =>
  new Response(JSON.stringify(b), { status: s, headers: { ...cors, 'Content-Type': 'application/json' } });

const REGISTERED_CACHE_MS = 24 * 60 * 60 * 1000; // a confirmed number is not re-checked for 24h
const NEGATIVE_CACHE_MS = 10 * 60 * 1000;        // a "not on WhatsApp" answer is reused for 10 min
const MAX_CALLS_PER_MINUTE = 20;                 // protects the connected WhatsApp number from being flagged

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors });
  if (req.method !== 'POST') return json({ error: 'Method not allowed' }, 405);

  let body: { country_code?: string; phone?: string };
  try { body = await req.json(); } catch { return json({ error: 'Invalid request' }, 400); }

  const cc = String(body.country_code ?? '').replace(/\D/g, '');
  const local = String(body.phone ?? '').replace(/\D/g, '').replace(/^0+/, '');
  const phone = cc + local;
  if (cc.length < 1 || cc.length > 4 || local.length < 6 || local.length > 12 || phone.length > 15) {
    return json({ error: 'Enter a valid country code and phone number' }, 400);
  }

  const db = createClient(Deno.env.get('SUPABASE_URL')!, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, {
    auth: { persistSession: false },
  });

  const save = async (status: 'registered' | 'not_registered' | 'unavailable') => {
    await db.from('whatsapp_number_checks')
      .upsert({ phone, status, checked_at: new Date().toISOString() }, { onConflict: 'phone' });
    return json({ status, phone });
  };

  // 1) cached answer?
  const { data: cached } = await db.from('whatsapp_number_checks')
    .select('status, checked_at').eq('phone', phone).maybeSingle();
  if (cached) {
    const age = Date.now() - new Date(cached.checked_at).getTime();
    if (cached.status === 'registered' && age < REGISTERED_CACHE_MS) return json({ status: 'registered', phone, cached: true });
    if (cached.status === 'not_registered' && age < NEGATIVE_CACHE_MS) return json({ status: 'not_registered', phone, cached: true });
  }

  // 2) global throttle on calls to the provider
  const since = new Date(Date.now() - 60_000).toISOString();
  const { count } = await db.from('whatsapp_number_checks')
    .select('phone', { count: 'exact', head: true }).gte('checked_at', since).neq('status', 'unavailable');
  if ((count ?? 0) >= MAX_CALLS_PER_MINUTE) return save('unavailable');

  // 3) ask the provider
  const idInstance = Deno.env.get('GREEN_API_ID_INSTANCE');
  const token = Deno.env.get('GREEN_API_TOKEN');
  const apiUrl = (Deno.env.get('GREEN_API_URL') || 'https://api.green-api.com').replace(/\/+$/, '');
  if (!idInstance || !token) {
    console.error('[check-whatsapp] GREEN_API_ID_INSTANCE / GREEN_API_TOKEN not set');
    return save('unavailable');
  }

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 8000);
    const res = await fetch(`${apiUrl}/waInstance${idInstance}/checkWhatsapp/${token}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: phone }),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      console.error('[check-whatsapp] provider HTTP', res.status);
      return save('unavailable');
    }
    const out = await res.json();
    if (typeof out?.existsWhatsapp !== 'boolean') return save('unavailable');
    return save(out.existsWhatsapp ? 'registered' : 'not_registered');
  } catch (e) {
    console.error('[check-whatsapp] provider error', e);
    return save('unavailable');
  }

// Receives Safaricom's B2C result. Deploy with --no-verify-jwt (Safaricom sends no Supabase token).
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const TABLES: Record<string, { table: string; paid: string }> = {
  agent: { table: "agent_withdrawals", paid: "paid" },
  worker: { table: "worker_withdrawals", paid: "paid" },
  tasker: { table: "task_withdrawal_requests", paid: "completed" },
};
const ack = () => new Response(JSON.stringify({ ResultCode: 0, ResultDesc: "Accepted" }), { headers: { "Content-Type": "application/json" } });

Deno.serve(async (req) => {
  const svc = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!);
  try {
    const body = await req.json();
    const r = body.Result;
    if (!r) return ack();
    const originator = r.OriginatorConversationID as string;
    const { data: row } = await svc.from("mpesa_b2c_requests").select("*")
      .or(`originator_conversation_id.eq.${originator},id.eq.${originator}`).maybeSingle();
    if (!row || row.status !== "pending") return ack(); // unknown or already handled (idempotent)

    const ok = Number(r.ResultCode) === 0;
    const params: Record<string, unknown> = {};
    for (const p of r.ResultParameters?.ResultParameter ?? []) params[p.Key] = p.Value;
    const receipt = (params["TransactionReceipt"] as string) || r.TransactionID || null;

    await svc.from("mpesa_b2c_requests").update({
      status: ok ? "success" : "failed",
      result_code: String(r.ResultCode), result_desc: r.ResultDesc,
      mpesa_receipt: ok ? receipt : null, raw_callback: body, completed_at: new Date().toISOString(),
    }).eq("id", row.id);

    const cfg = TABLES[row.kind];
    if (ok) {
      const patch: Record<string, unknown> = { status: cfg.paid, processed_at: new Date().toISOString() };
      if (row.kind === "agent") patch.mpesa_receipt_number = receipt;
      if (row.kind === "tasker") patch.admin_note = `M-Pesa ${receipt}`;
      else patch.admin_notes = `M-Pesa ${receipt}`;
      await svc.from(cfg.table).update(patch).eq("id", row.withdrawal_id);
    } else {
      // Put it back in the queue so the accountant can retry or reject
      await svc.from(cfg.table).update({ status: row.kind === "tasker" ? "pending" : "approved" }).eq("id", row.withdrawal_id);
    }
  } catch (e) {
    console.error("callback error", e);
  }
  return ack();
});
