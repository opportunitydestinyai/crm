import { describe, expect, it } from "vitest";

import { deveClassificarEtapa } from "@/lib/agent-engine/agent/stage-classifier";

describe("deveClassificarEtapa — só gasta o classificador quando há sinal de mudança de etapa", () => {
  it.each([
    "pode ser amanhã às 8h",
    "quero treinar segunda de manhã",
    "vou pensar e depois eu falo",
    "não quero mais, obrigado",
    "fechado, pode marcar",
    "quanto custa o plano?",
    "às 18:30 eu consigo",
  ])("roda em: %s", (texto) => {
    expect(deveClassificarEtapa(texto)).toBe(true);
  });

  it.each(["oi", "bom dia", "como funciona?", "", "   "])("não roda em: %j", (texto) => {
    expect(deveClassificarEtapa(texto)).toBe(false);
  });
});
