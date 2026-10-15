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
  subscription: HotmartSubscription | null;
  productId: string;
  source: "hotmart";
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
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").trim().toLowerCase();
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
      if (eligible) return { subscription: eligible, productId, source: "hotmart" as const };
      pageToken = payload.page_info?.next_page_token ?? null;
      if (!pageToken) break;
    }
  }
  return { subscription: null, productId: productIds[0], source: "hotmart" as const };
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

async function saveEligibility(
  admin: ReturnType<typeof serviceClient>,
  email: string,
  subscription: HotmartSubscription,
  productId: string,
) {
  const cohort = extractHotmartCohort(subscription);
  if (cohort) {
    const { error } = await admin.from("hotmart_cohort_roster").upsert({
      cohort_number: cohort.cohortNumber,
      email,
      full_name: subscription.subscriber?.name?.trim() || null,
      external_student_id: subscription.subscriber?.ucode ?? subscription.subscriber_code ?? (subscription.subscription_id == null ? null : String(subscription.subscription_id)),
      subscription_status: subscription.status?.toUpperCase() ?? "ACTIVE",
      plan_name: subscription.plan?.name ?? null,
      product_id: String(subscription.product?.id ?? productId),
      active: true,
      synced_at: new Date().toISOString(),
    }, { onConflict: "cohort_number,email" });
    if (error) throw new Error(`Falha ao registrar elegibilidade: ${error.message}`);
  }
  return cohort;
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

    let lookup: EligibilityLookup;
    try {
      lookup = await liveEligibleSubscription(email);
    } catch {
      return json({ error: "hotmart_unavailable", message: "Não foi possível confirmar a assinatura na Hotmart." }, 503);
    }

    if (!lookup.subscription) {
      if (currentUser) await admin.from("profiles").update({ subscription_status: "inactive" }).eq("id", currentUser.id);
      return json({ error: "subscription_not_eligible", message: "Assinatura sem acesso liberado." }, 403);
    }

    const cohort = await saveEligibility(admin, email, lookup.subscription, lookup.productId);
    if (currentUser) {
      await activateProfile(admin, currentUser, lookup.subscription, cohort?.cohortNumber ?? null);
      return json({ status: "validated", source: lookup.source });
    }

    return json({
      status: "eligible",
      source: lookup.source,
      full_name: lookup.subscription.subscriber?.name?.trim() || email.split("@")[0],
      cohort_number: cohort?.cohortNumber ?? null,
    });
  } catch (error) {
    console.error("student-access", error);
    return json({ error: "student_access_failed", message: "Não foi possível validar o acesso." }, 500);
  }
});
