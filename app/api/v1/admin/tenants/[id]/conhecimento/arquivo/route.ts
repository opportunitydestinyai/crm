import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { registrarArquivo } from "@/lib/ai/rag/material-da-plataforma";

export const dynamic = "force-dynamic";

/** Envio de arquivo (PDF, Markdown, CSV ou texto, até 20 MB) para o conhecimento de um cliente. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id } = await params;

  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  if (!z.string().uuid().safeParse(id).success) return fail("validation_error", "id inválido", 400, { requestId });

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return fail("invalid_request", "Falha ao processar o envio do arquivo.", 400, { requestId });
  }
  const arquivo = form.get("file");
  if (!(arquivo instanceof File)) return fail("invalid_request", "Nenhum arquivo foi enviado.", 400, { requestId });
  const nome = z.string().trim().min(2).max(120).safeParse(form.get("name") ?? arquivo.name.replace(/\.[^.]+$/, ""));
  if (!nome.success) return fail("validation_failed", "Dê um nome ao material (2 a 120 caracteres).", 422, { requestId });

  const admin = createAdminClient();
  const { data: org } = await admin.from("organizations").select("id").eq("id", id).maybeSingle();
  if (!org) return fail("not_found", "Cliente não encontrado", 404, { requestId });

  const r = await registrarArquivo(admin, { orgId: id, userId: ctx.user.id, nome: nome.data, arquivo });
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });

  void audit({
    action: "platform_admin.customer_knowledge_changed",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "ai_knowledge_source",
    resourceId: r.id,
    requestId,
    metadata: { acao: "arquivo", extensao: arquivo.name.split(".").pop()?.toLowerCase() ?? null },
  });
  return ok({ id: r.id, atualizado: r.atualizado }, { requestId, status: 201 });
}
