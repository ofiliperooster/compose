import { createClient } from "@supabase/supabase-js";
import {
  EgressClient,
  EncodedFileOutput,
  EncodedFileType,
  EncodingOptionsPreset,
  S3Upload,
  WebhookReceiver,
} from "livekit-server-sdk";

type RecordingAction = "start" | "stop" | "status";
type RecordingRequest = { action?: RecordingAction; session_id?: string };
type EgressInfoLike = {
  egressId?: string;
  roomName?: string;
  status?: number;
  error?: string;
  details?: string;
  fileResults?: Array<{ filename?: string; location?: string }>;
};

const EGRESS_STARTING = 0;
const EGRESS_ACTIVE = 1;
const EGRESS_ENDING = 2;
const EGRESS_COMPLETE = 3;
const EGRESS_FAILED = 4;
const EGRESS_ABORTED = 5;
const EGRESS_LIMIT_REACHED = 6;
const TERMINAL_STATUSES = new Set([EGRESS_COMPLETE, EGRESS_FAILED, EGRESS_ABORTED, EGRESS_LIMIT_REACHED]);

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

function liveKitHttpUrl(value: string) {
  return value.replace(/^wss:/i, "https:").replace(/^ws:/i, "http:");
}

function publicSupabaseUrl() {
  return (Deno.env.get("SUPABASE_PUBLIC_URL")?.trim() || requiredEnv("SUPABASE_URL"))
    .replace(/\/+$/, "");
}

function publicRecordingUrl(filepath: string) {
  const base = requiredEnv("LIVEKIT_RECORDING_PUBLIC_BASE_URL").replace(/\/+$/, "");
  return `${base}/${filepath.split("/").map(encodeURIComponent).join("/")}`;
}

function recordingState(status = EGRESS_STARTING) {
  if (status === EGRESS_ACTIVE) return "recording";
  if (status === EGRESS_ENDING) return "processing";
  if (status === EGRESS_COMPLETE) return "ready";
  if (status === EGRESS_FAILED || status === EGRESS_ABORTED || status === EGRESS_LIMIT_REACHED) return "failed";
  return "starting";
}

function serviceClient() {
  return createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_SERVICE_ROLE_KEY"), {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

async function persistEgressInfo(info: EgressInfoLike, sessionId?: string) {
  const admin = serviceClient();
  let query = admin
    .from("live_sessions")
    .select("id, status, ended_at, recording_filepath")
    .limit(1);
  if (sessionId) query = query.eq("id", sessionId);
  else if (info.egressId) query = query.eq("recording_egress_id", info.egressId);
  else if (info.roomName) query = query.eq("livekit_room", info.roomName);
  else return null;

  const initialLookup = await query.maybeSingle();
  if (initialLookup.error) throw initialLookup.error;
  let session = initialLookup.data;
  // A start request can succeed in LiveKit while the first database write
  // fails. In that case the webhook carries an egress id that is not linked
  // yet, so recover the session through the (unique) room name.
  if (!session && info.roomName) {
    const fallback = await admin
      .from("live_sessions")
      .select("id, status, ended_at, recording_filepath")
      .eq("livekit_room", info.roomName)
      .limit(1)
      .maybeSingle();
    if (fallback.error) throw fallback.error;
    session = fallback.data;
  }
  if (!session) return null;

  const state = recordingState(info.status);
  const filepath = session.recording_filepath || info.fileResults?.[0]?.filename || null;
  const update: Record<string, unknown> = {
    recording_status: state,
    recording_error: state === "failed" ? (info.error || info.details || "A gravação não foi concluída") : null,
  };
  if (info.egressId) update.recording_egress_id = info.egressId;
  if (filepath) update.recording_filepath = filepath;
  if (state === "ready" && filepath) {
    update.recording_url = publicRecordingUrl(filepath);
    // O estado inicial já é false. Não altere aqui: depois que o admin publicar,
    // um webhook repetido não pode ocultar novamente a gravação dos alunos.
  } else if (state === "failed") {
    update.recording_available = false;
    // Never leave the publisher apparently live after automatic recording has
    // failed. Ending the row also removes the room from the student live list;
    // the client unmounts its publisher tracks as soon as it receives UPDATE.
    if (["scheduled", "ready", "live"].includes(session.status)) {
      update.status = "ended";
      update.ended_at = session.ended_at || new Date().toISOString();
    }
  }

  const result = await admin
    .from("live_sessions")
    .update(update)
    .eq("id", session.id)
    .select("*")
    .single();
  if (result.error) throw result.error;
  return result.data;
}

async function handleWebhook(req: Request, apiKey: string, apiSecret: string) {
  const rawBody = await req.text();
  const authorization = req.headers.get("Authorization") || req.headers.get("Authorize") || undefined;
  const event = await new WebhookReceiver(apiKey, apiSecret).receive(rawBody, authorization) as unknown as {
    event?: string;
    egressInfo?: EgressInfoLike;
  };
  if (event.egressInfo && event.event?.startsWith("egress_")) {
    await persistEgressInfo(event.egressInfo);
  }
  return json({ received: true });
}

async function authorizeStaff(req: Request) {
  const authorization = req.headers.get("Authorization");
  if (!authorization) throw new Error("Não autorizado");
  const supabase = createClient(requiredEnv("SUPABASE_URL"), requiredEnv("SUPABASE_ANON_KEY"), {
    global: { headers: { Authorization: authorization } },
    auth: { persistSession: false, autoRefreshToken: false },
  });
  const token = authorization.replace(/^Bearer\s+/i, "");
  const { data: { user }, error: userError } = await supabase.auth.getUser(token);
  if (userError || !user) throw new Error("Não autorizado");
  const { data: profile } = await supabase.from("profiles").select("role").eq("id", user.id).maybeSingle();
  if (!profile || (profile.role !== "admin" && profile.role !== "support")) throw new Error("Apenas a equipe pode controlar gravações");
  return user;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  try {
    if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

    const apiKey = requiredEnv("LIVEKIT_API_KEY");
    const apiSecret = requiredEnv("LIVEKIT_API_SECRET");
    if (new URL(req.url).searchParams.get("webhook") === "1") {
      return await handleWebhook(req, apiKey, apiSecret);
    }

    await authorizeStaff(req);
    const body = await req.json() as RecordingRequest;
    if (!body.session_id || !body.action) return json({ error: "Ação ou sessão inválida" }, 400);

    const admin = serviceClient();
    const { data: session, error: sessionError } = await admin
      .from("live_sessions")
      .select("*")
      .eq("id", body.session_id)
      .maybeSingle();
    if (sessionError || !session?.livekit_room) return json({ error: "Live não encontrada" }, 404);

    const egress = new EgressClient(
      liveKitHttpUrl(requiredEnv("LIVEKIT_URL")),
      apiKey,
      apiSecret,
    );

    if (body.action === "start") {
      if (session.recording_status === "failed" && session.recording_egress_id) {
        return json({
          error: "A gravação desta live falhou e a transmissão foi encerrada. Crie uma nova live para tentar novamente.",
          session,
        }, 409);
      }
      if (["starting", "recording"].includes(session.recording_status) && session.recording_egress_id) {
        const activeItems = await egress.listEgress({ egressId: session.recording_egress_id });
        const activeInfo = activeItems[0] as EgressInfoLike | undefined;
        if (activeInfo) await persistEgressInfo(activeInfo, session.id);
        if (activeInfo && [EGRESS_STARTING, EGRESS_ACTIVE].includes(Number(activeInfo.status))) {
          const { data: refreshed } = await admin.from("live_sessions").select("*").eq("id", session.id).single();
          return json({ session: refreshed ?? session, reused: true });
        }
        if (activeInfo && Number(activeInfo.status) === EGRESS_ENDING) {
          const { data: refreshed } = await admin.from("live_sessions").select("*").eq("id", session.id).single();
          return json({ error: "A gravação anterior ainda está sendo processada", session: refreshed }, 409);
        }
        if (activeInfo && TERMINAL_STATUSES.has(Number(activeInfo.status))) {
          const { data: refreshed } = await admin.from("live_sessions").select("*").eq("id", session.id).single();
          const completed = refreshed?.recording_status === "ready";
          return json({
            error: completed
              ? "Esta sessão já possui uma gravação concluída; crie uma nova live para iniciar outro arquivo"
              : "A gravação desta live terminou com falha. O vínculo foi preservado para auditoria; crie uma nova live para tentar novamente.",
            session: refreshed ?? session,
          }, 409);
        }
      }
      if (["processing", "ready"].includes(session.recording_status)) {
        return json({ error: "Esta sessão já possui uma gravação encerrada; crie uma nova live para iniciar outro arquivo" }, 409);
      }
      if (!["scheduled", "ready", "live"].includes(session.status)) {
        return json({ error: "O estúdio ainda não está preparado" }, 409);
      }

      const filepath = `lives/${session.id}/${Date.now()}.mp4`;
      const { data: claimed, error: claimError } = await admin.rpc("claim_live_recording_start", {
        p_session_id: session.id,
        p_filepath: filepath,
      });
      if (claimError) throw new Error(`Não foi possível reservar a gravação: ${claimError.message}`);
      if (!claimed) {
        const { data: refreshed } = await admin.from("live_sessions").select("*").eq("id", session.id).single();
        return json({ error: "Outra aba já está iniciando ou finalizando a gravação", session: refreshed }, 409);
      }

      let startedEgressId: string | undefined;
      try {
        const output = new EncodedFileOutput({
          fileType: EncodedFileType.MP4,
          filepath,
          output: {
            case: "s3",
            value: new S3Upload({
              accessKey: requiredEnv("LIVEKIT_RECORDING_S3_ACCESS_KEY"),
              secret: requiredEnv("LIVEKIT_RECORDING_S3_SECRET_KEY"),
              region: Deno.env.get("LIVEKIT_RECORDING_S3_REGION")?.trim() || "us-east-1",
              endpoint: Deno.env.get("LIVEKIT_RECORDING_S3_ENDPOINT")?.trim() || "",
              bucket: requiredEnv("LIVEKIT_RECORDING_S3_BUCKET"),
              forcePathStyle: Deno.env.get("LIVEKIT_RECORDING_S3_FORCE_PATH_STYLE")?.trim().toLowerCase() !== "false",
              contentDisposition: "inline",
            }),
          },
        });
        // Egress runs outside the Supabase Compose network, so it cannot call
        // the internal `http://kong:8000` URL used by Edge Functions. Always
        // prefer the externally reachable Supabase domain for callbacks.
        const webhookUrl = `${publicSupabaseUrl()}/functions/v1/livekit-egress?webhook=1`;
        const info = await egress.startRoomCompositeEgress(session.livekit_room, { file: output }, {
          layout: "single-speaker",
          encodingOptions: EncodingOptionsPreset.H264_720P_30,
          audioOnly: false,
          videoOnly: false,
          webhooks: [{ url: webhookUrl, signingKey: apiKey }],
        });
        startedEgressId = info.egressId;
        const result = await admin.from("live_sessions").update({
          recording_status: recordingState(info.status),
          recording_egress_id: info.egressId,
          recording_filepath: filepath,
          recording_error: null,
        }).eq("id", session.id).select("*").single();
        if (result.error) throw result.error;
        return json({ session: result.data, egress_id: info.egressId });
      } catch (error) {
        let recoveryPersisted = false;
        let recoveryInfo: EgressInfoLike | undefined;
        if (startedEgressId) {
          try {
            recoveryInfo = await egress.stopEgress(startedEgressId) as EgressInfoLike;
            recoveryInfo.egressId ||= startedEgressId;
            recoveryInfo.roomName ||= session.livekit_room;
            await persistEgressInfo(recoveryInfo, session.id);
            recoveryPersisted = true;
          } catch (stopError) {
            console.error("Não foi possível interromper a gravação após falha de persistência", stopError);
          }
        }
        if (!recoveryPersisted) {
          const repair = await admin.from("live_sessions").update({
            // Preserve the association even when LiveKit could not be reached
            // for the compensating stop. The webhook/status action can then
            // finish reconciling the real terminal state.
            recording_status: startedEgressId ? recordingState(recoveryInfo?.status ?? EGRESS_ENDING) : "failed",
            recording_egress_id: startedEgressId ?? null,
            recording_filepath: filepath,
            recording_error: error instanceof Error ? error.message : "Não foi possível iniciar a gravação",
          }).eq("id", session.id);
          if (repair.error) {
            console.error("Não foi possível preservar o vínculo da gravação", repair.error);
          }
        }
        throw error;
      }
    }

    if (!session.recording_egress_id) {
      if (body.action === "stop") {
        return json({ error: "A live não possui uma gravação automática ativa" }, 409);
      }
      return json({ session, skipped: true });
    }

    let info: EgressInfoLike | undefined;
    if (body.action === "stop" && ["starting", "recording"].includes(session.recording_status)) {
      info = await egress.stopEgress(session.recording_egress_id);
      await persistEgressInfo(info, session.id);
    }

    for (let attempt = 0; attempt < (body.action === "stop" ? 6 : 1); attempt += 1) {
      const items = await egress.listEgress({ egressId: session.recording_egress_id });
      info = items[0] as EgressInfoLike | undefined;
      if (info) await persistEgressInfo(info, session.id);
      if (!info || TERMINAL_STATUSES.has(Number(info.status))) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }

    const { data: updated } = await admin.from("live_sessions").select("*").eq("id", session.id).single();
    if (body.action === "stop") {
      const { data: ended, error: endError } = await admin.from("live_sessions").update({
        status: "ended",
        ended_at: session.ended_at || new Date().toISOString(),
      }).eq("id", session.id).select("*").single();
      if (endError) throw endError;
      const ready = ended?.recording_status === "ready" && !!ended?.recording_filepath && !!ended?.recording_url;
      return json({
        session: ended,
        egress_status: info?.status ?? null,
        processing: !ready && ended?.recording_status !== "failed",
      }, ready || ended?.recording_status === "failed" ? 200 : 202);
    }
    return json({ session: updated, egress_status: info?.status ?? null });
  } catch (error) {
    console.error("livekit-egress failed", error);
    const message = error instanceof Error ? error.message : "Não foi possível controlar a gravação";
    const status = /Não autorizado|Apenas a equipe/.test(message) ? 403 : 500;
    return json({ error: message }, status);
  }
});
