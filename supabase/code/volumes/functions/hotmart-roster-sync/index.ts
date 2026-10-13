import { createClient } from "@supabase/supabase-js";
import { extractHotmartCohort } from "../hotmart-auth/cohort.ts";

type SyncRequest = {
  action?: "sync" | "cohorts";
  group_id?: string;
  force?: boolean;
};

type HotmartSubscription = {
  subscriber_code?: string;
  subscription_id?: number | string;
  status?: string;
  plan?: { name?: string; id?: number | string };
  product?: { id?: number | string; name?: string };
  subscriber?: { name?: string; email?: string; ucode?: string };
};

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
};

function json(body: Record<string, unknown>, status = 200) {
  return Response.json(body, {
    status,
    headers: { ...corsHeaders, "Cache-Control": "no-store" },
  });
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
  if (userError || !userData.user) {
    throw new Response(JSON.stringify({ error: "invalid_session" }), { status: 401 });
  }

  const admin = serviceClient();
  const { data: profile, error: profileError } = await admin
    .from("profiles")
    .select("role")
    .eq("id", userData.user.id)
    .maybeSingle();
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

  const response = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Basic ${basicToken.replace(/^Basic\s+/i, "")}`,
      "Content-Type": "application/json",
    },
  });
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500);
    throw new Error(`Hotmart OAuth falhou (${response.status}): ${detail}`);
  }
  const payload = await response.json() as { access_token?: string };
  if (!payload.access_token) throw new Error("Hotmart OAuth não retornou access_token");
  return payload.access_token;
}

function configuredStatuses() {
  const raw = Deno.env.get("HOTMART_ROSTER_STATUSES") ?? "ACTIVE,DELAYED,OVERDUE";
  const statuses = raw.split(",").map((value) => value.trim().toUpperCase()).filter(Boolean);
  return [...new Set(statuses)];
}

async function fetchSubscriptions(accessToken: string) {
  const productId = requiredEnv("HOTMART_PRODUCT_ID");
  const statuses = configuredStatuses();
  const subscriptions: HotmartSubscription[] = [];
  let pageToken: string | undefined;
  let page = 0;

  do {
    page += 1;
    if (page > 500) throw new Error("Hotmart excedeu o limite de 500 páginas por sincronização");

    const url = new URL("https://developers.hotmart.com/payments/api/v1/subscriptions");
    url.searchParams.set("product_id", productId);
    url.searchParams.set("max_results", "500");
    // Without accession_date Hotmart defaults to a recent period. Zero requests
    // the complete subscription history for the selected product.
    url.searchParams.set("accession_date", "0");
    for (const status of statuses) url.searchParams.append("status", status);
    if (pageToken) url.searchParams.set("page_token", pageToken);

    const response = await fetch(url, {
      headers: {
        Authorization: `Bearer ${accessToken}`,
        "Content-Type": "application/json",
      },
    });
    if (!response.ok) {
      const detail = (await response.text()).slice(0, 500);
      throw new Error(`Hotmart subscriptions falhou (${response.status}): ${detail}`);
    }

    const payload = await response.json() as {
      items?: HotmartSubscription[];
      page_info?: { next_page_token?: string | null };
    };
    subscriptions.push(...(payload.items ?? []));
    pageToken = payload.page_info?.next_page_token || undefined;
  } while (pageToken);

  return { subscriptions, productId, statuses };
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
      external_student_id: item.subscriber?.ucode ?? item.subscriber_code ??
        (item.subscription_id == null ? null : String(item.subscription_id)),
      subscription_status: item.status?.toUpperCase() ?? null,
      plan_name: item.plan?.name ?? null,
      product_id: String(item.product?.id ?? productId),
      active: true,
      synced_at: syncedAt,
    });
  }
  return [...deduplicated.values()];
}

async function activeRosterCount(admin: ReturnType<typeof serviceClient>, productId: string) {
  const { count, error } = await admin
    .from("hotmart_cohort_roster")
    .select("email", { count: "exact", head: true })
    .eq("product_id", productId)
    .eq("active", true);
  if (error) throw new Error(`Falha ao conferir roster anterior: ${error.message}`);
  return count ?? 0;
}

async function activeRosterCohortCounts(admin: ReturnType<typeof serviceClient>, productId: string) {
  const counts = new Map<number, number>();
  for (let offset = 0; ; offset += 1000) {
    const { data, error } = await admin
      .from("hotmart_cohort_roster")
      .select("cohort_number,email")
      .eq("product_id", productId)
      .eq("active", true)
      .order("cohort_number", { ascending: true })
      .order("email", { ascending: true })
      .range(offset, offset + 999);
    if (error) throw new Error(`Falha ao conferir turmas anteriores: ${error.message}`);
    for (const row of data ?? []) {
      const cohort = Number(row.cohort_number);
      counts.set(cohort, (counts.get(cohort) ?? 0) + 1);
    }
    if ((data ?? []).length < 1000) break;
  }
  return counts;
}

async function reconcileSnapshot(
  admin: ReturnType<typeof serviceClient>,
  productId: string,
  roster: Record<string, unknown>[],
  syncedAt: string,
  groupId?: string,
) {
  const { data, error } = await admin.rpc("reconcile_hotmart_roster_snapshot", {
    p_product_id: productId,
    p_rows: roster,
    p_synced_at: syncedAt,
    p_group_id: groupId ?? null,
  });
  if (error) throw new Error(`A reconciliação Hotmart foi revertida: ${error.message}`);
  const result = (data ?? {}) as { deactivated?: number; groups?: number; invitations?: number };
  return {
    deactivated: Number(result.deactivated ?? 0),
    groups: Number(result.groups ?? 0),
    invitations: Number(result.invitations ?? 0),
  };
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const { admin } = await requireStaff(req);
    const input = await req.json().catch(() => ({})) as SyncRequest;
    const action = input.action ?? "sync";
    if (!new Set(["sync", "cohorts"]).has(action)) return json({ error: "invalid_action" }, 400);

    const accessToken = await hotmartAccessToken();
    const { subscriptions, productId, statuses } = await fetchSubscriptions(accessToken);
    const syncedAt = new Date().toISOString();
    const roster = buildRoster(subscriptions, productId, syncedAt);
    const cohortCounts = new Map<number, number>();
    for (const row of roster) {
      const cohort = Number(row.cohort_number);
      cohortCounts.set(cohort, (cohortCounts.get(cohort) ?? 0) + 1);
    }
    const cohorts = [...cohortCounts.entries()]
      .sort(([left], [right]) => left - right)
      .map(([cohort_number, student_count]) => ({ cohort_number, student_count }));

    if (action === "cohorts") {
      return json({ cohorts, fetched: subscriptions.length, eligible: roster.length, statuses });
    }

    const [previousActiveGlobal, previousCohorts] = await Promise.all([
      activeRosterCount(admin, productId),
      activeRosterCohortCounts(admin, productId),
    ]);
    let targetCohort: number | undefined;
    if (input.group_id) {
      const { data: group, error: groupError } = await admin
        .from("student_groups")
        .select("cohort_number")
        .eq("id", input.group_id)
        .maybeSingle();
      if (groupError) throw new Error(`Falha ao buscar a turma do grupo: ${groupError.message}`);
      if (!group?.cohort_number) throw new Error("Grupo ou turma não encontrado");
      targetCohort = Number(group.cohort_number);
    }
    const scopedRoster = targetCohort == null
      ? roster
      : roster.filter((row) => Number(row.cohort_number) === targetCohort);
    const previousActive = targetCohort == null
      ? previousActiveGlobal
      : previousCohorts.get(targetCohort) ?? 0;
    const abnormalDrop = scopedRoster.length === 0 ||
      (previousActive >= 10 && scopedRoster.length < Math.ceil(previousActive * 0.25));
    const cohortEntries = targetCohort == null
      ? [...previousCohorts.entries()]
      : [[targetCohort, previousActive] as [number, number]];
    const abnormalCohorts = cohortEntries.flatMap(([cohort, previous]) => {
      const current = cohortCounts.get(cohort) ?? 0;
      const abnormal = current === 0 || (previous >= 5 && current < Math.ceil(previous * 0.25));
      return abnormal ? [{ cohort_number: cohort, previous, current }] : [];
    });
    if ((abnormalDrop || abnormalCohorts.length > 0) && !input.force) {
      return json({
        error: "roster_confirmation_required",
        message: abnormalCohorts.length
          ? `A Hotmart retornou uma queda anormal em ${abnormalCohorts.length} turma(s). Revise os planos T## e confirme a reconciliação manualmente.`
          : `A Hotmart retornou uma queda anormal no roster (${previousActive} → ${scopedRoster.length}). Revise os filtros e confirme a reconciliação manualmente.`,
        previous_active: previousActive,
        eligible: scopedRoster.length,
        affected_cohorts: abnormalCohorts,
      }, 409);
    }

    // Always send the complete API snapshot. The SQL function normally scopes
    // a group refresh to its cohort, but needs the full payload to revoke and
    // rebuild every cohort atomically if HOTMART_PRODUCT_ID has changed.
    const reconciliation = await reconcileSnapshot(admin, productId, roster, syncedAt, input.group_id);
    return json({
      status: "synced",
      synced: scopedRoster.length,
      cohorts,
      fetched: subscriptions.length,
      eligible: scopedRoster.length,
      deactivated: reconciliation.deactivated,
      statuses,
      groups: reconciliation.groups,
      invitations: reconciliation.invitations,
      forced: Boolean(input.force && (abnormalDrop || abnormalCohorts.length > 0)),
    });
  } catch (error) {
    if (error instanceof Response) {
      return new Response(error.body, {
        status: error.status,
        headers: { ...corsHeaders, "Content-Type": "application/json", "Cache-Control": "no-store" },
      });
    }
    return json({ error: "hotmart_roster_sync_failed", message: String(error) }, 500);
  }
});
