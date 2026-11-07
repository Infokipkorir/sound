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
