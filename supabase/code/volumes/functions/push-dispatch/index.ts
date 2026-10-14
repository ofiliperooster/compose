import { createClient } from "@supabase/supabase-js";

type Outbox = { id: string; user_id: string; category: "community" | "lives" | "security" | "system"; title: string; body: string; data: Record<string, unknown>; attempts: number };
type PushToken = { id: string; push_token: string; provider: string };
const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { "Cache-Control": "no-store" } });
const oneSignalAppId = Deno.env.get("ONESIGNAL_APP_ID") || "8d71b5d4-7668-4542-9d1f-86fb9172cf20";

Deno.serve(async (req) => {
  const workerSecret = Deno.env.get("PUSH_WORKER_SECRET");
  if (!workerSecret || req.headers.get("x-worker-secret") !== workerSecret) return json({ error: "Não autorizado" }, 401);
  const url = Deno.env.get("SUPABASE_URL");
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!url || !serviceKey) return json({ error: "Serviço não configurado" }, 503);
  const admin = createClient(url, serviceKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data: pendingReceipts } = await admin.from("notification_deliveries").select("id,token_id,provider_ticket_id").eq("status", "accepted").not("provider_ticket_id", "is", null).limit(300);
  if (pendingReceipts?.length) {
    const receiptResponse = await fetch("https://exp.host/--/api/v2/push/getReceipts", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ ids: pendingReceipts.map((item) => item.provider_ticket_id) }) });
    if (receiptResponse.ok) {
      const receipts = (await receiptResponse.json()).data || {};
      for (const delivery of pendingReceipts) {
        const receipt = receipts[delivery.provider_ticket_id];
        if (!receipt) continue;
        const invalid = receipt?.details?.error === "DeviceNotRegistered";
        await admin.from("notification_deliveries").update({ status: receipt.status === "ok" ? "delivered" : "failed", provider_response: receipt, updated_at: new Date().toISOString() }).eq("id", delivery.id);
        if (invalid && delivery.token_id) await admin.from("device_push_tokens").update({ notifications_enabled: false, invalidated_at: new Date().toISOString() }).eq("id", delivery.token_id);
      }
    }
  }
  const { data: jobs, error } = await admin.rpc("claim_notification_outbox", { p_limit: 100 });
  if (error) return json({ error: error.message }, 500);
  let accepted = 0;
  for (const job of (jobs || []) as Outbox[]) {
    try {
    const [profileResult, preferencesResult] = await Promise.all([
      admin.from("profiles").select("subscription_status").eq("id", job.user_id).maybeSingle(),
      admin.from("notification_preferences").select("community,lives,security").eq("user_id", job.user_id).maybeSingle(),
    ]);
    if (profileResult.error) throw new Error(`Falha ao validar assinatura: ${profileResult.error.message}`);
    if (preferencesResult.error) throw new Error(`Falha ao validar preferências: ${preferencesResult.error.message}`);
    const profile = profileResult.data;
    const preferences = preferencesResult.data;
    const preferenceEnabled = job.category === "community" ? preferences?.community !== false
      : job.category === "lives" ? preferences?.lives !== false
      : job.category === "security" ? preferences?.security !== false
      : true;
    let rejection = !preferenceEnabled ? "Preferência desativada" : "";
    if (!rejection && ["community", "lives"].includes(job.category) && profile?.subscription_status?.toLowerCase() !== "active") {
      rejection = "Assinatura inativa";
    }

    if (!rejection && job.category === "community" && typeof job.data.message_id === "string") {
      const { data: message, error: messageError } = await admin
        .from("community_messages")
        .select("group_id,published_at,publish_at,expires_at")
        .eq("id", job.data.message_id)
        .maybeSingle();
      if (messageError) throw new Error(`Falha ao validar publicação: ${messageError.message}`);
      if (!message || !message.published_at || new Date(message.publish_at) > new Date() || (message.expires_at && new Date(message.expires_at) <= new Date())) {
        rejection = "Publicação indisponível";
      } else if (message.group_id) {
        const { data: membership, error: membershipError } = await admin.from("student_group_members").select("group_id").eq("group_id", message.group_id).eq("user_id", job.user_id).maybeSingle();
        if (membershipError) throw new Error(`Falha ao validar grupo: ${membershipError.message}`);
        if (!membership) rejection = "Aluno fora do grupo";
      }
    }

    if (!rejection && job.category === "lives" && typeof job.data.session_id === "string") {
      const { data: live, error: liveError } = await admin.from("live_sessions").select("status,scheduled_at").eq("id", job.data.session_id).maybeSingle();
      if (liveError) throw new Error(`Falha ao validar live: ${liveError.message}`);
      const expectedStatus = typeof job.data.live_status === "string" ? job.data.live_status : null;
      const expectedSchedule = typeof job.data.scheduled_at === "string" ? new Date(job.data.scheduled_at).getTime() : null;
      const actualSchedule = live?.scheduled_at ? new Date(live.scheduled_at).getTime() : null;
      if (!live || (expectedStatus && live.status !== expectedStatus) || (expectedSchedule != null && actualSchedule !== expectedSchedule) || !["scheduled", "live"].includes(live.status)) {
        rejection = "Live indisponível ou reagendada";
      }
    }

    if (rejection) {
      await admin.from("notification_outbox").update({ status: "failed", processed_at: new Date().toISOString(), last_error: rejection }).eq("id", job.id);
      continue;
    }

    const { data: tokens, error: tokensError } = await admin.from("device_push_tokens").select("id,push_token,provider").eq("user_id", job.user_id).eq("notifications_enabled", true).is("invalidated_at", null);
    if (tokensError) throw new Error(`Falha ao buscar dispositivos: ${tokensError.message}`);
    if (!tokens?.length) {
      await admin.from("notification_outbox").update({ status: "failed", processed_at: new Date().toISOString(), last_error: "Nenhum token ativo" }).eq("id", job.id);
      continue;
    }
      const pushTokens = tokens as PushToken[];
      const oneSignalTokens = pushTokens.filter((token) => token.provider === "onesignal");
      const expoTokens = pushTokens.filter((token) => token.provider !== "onesignal");
      const imageUrl = typeof job.data.image_url === "string" && /^https:\/\//i.test(job.data.image_url)
        ? job.data.image_url
        : null;

      if (oneSignalTokens.length) {
        const apiKey = Deno.env.get("ONESIGNAL_REST_API_KEY");
        if (!apiKey) throw new Error("ONESIGNAL_REST_API_KEY não configurada");
        const response = await fetch("https://api.onesignal.com/notifications", {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Key ${apiKey}` },
          body: JSON.stringify({
            app_id: oneSignalAppId,
            target_channel: "push",
            include_subscription_ids: oneSignalTokens.map((token) => token.push_token),
            headings: { en: job.title },
            contents: { en: job.body },
            data: job.data,
            ...(imageUrl ? {
              big_picture: imageUrl,
              chrome_web_image: imageUrl,
              ios_attachments: { image: imageUrl },
            } : {}),
          }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(`OneSignal: ${JSON.stringify(result)}`);
        for (const token of oneSignalTokens) {
          await admin.from("notification_deliveries").insert({ outbox_id: job.id, token_id: token.id, provider_ticket_id: null, status: "accepted", provider_response: result });
        }
      }

      if (expoTokens.length) {
        const headers: Record<string, string> = { "Content-Type": "application/json" };
        const accessToken = Deno.env.get("EXPO_ACCESS_TOKEN");
        if (accessToken) headers.Authorization = `Bearer ${accessToken}`;
        const response = await fetch("https://exp.host/--/api/v2/push/send", { method: "POST", headers, body: JSON.stringify(expoTokens.map((token) => ({ to: token.push_token, title: job.title, body: job.body, data: job.data, sound: "default", ...(imageUrl ? { richContent: { image: imageUrl } } : {}) }))) });
        const result = await response.json();
        if (!response.ok) throw new Error(JSON.stringify(result));
        const tickets = Array.isArray(result.data) ? result.data : [result.data];
        for (let index = 0; index < expoTokens.length; index += 1) {
          const ticket = tickets[index] || {};
          const invalid = ticket?.details?.error === "DeviceNotRegistered";
          await admin.from("notification_deliveries").insert({ outbox_id: job.id, token_id: expoTokens[index].id, provider_ticket_id: ticket.id || null, status: ticket.status === "ok" ? "accepted" : "failed", provider_response: ticket });
          if (invalid) await admin.from("device_push_tokens").update({ notifications_enabled: false, invalidated_at: new Date().toISOString() }).eq("id", expoTokens[index].id);
        }
      }
      await admin.from("notification_outbox").update({ status: "sent", processed_at: new Date().toISOString(), last_error: null }).eq("id", job.id);
      accepted += 1;
    } catch (sendError) {
      const retry = job.attempts < 5;
      await admin.from("notification_outbox").update({ status: retry ? "pending" : "failed", available_at: new Date(Date.now() + Math.min(900, 2 ** job.attempts * 15) * 1000).toISOString(), last_error: String(sendError) }).eq("id", job.id);
    }
  }
  return json({ claimed: jobs?.length || 0, accepted });
});
