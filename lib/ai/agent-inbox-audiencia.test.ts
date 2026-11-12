import { describe, expect, it } from "vitest";

import { AUDIENCIA_DO_KIND, KIND_LABEL, audienciaDoKind } from "@/lib/ai/agent-inbox-copy";

describe("audiência dos avisos da Central", () => {
  it("todo kind com rótulo tem público definido", () => {
    for (const kind of Object.keys(KIND_LABEL)) {
      expect(Object.keys(AUDIENCIA_DO_KIND)).toContain(kind);
    }
  });

  it("WhatsApp caído é técnico; cliente esperando decisão é da equipe", () => {
    expect(audienciaDoKind("qr_rescan")).toBe("operacao");
    expect(audienciaDoKind("conhecimento_nao_indexado")).toBe("operacao");
    expect(audienciaDoKind("handoff")).toBe("equipe");
    expect(audienciaDoKind("case_stale")).toBe("equipe");
  });

  it("kind desconhecido cai na equipe, nunca some", () => {
    expect(audienciaDoKind("kind_do_futuro")).toBe("equipe");
  });
});
