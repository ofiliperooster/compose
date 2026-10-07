import { createClient } from "npm:@supabase/supabase-js@2";
import { AccessToken } from "npm:livekit-server-sdk@2.19.1";

type TokenRequest = {
  session_id?: string;
  role?: "publisher" | "audience";
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

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  try {
    if (req.method !== "POST") return json({ error: "Método não permitido" }, 405);

    const livekitUrl = Deno.env.get("LIVEKIT_URL")?.trim();
    const apiKey = Deno.env.get("LIVEKIT_API_KEY")?.trim();
    const apiSecret = Deno.env.get("LIVEKIT_API_SECRET")?.trim();
    if (!livekitUrl || !apiKey || !apiSecret) {
      console.error("LiveKit credentials are not configured");
      return json({ error: "Transmissão ainda não configurada" }, 503);
    }

    const body = await req.json() as TokenRequest;
    if (!body.session_id || (body.role !== "publisher" && body.role !== "audience")) {
      return json({ error: "Sessão ou papel inválido" }, 400);
    }

    const authorization = req.headers.get("Authorization");
    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!authorization || !supabaseUrl || !anonKey) return json({ error: "Não autorizado" }, 401);

    const supabase = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authorization } },
      auth: { persistSession: false, autoRefreshToken: false },
    });
    const accessToken = authorization.replace(/^Bearer\s+/i, "");
    const { data: { user }, error: userError } = await supabase.auth.getUser(accessToken);
    if (userError || !user) return json({ error: "Não autorizado" }, 401);

    const { data: session, error: sessionError } = await supabase
      .from("live_sessions")
      .select("id, status, livekit_room")
      .eq("id", body.session_id)
      .maybeSingle();
    if (sessionError || !session?.livekit_room) {
      console.error("Live lookup failed", sessionError);
      return json({ error: "Live não encontrada" }, 404);
    }

    if (body.role === "audience" && session.status !== "live") {
      return json({ error: "A live ainda não começou" }, 409);
    }

    if (body.role === "publisher") {
      const { data: profile, error: profileError } = await supabase
        .from("profiles")
        .select("role")
        .eq("id", user.id)
        .maybeSingle();
      if (profileError) console.error("Profile lookup failed", profileError);
      if (!profile || (profile.role !== "admin" && profile.role !== "support")) {
        return json({ error: "Somente a equipe pode transmitir" }, 403);
      }
    }

    const expiresIn = 4 * 60 * 60;
    const identity = `${body.role === "publisher" ? "host" : "viewer"}:${user.id}`;
    const token = new AccessToken(apiKey, apiSecret, { identity, ttl: expiresIn });
    token.addGrant({
      roomJoin: true,
      room: session.livekit_room,
      canPublish: body.role === "publisher",
      canSubscribe: true,
      canPublishData: false,
    });

    return json({
      url: livekitUrl,
      room: session.livekit_room,
      token: await token.toJwt(),
      identity,
      role: body.role,
      expires_in: expiresIn,
    });
  } catch (error) {
    console.error("livekit-token failed", error);
    return json({ error: "Não foi possível gerar o token da transmissão" }, 500);
  }
});
