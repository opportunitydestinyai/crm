/**
 * Material de consulta (RAG) de UM cliente, alimentado pelo painel da plataforma.
 *
 * O painel do CRM mestre (cartão do cliente) precisa alimentar o conhecimento de
 * um cliente SEM entrar no CRM dele. As rotas de `/api/v1/ai/knowledge/sources`
 * resolvem a organização pela sessão (cookie), então não servem a quem opera de
 * fora; este módulo é o mesmo caminho com a organização vinda por PARÂMETRO — e
 * quem chama (rotas de `/api/v1/admin/tenants/[id]/conhecimento`) já passou por
 * `requirePlatformAdmin`.
 *
 * O caminho de dados é o existente: blob no bucket privado + linha em
 * `ai_knowledge_sources` + evento `knowledge_source.updated`, e o indexador do
 * worker faz o resto. Nenhuma tabela nova.
 *
 * `admin` é service role e ignora RLS: TODA consulta aqui filtra
 * `organization_id`, que o chamador resolve do CAMINHO da rota, nunca do corpo.
 */
import { randomUUID } from "node:crypto";
import type { SupabaseClient } from "@supabase/supabase-js";

import { versionPayloadFrom } from "@/lib/ai/agents/duplicate";
import { publishAgentVersion } from "@/lib/ai/agents/publish";
import { temChaveDeEmbedding } from "@/lib/ai/embeddings/chave";
import {
  BUCKET_DE_CONHECIMENTO,
  ErroDeExtracao,
  extrairTextoDoArquivo,
  resolverExtensao,
} from "@/lib/ai/rag/ingest/documento";
import { lerSite, montarMarkdownDoSite, normalizarUrlDoSite } from "@/lib/ai/rag/ingest/site";
import { logger } from "@/lib/logger";

export const TAMANHO_MAXIMO_DO_ARQUIVO = 20 * 1024 * 1024;
const TEXTO_MAXIMO = 600_000;

export type Falha = { ok: false; status: number; code: string; message: string };
export type Resultado<T> = ({ ok: true } & T) | Falha;

const falha = (status: number, code: string, message: string): Falha => ({ ok: false, status, code, message });

type Admin = SupabaseClient;

export interface MaterialListado {
  id: string;
  nome: string;
  origem: "site" | "arquivo" | "texto";
  detalhe: string | null;
  status: string;
  trechos: number;
  indexacao: string | null;
  erro_de_indexacao: string | null;
  atualizado_em: string;
  em_uso_pela_ruby: boolean;
}

export interface PainelDeConhecimento {
  materiais: MaterialListado[];
  agente: { id: string; nome: string; versao: number } | null;
  chave_de_embedding: boolean;
  /** Materiais prontos que a versão publicada do agente ainda não enxerga. */
  fora_da_ruby: number;
}

async function agenteDaOrg(admin: Admin, orgId: string) {
  const { data: agente } = await admin
    .from("ai_agents")
    .select("id, name, published_version_id")
    .eq("organization_id", orgId)
    .not("published_version_id", "is", null)
    .is("archived_at", null)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();
  if (!agente?.published_version_id) return null;
  const { data: versao } = await admin
    .from("ai_agent_versions")
    .select("id, version_number, knowledge_source_ids")
    .eq("id", agente.published_version_id)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!versao) return null;
  return {
    id: agente.id as string,
    nome: agente.name as string,
    versao: versao.version_number as number,
    fontes: ((versao.knowledge_source_ids as string[] | null) ?? []) as string[],
  };
}

export async function painelDeConhecimento(admin: Admin, orgId: string): Promise<PainelDeConhecimento> {
  const [{ data: linhas }, agente, chave] = await Promise.all([
    admin
      .from("ai_knowledge_sources")
      .select("id, name, status, source_metadata, chunks_count, last_index_status, last_index_error, updated_at")
      .eq("organization_id", orgId)
      .neq("status", "archived")
      .order("created_at", { ascending: false }),
    agenteDaOrg(admin, orgId),
    temChaveDeEmbedding(orgId),
  ]);
  const emUso = new Set(agente?.fontes ?? []);
  const materiais: MaterialListado[] = (linhas ?? []).map((l) => {
    const meta = (l.source_metadata ?? {}) as Record<string, unknown>;
    const origem = meta.origem === "site" ? "site" : typeof meta.filename === "string" ? "arquivo" : "texto";
    return {
      id: l.id as string,
      nome: l.name as string,
      origem,
      detalhe: origem === "site" ? (meta.site_url as string | undefined) ?? null : (meta.filename as string | undefined) ?? null,
      status: l.status as string,
      trechos: (l.chunks_count as number | null) ?? 0,
      indexacao: (l.last_index_status as string | null) ?? null,
      erro_de_indexacao: (l.last_index_error as string | null) ?? null,
      atualizado_em: l.updated_at as string,
      em_uso_pela_ruby: emUso.has(l.id as string),
    };
  });
  return {
    materiais,
    agente: agente ? { id: agente.id, nome: agente.nome, versao: agente.versao } : null,
    chave_de_embedding: chave,
    fora_da_ruby: agente ? materiais.filter((m) => m.status === "ready" && !m.em_uso_pela_ruby).length : 0,
  };
}

interface Gravar {
  orgId: string;
  userId: string;
  nome: string;
  bytes: Buffer;
  ext: "md" | "pdf" | "txt" | "csv";
  mime: string;
  metadata: Record<string, unknown>;
  /** Mesmo nome + esta origem = atualiza o material em vez de recusar. */
  atualizaSeOrigem?: "site" | "texto";
  /** Roda depois do upload; se lançar, o blob é removido e a mensagem volta à pessoa. */
  validar?: (blobPath: string) => Promise<void>;
}

async function gravar(admin: Admin, g: Gravar): Promise<Resultado<{ id: string; atualizado: boolean }>> {
  const { data: existente } = await admin
    .from("ai_knowledge_sources")
    .select("id, source_metadata")
    .eq("organization_id", g.orgId)
    .eq("name", g.nome)
    .neq("status", "archived")
    .maybeSingle();
  const metaAnterior = (existente?.source_metadata ?? {}) as Record<string, unknown>;
  const origemAnterior = metaAnterior.origem === "site" ? "site" : typeof metaAnterior.filename === "string" ? "arquivo" : "texto";
  if (existente && origemAnterior !== g.atualizaSeOrigem) {
    return falha(409, "nome_em_uso", `Já existe um material chamado "${g.nome}". Escolha outro nome.`);
  }

  const blobPath = `${g.orgId}/${randomUUID()}.${g.ext}`;
  const { error: upErr } = await admin.storage
    .from(BUCKET_DE_CONHECIMENTO)
    .upload(blobPath, g.bytes, { contentType: g.mime, upsert: false });
  if (upErr) {
    logger.error("[material-da-plataforma] guardar o arquivo falhou", { erro: upErr.message });
    return falha(500, "internal_error", "Erro ao guardar o conteúdo do material.");
  }
  if (g.validar) {
    try {
      await g.validar(blobPath);
    } catch (err) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
      if (err instanceof ErroDeExtracao) return falha(422, "arquivo_ilegivel", err.message);
      logger.error("[material-da-plataforma] leitura do arquivo falhou", { erro: String(err) });
      return falha(500, "internal_error", "Erro ao ler o arquivo.");
    }
  }

  const metadata = { ...g.metadata, blob_path: blobPath, ext: g.ext, enviado_pela_plataforma_por: g.userId };
  let id: string;
  if (existente) {
    id = existente.id as string;
    const { error } = await admin
      .from("ai_knowledge_sources")
      .update({ source_metadata: metadata, status: "ready", is_active: true, ingested_at: new Date().toISOString() })
      .eq("id", id)
      .eq("organization_id", g.orgId);
    if (error) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
      return falha(500, "internal_error", "Erro ao atualizar o material.");
    }
    const antigo = metaAnterior.blob_path;
    if (typeof antigo === "string" && antigo !== blobPath) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([antigo]);
    }
  } else {
    const { data: novo, error } = await admin
      .from("ai_knowledge_sources")
      .insert({
        organization_id: g.orgId,
        agent_id: null,
        source_type: "documento",
        name: g.nome,
        status: "ready",
        is_active: true,
        source_metadata: metadata,
        ingested_at: new Date().toISOString(),
      })
      .select("id")
      .single();
    if (error || !novo) {
      await admin.storage.from(BUCKET_DE_CONHECIMENTO).remove([blobPath]);
      return falha(500, "internal_error", "Erro ao criar o material.");
    }
    id = (novo as { id: string }).id;
  }

  const { error: emitErr } = await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: { knowledge_source_id: id, agent_id: null, source_type: "documento" },
    p_organization_id: g.orgId,
  } as never);
  if (emitErr) logger.warn("[material-da-plataforma] emit_event falhou (não bloqueia)", { erro: emitErr.message });
  return { ok: true, id, atualizado: Boolean(existente) };
}

export async function registrarTexto(
  admin: Admin,
  p: { orgId: string; userId: string; nome: string; texto: string },
): Promise<Resultado<{ id: string; atualizado: boolean }>> {
  const texto = p.texto.trim();
  if (texto.length < 10) return falha(422, "texto_curto", "Escreva um texto um pouco maior.");
  if (texto.length > TEXTO_MAXIMO) return falha(413, "texto_grande", "O texto passa do limite de 600 mil caracteres.");
  return gravar(admin, {
    orgId: p.orgId,
    userId: p.userId,
    nome: p.nome,
    bytes: Buffer.from(texto, "utf8"),
    ext: "md",
    mime: "text/markdown",
    metadata: { origem: "texto", caracteres: texto.length },
    atualizaSeOrigem: "texto",
  });
}

export async function registrarSite(
  admin: Admin,
  p: { orgId: string; userId: string; url: string; nome?: string },
): Promise<Resultado<{ id: string; atualizado: boolean; paginas: number; avisos: string[] }>> {
  try {
    normalizarUrlDoSite(p.url);
  } catch {
    return falha(422, "site_invalido", "Esse endereço de site não parece válido. Exemplo: minhaempresa.com.br");
  }
  const lido = await lerSite(p.url, {});
  if (lido.paginas.length === 0) {
    const motivos = lido.ignoradas.slice(0, 3).map((i) => `${i.url}: ${i.motivo}`);
    return falha(
      422,
      "site_sem_conteudo",
      `Não consegui ler nenhuma página desse site.${lido.avisos.length ? ` ${lido.avisos.join(" ")}` : ""}${motivos.length ? ` (${motivos.join("; ")})` : ""}`,
    );
  }
  const { markdown, truncado } = montarMarkdownDoSite(lido);
  const r = await gravar(admin, {
    orgId: p.orgId,
    userId: p.userId,
    nome: p.nome ?? `Site ${lido.host}`,
    bytes: Buffer.from(markdown, "utf8"),
    ext: "md",
    mime: "text/markdown",
    metadata: {
      origem: "site",
      site_url: lido.origem,
      paginas: lido.paginas.map((x) => ({ url: x.url, titulo: x.titulo })),
      paginas_ignoradas: lido.ignoradas.length,
      lido_em: new Date().toISOString(),
    },
    atualizaSeOrigem: "site",
  });
  if (!r.ok) return r;
  const avisos = [...lido.avisos];
  if (truncado) avisos.push("O texto do site passou do limite e foi cortado no final.");
  return { ok: true, id: r.id, atualizado: r.atualizado, paginas: lido.paginas.length, avisos };
}

export async function registrarArquivo(
  admin: Admin,
  p: { orgId: string; userId: string; nome: string; arquivo: File },
): Promise<Resultado<{ id: string; atualizado: boolean }>> {
  if (p.arquivo.size > TAMANHO_MAXIMO_DO_ARQUIVO) return falha(413, "arquivo_grande", "O arquivo passa de 20 MB.");
  const ext = resolverExtensao(p.arquivo.name, p.arquivo.type);
  if (!ext) {
    return falha(415, "tipo_nao_suportado", "Não sei ler esse tipo de arquivo. Envie PDF, Markdown (.md), CSV (.csv) ou texto (.txt).");
  }
  const mime = { pdf: "application/pdf", md: "text/markdown", txt: "text/plain", csv: "text/csv" }[ext];
  return gravar(admin, {
    orgId: p.orgId,
    userId: p.userId,
    nome: p.nome,
    bytes: Buffer.from(await p.arquivo.arrayBuffer()),
    ext,
    mime,
    metadata: { filename: p.arquivo.name, mime_type: p.arquivo.type, size_bytes: p.arquivo.size },
    validar: async (blobPath) => {
      await extrairTextoDoArquivo(blobPath, ext);
    },
  });
}

export async function arquivarMaterial(admin: Admin, orgId: string, id: string): Promise<Resultado<object>> {
  const { data, error } = await admin
    .from("ai_knowledge_sources")
    .update({ status: "archived", is_active: false })
    .eq("id", id)
    .eq("organization_id", orgId)
    .neq("status", "archived")
    .select("id")
    .maybeSingle();
  if (error) return falha(500, "internal_error", "Não foi possível remover o material.");
  if (!data) return falha(404, "not_found", "Material não encontrado.");
  await admin.rpc("emit_event" as never, {
    p_event_type: "knowledge_source.updated",
    p_entity_kind: "ai_knowledge_source",
    p_entity_id: id,
    p_payload: { knowledge_source_id: id, agent_id: null, source_type: "documento" },
    p_organization_id: orgId,
  } as never);
  return { ok: true };
}

/**
 * Faz a Ruby do cliente enxergar TODOS os materiais prontos.
 *
 * O vínculo mora na VERSÃO do agente e uma versão publicada é imutável (trigger
 * `fn_ai_agent_version_content_immutable`), então "ligar" é criar uma versão
 * nova — cópia da publicada, só com `knowledge_source_ids` trocado — e
 * publicá-la. É o mesmo caminho de `applyProposal`.
 */
export async function ligarMateriaisAARuby(
  admin: Admin,
  orgId: string,
  userId: string,
): Promise<Resultado<{ mudou: boolean; versao?: number }>> {
  const agente = await agenteDaOrg(admin, orgId);
  if (!agente) return falha(409, "agente_nao_publicado", "Este cliente ainda não tem um agente publicado.");

  const { data: prontos } = await admin
    .from("ai_knowledge_sources")
    .select("id")
    .eq("organization_id", orgId)
    .eq("status", "ready")
    .eq("is_active", true);
  const ids = (prontos ?? []).map((r) => r.id as string).sort();
  const atuais = [...agente.fontes].sort();
  if (ids.length === atuais.length && ids.every((v, i) => v === atuais[i])) return { ok: true, mudou: false };

  const { data: agenteRow } = await admin
    .from("ai_agents")
    .select("published_version_id")
    .eq("id", agente.id)
    .eq("organization_id", orgId)
    .maybeSingle();
  const { data: base } = await admin
    .from("ai_agent_versions")
    .select("*")
    .eq("id", agenteRow?.published_version_id as string)
    .eq("organization_id", orgId)
    .maybeSingle();
  if (!base) return falha(500, "internal_error", "Versão publicada não encontrada.");

  const { data: maxRow } = await admin
    .from("ai_agent_versions")
    .select("version_number")
    .eq("agent_id", agente.id)
    .eq("organization_id", orgId)
    .order("version_number", { ascending: false })
    .limit(1)
    .maybeSingle();
  const proxima = ((maxRow?.version_number as number | undefined) ?? 0) + 1;

  const { data: criada, error } = await admin
    .from("ai_agent_versions")
    .insert({
      organization_id: orgId,
      agent_id: agente.id,
      version_number: proxima,
      ...versionPayloadFrom(base),
      knowledge_source_ids: ids,
      status: "draft",
      created_by: userId,
    })
    .select("id, version_number")
    .single();
  if (error || !criada) return falha(500, "internal_error", "Não foi possível criar a versão nova do agente.");

  const publicada = await publishAgentVersion(admin, { orgId, agentId: agente.id, versionId: criada.id as string });
  if (!publicada.ok) {
    return falha(422, publicada.code, `A publicação foi recusada (${publicada.code}). A versão ficou como rascunho.`);
  }
  return { ok: true, mudou: true, versao: criada.version_number as number };
}
