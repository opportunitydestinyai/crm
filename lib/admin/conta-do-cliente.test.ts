import { describe, expect, it } from "vitest";

import {
  centavosParaReais,
  diasAteOFim,
  diasDesdeOInicio,
  reaisParaCentavos,
  situacaoDaVigencia,
} from "@/lib/admin/conta-do-cliente";

const HOJE = new Date("2026-11-11T15:00:00Z");

describe("vigência do contrato", () => {
  it("conta os dias até o fim e desde o início", () => {
    expect(diasAteOFim("2026-12-11", HOJE)).toBe(30);
    expect(diasAteOFim("2026-11-10", HOJE)).toBe(-1);
    expect(diasAteOFim(null, HOJE)).toBeNull();
    expect(diasDesdeOInicio("2026-11-01", HOJE)).toBe(10);
    expect(diasDesdeOInicio("2026-12-01", HOJE)).toBeNull();
  });

  it("avisa a renovação dentro da janela e não antes", () => {
    expect(situacaoDaVigencia("2026-12-11", 30, "em_operacao", HOJE)).toMatchObject({ tom: "atencao", precisaRenovar: true });
    expect(situacaoDaVigencia("2027-03-01", 30, "em_operacao", HOJE)).toMatchObject({ tom: "ok", precisaRenovar: false });
  });

  it("vencido e vence hoje são problema", () => {
    expect(situacaoDaVigencia("2026-11-08", 30, "em_operacao", HOJE)).toMatchObject({ texto: "Venceu há 3 dias", tom: "problema" });
    expect(situacaoDaVigencia("2026-11-11", 30, "em_operacao", HOJE).texto).toBe("Vence hoje");
  });

  it("encerrado e cancelou não pedem renovação", () => {
    expect(situacaoDaVigencia("2026-11-08", 30, "encerrado", HOJE).precisaRenovar).toBe(false);
    expect(situacaoDaVigencia("2026-11-08", 30, "cancelou", HOJE).precisaRenovar).toBe(false);
  });
});

describe("dinheiro", () => {
  it.each([
    ["1.234,56", 123456],
    ["90", 9000],
    ["R$ 287,00", 28700],
    ["12.5", 1250],
  ])("lê %s", (texto, centavos) => {
    expect(reaisParaCentavos(texto)).toBe(centavos);
  });

  it.each(["", "abc", "1,2,3", "-5"])("recusa %j", (texto) => {
    expect(reaisParaCentavos(texto)).toBeNull();
  });

  it("formata em reais", () => {
    expect(centavosParaReais(28700)).toContain("287,00");
  });
});
