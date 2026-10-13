// Follow this setup guide to integrate the Deno language server with your editor:
// https://deno.land/manual/getting_started/setup_your_environment
// This enables autocomplete, go to definition, etc.

// Setup type definitions for built-in Supabase Runtime APIs
import "@supabase/functions-js/edge-runtime.d.ts";
import { withSupabase } from "@supabase/server";
import { extractHotmartCohort } from "./cohort.ts";

type HotmartRequest = { payload?: unknown; user_id?: string; email?: string };

export default {
  fetch: withSupabase({ auth: ["publishable", "secret"] }, async (req, ctx) => {
    let input: HotmartRequest;
    try {
      input = await req.json() as HotmartRequest;
    } catch {
      return Response.json({ error: "invalid_json" }, { status: 400 });
    }

    const cohort = extractHotmartCohort(input.payload ?? input);
    if (!cohort) {
      return Response.json({ error: "cohort_not_found", message: "Nenhuma turma no formato T19 foi encontrada em plan.name." }, { status: 422 });
    }
    if (!input.user_id && !input.email) return Response.json({ status: "parsed", cohort });
    if (ctx.authMode !== "secret") return Response.json({ error: "secret_required" }, { status: 403 });

    let userId = input.user_id;
    if (!userId && input.email) {
      const normalizedEmail = input.email.trim().toLocaleLowerCase();
      for (let page = 1; page <= 10 && !userId; page += 1) {
        const { data, error } = await ctx.supabaseAdmin.auth.admin.listUsers({ page, perPage: 1000 });
        if (error) return Response.json({ error: "user_lookup_failed", message: error.message }, { status: 500 });
        userId = data.users.find((user) => user.email?.toLocaleLowerCase() === normalizedEmail)?.id;
        if (data.users.length < 1000) break;
      }
    }
    if (!userId) return Response.json({ error: "user_not_found" }, { status: 404 });

    const { error } = await ctx.supabaseAdmin.from("profiles").update({ cohort_number: cohort.cohortNumber }).eq("id", userId);
    if (error) return Response.json({ error: "profile_update_failed", message: error.message }, { status: 500 });
    return Response.json({ status: "updated", user_id: userId, cohort });
  }),
};
