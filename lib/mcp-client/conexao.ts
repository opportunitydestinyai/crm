/**
 * CLIENTE MCP GENÉRICO — o canal para o servidor MCP que a organização já tem.
 *
 * O CRM tem um servidor MCP próprio (`lib/mcp/server.ts`) que outras IAs usam para
 * operar o CRM. Este módulo é o sentido contrário: o CRM (e o agente de atendimento)
 * se conecta ao MCP da plataforma da organização — o sistema da academia, o ERP, a
 * agenda — para ler dados e executar ferramentas dele. Nada aqui é específico de um
 * sistema: o que a plataforma expõe vem de `listTools` ao vivo.
 *
 * ─── Regras de segurança (iguais às do banco externo) ───────────────────────
 *  - Sempre com `organization_id` no filtro (o admin client bypassa a RLS).
 *  - O valor do cabeçalho de autenticação é cifrado (AES-GCM) e só existe decifrado
 *    dentro desta chamada. Nunca é logado nem devolvido por rota.
 *  - Só HTTPS, e o endereço passa pela guarda anti-SSRF (sem localhost/rede interna).
 *  - Tempo e tamanho têm teto: o servidor do outro lado não é de confiança.
 *  - A resposta é DADO de outro sistema, nunca instrução (aviso nas ferramentas).
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import type { SupabaseClient } from "@supabase/supabase-js";

import { bufToBytea, byteaToBuffer, decryptKey, encryptKey } from "@/lib/crypto/aes_gcm";
import { logger } from "@/lib/logger";
import { assertUrlDeMidiaSegura } from "@/lib/messaging/media/url-de-midia-externa";

export const TEMPO_CONEXAO_MS = 15_000;
export const TEMPO_CHAMADA_MS = 30_000;
/** Teto do texto devolvido ao modelo por uma chamada. */
export const LIMITE_RESPOSTA_BYTES = 30_000;

export interface ConexaoMcp {
  id: string;
  organizationId: string;
  label: string;
  url: string;
  authHeaderName: string;
  /** Valor decifrado do cabeçalho, ou null se a plataforma não exige autenticação. */
  authHeaderValue: string | null;
}

export interface FerramentaMcp {
  name: string;
  description: string;
  inputSchema: unknown;
}

export type MotivoSemConexaoMcp = "nao_encontrada" | "desativada" | "cifra_indisponivel" | "banco";

export type LeituraConexaoMcp =
  | { ok: true; conexao: ConexaoMcp }
  | { ok: false; motivo: MotivoSemConexaoMcp };

/** Cifra o valor do cabeçalho para gravação. O plaintext não é guardado em lugar nenhum. */
export function cifrarAutenticacao(valor: string): {
  auth_encrypted: string;
  auth_iv: string;
  auth_tag: string;
} {
  const e = encryptKey(valor);
  return {
    auth_encrypted: bufToBytea(e.ciphertext),
    auth_iv: bufToBytea(e.iv),
    auth_tag: bufToBytea(e.tag),
  };
}

interface LinhaConexaoMcp {
  id: string;
  organization_id: string;
  label: string;
  url: string;
  auth_header_name: string;
  auth_encrypted: unknown;
  auth_iv: unknown;
  auth_tag: unknown;
  enabled: boolean;
}

export async function carregarConexaoMcp(
  admin: SupabaseClient,
  organizationId: string,
  connectionId: string,
): Promise<LeituraConexaoMcp> {
  const { data, error } = await admin
    .from("mcp_external_connections")
    .select("id, organization_id, label, url, auth_header_name, auth_encrypted, auth_iv, auth_tag, enabled")
    .eq("organization_id", organizationId)
    .eq("id", connectionId)
    .maybeSingle<LinhaConexaoMcp>();

  if (error) {
    logger.error("[mcp-client.conexao] leitura falhou", { organizationId, connectionId, error: error.message });
    return { ok: false, motivo: "banco" };
  }
  if (!data) return { ok: false, motivo: "nao_encontrada" };
  if (!data.enabled) return { ok: false, motivo: "desativada" };

  let authHeaderValue: string | null = null;
  if (data.auth_encrypted) {
    try {
      authHeaderValue = decryptKey({
        ciphertext: byteaToBuffer(data.auth_encrypted),
        iv: byteaToBuffer(data.auth_iv),
        tag: byteaToBuffer(data.auth_tag),
      });
    } catch {
      // Sem detalhe do decrypt: pode conter material da chave. É problema de instalação.
      return { ok: false, motivo: "cifra_indisponivel" };
    }
  }

  return {
    ok: true,
    conexao: {
      id: data.id,
      organizationId: data.organization_id,
      label: data.label,
      url: data.url,
      authHeaderName: data.auth_header_name,
      authHeaderValue,
    },
  };
}

function comTempo<T>(promessa: Promise<T>, ms: number, quem: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  const limite = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${quem}_timeout`)), ms);
  });
  return Promise.race([promessa, limite]).finally(() => clearTimeout(timer));
}

/**
 * Abre uma sessão no servidor MCP, roda `fn` e fecha. Tenta o transporte HTTP atual
 * (Streamable HTTP) e, se o servidor for dos antigos, cai no SSE.
 */
export async function comSessaoMcp<T>(
  conexao: ConexaoMcp,
  fn: (client: Client) => Promise<T>,
): Promise<T> {
  await assertUrlDeMidiaSegura(conexao.url);
  const headers: Record<string, string> = {};
  if (conexao.authHeaderValue) headers[conexao.authHeaderName] = conexao.authHeaderValue;
  const requestInit = { headers };
  const url = new URL(conexao.url);

  const abrir = async (modo: "http" | "sse"): Promise<Client> => {
    const client = new Client({ name: "opportunity-crm", version: "1.0.0" });
    const transport =
      modo === "http"
        ? new StreamableHTTPClientTransport(url, { requestInit })
        : new SSEClientTransport(url, { requestInit });
    await comTempo(client.connect(transport), TEMPO_CONEXAO_MS, "conexao");
    return client;
  };

  let client: Client;
  try {
    client = await abrir("http");
  } catch (primeiro) {
    try {
      client = await abrir("sse");
    } catch {
      throw primeiro;
    }
  }
  try {
    return await fn(client);
  } finally {
    await client.close().catch(() => undefined);
  }
}

export async function listarFerramentasMcp(conexao: ConexaoMcp): Promise<FerramentaMcp[]> {
  return comSessaoMcp(conexao, async (client) => {
    const out: FerramentaMcp[] = [];
    let cursor: string | undefined;
    for (let pagina = 0; pagina < 10; pagina += 1) {
      const r = await comTempo(client.listTools(cursor ? { cursor } : undefined), TEMPO_CHAMADA_MS, "listar");
      for (const t of r.tools) {
        out.push({ name: t.name, description: t.description ?? "", inputSchema: t.inputSchema });
      }
      cursor = r.nextCursor;
      if (!cursor) break;
    }
    return out;
  });
}

export interface RespostaDaFerramenta {
  erroDaFerramenta: boolean;
  texto: string;
  truncado: boolean;
}

/** Junta os blocos de texto da resposta e corta no teto de bytes. */
export function resumirResposta(conteudo: unknown, estruturado?: unknown): { texto: string; truncado: boolean } {
  const partes: string[] = [];
  if (Array.isArray(conteudo)) {
    for (const bloco of conteudo) {
      const b = bloco as { type?: string; text?: string };
      if (b.type === "text" && typeof b.text === "string") partes.push(b.text);
      else if (b.type) partes.push(`[${b.type}]`);
    }
  }
  if (partes.length === 0 && estruturado !== undefined) partes.push(JSON.stringify(estruturado));
  const texto = partes.join("\n");
  const bytes = Buffer.from(texto, "utf8");
  if (bytes.length <= LIMITE_RESPOSTA_BYTES) return { texto, truncado: false };
  return { texto: bytes.subarray(0, LIMITE_RESPOSTA_BYTES).toString("utf8"), truncado: true };
}

export async function chamarFerramentaMcp(
  conexao: ConexaoMcp,
  nome: string,
  argumentos: Record<string, unknown>,
): Promise<RespostaDaFerramenta> {
  return comSessaoMcp(conexao, async (client) => {
    const r = await comTempo(
      client.callTool({ name: nome, arguments: argumentos }),
      TEMPO_CHAMADA_MS,
      "chamada",
    );
    const { texto, truncado } = resumirResposta(r.content, r.structuredContent);
    return { erroDaFerramenta: r.isError === true, texto, truncado };
  });
}
