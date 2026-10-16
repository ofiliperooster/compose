import { createClient, type User } from "@supabase/supabase-js";
import { extractHotmartCohort } from "../hotmart-auth/cohort.ts";

type AccessRequest = { email?: string };
type HotmartSubscription = {
  status?: string;
  subscriber_code?: string;
  subscription_id?: number | string;
  subscriber?: { email?: string; name?: string; ucode?: string };
  plan?: { name?: string };
  product?: { id?: number | string };
};
type HotmartProduct = {
  id?: number | string;
  name?: string;
};
type EligibilityLookup = {
  matches: Array<{ subscription: HotmartSubscription; productId: string }>;
  productIds: string[];
  source: "hotmart";
};
type ManualAccessGrant = {
  email: string;
  product_id: string;
  cohort_number: number;
  full_name: string | null;
};

const ACCESS_STATUSES = ["ACTIVE", "DELAYED", "OVERDUE"] as const;
const DEFAULT_ACCESS_PRODUCT_NAMES = [
  "Casa de Isabel - Ensino e cuidado",
  "Casa de Isabel - Tornando-se uma mentora",
];
let accessProductCache: { ids: string[]; expiresAt: number } | null = null;
const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} não configurada`);
  return value;
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function hotmartAccessToken() {
  const url = new URL("https://api-sec-vlc.hotmart.com/security/oauth/token");
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", requiredEnv("HOTMART_CLIENT_ID"));
  url.searchParams.set("client_secret", requiredEnv("HOTMART_CLIENT_SECRET"));
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${requiredEnv("HOTMART_BASIC_TOKEN").replace(/^Basic\s+/i, "")}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) throw new Error(`Hotmart OAuth ${response.status}`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("Hotmart OAuth sem access_token");
  return payload.access_token;
}

function normalizedProductName(value: string) {
  return value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

function configuredProductIds() {
  const raw = [
    Deno.env.get("HOTMART_ACCESS_PRODUCT_IDS"),
    Deno.env.get("HOTMART_PRODUCT_IDS"),
    Deno.env.get("HOTMART_PRODUCT_ID"),
  ].filter(Boolean).join(",");
  return [...new Set(raw.split(",").map((value) => value.trim()).filter(Boolean))];
}

async function accessProductIds(accessToken: string) {
  if (accessProductCache && accessProductCache.expiresAt > Date.now()) return accessProductCache.ids;

  const ids = new Set(configuredProductIds());
  const configuredNames = Deno.env.get("HOTMART_ACCESS_PRODUCT_NAMES")
    ?.split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  const acceptedNames = new Set((configuredNames?.length ? configuredNames : DEFAULT_ACCESS_PRODUCT_NAMES).map(normalizedProductName));
  let pageToken: string | null = null;

  for (let page = 0; page < 20; page += 1) {
    const url = new URL("https://developers.hotmart.com/products/api/v1/products");
    url.searchParams.set("max_results", "50");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    });
    if (!response.ok) throw new Error(`Hotmart products ${response.status}`);
    const payload = await response.json() as {
      items?: HotmartProduct[];
      page_info?: { next_page_token?: string | null };
    };
    for (const product of payload.items ?? []) {
      if (product.id != null && product.name && acceptedNames.has(normalizedProductName(product.name))) {
        ids.add(String(product.id));
      }
    }
    pageToken = payload.page_info?.next_page_token ?? null;
    if (!pageToken) break;
  }

  const resolved = [...ids];
  if (!resolved.length) throw new Error("Nenhum produto de acesso da Casa de Isabel foi encontrado");
  accessProductCache = { ids: resolved, expiresAt: Date.now() + 10 * 60 * 1000 };
  return resolved;
}

async function liveEligibleSubscription(email: string): Promise<EligibilityLookup> {
  const accessToken = await hotmartAccessToken();
  const productIds = await accessProductIds(accessToken);
  const matches: EligibilityLookup["matches"] = [];
  for (const productId of productIds) {
    let pageToken: string | null = null;
    for (let page = 0; page < 10; page += 1) {
      const url = new URL("https://developers.hotmart.com/payments/api/v1/subscriptions");
      url.searchParams.set("product_id", productId);
      url.searchParams.set("subscriber_email", email);
      url.searchParams.set("accession_date", "0");
      url.searchParams.set("max_results", "100");
      for (const status of ACCESS_STATUSES) url.searchParams.append("status", status);
      if (pageToken) url.searchParams.set("page_token", pageToken);
      const response = await fetchWithTimeout(url, {
        headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
      });
      if (!response.ok) throw new Error(`Hotmart subscriptions ${response.status}`);
      const payload = await response.json() as {
        items?: HotmartSubscription[];
        page_info?: { next_page_token?: string | null };
      };
      const eligible = (payload.items ?? []).find((item) =>
        item.subscriber?.email?.trim().toLowerCase() === email &&
        ACCESS_STATUSES.includes((item.status?.toUpperCase() ?? "") as typeof ACCESS_STATUSES[number])
      );
      if (eligible) {
        matches.push({ subscription: eligible, productId });
        break;
      }
      pageToken = payload.page_info?.next_page_token ?? null;
      if (!pageToken) break;
    }
  }
  return { matches, productIds, source: "hotmart" as const };
}

async function authenticatedUser(req: Request): Promise<User | null> {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) return null;
  const client = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await client.auth.getUser();
  return error ? null : data.user;
}

async function manualAccessGrants(
  admin: ReturnType<typeof serviceClient>,
  email: string,
): Promise<ManualAccessGrant[]> {
  const { data, error } = await admin
    .from("manual_access_grants")
    .select("email,product_id,cohort_number,full_name")
    .eq("email", email)
    .eq("active", true)
    .order("updated_at", { ascending: false });
  if (error) throw new Error(`Falha ao consultar liberação manual: ${error.message}`);
  return (data ?? []) as ManualAccessGrant[];
}

async function activateManualProfile(
  admin: ReturnType<typeof serviceClient>,
  user: User,
  grant: ManualAccessGrant,
) {
  const { data: profile, error: profileError } = await admin.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (profileError) throw new Error(profileError.message);
  const values = {
    full_name: grant.full_name?.trim() || user.user_metadata?.full_name || user.email?.split("@")[0] || "Aluno(a)",
    subscription_status: "active",
    cohort_number: grant.cohort_number,
  };
  const response = profile
    ? await admin.from("profiles").update(values).eq("id", user.id)
    : await admin.from("profiles").insert({ id: user.id, role: "student", ...values });
  if (response.error) throw new Error(`Falha ao liberar o perfil manual: ${response.error.message}`);
}

async function saveEligibility(
  admin: ReturnType<typeof serviceClient>,
  email: string,
  subscription: HotmartSubscription,
  productId: string,
) {
  const cohort = extractHotmartCohort(subscription);
  if (cohort) {
    const resolvedProductId = String(subscription.product?.id ?? productId);
    const { error } = await admin.from("hotmart_cohort_roster").upsert({
      cohort_number: cohort.cohortNumber,
      email,
      full_name: subscription.subscriber?.name?.trim() || null,
      external_student_id: subscription.subscriber?.ucode ?? subscription.subscriber_code ?? (subscription.subscription_id == null ? null : String(subscription.subscription_id)),
      subscription_status: subscription.status?.toUpperCase() ?? "ACTIVE",
      plan_name: subscription.plan?.name ?? null,
      product_id: resolvedProductId,
      active: true,
      synced_at: new Date().toISOString(),
    }, { onConflict: "product_id,cohort_number,email" });
    if (error) throw new Error(`Falha ao registrar elegibilidade: ${error.message}`);

    const { data: groups, error: groupsError } = await admin
      .from("student_groups")
      .select("id")
      .eq("product_id", resolvedProductId)
      .eq("cohort_number", cohort.cohortNumber);
    if (groupsError) throw new Error(`Falha ao localizar o grupo da assinatura: ${groupsError.message}`);
    for (const group of groups ?? []) {
      const { error: syncError } = await admin.rpc("sync_group_from_cohort_roster", { p_group_id: group.id });
      if (syncError) throw new Error(`Falha ao vincular a aluna ao grupo: ${syncError.message}`);
    }
  }
  return cohort;
}

async function revokeIneligibleProductAccess(
  admin: ReturnType<typeof serviceClient>,
  email: string,
  allProductIds: string[],
  eligibleProductIds: string[],
  currentUser: User | null,
) {
  const eligible = new Set(eligibleProductIds);
  const ineligibleProductIds = allProductIds.filter((productId) => !eligible.has(productId));
  if (!ineligibleProductIds.length) return;

  const syncedAt = new Date().toISOString();
  const { error: rosterError } = await admin
    .from("hotmart_cohort_roster")
    .update({ active: false, synced_at: syncedAt })
    .eq("email", email)
    .in("product_id", ineligibleProductIds);
  if (rosterError) throw new Error(`Falha ao revogar produto sem assinatura: ${rosterError.message}`);

  const { data: groups, error: groupsError } = await admin
    .from("student_groups")
    .select("id")
    .in("product_id", ineligibleProductIds);
  if (groupsError) throw new Error(`Falha ao consultar grupos por produto: ${groupsError.message}`);
  const groupIds = (groups ?? []).map((group) => String(group.id));
  if (!groupIds.length) return;

  const { error: invitationsError } = await admin
    .from("student_group_invitations")
    .update({ status: "inactive", matched_user_id: null, matched_at: null })
    .eq("email", email)
    .in("group_id", groupIds);
  if (invitationsError) throw new Error(`Falha ao revogar convites por produto: ${invitationsError.message}`);

  if (currentUser) {
    const { error: membershipsError } = await admin
      .from("student_group_members")
      .delete()
      .eq("user_id", currentUser.id)
      .in("group_id", groupIds);
    if (membershipsError) throw new Error(`Falha ao revogar grupos por produto: ${membershipsError.message}`);
  }
}

async function activateProfile(
  admin: ReturnType<typeof serviceClient>,
  user: User,
  subscription: HotmartSubscription,
  cohortNumber: number | null,
) {
  const { data: profile, error: profileError } = await admin.from("profiles").select("id").eq("id", user.id).maybeSingle();
  if (profileError) throw new Error(profileError.message);
  const values = {
    full_name: subscription.subscriber?.name?.trim() || user.user_metadata?.full_name || user.email?.split("@")[0] || "Aluno(a)",
    subscription_status: "active",
    ...(cohortNumber ? { cohort_number: cohortNumber } : {}),
  };
  const response = profile
    ? await admin.from("profiles").update(values).eq("id", user.id)
    : await admin.from("profiles").insert({ id: user.id, role: "student", cohort_number: cohortNumber ?? 11, ...values });
  if (response.error) throw new Error(`Falha ao liberar o perfil: ${response.error.message}`);
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const input = await req.json().catch(() => ({})) as AccessRequest;
    const email = input.email?.trim().toLowerCase() ?? "";
    if (!/^\S+@\S+\.\S+$/.test(email)) return json({ error: "invalid_email", message: "E-mail inválido." }, 400);

    const admin = serviceClient();
    const currentUser = await authenticatedUser(req);
    if (currentUser?.email?.trim().toLowerCase() !== email && currentUser) {
      return json({ error: "email_mismatch", message: "O e-mail não corresponde à sessão atual." }, 403);
    }

    const manualGrants = await manualAccessGrants(admin, email);
    if (manualGrants.length) {
      const primary = manualGrants[0];
      if (currentUser) {
        await activateManualProfile(admin, currentUser, primary);
        return json({
          status: "validated",
          source: "manual",
          product_ids: manualGrants.map((grant) => grant.product_id),
        });
      }
      return json({
        status: "eligible",
        source: "manual",
        full_name: primary.full_name?.trim() || email.split("@")[0],
        cohort_number: primary.cohort_number,
        product_ids: manualGrants.map((grant) => grant.product_id),
      });
    }

    let lookup: EligibilityLookup;
    try {
      lookup = await liveEligibleSubscription(email);
    } catch {
      return json({ error: "hotmart_unavailable", message: "Não foi possível confirmar a assinatura na Hotmart." }, 503);
    }

    if (!lookup.matches.length) {
      await revokeIneligibleProductAccess(admin, email, lookup.productIds, [], currentUser);
      if (currentUser) await admin.from("profiles").update({ subscription_status: "inactive" }).eq("id", currentUser.id);
      return json({ error: "subscription_not_eligible", message: "Assinatura sem acesso liberado." }, 403);
    }

    const saved = await Promise.all(lookup.matches.map(async (match) => ({
      ...match,
      cohort: await saveEligibility(admin, email, match.subscription, match.productId),
    })));
    await revokeIneligibleProductAccess(
      admin,
      email,
      lookup.productIds,
      saved.map((match) => match.productId),
      currentUser,
    );
    const primary = saved[0];
    if (currentUser) {
      await activateProfile(admin, currentUser, primary.subscription, primary.cohort?.cohortNumber ?? null);
      return json({
        status: "validated",
        source: lookup.source,
        product_ids: saved.map((match) => match.productId),
      });
    }

    return json({
      status: "eligible",
      source: lookup.source,
      full_name: primary.subscription.subscriber?.name?.trim() || email.split("@")[0],
      cohort_number: primary.cohort?.cohortNumber ?? null,
      product_ids: saved.map((match) => match.productId),
    });
  } catch (error) {
    console.error("student-access", error);
    return json({ error: "student_access_failed", message: "Não foi possível validar o acesso." }, 500);
  }
});
