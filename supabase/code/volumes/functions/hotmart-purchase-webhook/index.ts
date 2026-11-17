import { createClient } from "npm:@supabase/supabase-js@2.114.0";
import { timingSafeEqual } from "node:crypto";

type PurchaseEvent = {
  event?: string;
  data?: {
    product?: { id?: number | string };
    purchase?: { transaction?: string };
  };
};

Deno.serve(async (request) => {
  if (request.method !== "POST") {
    return Response.json({ error: "method_not_allowed" }, { status: 405 });
  }

  const token = Deno.env.get("HOTMART_WEBHOOK_TOKEN")?.trim();
  const url = Deno.env.get("SUPABASE_URL");
  const key = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!token || !url || !key) {
    return Response.json({ error: "not_configured" }, { status: 503 });
  }

  const encoder = new TextEncoder();
  const actual = encoder.encode(request.headers.get("X-HOTMART-HOTTOK") ?? "");
  const expected = encoder.encode(token);
  if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }

  const payload = await request.json().catch(() => null) as PurchaseEvent | null;
  if (!payload?.event) {
    return Response.json({ error: "invalid_event" }, { status: 400 });
  }

  const event = payload.event;
  const product = String(payload.data?.product?.id ?? "");
  const transaction = payload.data?.purchase?.transaction;
  const validProduct = /^\d+$/.test(product);
  const validTransaction = typeof transaction === "string" &&
    /^[A-Za-z0-9_-]{1,100}$/.test(transaction);

  console.info("[hotmart-purchase-webhook] Evento recebido", JSON.stringify({
    event: typeof event === "string" && /^[A-Z_]{1,80}$/.test(event) ? event : null,
    product_id: validProduct && product.length <= 30 ? product : null,
    transaction: validTransaction ? transaction : null,
  }));

  const status = event === "PURCHASE_REFUNDED" ? "REFUNDED"
    : event === "PURCHASE_CHARGEBACK" ? "CHARGEBACK" : null;

  if (!status) {
    return Response.json({ received: true, ignored: true });
  }

  if (!validProduct || !validTransaction) {
    return Response.json({ error: "invalid_purchase" }, { status: 400 });
  }

  const admin = createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });

  const { data, error } = await admin.rpc("record_hotmart_purchase_reversal", {
    p_product_id: product,
    p_transaction: transaction,
    p_status: status,
  });

  if (error) {
    console.error("record_hotmart_purchase_reversal failed", error.code);
    return Response.json({ error: "reconciliation_failed" }, { status: 500 });
  }

  return Response.json({ received: true, affected: data });
});
