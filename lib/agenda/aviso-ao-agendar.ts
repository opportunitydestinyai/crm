// lib/agenda/aviso-ao-agendar.ts
/**
 * Quando um compromisso é CRIADO (pela Ruby ou pela equipe), a EQUIPE recebe um
 * WhatsApp com quem agendou, quando e o telefone do cliente — "como se fosse uma
 * funcionária avisando".
 *
 * Mesmo desenho do aviso de proposta (`lib/propostas/aviso-no-whatsapp.ts`) e do
 * aviso de caso: regra pura, dependências injetadas, nunca devolve `error`, e o
 * número de destino é o MESMO da configuração do aviso de caso
 * (`config_aviso_de_caso`). Não há chave própria: o aviso fica DESLIGADO enquanto
 * essa configuração estiver desligada ou sem número — é a decisão do dono para o
 * período de testes (o número dele é o de teste).
 *
 * Sem tabela de entrega: a baixa do evento é a trava. Uma queda exatamente entre
 * o envio e a baixa pode repetir o aviso — para a equipe, nunca para o cliente.
 */
import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  ADIAMENTO_DO_CANAL_MS,
  ADIAMENTO_DO_DRENO_EM_REQUEST_MS,
  IDADE_MAXIMA_DO_EVENTO_MS,
  TETO_DE_TENTATIVAS_DE_ENVIO,
  TETO_DE_TENTATIVAS_DO_CANAL,
  mascara,
  type CanalDoAviso,
  type ConfigDoAviso,
  type PacingDoAviso,
  type TransporteDoAviso,
} from "@/lib/escalacao/aviso-ao-suporte";
import { primeiroNome } from "@/lib/escalacao/texto-do-aviso";
import { urlPublicaUsavel } from "@/lib/escalacao/url-publica";
import { traduzir } from "@/lib/i18n/dicionario";
import type { Idioma } from "@/lib/i18n/idiomas";

export const EVENTO_AGENDAMENTO_CRIADO = "appointment.created";

export interface CompromissoDoAviso {
  starts_at: string | null;
  time_zone: string | null;
  created_by_kind: string | null;
}

export interface ContatoDoAviso {
  nome: string | null;
  telefone: string | null;
}

export interface AvisoAoAgendarDb {
  carregaConfig(orgId: string): Promise<ConfigDoAviso | null>;
  carregaCompromisso(orgId: string, id: string): Promise<CompromissoDoAviso | null>;
  carregaContato(orgId: string, contactId: string): Promise<ContatoDoAviso | null>;
  carregaCanal(orgId: string, channelSessionId: string): Promise<CanalDoAviso | null>;
  registraJidDoAviso(orgId: string, jid: string): Promise<void>;
  marcaDaOrganizacao(orgId: string): Promise<{ nome: string; idioma: Idioma }>;
}

export interface AvisoAoAgendarDeps {
  db: AvisoAoAgendarDb;
  transporte: TransporteDoAviso;
  pacing: PacingDoAviso;
  clock: () => Date;
  urlPublica: string;
  origemDoDreno: () => "worker" | "request";
  audita: (entrada: {
    action: "agenda.aviso_whatsapp_enviado" | "agenda.aviso_whatsapp_falhou";
    organizationId: string;
    appointmentId: string;
    metadata: Record<string, unknown>;
  }) => void;
}

export interface DesfechoDoAvisoAoAgendar {
  status: "ok" | "skipped" | "retry";
  detail: string;
  retry_at?: string;
}

const skipped = (detail: string): DesfechoDoAvisoAoAgendar => ({ status: "skipped", detail });
const retry = (quando: Date, detail: string): DesfechoDoAvisoAoAgendar => ({ status: "retry", detail, retry_at: quando.toISOString() });

/** "qui, 12/11 às 08:00" no fuso do compromisso; `null` quando a data não existe. */
export function quandoPorExtenso(inicioISO: string | null, fuso: string | null): string | null {
  if (!inicioISO) return null;
  const d = new Date(inicioISO);
  if (Number.isNaN(d.getTime())) return null;
  try {
    const partes = new Intl.DateTimeFormat("pt-BR", {
      timeZone: fuso ?? "America/Sao_Paulo",
      weekday: "short",
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(d);
    const p = (tipo: string) => partes.find((x) => x.type === tipo)?.value ?? "";
    return `${p("weekday").replace(".", "")}, ${p("day")}/${p("month")} às ${p("hour")}:${p("minute")}`;
  } catch {
    return null;
  }
}

export function montarAvisoAoAgendar(e: {
  marca: string;
  idioma: Idioma;
  cliente: string | null;
  telefone: string | null;
  quando: string | null;
  tipo: string | null;
  porIA: boolean;
  link: string;
}): string {
  const t = (texto: string): string => traduzir(texto, e.idioma);
  const linhas = [`📅 ${e.marca}: ${e.porIA ? t("a Ruby marcou um agendamento") : t("novo agendamento")}`, ""];
  const cliente = primeiroNome(e.cliente);
  if (cliente) linhas.push(`${t("Cliente")}: ${cliente}`);
  if (e.telefone) linhas.push(`${t("Telefone")}: ${e.telefone}`);
  if (e.quando) linhas.push(`${t("Quando")}: ${e.quando}`);
  const tipo = (e.tipo ?? "").trim().slice(0, 80);
  if (tipo) linhas.push(`${t("Assunto")}: ${tipo}`);
  linhas.push("", `${t("Ver na agenda")}: ${e.link}`, "");
  linhas.push(t("Responder aqui não chega ao cliente — fale com ele pelo telefone acima ou pela conversa no CRM."));
  return linhas.join("\n");
}

function passouDoTeto(row: EventRow, agora: Date): boolean {
  if (!row.created_at) return false;
  const emitido = Date.parse(row.created_at);
  return !Number.isNaN(emitido) && agora.getTime() - emitido > IDADE_MAXIMA_DO_EVENTO_MS;
}

export async function aplicaAvisoAoAgendar(deps: AvisoAoAgendarDeps, row: EventRow): Promise<DesfechoDoAvisoAoAgendar> {
  if (row.event_type !== EVENTO_AGENDAMENTO_CRIADO) return skipped("evento_ignorado");
  const agora = deps.clock();
  const orgId = row.organization_id;

  if (deps.origemDoDreno() === "request") {
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_DRENO_EM_REQUEST_MS), "adiado: dreno dentro da requisição");
  }

  const compromissoId =
    (typeof row.payload.appointment_id === "string" ? row.payload.appointment_id : null) ??
    (typeof row.entity_id === "string" ? row.entity_id : null);
  if (!compromissoId) return skipped("payload_incompleto");

  const cfg = await deps.db.carregaConfig(orgId);
  if (!cfg || !cfg.ligado || !cfg.channel_session_id) return skipped("sem_configuracao");
  const canalId = cfg.channel_session_id;

  if (passouDoTeto(row, agora)) return skipped("evento_velho");

  const compromisso = await deps.db.carregaCompromisso(orgId, compromissoId);
  if (!compromisso) return skipped("compromisso_nao_encontrado");

  const tentativa = row.attempts + 1;
  const falha = (codigo: string): DesfechoDoAvisoAoAgendar => {
    deps.audita({
      action: "agenda.aviso_whatsapp_falhou",
      organizationId: orgId,
      appointmentId: compromissoId,
      metadata: { codigo, canal: canalId, tentativas: tentativa },
    });
    return skipped(codigo);
  };

  const canal = await deps.db.carregaCanal(orgId, canalId);
  if (!canal || canal.archived_at) return falha("canal_arquivado");
  if (!canal.aceitaMensagemLivre) return falha("canal_nao_aceita_aviso_livre");
  if (canal.status !== "WORKING") {
    if (tentativa >= TETO_DE_TENTATIVAS_DO_CANAL) return falha("canal_desconectado");
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), `canal ${canal.status}`);
  }

  if (!urlPublicaUsavel(deps.urlPublica)) return falha("sem_endereco_publico");

  if (!(await deps.transporte.configurado(orgId, canal))) {
    if (tentativa >= TETO_DE_TENTATIVAS_DE_ENVIO) return falha("transporte_ausente");
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "transporte fora do ar");
  }

  const pacing = await deps.pacing.decide(orgId, canalId, agora);
  if (!pacing.liberado) return retry(pacing.liberaEm, `pacing:${pacing.motivo}`);

  const to = await deps.transporte.resolveDestino(orgId, canal, cfg.telefone_destino);
  if (!to) return falha("destino_invalido");

  const contactId = typeof row.payload.contact_id === "string" ? row.payload.contact_id : null;
  const marca = await deps.db.marcaDaOrganizacao(orgId);
  const contato = contactId ? await deps.db.carregaContato(orgId, contactId) : null;
  const tipo = typeof row.payload.event_type_name === "string" ? row.payload.event_type_name : null;
  const body = montarAvisoAoAgendar({
    marca: marca.nome,
    idioma: marca.idioma,
    cliente: contato?.nome ?? null,
    telefone: contato?.telefone ?? null,
    quando: quandoPorExtenso(compromisso.starts_at, compromisso.time_zone),
    tipo,
    porIA: compromisso.created_by_kind === "ai",
    link: `${deps.urlPublica.replace(/\/+$/, "")}/app/agenda`,
  });

  try {
    await deps.transporte.envia(orgId, canal, to, body);
  } catch {
    if (tentativa >= TETO_DE_TENTATIVAS_DE_ENVIO) return falha("falha_no_envio");
    return retry(new Date(agora.getTime() + ADIAMENTO_DO_CANAL_MS), "envio recusado");
  }

  // Depois do envio TUDO falha aberto: a mensagem já saiu, e lançar aqui faria o
  // dreno reprocessar e a equipe receber de novo.
  try {
    await deps.pacing.registraEnvio(orgId, canalId, agora);
  } catch {
    /* o ledger é best-effort depois do envio */
  }
  try {
    await deps.db.registraJidDoAviso(orgId, to);
  } catch {
    /* idem */
  }
  deps.audita({
    action: "agenda.aviso_whatsapp_enviado",
    organizationId: orgId,
    appointmentId: compromissoId,
    metadata: { canal: canalId, tentativas: tentativa, destino_mascarado: mascara(cfg.telefone_destino), por_ia: compromisso.created_by_kind === "ai" },
  });
  return { status: "ok", detail: `enviado canal=${canalId}` };
}
