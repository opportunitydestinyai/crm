/**
 * Regras puras do cartão do cliente no CRM mestre (migration 0536).
 *
 * Sem rede e sem relógio próprio: `hoje` entra por parâmetro, e é por isso que
 * o teste exercita o "faltam N dias" sem depender do dia em que roda.
 */

export const ETAPAS_DO_CLIENTE = [
  "contratou",
  "configurando",
  "em_operacao",
  "renovacao",
  "encerrado",
  "cancelou",
] as const;
export type EtapaDoCliente = (typeof ETAPAS_DO_CLIENTE)[number];

export const ROTULO_DA_ETAPA: Record<EtapaDoCliente, string> = {
  contratou: "Contratou",
  configurando: "Configurando",
  em_operacao: "Em operação",
  renovacao: "Renovação",
  encerrado: "Encerrado",
  cancelou: "Cancelou",
};

/** Uma frase por etapa: aparece no "?" ao passar o mouse. */
export const AJUDA_DA_ETAPA: Record<EtapaDoCliente, string> = {
  contratou: "Fechou o contrato, mas ainda não começamos a configurar.",
  configurando: "Estamos montando o CRM e o agente do cliente.",
  em_operacao: "Está usando o sistema normalmente.",
  renovacao: "Perto do fim da vigência: hora de conversar sobre renovar.",
  encerrado: "O contrato terminou sem renovação. Sem multa: acabou o prazo.",
  cancelou: "O cliente cancelou antes do fim do contrato. Aqui entra a multa, se houver.",
};

export const PAGAMENTOS_DO_CLIENTE = ["pago", "pendente", "atrasado"] as const;
export type PagamentoDoCliente = (typeof PAGAMENTOS_DO_CLIENTE)[number];

export const ROTULO_DO_PAGAMENTO: Record<PagamentoDoCliente, string> = {
  pago: "Pago",
  pendente: "Pendente",
  atrasado: "Atrasado",
};

export type TomDoAviso = "ok" | "atencao" | "problema" | "neutro";

const MS_POR_DIA = 24 * 60 * 60 * 1000;

function dia(aaaammdd: string): number {
  const [a = 0, m = 1, d = 1] = aaaammdd.split("-").map(Number);
  return Date.UTC(a, m - 1, d);
}

/** Dias inteiros de `hoje` até `fim` (negativo = já venceu). `null` sem data. */
export function diasAteOFim(fim: string | null, hoje: Date): number | null {
  if (!fim) return null;
  const h = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());
  return Math.round((dia(fim) - h) / MS_POR_DIA);
}

/** Dias inteiros desde o início do contrato. `null` sem data ou se ainda não começou. */
export function diasDesdeOInicio(inicio: string | null, hoje: Date): number | null {
  if (!inicio) return null;
  const h = Date.UTC(hoje.getUTCFullYear(), hoje.getUTCMonth(), hoje.getUTCDate());
  const n = Math.round((h - dia(inicio)) / MS_POR_DIA);
  return n < 0 ? null : n;
}

export interface SituacaoDaVigencia {
  texto: string;
  tom: TomDoAviso;
  /** Já entrou na janela de aviso de renovação (ou venceu). */
  precisaRenovar: boolean;
}

export function situacaoDaVigencia(
  fim: string | null,
  avisoDias: number,
  etapa: EtapaDoCliente,
  hoje: Date,
): SituacaoDaVigencia {
  if (etapa === "cancelou") return { texto: "Contrato cancelado", tom: "neutro", precisaRenovar: false };
  if (etapa === "encerrado") return { texto: "Contrato encerrado", tom: "neutro", precisaRenovar: false };
  const dias = diasAteOFim(fim, hoje);
  if (dias === null) return { texto: "Sem data de fim definida", tom: "neutro", precisaRenovar: false };
  if (dias < 0) {
    const n = Math.abs(dias);
    return { texto: `Venceu há ${n} dia${n === 1 ? "" : "s"}`, tom: "problema", precisaRenovar: true };
  }
  if (dias === 0) return { texto: "Vence hoje", tom: "problema", precisaRenovar: true };
  if (dias <= avisoDias) {
    return {
      texto: `Faltam ${dias} dia${dias === 1 ? "" : "s"} — hora de falar de renovação`,
      tom: "atencao",
      precisaRenovar: true,
    };
  }
  return { texto: `Faltam ${dias} dias`, tom: "ok", precisaRenovar: false };
}

/** "1.234,56" / "1234.5" / "R$ 90" → centavos. `null` se não for um valor. */
export function reaisParaCentavos(texto: string): number | null {
  const limpo = texto.replace(/[R$\s]/g, "");
  if (limpo === "") return null;
  // Se tem vírgula, ela é o decimal e os pontos são milhar.
  const normal = limpo.includes(",") ? limpo.replace(/\./g, "").replace(",", ".") : limpo;
  if (!/^\d+(\.\d{1,2})?$/.test(normal)) return null;
  return Math.round(Number(normal) * 100);
}

export function centavosParaReais(centavos: number): string {
  return (centavos / 100).toLocaleString("pt-BR", { style: "currency", currency: "BRL" });
}
