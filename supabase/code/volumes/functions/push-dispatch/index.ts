import { createClient } from "@supabase/supabase-js";

type Outbox = {
  id: string;
  user_id: string;
  category: "community" | "lives" | "security" | "system";
  title: string;
  body: string;
  data: Record<string, unknown>;
  attempts: number;
};
type PushToken = { id: string; user_id: string; push_token: string; provider: string };
type Profile = { id: string; subscription_status: string | null };
type Preferences = { user_id: string; community: boolean; lives: boolean; security: boolean };
type CommunityMessage = { id: string; group_id: string | null; published_at: string | null; publish_at: string; expires_at: string | null };
type LiveSession = { id: string; status: string; scheduled_at: string | null };

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type, x-worker-secret",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};
const json = (body: unknown, status = 200) => Response.json(body, {
  status,
  headers: { ...corsHeaders, "Cache-Control": "no-store" },
});
const oneSignalAppId = Deno.env.get("ONESIGNAL_APP_ID") || "8d71b5d4-7668-4542-9d1f-86fb9172cf20";

function requiredEnv(name: string) {
  const value = Deno.env.get(name)?.trim();
  if (!value) throw new Error(`${name} não configurada`);
  return value;
}

async function fetchWithTimeout(input: string, init: RequestInit, timeoutMs = 15_000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(input, { ...init, signal: controller.signal });
  } catch (error) {
    if (error instanceof DOMException && error.name === "AbortError") {
      throw new Error(`O provedor de push não respondeu em ${Math.round(timeoutMs / 1000)} segundos`);
    }
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

async function authorize(req: Request, url: string) {
  const configuredSecret = Deno.env.get("PUSH_WORKER_SECRET")?.trim();
  const suppliedSecret = req.headers.get("x-worker-secret")?.trim();
  if (configuredSecret && suppliedSecret === configuredSecret) return "worker";

  const authorization = req.headers.get("Authorization") ?? "";
  if (!authorization.toLowerCase().startsWith("bearer ")) throw new Error("Não autorizado");
  const anon = createClient(url, requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const { data, error } = await anon.auth.getUser();
  if (error || !data.user) throw new Error("Sessão inválida");
  const { data: currentSession, error: sessionError } = await anon.rpc("check_current_app_session");
  if (sessionError || currentSession !== true) throw new Error("Sessão do aplicativo inválida");
  return "app";
}

function preferenceEnabled(job: Outbox, preference?: Preferences) {
  if (job.category === "community") return preference?.community !== false;
  if (job.category === "lives") return preference?.lives !== false;
  if (job.category === "security") return preference?.security !== false;
  return true;
}

function payloadKey(job: Outbox) {
  return JSON.stringify({ title: job.title, body: job.body, data: job.data });
}

function chunks<T>(values: T[], size: number) {
  const result: T[][] = [];
  for (let index = 0; index < values.length; index += size) result.push(values.slice(index, index + size));
  return result;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);

  try {
    const url = requiredEnv("SUPABASE_URL");
    const serviceKey = requiredEnv("SUPABASE_SERVICE_ROLE_KEY");
    const caller = await authorize(req, url);
    const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });

    const { data: pendingReceipts } = await admin
      .from("notification_deliveries")
      .select("id,token_id,provider_ticket_id")
      .eq("status", "accepted")
      .not("provider_ticket_id", "is", null)
      .limit(300);
    if (pendingReceipts?.length) {
      const receiptResponse = await fetchWithTimeout("https://exp.host/--/api/v2/push/getReceipts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ids: pendingReceipts.map((item) => item.provider_ticket_id) }),
      });
      if (receiptResponse.ok) {
        const receipts = (await receiptResponse.json()).data || {};
        for (const delivery of pendingReceipts) {
          const receipt = receipts[delivery.provider_ticket_id];
          if (!receipt) continue;
          const invalid = receipt?.details?.error === "DeviceNotRegistered";
          await admin.from("notification_deliveries").update({
            status: receipt.status === "ok" ? "delivered" : "failed",
            provider_response: receipt,
            updated_at: new Date().toISOString(),
          }).eq("id", delivery.id);
          if (invalid && delivery.token_id) {
            await admin.from("device_push_tokens").update({ notifications_enabled: false, invalidated_at: new Date().toISOString() }).eq("id", delivery.token_id);
          }
        }
      }
    }

    const { data: claimed, error: claimError } = await admin.rpc("claim_notification_outbox", { p_limit: 100 });
    if (claimError) return json({ error: claimError.message }, 500);
    const jobs = (claimed || []) as Outbox[];
    if (!jobs.length) return json({ caller, claimed: 0, accepted: 0, rejected: 0, retried: 0, errors: [] });

    const userIds = [...new Set(jobs.map((job) => job.user_id))];
    const messageIds = [...new Set(jobs.map((job) => typeof job.data.message_id === "string" ? job.data.message_id : "").filter(Boolean))];
    const sessionIds = [...new Set(jobs.map((job) => typeof job.data.session_id === "string" ? job.data.session_id : "").filter(Boolean))];
    const [profilesResult, preferencesResult, tokensResult, messagesResult, livesResult] = await Promise.all([
      admin.from("profiles").select("id,subscription_status").in("id", userIds),
      admin.from("notification_preferences").select("user_id,community,lives,security").in("user_id", userIds),
      admin.from("device_push_tokens").select("id,user_id,push_token,provider").in("user_id", userIds).eq("notifications_enabled", true).is("invalidated_at", null),
      messageIds.length
        ? admin.from("community_messages").select("id,group_id,published_at,publish_at,expires_at").in("id", messageIds)
        : Promise.resolve({ data: [], error: null }),
      sessionIds.length
        ? admin.from("live_sessions").select("id,status,scheduled_at").in("id", sessionIds)
        : Promise.resolve({ data: [], error: null }),
    ]);
    const preloadError = profilesResult.error || preferencesResult.error || tokensResult.error || messagesResult.error || livesResult.error;
    if (preloadError) throw new Error(`Falha ao preparar a fila: ${preloadError.message}`);

    const profiles = new Map(((profilesResult.data ?? []) as Profile[]).map((item) => [item.id, item]));
    const preferences = new Map(((preferencesResult.data ?? []) as Preferences[]).map((item) => [item.user_id, item]));
    const messages = new Map(((messagesResult.data ?? []) as CommunityMessage[]).map((item) => [item.id, item]));
    const lives = new Map(((livesResult.data ?? []) as LiveSession[]).map((item) => [item.id, item]));
    const tokensByUser = new Map<string, PushToken[]>();
    for (const token of (tokensResult.data ?? []) as PushToken[]) {
      tokensByUser.set(token.user_id, [...(tokensByUser.get(token.user_id) ?? []), token]);
    }

    const groupedMemberships = new Map<string, boolean>();
    const groupIds = [...new Set([...messages.values()].map((message) => message.group_id).filter((value): value is string => !!value))];
    if (groupIds.length) {
      const { data, error } = await admin.from("student_group_members").select("group_id,user_id").in("group_id", groupIds).in("user_id", userIds);
      if (error) throw new Error(`Falha ao validar grupos: ${error.message}`);
      for (const membership of data ?? []) groupedMemberships.set(`${membership.group_id}:${membership.user_id}`, true);
    }

    const eligible: Outbox[] = [];
    let rejected = 0;
    const errors: string[] = [];
    for (const job of jobs) {
      let rejection = preferenceEnabled(job, preferences.get(job.user_id)) ? "" : "Preferência desativada";
      const profile = profiles.get(job.user_id);
      if (!rejection && ["community", "lives"].includes(job.category) && profile?.subscription_status?.toLowerCase() !== "active") rejection = "Assinatura inativa";
      if (!rejection && job.category === "community" && typeof job.data.message_id === "string") {
        const message = messages.get(job.data.message_id);
        if (!message || !message.published_at || new Date(message.publish_at) > new Date() || (message.expires_at && new Date(message.expires_at) <= new Date())) {
          rejection = "Publicação indisponível";
        } else if (message.group_id && !groupedMemberships.get(`${message.group_id}:${job.user_id}`)) {
          rejection = "Aluno fora do grupo";
        }
      }
      if (!rejection && job.category === "lives" && typeof job.data.session_id === "string") {
        const live = lives.get(job.data.session_id);
        const expectedStatus = typeof job.data.live_status === "string" ? job.data.live_status : null;
        const expectedSchedule = typeof job.data.scheduled_at === "string" ? new Date(job.data.scheduled_at).getTime() : null;
        const actualSchedule = live?.scheduled_at ? new Date(live.scheduled_at).getTime() : null;
        if (!live || (expectedStatus && live.status !== expectedStatus) || (expectedSchedule != null && actualSchedule !== expectedSchedule) || !["scheduled", "live"].includes(live.status)) {
          rejection = "Live indisponível ou reagendada";
        }
      }
      if (rejection) {
        rejected += 1;
        await admin.from("notification_outbox").update({ status: "failed", processed_at: new Date().toISOString(), last_error: rejection }).eq("id", job.id);
      } else {
        eligible.push(job);
      }
    }

    const groups = new Map<string, Outbox[]>();
    for (const job of eligible) groups.set(payloadKey(job), [...(groups.get(payloadKey(job)) ?? []), job]);
    const apiKey = requiredEnv("ONESIGNAL_REST_API_KEY");
    let accepted = 0;
    let retried = 0;

    for (const batch of chunks([...groups.values()], 5)) {
      await Promise.all(batch.map(async (group) => {
        const sample = group[0];
        const imageUrl = typeof sample.data.image_url === "string" && /^https:\/\//i.test(sample.data.image_url) ? sample.data.image_url : null;
        try {
          const response = await fetchWithTimeout("https://api.onesignal.com/notifications", {
            method: "POST",
            headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Key ${apiKey}` },
            body: JSON.stringify({
              app_id: oneSignalAppId,
              target_channel: "push",
              include_aliases: { external_id: group.map((job) => job.user_id) },
              headings: { en: sample.title, pt: sample.title },
              contents: { en: sample.body, pt: sample.body },
              data: sample.data,
              ...(imageUrl ? { big_picture: imageUrl, chrome_web_image: imageUrl, ios_attachments: { image: imageUrl } } : {}),
            }),
          });
          const result = await response.json().catch(() => ({}));
          if (!response.ok) throw new Error(`OneSignal HTTP ${response.status}: ${JSON.stringify(result)}`);

          for (const job of group) {
            await admin.from("notification_deliveries").insert({
              outbox_id: job.id,
              token_id: null,
              provider_ticket_id: null,
              status: "accepted",
              provider_response: result,
            });
            await admin.from("notification_outbox").update({ status: "sent", processed_at: new Date().toISOString(), last_error: null }).eq("id", job.id);
            accepted += 1;
          }

          const expoDeliveries = group.flatMap((job) => {
            const userTokens = tokensByUser.get(job.user_id) ?? [];
            if (userTokens.some((token) => token.provider === "onesignal")) return [];
            return userTokens.filter((token) => token.provider !== "onesignal").map((token) => ({ job, token }));
          });
          if (expoDeliveries.length) {
            const headers: Record<string, string> = { "Content-Type": "application/json" };
            const accessToken = Deno.env.get("EXPO_ACCESS_TOKEN");
            if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
            const expoResponse = await fetchWithTimeout("https://exp.host/--/api/v2/push/send", {
              method: "POST",
              headers,
              body: JSON.stringify(expoDeliveries.map(({ job, token }) => ({ to: token.push_token, title: job.title, body: job.body, data: job.data, sound: "default" }))),
            });
            const expoResult = await expoResponse.json().catch(() => ({}));
            if (!expoResponse.ok) errors.push(`Expo HTTP ${expoResponse.status}: ${JSON.stringify(expoResult)}`.slice(0, 500));
          }
        } catch (sendError) {
          const message = sendError instanceof Error ? sendError.message : String(sendError);
          errors.push(message.slice(0, 500));
          for (const job of group) {
            const retry = job.attempts < 5;
            if (retry) retried += 1;
            await admin.from("notification_outbox").update({
              status: retry ? "pending" : "failed",
              available_at: new Date(Date.now() + Math.min(900, 2 ** job.attempts * 15) * 1000).toISOString(),
              processed_at: retry ? null : new Date().toISOString(),
              last_error: message,
            }).eq("id", job.id);
          }
        }
      }));
    }

    return json({ caller, claimed: jobs.length, accepted, rejected, retried, errors: [...new Set(errors)].slice(0, 10) });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = /autorizado|inválida/i.test(message) ? 401 : 500;
    return json({ error: "push_dispatch_failed", message }, status);
  }
});
