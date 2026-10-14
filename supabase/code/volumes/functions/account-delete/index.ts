import { createClient } from "@supabase/supabase-js";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: Record<string, unknown>, status = 200) => Response.json(body, { status, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
const requiredEnv = (name: string) => { const value = Deno.env.get(name)?.trim(); if (!value) throw new Error(`${name} não configurada`); return value; };

async function removeAvatarFiles(admin: ReturnType<typeof createClient>, userId: string) {
  const { data, error } = await admin.storage.from("avatars").list(userId, { limit: 100 });
  if (error || !data?.length) return;
  await admin.storage.from("avatars").remove(data.map((item) => `${userId}/${item.name}`));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const authorization = req.headers.get("Authorization") ?? "";
    if (!authorization.toLowerCase().startsWith("bearer ")) return json({ error: "missing_authorization" }, 401);
    const input = await req.json().catch(() => ({})) as { confirmation?: string };
    if (input.confirmation !== "DELETE") return json({ error: "confirmation_required" }, 400);
    const supabaseUrl = requiredEnv("SUPABASE_URL");
    const anon = createClient(supabaseUrl, requiredEnv("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
    const { data: userData, error: userError } = await anon.auth.getUser();
    if (userError || !userData.user?.email) return json({ error: "invalid_session" }, 401);
    const admin = createClient(supabaseUrl, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
    const user = userData.user;
    const { data: profile } = await admin.from("profiles").select("role").eq("id", user.id).maybeSingle();
    if (profile?.role === "admin" || profile?.role === "support") return json({ error: "staff_account_protected", message: "Contas da equipe devem ser removidas por outro administrador." }, 403);
    await admin.from("security_audit_log").insert({ user_id: user.id, event_type: "account_deletion_requested", metadata: { source: req.headers.get("origin") || "app" } });
    await removeAvatarFiles(admin, user.id).catch(() => undefined);
    await admin.from("student_group_invitations").delete().ilike("email", user.email);
    await admin.from("hotmart_cohort_roster").delete().ilike("email", user.email);
    const { error: deleteError } = await admin.auth.admin.deleteUser(user.id, false);
    if (deleteError) throw deleteError;
    return json({ status: "deleted" });
  } catch (error) {
    console.error("account-delete", error);
    return json({ error: "account_delete_failed", message: "Não foi possível excluir a conta." }, 500);
  }
});
