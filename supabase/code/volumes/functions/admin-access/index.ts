import { createClient } from "@supabase/supabase-js";

type Permission = "overview" | "notices" | "chat" | "moderation" | "push" | "lives" | "recordings" | "groups" | "manage_admins";
const VALID_PERMISSIONS = new Set<Permission>(["overview", "notices", "chat", "moderation", "push", "lives", "recordings", "groups", "manage_admins"]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
function requiredEnv(name: string) { const value = Deno.env.get(name)?.trim(); if (!value) throw new Error(`${name} não configurada`); return value; }
function normalizeEmail(value: unknown) { return String(value ?? "").trim().toLowerCase(); }
function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((item): item is Permission => VALID_PERMISSIONS.has(item as Permission)))];
}

async function context(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new Response("Sessão ausente", { status: 401 });
  const url = requiredEnv("SUPABASE_URL");
  const anon = createClient(url, requiredEnv("SUPABASE_ANON_KEY"), { global: { headers: { Authorization: authorization } }, auth: { persistSession: false, autoRefreshToken: false } });
  const { data: userData, error: userError } = await anon.auth.getUser();
  if (userError || !userData.user) throw new Response("Sessão inválida", { status: 401 });
  const admin = createClient(url, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: access, error: accessError } = await admin.from("admin_accounts").select("user_id,email,permissions,active").eq("user_id", userData.user.id).maybeSingle();
  if (accessError || !access?.active || !(access.permissions ?? []).includes("manage_admins")) throw new Response("Acesso para gerenciar administradores não autorizado", { status: 403 });
  return { admin, anon, user: userData.user };
}

async function audit(admin: ReturnType<typeof createClient>, actorId: string, action: string, targetEmail?: string, targetUserId?: string, details: Record<string, unknown> = {}) {
  await admin.from("admin_access_audit").insert({ actor_id: actorId, action, target_email: targetEmail || null, target_user_id: targetUserId || null, details });
}

async function ensureManagerRemains(admin: ReturnType<typeof createClient>, targetUserId: string, nextPermissions: Permission[], nextActive: boolean) {
  const { data: target } = await admin.from("admin_accounts").select("permissions,active").eq("user_id", targetUserId).maybeSingle();
  const removesManager = target?.active && (target.permissions ?? []).includes("manage_admins") && (!nextActive || !nextPermissions.includes("manage_admins"));
  if (!removesManager) return;
  const { data: managers, error } = await admin.from("admin_accounts").select("user_id").eq("active", true).contains("permissions", ["manage_admins"]);
  if (error) throw new Error(error.message);
  if ((managers ?? []).length <= 1) throw new Error("Não é possível remover o último administrador com permissão para gerenciar acessos.");
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  try {
    const { admin, anon, user } = await context(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "list");
    if (action === "list") {
      const [accountsResult, invitationsResult] = await Promise.all([
        admin.from("admin_accounts").select("user_id,email,full_name,permissions,active,created_at,updated_at").order("created_at"),
        admin.from("admin_invitations").select("id,email,full_name,permissions,status,expires_at,created_at").in("status", ["pending", "expired"]).order("created_at", { ascending: false }),
      ]);
      const error = accountsResult.error || invitationsResult.error;
      if (error) throw new Error(error.message);
      return json({ accounts: accountsResult.data ?? [], invitations: invitationsResult.data ?? [] });
    }
    if (action === "invite" || action === "resend") {
      const email = normalizeEmail(body.email);
      const fullName = String(body.full_name ?? "").trim();
      const permissions = normalizePermissions(body.permissions);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Informe um e-mail válido." }, 400);
      if (!fullName) return json({ error: "Informe o nome da pessoa." }, 400);
      if (!permissions.length) return json({ error: "Selecione ao menos uma permissão." }, 400);
      const { data: existing } = await admin.from("admin_accounts").select("user_id,active").eq("email", email).maybeSingle();
      if (existing?.active) return json({ error: "Este e-mail já possui acesso administrativo ativo." }, 409);
      await admin.from("admin_invitations").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("email", email).eq("status", "pending");
      const { data: invitation, error: invitationError } = await admin.from("admin_invitations").insert({ email, full_name: fullName, permissions, invited_by: user.id, expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString() }).select("id,email,full_name,permissions,status,expires_at,created_at").single();
      if (invitationError) throw new Error(invitationError.message);
      const redirectTo = (Deno.env.get("PANEL_ADMIN_URL") || "https://painel.casadeisabel.com.br").replace(/\/$/, "") + "/?admin_invite=1";
      const { error: otpError } = await anon.auth.signInWithOtp({ email, options: { shouldCreateUser: true, emailRedirectTo: redirectTo } });
      if (otpError) { await admin.from("admin_invitations").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", invitation.id); throw new Error(`Não foi possível enviar o convite: ${otpError.message}`); }
      await audit(admin, user.id, action === "resend" ? "invitation_resent" : "invitation_created", email, undefined, { invitation_id: invitation.id, permissions });
      return json({ invitation, sent: true });
    }
    if (action === "update") {
      const userId = String(body.user_id ?? "");
      const fullName = String(body.full_name ?? "").trim();
      const permissions = normalizePermissions(body.permissions);
      const active = body.active !== false;
      if (!userId || !permissions.length) return json({ error: "Usuário e permissões são obrigatórios." }, 400);
      await ensureManagerRemains(admin, userId, permissions, active);
      const { data, error } = await admin.from("admin_accounts").update({ full_name: fullName || null, permissions, active, updated_at: new Date().toISOString() }).eq("user_id", userId).select("user_id,email,full_name,permissions,active,created_at,updated_at").single();
      if (error) throw new Error(error.message);
      await audit(admin, user.id, "account_updated", data.email, userId, { permissions, active });
      return json({ account: data });
    }
    if (action === "password_reset") {
      const targetUserId = String(body.user_id ?? "");
      const { data: target, error: targetError } = await admin.from("admin_accounts").select("user_id,email,active").eq("user_id", targetUserId).maybeSingle();
      if (targetError || !target?.active) return json({ error: "Administrador ativo não encontrado." }, 404);
      const redirectTo = (Deno.env.get("PANEL_ADMIN_URL") || "https://painel.casadeisabel.com.br").replace(/\/$/, "") + "/?password_reset=1";
      const { error: resetError } = await anon.auth.resetPasswordForEmail(target.email, { redirectTo });
      if (resetError) throw new Error(`Não foi possível enviar a troca de senha: ${resetError.message}`);
      await audit(admin, user.id, "password_reset_requested", target.email, target.user_id);
      return json({ sent: true });
    }
    if (action === "revoke") {
      const invitationId = String(body.invitation_id ?? "");
      const { data, error } = await admin.from("admin_invitations").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", invitationId).eq("status", "pending").select("email").maybeSingle();
      if (error) throw new Error(error.message);
      if (data) await audit(admin, user.id, "invitation_revoked", data.email, undefined, { invitation_id: invitationId });
      return json({ revoked: !!data });
    }
    return json({ error: "Ação desconhecida." }, 400);
  } catch (error) {
    if (error instanceof Response) return json({ error: await error.text() }, error.status);
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
