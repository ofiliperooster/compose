import { createClient } from 'npm:@supabase/supabase-js@2.114.0';

const headers = {
  'Access-Control-Allow-Origin': 'https://criaracesso.casadeisabel.com.br',
  'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Cache-Control': 'no-store',
};
const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
const authOptions = { persistSession: false, autoRefreshToken: false };

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers });
  if (req.method !== 'POST') return json({ error: 'Método inválido' }, 405);
  const { token } = await req.json().catch(() => ({}));
  if (typeof token !== 'string' || !/^[a-f0-9]{64}$/.test(token)) return json({ error: 'Link inválido ou expirado.' }, 400);
  try {
    const url = Deno.env.get('SUPABASE_URL')!;
    const admin = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!, { auth: authOptions });
    const { data: email, error: ticketError } = await admin.rpc('consume_courtesy_password_invitation', { p_token: token });
    if (ticketError) throw new Error('ticket_storage');
    if (!email) return json({ error: 'Link expirado, utilizado ou revogado. Solicite um novo e-mail de acesso.' }, 410);
    // Auth still generates and verifies a native short-lived token, immediately.
    const link = await admin.auth.admin.generateLink({ type: 'magiclink', email });
    if (link.error || !link.data.properties?.hashed_token) throw new Error('auth_link');
    const client = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { auth: authOptions });
    const verified = await client.auth.verifyOtp({ token_hash: link.data.properties.hashed_token, type: 'email' });
    if (verified.error || !verified.data.session) throw new Error('auth_verify');
    return json({ session: { access_token: verified.data.session.access_token, refresh_token: verified.data.session.refresh_token } });
  } catch {
    // Never log the ticket or Auth credentials.
    return json({ error: 'Não foi possível iniciar a criação de senha. Solicite um novo e-mail de acesso.' }, 503);
  }
});
