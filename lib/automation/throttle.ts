/**
 * Anti-banimento do envio AUTOMATIZADO: limite diário da sessão e espaçamento
 * 1.2s + jitter.
 *
 * ═══ A JANELA DE HORÁRIO NÃO MORA MAIS AQUI ═══
 *
 * Se você veio procurar por `withinSendWindow()`: ela foi REMOVIDA, e não por
 * arrumação. Ela media a janela com `new Date().getHours()` — o relógio do
 * processo —, e o contêiner de produção roda em UTC (`TZ=UTC`, declarado no
 * `Dockerfile.scheduler` e no `docker-compose.prod.yml`). A faixa "7h–22h"
 * virava 4h–19h de Brasília: a automação represava um envio das 19h30 até as
 * 4h da manhã, e mandava mensagem para o cliente às 5h.
 *
 * Pior que o fuso: era uma SEGUNDA régua. A faixa que o dono do negócio
 * configura em Conexões › Proteção de envio valia para o agente de IA e não
 * valia para a automação, sem nada na tela dizendo isso.
 *
 * A janela agora é UMA só, vem de `channel_knobs` e é avaliada no fuso do
 * tenant: `lib/automation/janela-do-canal.ts`, que chama a mesma regra pura
 * de `lib/agent-engine/pacing/`. Precisa de janela? Use aquele módulo — não
 * ressuscite uma régua local aqui.
 */
import type { SupabaseClient } from "@supabase/supabase-js";

import { lerEstadoDoPacing } from "@/lib/agent-engine/pacing/ledger-supabase";
import { dayStartInTz, proximaAberturaDaJanela } from "@/lib/agent-engine/pacing/engine";
import { knobsDoCanal } from "@/lib/automation/janela-do-canal";

export interface ThrottleVerdict {
  allowed: boolean;
  retry_at?: string;
  reason?: string;
}

export async function checkDailyLimit(
  admin: SupabaseClient,
  organizationId: string,
  channelSessionId: string,
): Promise<ThrottleVerdict> {
  const { data: session } = await admin
    .from("channel_sessions")
    .select("daily_message_limit")
    .eq("id", channelSessionId)
    .eq("organization_id", organizationId)
    .maybeSingle();
  const limit = (session as { daily_message_limit?: number } | null)?.daily_message_limit ?? 300;

  // "Hoje" e o retry valem no FUSO DO TENANT (mesmo knob da janela de envio),
  // não no UTC do contêiner.
  const agora = new Date();
  const knobs = await knobsDoCanal(admin, organizationId, channelSessionId);
  // Quem conta envio de verdade é o `pacing_ledger` (o mesmo do agente); as
  // ações de automação gravam nele em `reportarEnvio`.
  const { sentToday: sent } = await lerEstadoDoPacing(admin, organizationId, channelSessionId, {
    agora,
    timezone: knobs.timezone,
  });

  if (sent >= limit) {
    // O `retry_at` vem da régua única da janela (fuso do tenant): abertura da
    // janela no dia local seguinte, não `setHours` no relógio do processo.
    const meiaNoiteAmanha = new Date(dayStartInTz(agora, knobs.timezone).getTime() + 25 * 3600_000);
    const abertura = proximaAberturaDaJanela(dayStartInTz(meiaNoiteAmanha, knobs.timezone), knobs);
    return { allowed: false, retry_at: abertura.toISOString(), reason: "daily_limit" };
  }
  return { allowed: true };
}

export const AUTOMATED_SEND_SPACING_MS = 1200;

export function jitterMs(): number {
  return Math.floor(Math.random() * 801);
}

/**
 * Espaçamento entre envios automatizados do MESMO número, dentro do tique do
 * drain. Intervalo fixo é assinatura de robô, daí o jitter.
 *
 * O estado é de módulo — suficiente para a instância única do cron, e é o que
 * já valia quando isto morava dentro da ação de WhatsApp. Virou função aqui
 * porque a ação de IA precisa do MESMO espaçamento: duas cópias do contador
 * dariam a cada uma seu próprio relógio, e duas ações na mesma regra
 * disparariam em rajada pelo mesmo número — exatamente o padrão que faz o
 * WhatsApp banir.
 */
const _ultimoEnvioPorSessao = new Map<string, number>();

export async function espacarEnvio(sessionId: string): Promise<void> {
  const ultimo = _ultimoEnvioPorSessao.get(sessionId) ?? 0;
  const esperar = ultimo + AUTOMATED_SEND_SPACING_MS + jitterMs() - Date.now();
  if (esperar > 0) await new Promise((r) => setTimeout(r, esperar));
  _ultimoEnvioPorSessao.set(sessionId, Date.now());
}
