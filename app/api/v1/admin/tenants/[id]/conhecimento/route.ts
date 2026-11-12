import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import {
  arquivarMaterial,
  ligarMateriaisAARuby,
  painelDeConhecimento,
  registrarSite,
  registrarTexto,
} from "@/lib/ai/rag/material-da-plataforma";

export const dynamic = "force-dynamic";
/** Ler dezenas de páginas de um site leva segundos. */
export const maxDuration = 120;

/**
 * Conhecimento (RAG) de um cliente, alimentado pelo CRM mestre.
 * Regras em `lib/ai/rag/material-da-plataforma.ts`. O `organization_id` vem do
 * CAMINHO; o corpo nunca o define.
 */

type Ctx = { params: Promise<{ id: string }> };
const uuid = z.string().uuid();

const nome = z.string().trim().min(2).max(120);
const corpoSchema = z.discriminatedUnion("acao", [
  z.object({ acao: z.literal("site"), url: z.string().trim().min(4).max(2048), name: nome.optional() }).strict(),
  z.object({ acao: z.literal("texto"), name: nome, texto: z.string().min(10).max(600_000) }).strict(),
  z.object({ acao: z.literal("ligar") }).strict(),
]);

async function organizacaoExiste(admin: ReturnType<typeof createAdminClient>, id: string) {
  const { data } = await admin.from("organizations").select("id").eq("id", id).maybeSingle();
  return Boolean(data);
}

export async function GET(_req: NextRequest, { params }: Ctx) {
  const requestId = randomUUID();
  const { id } = await params;
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  if (!uuid.safeParse(id).success) return fail("validation_error", "id inválido", 400, { requestId });
  const admin = createAdminClient();
  if (!(await organizacaoExiste(admin, id))) return fail("not_found", "Cliente não encontrado", 404, { requestId });
  return ok(await painelDeConhecimento(admin, id), { requestId });
}

export async function POST(req: NextRequest, { params }: Ctx) {
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
  if (!uuid.safeParse(id).success) return fail("validation_error", "id inválido", 400, { requestId });

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("validation_error", "JSON inválido", 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_error", "Dados inválidos", 400, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  if (!(await organizacaoExiste(admin, id))) return fail("not_found", "Cliente não encontrado", 404, { requestId });
  const d = parsed.data;

  const resultado =
    d.acao === "site"
      ? await registrarSite(admin, { orgId: id, userId: ctx.user.id, url: d.url, nome: d.name })
      : d.acao === "texto"
        ? await registrarTexto(admin, { orgId: id, userId: ctx.user.id, nome: d.name, texto: d.texto })
        : await ligarMateriaisAARuby(admin, id, ctx.user.id);

  if (!resultado.ok) return fail(resultado.code, resultado.message, resultado.status, { requestId });

  void audit({
    action: "platform_admin.customer_knowledge_changed",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "ai_knowledge_source",
    requestId,
    metadata: { acao: d.acao },
  });
  return ok(resultado, { requestId, status: d.acao === "ligar" ? 200 : 201 });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
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
  const fonteId = req.nextUrl.searchParams.get("fonte_id");
  if (!uuid.safeParse(id).success || !uuid.safeParse(fonteId).success) {
    return fail("validation_error", "Informe fonte_id", 400, { requestId });
  }
  const admin = createAdminClient();
  const r = await arquivarMaterial(admin, id, fonteId as string);
  if (!r.ok) return fail(r.code, r.message, r.status, { requestId });
  void audit({
    action: "platform_admin.customer_knowledge_changed",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "ai_knowledge_source",
    resourceId: fonteId as string,
    requestId,
    metadata: { acao: "removido" },
  });
  return ok({ removido: true }, { requestId });
}
