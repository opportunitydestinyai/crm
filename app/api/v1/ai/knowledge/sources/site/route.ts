/**
 * POST /api/v1/ai/knowledge/sources/site — lê um site e o transforma em material.
 *
 * A pessoa informa o endereço do site da empresa; o servidor baixa as páginas
 * públicas (`lib/ai/rag/ingest/site.ts`), junta o texto num Markdown único e o
 * cadastra como material do tipo `documento` — o MESMO caminho do texto colado.
 * Por isso o chunking, o embedding e a busca já existentes valem, e nenhuma
 * tabela nem migration é necessária.
 *
 * Ler de novo o mesmo site ATUALIZA o material (mesmo nome), em vez de criar um
 * segundo: o site muda, e dois materiais iguais fariam o agente citar o antigo.
 *
 * Auth: sessão por cookie, papel >= manager. `organization_id` sai da sessão.
 */
import { randomUUID } from "node:crypto";
import { type NextRequest } from "next/server";
import { z } from "zod";

import { ok, fail } from "@/lib/api/wrappers";
import { audit } from "@/lib/audit";
import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";
import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import { BUCKET_DE_CONHECIMENTO } from "@/lib/ai/rag/ingest/documento";
import {
  LIMITES_PADRAO,
  lerSite,
  montarMarkdownDoSite,
  normalizarUrlDoSite,
} from "@/lib/ai/rag/ingest/site";
import { traduzir } from "@/lib/i18n/dicionario";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";
/** Ler dezenas de páginas leva segundos, mas o teto evita uma requisição eterna. */
export const maxDuration = 120;

const corpoSchema = z
  .object({
    url: z.string().trim().min(4).max(2048),
    name: z.string().trim().min(2).max(120).optional(),
    max_paginas: z.number().int().min(1).max(LIMITES_PADRAO.maxPaginasTeto).optional(),
  })
  .strict();

export async function POST(req: NextRequest): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;

  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "ai_knowledge" });
  if (!authz.ok) return authz.response;
  const t = (texto: string) => traduzir(texto, authz.user.idioma);
  const { org: activeOrg, user } = authz;

  let bruto: unknown;
  try {
    bruto = await req.json();
  } catch {
    return fail("invalid_request", t("Body JSON inválido."), 400, { requestId });
  }
  const parsed = corpoSchema.safeParse(bruto);
  if (!parsed.success) {
    return fail("validation_failed", t("Campos inválidos."), 422, {
      requestId,
      details: parsed.error.flatten(),
    });
  }

  try {
    normalizarUrlDoSite(parsed.data.url);
  } catch {
    return fail("validation_failed", t("Esse endereço de site não parece válido. Exemplo: minhaempresa.com.br"), 422, {
      requestId,
    });
  }

  const resultado = await lerSite(parsed.data.url, { maxPaginas: parsed.data.max_paginas });
  if (resultado.paginas.length === 0) {
    const motivos = resultado.ignoradas.slice(0, 3).map((i) => `${i.url}: ${i.motivo}`);
    return fail(
      "site_sem_conteudo",
      t("Não consegui ler nenhuma página desse site.") +
        (resultado.avisos.length > 0 ? ` ${resultado.avisos.join(" ")}` : "") +
        (motivos.length > 0 ? ` (${motivos.join("; ")})` : ""),
      422,
      { requestId },
    );
  }

  const { markdown, truncado } = montarMarkdownDoSite(resultado);
  const nome = parsed.data.name ?? `Site ${resultado.host}`;
  const admin = createAdminClient();

  const { data: existente, error: leituraErr } = await admin
    .from("ai_knowledge_sources")
    .select("id, status, source_metadata")
    .eq("organization_id", activeOrg.orgId)
    .eq("name", nome)
    .neq("status", "archived")
    .maybeSingle();
  if (leituraErr) {
    logger.error("[ai-knowledge-site] leitura do material existente falhou", { erro: leituraErr.message, requestId });
    return fail("internal_error", t("Erro ao conferir os materiais."), 500, { requestId });
  }
  const metaAnterior = (existente?.source_metadata ?? {}) as Record<string, unknown>;
  if (existente && metaAnterior.origem !== "site") {
    return fail(
      "knowledge_source_name_in_use",
      `Já existe um material chamado "${nome}" que não veio de um site. Escolha outro nome.`,
      409,
      { requestId },
    );
  }

  const blobPath = `${activeOrg.orgId}/${randomUUID()}.md`;
  const { error: upErr } = await admin.storage
    .from(BUCKET_DE_CONHECIMENTO)
    .upload(blobPath, Buffer.from(markdown, "utf8"), { contentType: "text/markdown", upsert: false });
  if (upErr) {
    logger.error("[ai-knowledge-site] guardar o texto falhou", { erro: upErr.message, requestId });
    return fail("internal_error", t("Erro ao guardar o conteúdo do material."), 500, { requestId });
  }

  const metadata = {
    blob_path: blobPath,
    ext: "md",
    origem: "site",
    site_url: resultado.origem,
    paginas: resultado.paginas.map((p) => ({ url: p.url, titulo: p.titulo })),
    paginas_ignoradas: resultado.ignoradas.length,
    lido_em: new Date().toISOString(),
  };

  let id: string;
  if (existente) {
    id = existente.id as string;
    const { error } = await admin
      .from("ai_knowledge_sources")
      .update({ source_metadata: metadata, status: "ready", is_active: true, ingested_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", activeOrg.orgId);
    if (error) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
      logger.error("[ai-knowledge-site] atualização falhou", { erro: error.message, requestId });
      return fail("internal_error", t("Erro ao atualizar o material."), 500, { requestId });
    }
    const antigo = metaAnterior.blob_path;
    if (typeof antigo === "string" && antigo !== blobPath) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([antigo]);
    }
  } else {
    const { data: novo, error } = await admin
      .from("ai_knowledge_sources")
      .insert({
        organization_id: activeOrg.orgId,
        agent_id: null,
        source_type: "documento",
        name: nome,
        status: "ready",
        is_active: true,
        source_metadata: metadata,
        ingested_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !novo) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
      logger.error("[ai-knowledge-site] criação falhou", { erro: error?.message, requestId });
      return fail("internal_error", t("Erro ao criar o material."), 500, { requestId });
    }
    id = (novo as { id: string }).id;
  }

  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: { knowledge_source_id: id, agent_id: null, source_type: "documento" },
    p_organization_id: activeOrg.orgId,
  } as never);
  if (emitErr) {
    logger.warn("[ai-knowledge-site] emit_event falhou (não bloqueia)", { erro: emitErr.message, requestId });
  }

  void audit({
    action: "ai.knowledge_site_read",
    actorUserId: user.id,
    organizationId: activeOrg.orgId,
    resourceType: "ai_knowledge_source",
    resourceId: id,
    requestId,
    metadata: { host: resultado.host, paginas: resultado.paginas.length, atualizado: Boolean(existente) },
  });

  const avisos = [...resultado.avisos];
  if (truncado) avisos.push("O texto do site passou do limite e foi cortado no final.");

  return ok(
    {
      id,
      nome,
      atualizado: Boolean(existente),
      paginas: resultado.paginas.length,
      caracteres: markdown.length,
      ignoradas: resultado.ignoradas.slice(0, 10),
      avisos,
      indexacao_habilitada: await temChaveDeEmbedding(activeOrg.orgId),
    },
    { status: existente ? 200 : 201, requestId },
  );
}
