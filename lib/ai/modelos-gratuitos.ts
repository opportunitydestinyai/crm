/**
 * "Somente modelos gratuitos" — a trava da organização que decide se o seletor
 * de modelo do agente oferece só o que não cobra ou também os modelos pagos.
 *
 * Mora em `organizations.settings.llm.somente_gratuitos`. Ausente = LIGADA: uma
 * empresa nova nasce sem poder escolher, por engano, um modelo que cobra na
 * conta do provedor. Quem quer pagos liga a opção em IA › Provedores.
 */

export interface ModeloComPreco {
  model_id: string;
  input_price_per_million_cents?: number | null;
  output_price_per_million_cents?: number | null;
}

/** Gratuito = o agregador marca `:free` OU os dois preços são zero conhecidos. */
export function ehModeloGratuito(m: ModeloComPreco): boolean {
  if (m.model_id.endsWith(":free")) return true;
  return m.input_price_per_million_cents === 0 && m.output_price_per_million_cents === 0;
}

/** Lê a trava de `organizations.settings`. Valor ausente ou inválido = ligada. */
export function somenteGratuitosDaOrg(settings: unknown): boolean {
  const llm = (settings as { llm?: { somente_gratuitos?: unknown } } | null)?.llm;
  return llm?.somente_gratuitos !== false;
}
