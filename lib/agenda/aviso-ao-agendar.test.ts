import { describe, expect, it, vi } from "vitest";

import type { EventRow } from "@/lib/event-log/dispatcher";
import {
  aplicaAvisoAoAgendar,
  montarAvisoAoAgendar,
  quandoPorExtenso,
  type AvisoAoAgendarDeps,
} from "@/lib/agenda/aviso-ao-agendar";

const AGORA = new Date("2026-11-11T15:00:00Z");

function evento(extra: Partial<EventRow> = {}): EventRow {
  return {
    id: "ev1",
    organization_id: "org1",
    event_type: "appointment.created",
    entity_kind: "calendar_appointment",
    entity_id: "ap1",
    payload: { appointment_id: "ap1", contact_id: "c1", event_type_name: "Demonstração" },
    metadata: {},
    consumed_by: [],
    attempts: 0,
    created_at: AGORA.toISOString(),
    ...extra,
  } as EventRow;
}

function deps(over: Partial<AvisoAoAgendarDeps> = {}) {
  const envia = vi.fn(async () => ({ externalId: "x" }));
  const base: AvisoAoAgendarDeps = {
    db: {
      carregaConfig: async () => ({ organization_id: "org1", channel_session_id: "ch1", telefone_destino: "+5585999990000", destino_jid: null, ligado: true }),
      carregaCompromisso: async () => ({ starts_at: "2026-11-12T11:00:00Z", time_zone: "America/Recife", created_by_kind: "ai" }),
      carregaContato: async () => ({ nome: "Maria Souza", telefone: "+55 85 99999-1111" }),
      carregaCanal: async () => ({ id: "ch1", status: "WORKING", archived_at: null, aceitaMensagemLivre: true }),
      registraJidDoAviso: async () => undefined,
      marcaDaOrganizacao: async () => ({ nome: "Opportunity", idioma: "pt-BR" }),
    },
    transporte: { configurado: async () => true, resolveDestino: async () => "5585999990000@c.us", envia },
    pacing: { decide: async () => ({ liberado: true }) as never, registraEnvio: async () => undefined },
    clock: () => AGORA,
    urlPublica: "https://crm.exemplo.com",
    origemDoDreno: () => "worker",
    audita: vi.fn(),
    ...over,
  };
  return { d: base, envia };
}

describe("aviso ao agendar", () => {
  it("manda ao número da equipe com cliente, telefone, horário e quem agendou", async () => {
    const { d, envia } = deps();
    const r = await aplicaAvisoAoAgendar(d, evento());
    expect(r.status).toBe("ok");
    const corpo = (envia.mock.calls[0] as unknown[])[3] as string;
    expect(corpo).toContain("a Ruby marcou um agendamento");
    expect(corpo).toContain("Maria");
    expect(corpo).toContain("+55 85 99999-1111");
    expect(corpo).toContain("08:00");
    expect(corpo).toContain("Demonstração");
  });

  it("fica quieto quando o aviso está desligado ou sem número (estado de teste)", async () => {
    const { d, envia } = deps({
      db: { ...deps().d.db, carregaConfig: async () => null },
    });
    expect((await aplicaAvisoAoAgendar(d, evento())).detail).toBe("sem_configuracao");
    expect(envia).not.toHaveBeenCalled();
  });

  it("ligado=false também não envia", async () => {
    const base = deps().d.db;
    const { d, envia } = deps({
      db: { ...base, carregaConfig: async () => ({ organization_id: "org1", channel_session_id: "ch1", telefone_destino: "+55", destino_jid: null, ligado: false }) },
    });
    expect((await aplicaAvisoAoAgendar(d, evento())).status).toBe("skipped");
    expect(envia).not.toHaveBeenCalled();
  });

  it("adia quando o dreno roda dentro de uma requisição", async () => {
    const { d, envia } = deps({ origemDoDreno: () => "request" });
    expect((await aplicaAvisoAoAgendar(d, evento())).status).toBe("retry");
    expect(envia).not.toHaveBeenCalled();
  });

  it("ignora outro tipo de evento e evento velho", async () => {
    const { d } = deps();
    expect((await aplicaAvisoAoAgendar(d, evento({ event_type: "appointment.cancelled" }))).detail).toBe("evento_ignorado");
    const velho = evento({ created_at: new Date(AGORA.getTime() - 60 * 60 * 1000).toISOString() });
    expect((await aplicaAvisoAoAgendar(d, velho)).detail).toBe("evento_velho");
  });

  it("agendamento feito pela equipe não diz que foi a Ruby", () => {
    const texto = montarAvisoAoAgendar({ marca: "X", idioma: "pt-BR", cliente: "Ana", telefone: null, quando: null, tipo: null, porIA: false, link: "https://x/app/agenda" });
    expect(texto).toContain("novo agendamento");
    expect(texto).not.toContain("a Ruby");
  });

  it("formata o horário no fuso do compromisso", () => {
    expect(quandoPorExtenso("2026-11-12T11:00:00Z", "America/Recife")).toMatch(/12\/11 às 08:00/);
    expect(quandoPorExtenso(null, null)).toBeNull();
  });
});
