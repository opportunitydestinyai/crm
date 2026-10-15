/**
 * GET/PUT /api/v1/ai/somente-gratuitos — a trava "só modelos gratuitos" da empresa.
 *
 * GET (manager+) lê; PUT (admin) liga/desliga. A trava só filtra o que o
 * seletor de modelo oferece (`GET /api/v1/ai/providers/:provider/models`) —
 * chave de provedor pago continua cadastrável em IA › Credenciais.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { somenteGratuitosDaOrg } from "@/lib/ai/modelos-gratuitos";
import { createAdminClient } from "@/lib/supabase/admin";

export const dynamic = "force-dynamic";

const bodySchema = z.object({ somente_gratuitos: z.boolean() });

export async function GET(_req: NextRequest): Promise<Response> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_models" });
  if (!authz.ok) return authz.response;

  const admin = createAdminClient();
  const { data, error } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (error) return fail("internal_error", "Erro ao ler a configuração.", 500, { requestId });

  return ok({ somente_gratuitos: somenteGratuitosDaOrg(data?.settings) }, { requestId });
}

export async function PUT(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("admin", { requestId, resource: "ai_models" });
  if (!authz.ok) return authz.response;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_failed", "JSON inválido.", 422, { requestId });
  }
  const parsed = bodySchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_failed", "Payload inválido.", 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  const admin = createAdminClient();
  const { data: atual, error: leituraErr } = await admin
    .from("organizations")
    .select("settings")
    .eq("id", authz.org.orgId)
    .maybeSingle();
  if (leituraErr || !atual) {
    return fail("internal_error", "Erro ao ler a configuração.", 500, { requestId });
  }

  const settings = (atual.settings ?? {}) as Record<string, unknown>;
  const llm = (settings.llm ?? {}) as Record<string, unknown>;
  const antes = somenteGratuitosDaOrg(settings);
  const novo = { ...settings, llm: { ...llm, somente_gratuitos: parsed.data.somente_gratuitos } };

  const { error } = await admin
    .from("organizations")
    .update({ settings: novo })
    .eq("id", authz.org.orgId);
  if (error) return fail("internal_error", "Não consegui salvar.", 500, { requestId });

  void audit({
    action: "ai.somente_gratuitos_changed",
    actorUserId: authz.user.id,
    organizationId: authz.org.orgId,
    resourceType: "organization",
    resourceId: authz.org.orgId,
    requestId,
    metadata: { antes, depois: parsed.data.somente_gratuitos },
  });

  return ok({ somente_gratuitos: parsed.data.somente_gratuitos }, { requestId });
}
