import { afterEach, describe, expect, it, vi } from "vitest";

import {
  calcularAtrasoHumano,
  manterDigitando,
} from "@/lib/agent-engine/agent/atraso-humano";
import type { Logger } from "@/lib/agent-engine/obs/logger";

const log: Logger = { info: () => undefined, warn: () => undefined, error: () => undefined };

describe("calcularAtrasoHumano com faixa larga", () => {
  const knobs = { atrasoMinimoMs: 5000, atrasoMaximoMs: 30000 };

  it("sorteia o alvo entre o mínimo e o máximo", () => {
    expect(calcularAtrasoHumano("Oi", knobs, () => 0)).toBe(5000);
    expect(calcularAtrasoHumano("Oi", knobs, () => 1)).toBe(30000);
    expect(calcularAtrasoHumano("Oi", knobs, () => 0.5)).toBe(17500);
  });

  it("sem fonte de sorteio, segue só pelo tamanho do texto (comportamento de antes)", () => {
    expect(calcularAtrasoHumano("Oi", knobs)).toBe(5000);
  });

  it("faixa pequena (o default) não sorteia", () => {
    expect(calcularAtrasoHumano("Oi", undefined, () => 1)).toBe(1200);
  });
});

describe("manterDigitando", () => {
  afterEach(() => vi.useRealTimers());

  it("acende já, renova no intervalo e para quando mandam parar", async () => {
    vi.useFakeTimers();
    const sinal = vi.fn().mockResolvedValue(undefined);
    const parar = manterDigitando(sinal, log, { renovaMs: 1000, tetoMs: 60_000 });
    expect(sinal).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(3000);
    expect(sinal).toHaveBeenCalledTimes(4);
    parar();
    await vi.advanceTimersByTimeAsync(5000);
    expect(sinal).toHaveBeenCalledTimes(4);
  });

  it("para sozinho no teto de segurança", async () => {
    vi.useFakeTimers();
    const sinal = vi.fn().mockResolvedValue(undefined);
    manterDigitando(sinal, log, { renovaMs: 1000, tetoMs: 3000 });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(sinal.mock.calls.length).toBeLessThanOrEqual(4);
  });

  it("falha do canal não derruba nada", async () => {
    vi.useFakeTimers();
    const sinal = vi.fn().mockRejectedValue(new Error("fora do ar"));
    const parar = manterDigitando(sinal, log, { renovaMs: 1000 });
    await vi.advanceTimersByTimeAsync(2500);
    parar();
    expect(sinal).toHaveBeenCalled();
  });
});
