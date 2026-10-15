import { createClient } from "@supabase/supabase-js";
import { extractHotmartCohort } from "../hotmart-auth/cohort.ts";

type SyncRequest = {
  action?: "sync" | "cohorts";
  group_id?: string;
  force?: boolean;
  run_id?: string;
};
type SyncRun = {
  id: string;
  requested_by: string;
  action: "sync" | "cohorts";
  group_id: string | null;
  product_id: string;
  status: "collecting" | "awaiting_confirmation" | "completed" | "failed";
  next_page_token: string | null;
  seen_page_tokens: string[];
  pages: number;
  fetched: number;
};
type HotmartSubscription = {
  subscriber_code?: string;
  subscription_id?: number | string;
  status?: string;
  plan?: { name?: string; id?: number | string };
  product?: { id?: number | string; name?: string };
  subscriber?: { name?: string; email?: string; ucode?: string };
};
type HotmartProduct = { id?: number | string; ucode?: string; name?: string };
type HotmartPlan = { code?: string; name?: string };
type CohortPlan = { cohort_number: number; plan_name: string; plan_code: string | null; product_name: string };

const DEFAULT_ACCESS_PRODUCT_NAMES = [
  "Casa de Isabel - Ensino e cuidado",
  "Casa de Isabel - Tornando-se uma mentora",
];

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, { status, headers: { ...corsHeaders, "Cache-Control": "no-store" } });
}

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} não configurada`);
  return value;
}

function integerEnv(name: string, fallback: number, minimum: number, maximum: number) {
  const parsed = Number.parseInt(Deno.env.get(name)?.trim() || "", 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(maximum, Math.max(minimum, parsed));
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function fetchWithTimeout(input: string | URL, init: RequestInit, timeoutMs = 25_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`A Hotmart não respondeu em ${Math.round(timeoutMs / 1000)} segundos. Tente novamente.`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function requireStaff(req: Request) {
  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) {
    throw new Response(JSON.stringify({ error: "missing_authorization" }), { status: 401 });
  }
  const supabaseUrl = requiredEnv("SUPABASE_URL");
  const anon = createClient(supabaseUrl, requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data: userData, error: userError } = await anon.auth.getUser();
  if (userError || !userData.user) throw new Response(JSON.stringify({ error: "invalid_session" }), { status: 401 });
  const admin = serviceClient();
  const { data: profile, error: profileError } = await admin.from("profiles").select("role").eq("id", userData.user.id).maybeSingle();
  if (profileError || !profile || !["admin", "support"].includes(profile.role)) {
    throw new Response(JSON.stringify({ error: "staff_required" }), { status: 403 });
  }
  return { admin, userId: userData.user.id };
}

async function hotmartAccessToken() {
  const clientId = requiredEnv("HOTMART_CLIENT_ID");
  const clientSecret = requiredEnv("HOTMART_CLIENT_SECRET");
  const basicToken = requiredEnv("HOTMART_BASIC_TOKEN");
  const url = new URL("https://api-sec-vlc.hotmart.com/security/oauth/token");
  url.searchParams.set("grant_type", "client_credentials");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("client_secret", clientSecret);
  const response = await fetchWithTimeout(url, {
    method: "POST",
    headers: { Authorization: `Basic ${basicToken.replace(/^Basic\s+/i, "")}`, "Content-Type": "application/json" },
  }, 15_000);
  if (!response.ok) throw new Error(`Hotmart OAuth falhou (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("Hotmart OAuth não retornou access_token");
  return payload.access_token;
}

function configuredStatuses() {
  const raw = Deno.env.get("HOTMART_ROSTER_STATUSES") ?? "ACTIVE,DELAYED,OVERDUE";
  return [...new Set(raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean))];
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
  return new Set(raw.split(",").map((value) => value.trim()).filter(Boolean));
}

async function fetchAccessProducts(accessToken: string) {
  const configuredIds = configuredProductIds();
  const configuredNames = Deno.env.get("HOTMART_ACCESS_PRODUCT_NAMES")
    ?.split("|")
    .map((value) => value.trim())
    .filter(Boolean);
  const acceptedNames = new Set((configuredNames?.length ? configuredNames : DEFAULT_ACCESS_PRODUCT_NAMES).map(normalizedProductName));
  const products = new Map<string, { id: string; name: string }>();
  let pageToken: string | null = null;
  for (let page = 0; page < 20; page += 1) {
    const url = new URL("https://developers.hotmart.com/products/api/v1/products");
    url.searchParams.set("max_results", "50");
    if (pageToken) url.searchParams.set("page_token", pageToken);
    const response = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
    }, 20_000);
    if (!response.ok) throw new Error(`Hotmart produtos falhou (${response.status}): ${(await response.text()).slice(0, 500)}`);
    const payload = await response.json() as { items?: HotmartProduct[]; page_info?: { next_page_token?: string | null } };
    for (const product of payload.items ?? []) {
      if (product.id == null) continue;
      const id = String(product.id);
      const name = product.name?.trim() || `Produto ${id}`;
      if (configuredIds.has(id) || acceptedNames.has(normalizedProductName(name))) products.set(id, { id, name });
    }
    pageToken = payload.page_info?.next_page_token ?? null;
    if (!pageToken) break;
  }
  for (const id of configuredIds) {
    if (!products.has(id)) products.set(id, { id, name: `Produto ${id}` });
  }
  if (!products.size) throw new Error("Nenhum produto de acesso da Casa de Isabel foi encontrado.");
  return [...products.values()];
}

async function fetchProductUcode(accessToken: string, productId: string) {
  const configured = Deno.env.get("HOTMART_PRODUCT_UCODE")?.trim();
  const legacyProductId = Deno.env.get("HOTMART_PRODUCT_ID")?.trim();
  if (configured && legacyProductId === productId) return configured;
  const url = new URL("https://developers.hotmart.com/products/api/v1/products");
  url.searchParams.set("id", productId);
  url.searchParams.set("max_results", "50");
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  }, 20_000);
  if (!response.ok) throw new Error(`Hotmart produtos falhou (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as { items?: HotmartProduct[] };
  const product = (payload.items ?? []).find((item) => String(item.id ?? "") === productId) ?? payload.items?.[0];
  if (!product?.ucode) throw new Error("A Hotmart não retornou o identificador UUID do produto.");
  return product.ucode;
}

async function fetchCohortPlans(accessToken: string, productId: string, productName: string) {
  const productUcode = await fetchProductUcode(accessToken, productId);
  const url = new URL(`https://developers.hotmart.com/products/api/v1/products/${encodeURIComponent(productUcode)}/plans`);
  url.searchParams.set("max_results", "500");
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  }, 20_000);
  if (!response.ok) throw new Error(`Hotmart planos falhou (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as { items?: HotmartPlan[]; page_info?: { next_page_token?: string | null } };
  if (payload.page_info?.next_page_token) throw new Error("O produto possui mais de 500 planos. Contate o suporte para ampliar a paginação do catálogo.");
  const plans = new Map<string, CohortPlan>();
  for (const plan of payload.items ?? []) {
    const planName = plan.name?.trim();
    if (!planName) continue;
    const cohort = extractHotmartCohort({ plan: { name: planName } });
    if (!cohort) continue;
    plans.set(planName, {
      cohort_number: cohort.cohortNumber,
      plan_name: planName,
      plan_code: plan.code?.trim() || null,
      product_name: productName,
    });
  }
  if (!plans.size) throw new Error("Nenhuma turma no formato T## foi encontrada nos nomes dos planos da Hotmart.");
  return [...plans.values()];
}

async function refreshCohortCatalog(admin: ReturnType<typeof serviceClient>, accessToken: string, productId: string, productName: string) {
  const plans = await fetchCohortPlans(accessToken, productId, productName);
  const syncedAt = new Date().toISOString();
  const { error: deactivateError } = await admin.from("hotmart_cohort_plans").update({ active: false, synced_at: syncedAt }).eq("product_id", productId);
  if (deactivateError) throw new Error(`Falha ao atualizar o catálogo de turmas: ${deactivateError.message}`);
  const { error: upsertError } = await admin.from("hotmart_cohort_plans").upsert(plans.map((plan) => ({
    product_id: productId,
    ...plan,
    active: true,
    synced_at: syncedAt,
  })), { onConflict: "product_id,plan_name" });
  if (upsertError) throw new Error(`Falha ao salvar as turmas da Hotmart: ${upsertError.message}`);
  const cohorts = [...new Set(plans.map((plan) => plan.cohort_number))].sort((left, right) => left - right);
  return { plans, cohorts };
}

async function groupCohortPlans(admin: ReturnType<typeof serviceClient>, groupId: string | null, productId: string) {
  if (!groupId) throw new Error("Selecione um grupo para sincronizar somente os alunos da turma correspondente.");
  const { data: group, error: groupError } = await admin.from("student_groups").select("cohort_number,product_id").eq("id", groupId).maybeSingle();
  if (groupError || !group?.cohort_number || !group.product_id) throw new Error("Grupo sem produto ou turma definidos.");
  if (String(group.product_id) !== productId) throw new Error("O grupo pertence a outro produto da Hotmart.");
  const cohortNumber = Number(group.cohort_number);
  const { data: plans, error: plansError } = await admin.from("hotmart_cohort_plans").select("plan_name").eq("product_id", productId).eq("cohort_number", cohortNumber).eq("active", true);
  if (plansError) throw new Error(`Falha ao consultar os planos da turma: ${plansError.message}`);
  const planNames = [...new Set((plans ?? []).map((plan) => String(plan.plan_name).trim()).filter(Boolean))];
  if (!planNames.length) throw new Error(`A Turma ${cohortNumber} não está no catálogo atual. Clique em “Atualizar turmas” antes de sincronizar os alunos.`);
  return { cohortNumber, planNames };
}

async function fetchSubscriptionPage(accessToken: string, productId: string, planNames: string[], pageToken?: string) {
  const statuses = configuredStatuses();
  const url = new URL("https://developers.hotmart.com/payments/api/v1/subscriptions");
  url.searchParams.set("product_id", productId);
  url.searchParams.set("max_results", String(integerEnv("HOTMART_ROSTER_PAGE_SIZE", 100, 25, 200)));
  url.searchParams.set("accession_date", Deno.env.get("HOTMART_ROSTER_ACCESSION_DATE")?.trim() || "0");
  for (const status of statuses) url.searchParams.append("status", status);
  for (const planName of planNames) url.searchParams.append("plan", planName);
  if (pageToken) url.searchParams.set("page_token", pageToken);
  const response = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${accessToken}`, "Content-Type": "application/json" },
  }, integerEnv("HOTMART_REQUEST_TIMEOUT_MS", 35_000, 10_000, 40_000));
  if (!response.ok) throw new Error(`Hotmart subscriptions falhou (${response.status}): ${(await response.text()).slice(0, 500)}`);
  const payload = await response.json() as { items?: HotmartSubscription[]; page_info?: { next_page_token?: string | null } };
  return { items: payload.items ?? [], nextPageToken: payload.page_info?.next_page_token || null, statuses };
}

function buildRoster(subscriptions: HotmartSubscription[], productId: string, syncedAt: string) {
  const deduplicated = new Map<string, Record<string, unknown>>();
  for (const item of subscriptions) {
    const email = item.subscriber?.email?.trim().toLowerCase();
    const cohort = extractHotmartCohort(item);
    if (!email || !cohort) continue;
    const key = `${cohort.cohortNumber}:${email}`;
    deduplicated.set(key, {
      cohort_number: cohort.cohortNumber,
      email,
      full_name: item.subscriber?.name?.trim() || null,
      external_student_id: item.subscriber?.ucode ?? item.subscriber_code ?? (item.subscription_id == null ? null : String(item.subscription_id)),
      subscription_status: item.status?.toUpperCase() ?? null,
      plan_name: item.plan?.name ?? null,
      product_id: String(item.product?.id ?? productId),
      active: true,
      synced_at: syncedAt,
    });
  }
  return [...deduplicated.values()];
}

async function loadRunRoster(admin: ReturnType<typeof serviceClient>, runId: string) {
  const roster: Record<string, unknown>[] = [];
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.from("hotmart_roster_sync_rows").select("payload").eq("run_id", runId).range(offset, offset + 999);
    if (error) throw new Error(`Falha ao montar o lote Hotmart: ${error.message}`);
    roster.push(...(data ?? []).map((row) => row.payload as Record<string, unknown>));
    if ((data ?? []).length < 1000) break;
  }
  return roster;
}

async function activeRosterCount(admin: ReturnType<typeof serviceClient>, productId: string) {
  const { count, error } = await admin.from("hotmart_cohort_roster").select("email", { count: "exact", head: true }).eq("product_id", productId).eq("active", true);
  if (error) throw new Error(`Falha ao conferir roster anterior: ${error.message}`);
  return count ?? 0;
}

async function activeRosterCohortCounts(admin: ReturnType<typeof serviceClient>, productId: string) {
  const counts = new Map<number, number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin.from("hotmart_cohort_roster").select("cohort_number,email").eq("product_id", productId).eq("active", true).range(offset, offset + 999);
    if (error) throw new Error(`Falha ao conferir turmas anteriores: ${error.message}`);
    for (const row of data ?? []) counts.set(Number(row.cohort_number), (counts.get(Number(row.cohort_number)) ?? 0) + 1);
    if ((data ?? []).length < 1000) break;
  }
  return counts;
}

async function reconcileSnapshot(admin: ReturnType<typeof serviceClient>, productId: string, roster: Record<string, unknown>[], syncedAt: string, groupId?: string | null) {
  const { data, error } = await admin.rpc("reconcile_hotmart_roster_snapshot", {
    p_product_id: productId,
    p_rows: roster,
    p_synced_at: syncedAt,
    p_group_id: groupId ?? null,
  });
  if (error) throw new Error(`A reconciliação Hotmart foi revertida: ${error.message}`);
  const result = (data ?? {}) as { deactivated?: number; groups?: number; invitations?: number };
  return { deactivated: Number(result.deactivated ?? 0), groups: Number(result.groups ?? 0), invitations: Number(result.invitations ?? 0) };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  let activeRunId: string | null = null;
  try {
    const { admin, userId } = await requireStaff(req);
    const input = await req.json().catch(() => ({})) as SyncRequest;
    const requestedAction = input.action ?? "sync";
    if (!new Set(["sync", "cohorts"]).has(requestedAction)) return json({ error: "invalid_action" }, 400);

    if (requestedAction === "cohorts") {
      const accessToken = await hotmartAccessToken();
      const products = await fetchAccessProducts(accessToken);
      const catalogs = [];
      for (const product of products) {
        const catalog = await refreshCohortCatalog(admin, accessToken, product.id, product.name);
        catalogs.push({ product, catalog });
      }
      return json({
        status: "completed",
        cohorts: catalogs.flatMap(({ product, catalog }) => catalog.cohorts.map((cohort_number) => ({
          product_id: product.id,
          product_name: product.name,
          cohort_number,
          plan_count: catalog.plans.filter((plan) => plan.cohort_number === cohort_number).length,
        }))),
        plans: catalogs.reduce((total, entry) => total + entry.catalog.plans.length, 0),
        products: products.length,
      });
    }

    let run: SyncRun;
    if (input.run_id) {
      const { data, error } = await admin.from("hotmart_roster_sync_runs").select("*").eq("id", input.run_id).eq("requested_by", userId).maybeSingle();
      if (error || !data) return json({ error: "sync_run_not_found", message: "Sincronização não encontrada ou expirada." }, 404);
      run = data as SyncRun;
    } else {
      if (!input.group_id) return json({ error: "group_required", message: "Selecione um grupo para sincronizar os alunos da turma." }, 400);
      const { data: targetGroup, error: targetGroupError } = await admin.from("student_groups").select("product_id").eq("id", input.group_id).maybeSingle();
      if (targetGroupError || !targetGroup?.product_id) return json({ error: "group_product_required", message: "Defina o produto da Hotmart deste grupo." }, 400);
      const productId = String(targetGroup.product_id);
      await admin.from("hotmart_roster_sync_runs").delete().eq("requested_by", userId).lt("started_at", new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString());
      const { data, error } = await admin.from("hotmart_roster_sync_runs").insert({
        requested_by: userId,
        action: requestedAction,
        group_id: input.group_id ?? null,
        product_id: productId,
      }).select("*").single();
      if (error || !data) throw new Error(`Não foi possível iniciar a sincronização: ${error?.message ?? "erro desconhecido"}`);
      run = data as SyncRun;
    }
    activeRunId = run.id;

    if (run.status === "completed") return json({ status: "completed", run_id: run.id, fetched: run.fetched, eligible: 0 });
    if (run.status === "failed") return json({ error: "sync_run_failed", message: "A sincronização anterior falhou. Inicie novamente." }, 409);

    if (run.status === "collecting") {
      if (run.pages >= 500) throw new Error("A Hotmart excedeu o limite seguro de 500 páginas. Revise o produto e os filtros.");
      const currentToken = run.pages > 0 ? run.next_page_token || undefined : undefined;
      if (currentToken && run.seen_page_tokens.includes(currentToken)) throw new Error("A Hotmart repetiu o cursor de paginação e a sincronização foi interrompida com segurança.");
      const cohort = await groupCohortPlans(admin, run.group_id, run.product_id);
      const accessToken = await hotmartAccessToken();
      const page = await fetchSubscriptionPage(accessToken, run.product_id, cohort.planNames, currentToken);
      const syncedAt = new Date().toISOString();
      const pageRoster = buildRoster(page.items, run.product_id, syncedAt).filter((row) => Number(row.cohort_number) === cohort.cohortNumber);
      if (pageRoster.length) {
        const { error } = await admin.from("hotmart_roster_sync_rows").upsert(pageRoster.map((payload) => ({
          run_id: run.id,
          cohort_number: payload.cohort_number,
          email: payload.email,
          payload,
        })), { onConflict: "run_id,cohort_number,email" });
        if (error) throw new Error(`Falha ao salvar uma página da Hotmart: ${error.message}`);
      }
      const seen = currentToken ? [...run.seen_page_tokens, currentToken] : run.seen_page_tokens;
      if (page.nextPageToken && (page.nextPageToken === currentToken || seen.includes(page.nextPageToken))) {
        throw new Error("A Hotmart devolveu um cursor de paginação repetido.");
      }
      const pages = run.pages + 1;
      const fetched = run.fetched + page.items.length;
      const { error: updateError } = await admin.from("hotmart_roster_sync_runs").update({
        next_page_token: page.nextPageToken,
        seen_page_tokens: seen,
        pages,
        fetched,
        updated_at: new Date().toISOString(),
      }).eq("id", run.id);
      if (updateError) throw new Error(`Falha ao atualizar o progresso: ${updateError.message}`);
      run = { ...run, next_page_token: page.nextPageToken, seen_page_tokens: seen, pages, fetched };
      if (page.nextPageToken) {
        return json({ status: "collecting", run_id: run.id, pages, fetched, page_eligible: pageRoster.length });
      }
    }

    const roster = await loadRunRoster(admin, run.id);
    const cohortCounts = new Map<number, number>();
    for (const row of roster) cohortCounts.set(Number(row.cohort_number), (cohortCounts.get(Number(row.cohort_number)) ?? 0) + 1);
    const cohorts = [...cohortCounts.entries()].sort(([left], [right]) => left - right).map(([cohort_number, student_count]) => ({ cohort_number, student_count }));
    const [previousActiveGlobal, previousCohorts] = await Promise.all([
      activeRosterCount(admin, run.product_id),
      activeRosterCohortCounts(admin, run.product_id),
    ]);
    let targetCohort: number | undefined;
    if (run.group_id) {
      const { data: group, error } = await admin.from("student_groups").select("cohort_number").eq("id", run.group_id).maybeSingle();
      if (error) throw new Error(`Falha ao buscar a turma do grupo: ${error.message}`);
      if (!group?.cohort_number) throw new Error("Grupo ou turma não encontrado");
      targetCohort = Number(group.cohort_number);
    }
    const scopedRoster = targetCohort == null ? roster : roster.filter((row) => Number(row.cohort_number) === targetCohort);
    const previousActive = targetCohort == null ? previousActiveGlobal : previousCohorts.get(targetCohort) ?? 0;
    const abnormalDrop = scopedRoster.length === 0 || (previousActive >= 10 && scopedRoster.length < Math.ceil(previousActive * 0.25));
    const cohortEntries = targetCohort == null ? [...previousCohorts.entries()] : [[targetCohort, previousActive] as [number, number]];
    const abnormalCohorts = cohortEntries.flatMap(([cohort, previous]) => {
      const current = cohortCounts.get(cohort) ?? 0;
      return current === 0 || (previous >= 5 && current < Math.ceil(previous * 0.25)) ? [{ cohort_number: cohort, previous, current }] : [];
    });
    if ((abnormalDrop || abnormalCohorts.length > 0) && !input.force) {
      await admin.from("hotmart_roster_sync_runs").update({ status: "awaiting_confirmation", eligible: scopedRoster.length, updated_at: new Date().toISOString() }).eq("id", run.id);
      return json({
        error: "roster_confirmation_required",
        message: abnormalCohorts.length
          ? `A Hotmart retornou uma queda anormal em ${abnormalCohorts.length} turma(s). Revise os planos T## e confirme a reconciliação manualmente.`
          : `A Hotmart retornou uma queda anormal no roster (${previousActive} → ${scopedRoster.length}).`,
        run_id: run.id,
        previous_active: previousActive,
        eligible: scopedRoster.length,
        affected_cohorts: abnormalCohorts,
      }, 409);
    }

    const reconciliation = await reconcileSnapshot(admin, run.product_id, roster, new Date().toISOString(), run.group_id);
    await admin.from("hotmart_roster_sync_runs").update({ status: "completed", eligible: roster.length, completed_at: new Date().toISOString(), updated_at: new Date().toISOString() }).eq("id", run.id);
    await admin.from("hotmart_roster_sync_rows").delete().eq("run_id", run.id);
    return json({
      status: "synced",
      run_id: run.id,
      synced: scopedRoster.length,
      cohorts,
      fetched: run.fetched,
      eligible: scopedRoster.length,
      deactivated: reconciliation.deactivated,
      statuses: configuredStatuses(),
      groups: reconciliation.groups,
      invitations: reconciliation.invitations,
      forced: Boolean(input.force && (abnormalDrop || abnormalCohorts.length > 0)),
    });
  } catch (error) {
    if (error instanceof Response) return new Response(error.body, { status: error.status, headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" } });
    const message = error instanceof Error ? error.message : String(error);
    if (activeRunId) {
      try {
        await serviceClient().from("hotmart_roster_sync_runs").update({ status: "failed", error: message.slice(0, 1000), updated_at: new Date().toISOString() }).eq("id", activeRunId);
      } catch {
        // The original error is more useful than a secondary audit failure.
      }
    }
    return json({ error: "hotmart_roster_sync_failed", message }, 500);
  }
});
