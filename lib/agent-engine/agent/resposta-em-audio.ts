/**
 * RESPONDER EM ÁUDIO QUANDO O CLIENTE MANDA ÁUDIO.
 *
 * Regra comercial (dono, 06/11/2026): quem escreve texto recebe texto; quem manda
 * áudio recebe áudio. A voz vem do Gemini (modelo TTS) com a MESMA credencial Google
 * da organização que já conversa — nenhuma chave nova.
 *
 * Falha-macio: qualquer problema (organização sem Google, TTS fora, texto longo,
 * upload recusado) devolve `null` e o chamador manda o texto normal. O áudio é
 * melhoria de experiência; a resposta é o produto.
 *
 * O arquivo sai como WAV (PCM 24 kHz do Gemini embrulhado em cabeçalho). O WAHA
 * converte para nota de voz (`sendVoice` com `convert: true`, ver `lib/waha/media-send.ts`).
 */
import { randomUUID } from 'node:crypto';
import type pg from 'pg';
import type { SupabaseClient } from '@supabase/supabase-js';

import { resolveOrgLlmConfig, type LlmEdgeConfig } from '../edge/llm/credentials';

export const MODELO_DE_VOZ = 'gemini-2.5-flash-preview-tts';
export const VOZ_PADRAO = 'Kore';
/** Acima disto o áudio fica longo demais para uma conversa: vai texto. */
export const MAX_CHARS_PARA_AUDIO = 700;
const BUCKET_DA_CONVERSA = 'whatsapp-media';
const SAMPLE_RATE = 24000;

const DIRECAO_DE_VOZ =
  'Fale em português do Brasil, com sotaque brasileiro natural, tom caloroso e descontraído, como uma pessoa real conversando no WhatsApp: ';

interface Log {
  warn(msg: string, fields?: Record<string, unknown>): void;
}

/** Texto como será FALADO: sem marcação que a voz leria em voz alta. */
export function textoParaFala(texto: string): string {
  return texto
    .replace(/https?:\/\/\S+/g, '')
    .replace(/[*_`#>~]+/g, '')
    .replace(/^\s*[-•]\s+/gm, '')
    .replace(/\s*\n+\s*/g, '. ')
    .replace(/\s{2,}/g, ' ')
    .trim();
}

/** PCM 16 bits mono do Gemini → WAV (o WAHA converte para nota de voz). */
export function pcmParaWav(pcm: Buffer, sampleRate: number = SAMPLE_RATE): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(sampleRate, 24);
  h.writeUInt32LE(sampleRate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** A mensagem que abriu o turno foi um áudio? (recorte por org + conversa + id + inbound) */
export async function mensagemRecebidaFoiAudio(
  db: Pick<pg.Pool, 'query'>,
  input: { tenantId: string; conversationId: string; inboundMessageId: string },
): Promise<boolean> {
  const { rows } = await db.query<{ type: string }>(
    `select type from messages
      where organization_id = $1 and conversation_id = $2 and id = $3 and direction = 'inbound'
      limit 1`,
    [input.tenantId, input.conversationId, input.inboundMessageId],
  );
  return rows[0]?.type === 'audio';
}

export async function sintetizarVoz(args: {
  apiKey: string;
  texto: string;
  voz?: string;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}): Promise<Buffer | null> {
  const f = args.fetchFn ?? fetch;
  const res = await f(
    `https://generativelanguage.googleapis.com/v1beta/models/${MODELO_DE_VOZ}:generateContent`,
    {
      method: 'POST',
      headers: { 'x-goog-api-key': args.apiKey, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: DIRECAO_DE_VOZ + args.texto }] }],
        generationConfig: {
          responseModalities: ['AUDIO'],
          speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: args.voz ?? VOZ_PADRAO } } },
        },
      }),
      signal: AbortSignal.timeout(args.timeoutMs ?? 45_000),
    },
  );
  if (!res.ok) return null;
  const json = (await res.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ inlineData?: { data?: string } }> } }>;
  };
  const b64 = json.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data)?.inlineData?.data;
  return b64 ? Buffer.from(b64, 'base64') : null;
}

export interface DepsDoAudio {
  pool: pg.Pool;
  llmCfg: LlmEdgeConfig;
  supabase: SupabaseClient;
  log: Log;
}

/**
 * Gera a voz do `texto` e guarda na pasta da conversa. Devolve o caminho para o
 * envio como mídia, ou `null` (e o chamador manda texto).
 */
export async function prepararRespostaEmAudio(
  deps: DepsDoAudio,
  args: { tenantId: string; conversationId: string; texto: string },
): Promise<{ storagePath: string; mime: string } | null> {
  try {
    const fala = textoParaFala(args.texto);
    if (fala === '' || fala.length > MAX_CHARS_PARA_AUDIO) return null;

    const org = await resolveOrgLlmConfig(deps.pool, deps.llmCfg, args.tenantId);
    if (org.provider !== 'google' || !org.apiKey) return null;

    const pcm = await sintetizarVoz({ apiKey: org.apiKey, texto: fala });
    if (pcm === null || pcm.length === 0) return null;

    const storagePath = `${args.tenantId}/${args.conversationId}/${randomUUID()}.wav`;
    const { error } = await deps.supabase.storage
      .from(BUCKET_DA_CONVERSA)
      .upload(storagePath, pcmParaWav(pcm), { contentType: 'audio/wav' });
    if (error) {
      deps.log.warn('áudio da resposta não guardado (segue em texto)', { detalhe: error.message.slice(0, 120) });
      return null;
    }
    return { storagePath, mime: 'audio/wav' };
  } catch (err) {
    deps.log.warn('não consegui gerar o áudio da resposta (segue em texto)', {
      error: err instanceof Error ? err.name : 'unknown',
    });
    return null;
  }
}
