import { describe, expect, it, vi } from "vitest";

import {
  mensagemRecebidaFoiAudio,
  pcmParaWav,
  sintetizarVoz,
  textoParaFala,
} from "@/lib/agent-engine/agent/resposta-em-audio";

describe("textoParaFala", () => {
  it("tira marcação, links e listas que a voz leria em voz alta", () => {
    const f = textoParaFala("**Planos:**\n- Padrão: R$ 287\n- Pro: R$ 387\nVeja https://exemplo.com/x");
    expect(f).not.toMatch(/[*#]|https?:/);
    expect(f).toContain("Padrão: R$ 287");
    expect(f).not.toMatch(/\n/);
  });
});

describe("pcmParaWav", () => {
  it("monta cabeçalho WAV válido de 24 kHz mono 16 bits", () => {
    const pcm = Buffer.alloc(4800);
    const wav = pcmParaWav(pcm);
    expect(wav.length).toBe(44 + 4800);
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(4800);
  });
});

describe("sintetizarVoz", () => {
  it("devolve os bytes de áudio quando o Gemini responde", async () => {
    const dados = Buffer.from([1, 2, 3, 4]).toString("base64");
    const fetchFn = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ candidates: [{ content: { parts: [{ inlineData: { data: dados } }] } }] }),
    });
    const out = await sintetizarVoz({ apiKey: "k", texto: "Oi", fetchFn: fetchFn as unknown as typeof fetch });
    expect(out?.length).toBe(4);
    const [, init] = fetchFn.mock.calls[0]!;
    expect((init as RequestInit).headers).toMatchObject({ "x-goog-api-key": "k" });
  });

  it("devolve null quando o Gemini recusa (o chamador manda texto)", async () => {
    const fetchFn = vi.fn().mockResolvedValue({ ok: false, json: async () => ({}) });
    expect(await sintetizarVoz({ apiKey: "k", texto: "Oi", fetchFn: fetchFn as unknown as typeof fetch })).toBeNull();
  });
});

describe("mensagemRecebidaFoiAudio", () => {
  it("só é verdade para mensagem inbound do tipo audio, recortada por org + conversa + id", async () => {
    const query = vi.fn().mockResolvedValue({ rows: [{ type: "audio" }] });
    const ok = await mensagemRecebidaFoiAudio({ query } as never, { tenantId: "o", conversationId: "c", inboundMessageId: "m" });
    expect(ok).toBe(true);
    expect(query.mock.calls[0]![0]).toMatch(/direction = 'inbound'/);
    expect(query.mock.calls[0]![1]).toEqual(["o", "c", "m"]);
    query.mockResolvedValue({ rows: [{ type: "text" }] });
    expect(await mensagemRecebidaFoiAudio({ query } as never, { tenantId: "o", conversationId: "c", inboundMessageId: "m" })).toBe(false);
    query.mockResolvedValue({ rows: [] });
    expect(await mensagemRecebidaFoiAudio({ query } as never, { tenantId: "o", conversationId: "c", inboundMessageId: "m" })).toBe(false);
  });
});
