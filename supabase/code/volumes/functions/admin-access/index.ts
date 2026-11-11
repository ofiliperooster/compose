// Keep the dependency self-contained because the self-hosted Edge Runtime
// receives only index.ts in some EasyPanel deployments (without deno.json).
import { createClient } from "npm:@supabase/supabase-js@2.114.0";
import nodemailer from "npm:nodemailer@6.10.1";

type Permission =
  | "overview" | "notices" | "chat" | "moderation" | "push"
  | "lives" | "recordings" | "groups" | "manage_admins" | "app_management";

const VALID_PERMISSIONS = new Set<Permission>([
  "overview", "notices", "chat", "moderation", "push",
  "lives", "recordings", "groups", "manage_admins", "app_management",
]);
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { ...corsHeaders, "Cache-Control": "no-store" },
});

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} não configurada`);
  return value;
}

function normalizeEmail(value: unknown) {
  return String(value ?? "").trim().toLowerCase();
}

function normalizePermissions(value: unknown): Permission[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.map(String).filter((item): item is Permission => VALID_PERMISSIONS.has(item as Permission)))];
}

async function context(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new Response("Sessão ausente", { status: 401 });
  const url = requiredEnv("SUPABASE_URL");
  const anon = createClient(url, requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await anon.auth.getUser();
  if (userError || !userData.user) throw new Response("Sessão inválida", { status: 401 });
  const admin = createClient(url, requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: access, error: accessError } = await admin
    .from("admin_accounts")
    .select("user_id,email,permissions,active")
    .eq("user_id", userData.user.id)
    .maybeSingle();
  if (accessError || !access?.active) throw new Response("Acesso administrativo não autorizado", { status: 403 });
  return { admin, anon, user: userData.user, access };
}

function requirePermission(access: { permissions?: string[] }, permission: Permission) {
  if (!(access.permissions ?? []).includes(permission)) {
    throw new Response("Permissão administrativa insuficiente", { status: 403 });
  }
}

async function authUserExists(admin: ReturnType<typeof createClient>, email: string) {
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 1000 });
    if (error) throw new Error(`Não foi possível verificar a conta: ${error.message}`);
    if (data.users.some((candidate) => candidate.email?.trim().toLowerCase() === email)) return true;
    if (data.users.length < 1000) return false;
  }
  return false;
}

async function audit(admin: ReturnType<typeof createClient>, actorId: string, action: string, targetEmail?: string, targetUserId?: string, details: Record<string, unknown> = {}) {
  await admin.from("admin_access_audit").insert({
    actor_id: actorId,
    action,
    target_email: targetEmail || null,
    target_user_id: targetUserId || null,
    details,
  });
}

async function ensureManagerRemains(admin: ReturnType<typeof createClient>, targetUserId: string, nextPermissions: Permission[], nextActive: boolean) {
  const { data: target } = await admin.from("admin_accounts").select("permissions,active").eq("user_id", targetUserId).maybeSingle();
  const removesManager = target?.active && (target.permissions ?? []).includes("manage_admins") && (!nextActive || !nextPermissions.includes("manage_admins"));
  if (!removesManager) return;
  const { data: managers, error } = await admin.from("admin_accounts").select("user_id").eq("active", true).contains("permissions", ["manage_admins"]);
  if (error) throw new Error(error.message);
  if ((managers ?? []).length <= 1) throw new Error("Não é possível remover o último administrador com permissão para gerenciar acessos.");
}

async function sendCourtesyInvitation(email: string, link: string) {
  const port = Number(requiredEnv("SMTP_PORT"));
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("SMTP_PORT inválida");
  const senderName = Deno.env.get("SMTP_SENDER_NAME")?.trim() || "Casa de Isabel";
  const senderEmail = requiredEnv("SMTP_ADMIN_EMAIL");
  const transporter = nodemailer.createTransport({
    host: requiredEnv("SMTP_HOST"),
    port,
    secure: port === 465,
    requireTLS: port === 587,
    auth: { user: requiredEnv("SMTP_USER"), pass: requiredEnv("SMTP_PASS") },
  });
  const safeName = senderName.replace(/[<>"&]/g, "");
  try {
    await transporter.sendMail({
      from: { name: safeName, address: senderEmail },
      to: email,
      subject: "Crie seu acesso à Casa de Isabel",
      text: `Seu acesso de cortesia está pronto. Crie sua senha pelo link (válido por 24 horas): ${link}`,
      html: `<!doctype html><html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><body style="margin:0;background:#090909;color:#f7f5ef;font-family:Arial,sans-serif"><main style="max-width:480px;margin:32px auto;padding:32px;background:#151719;border:1px solid #303438;border-radius:20px"><p style="font-size:12px;letter-spacing:3px;color:#a9c1d5">CASA DE ISABEL</p><h1 style="font-size:26px">Crie sua senha</h1><p style="color:#c5ccd2;line-height:1.6">Seu acesso de cortesia está pronto. Use o botão abaixo para criar sua senha e entrar no aplicativo. Este link é individual e válido por 24 horas.</p><p style="margin:28px 0"><a href="${link}" style="display:inline-block;padding:15px 24px;border-radius:12px;background:#fff;color:#111;text-decoration:none;font-weight:bold">Criar minha senha</a></p><p style="font-size:12px;color:#a9b0b5;line-height:1.5">Se o botão não abrir, copie este endereço para o navegador:<br><a href="${link}" style="color:#a9c1d5;word-break:break-all">${link}</a></p></main></body></html>`,
    });
  } finally {
    transporter.close();
  }
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { admin, anon, user, access } = await context(req);
    const body = await req.json().catch(() => ({})) as Record<string, unknown>;
    const action = String(body.action ?? "list");

    if (action.startsWith("courtesy_")) requirePermission(access, "app_management");
    else requirePermission(access, "manage_admins");

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
      const { data: invitation, error: invitationError } = await admin.from("admin_invitations").insert({
        email,
        full_name: fullName,
        permissions,
        invited_by: user.id,
        expires_at: new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      }).select("id,email,full_name,permissions,status,expires_at,created_at").single();
      if (invitationError) throw new Error(invitationError.message);

      const redirectTo = (Deno.env.get("FIRST_ACCESS_URL") || "https://criaracesso.casadeisabel.com.br").replace(/\/$/, "") + "/?admin_invite=1";
      const existingAuthUser = await authUserExists(admin, email);
      const deliveryError = existingAuthUser
        ? (await anon.auth.signInWithOtp({
            email,
            options: { shouldCreateUser: false, emailRedirectTo: redirectTo },
          })).error
        : (await admin.auth.admin.inviteUserByEmail(email, {
            redirectTo,
            data: { full_name: fullName, admin_invitation_id: invitation.id },
          })).error;
      if (deliveryError) {
        await admin.from("admin_invitations").update({ status: "revoked", updated_at: new Date().toISOString() }).eq("id", invitation.id);
        throw new Error(`Não foi possível enviar o convite: ${deliveryError.message}`);
      }
      await audit(admin, user.id, action === "resend" ? "invitation_resent" : "invitation_created", email, undefined, { invitation_id: invitation.id, permissions, delivery: existingAuthUser ? "otp" : "native_invite" });
      return json({ invitation, sent: true, delivery: existingAuthUser ? "otp" : "native_invite" });
    }

    if (action === "courtesy_invite" || action === "courtesy_resend") {
      const email = normalizeEmail(body.email);
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json({ error: "Informe um e-mail válido." }, 400);
      const { data: grant, error: grantError } = await admin.from("courtesy_access_grants")
        .select("id,email,access_expires_at,active,password_set_at,created_at,updated_at")
        .eq("email", email).maybeSingle();
      if (grantError) throw new Error(grantError.message);
      if (!grant?.active || grant.password_set_at || grant.access_expires_at < new Date().toISOString().slice(0, 10)) {
        return json({ error: "Acesso de cortesia não está ativo, expirou ou a senha já foi criada." }, 409);
      }

      const { data: ticket, error: ticketError } = await anon.rpc('create_courtesy_password_invitation', { p_email: email });
      if (ticketError || !ticket?.token) throw new Error(ticketError?.message || 'Não foi possível preparar o convite de cortesia.');
      const redirectTo = (Deno.env.get("FIRST_ACCESS_URL") || "https://criaracesso.casadeisabel.com.br").replace(/\/$/, "") + "/?courtesy_setup=1&courtesy_ticket=" + encodeURIComponent(ticket.token);
      await sendCourtesyInvitation(email, redirectTo);
      const { error: finalizeError } = await anon.rpc("finalize_courtesy_password_invitation", { p_token: ticket.token });
      if (finalizeError) throw new Error(`E-mail enviado, mas não foi possível invalidar os links anteriores: ${finalizeError.message}`);
      await admin.from("courtesy_access_grants").update({ invitation_sent_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", grant.id);
      await audit(admin, user.id, action, email, undefined, { grant_id: grant.id, access_expires_at: grant.access_expires_at, delivery: "smtp" });
      return json({ grant, sent: true, delivery: "smtp" });
    }

    if (action === "update") {
      const userId = String(body.user_id ?? "");
      const fullName = String(body.full_name ?? "").trim();
      const permissions = normalizePermissions(body.permissions);
      const active = body.active !== false;
      if (!userId || !permissions.length) return json({ error: "Usuário e permissões são obrigatórios." }, 400);
      await ensureManagerRemains(admin, userId, permissions, active);
      const { data, error } = await admin.from("admin_accounts").update({
        full_name: fullName || null,
        permissions,
        active,
        updated_at: new Date().toISOString(),
      }).eq("user_id", userId).select("user_id,email,full_name,permissions,active,created_at,updated_at").single();
      if (error) throw new Error(error.message);
      await audit(admin, user.id, "account_updated", data.email, userId, { permissions, active });
      return json({ account: data });
    }

    if (action === "password_reset") {
      const targetUserId = String(body.user_id ?? "");
      const { data: target, error: targetError } = await admin
        .from("admin_accounts")
        .select("user_id,email,active")
        .eq("user_id", targetUserId)
        .maybeSingle();
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
    console.error('[admin-access]', error instanceof Error ? error.message : String(error));
    return json({ error: error instanceof Error ? error.message : String(error) }, 500);
  }
});
