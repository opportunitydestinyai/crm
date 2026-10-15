import { describe, expect, it } from "vitest";
import { format } from "date-fns";

import { DICIONARIO, traduzir } from "@/lib/i18n/dicionario";
import italiano from "@/lib/i18n/traducoes/it.json";
import { localeDeData, tagDeIdioma } from "@/lib/i18n/datas";
import { normalizarIdioma, parseAcceptLanguage } from "@/lib/i18n/idiomas";
import { NAV_CATALOG, NAV_GROUPS } from "@/lib/navigation/catalogo";
import { lerDiagnosticoGoogle } from "@/lib/conversoes/historico";

const catalogo: Record<string, string> = italiano;
const tokens = (s: string) => s.match(/\{\{?[^{}\n]+\}?\}|https?:\/\/[^\s]+|`[^`]+`/g) ?? [];

describe("italiano: catálogo, parâmetros e preferência", () => {
  it("cobre todas as frases do dicionário sem traduções vazias", () => {
    expect(Object.keys(DICIONARIO).length).toBeGreaterThan(8000);
    expect(Object.keys(DICIONARIO).filter((chave) => !catalogo[chave]?.trim())).toEqual([]);
  });

  it("preserva parâmetros, URLs e trechos de código de cada frase", () => {
    expect(
      Object.keys(DICIONARIO).filter(
        (chave) => JSON.stringify(tokens(chave)) !== JSON.stringify(tokens(catalogo[chave] ?? "")),
      ),
    ).toEqual([]);
  });

  it("resolve os textos reais da navegação e seus hubs", () => {
    const textos: string[] = [];
    for (const item of NAV_CATALOG) {
      textos.push(item.label, item.description);
      if ("section" in item) textos.push(item.section);
    }
    for (const grupo of NAV_GROUPS) {
      textos.push(grupo.label);
      if (grupo.hub) textos.push(grupo.hub.label);
    }
    expect(textos.filter((texto) => !catalogo[texto])).toEqual([]);
    expect(traduzir("Configurações", "it")).toBe("Impostazioni");
    expect(traduzir("Senha", "it")).toBe("Password");
    expect(traduzir("testo sconosciuto", "it")).toBe("testo sconosciuto");
  });

  it("aceita italiano e mantém o padrão histórico para valores desconhecidos", () => {
    expect(normalizarIdioma("it")).toBe("it");
    expect(normalizarIdioma("xx")).toBe("pt-BR");
    expect(parseAcceptLanguage("it-IT,it;q=0.9,en;q=0.8")).toBe("it");
    expect(tagDeIdioma("it")).toBe("it-IT");
    expect(format(new Date(2026, 9, 4), "EEEE d MMMM", { locale: localeDeData("it") })).toBe(
      "domenica 4 ottobre",
    );
  });

  it.each([
    ["MMMM 'de' yyyy", "ottobre 2026"],
    ["d 'de' MMM", "4 ott"],
    ["d 'de' MMMM", "4 ottobre"],
    ["EEEE, d 'de' MMMM", "domenica, 4 ottobre"],
    ["EEEE, d 'de' MMM", "domenica, 4 ott"],
    ["d 'de' MMMM 'às' HH:mm", "4 ottobre alle 09:30"],
    ["EEEE, d 'de' MMMM 'às' HH:mm", "domenica, 4 ottobre alle 09:30"],
  ])("formata o padrão real da agenda %s sem corromper tokens", (padrao, esperado) => {
    expect(format(new Date(2026, 9, 4, 9, 30), traduzir(padrao, "it"), {
      locale: localeDeData("it"),
    })).toBe(esperado);
  });

  it.each([false, true])(
    "descreve o envio real quando habilitada=%s, sem confundir conexão e envio",
    async (habilitada) => {
      // Real diagnostic branching; database responses contain no customer data or external calls.
      const admin = {
        from() {
          const query = {
            select: () => query,
            eq: () => query,
            gte: () => query,
            in: () => query,
            order: () => query,
            limit: () => query,
            maybeSingle: async () => ({ data: null, error: null }),
            then: (resolve: (value: unknown) => unknown) =>
              Promise.resolve({ data: [], count: 0, error: null }).then(resolve),
          };
          return query;
        },
      };
      const diagnostico = await lerDiagnosticoGoogle(admin as never, "org-sintetica", {
        instalacaoConfigurada: true,
        habilitada,
        temRefreshToken: true,
        customerId: "test",
        temAcaoDeVenda: false,
        etapasAbertas: 0,
      });
      const conexao = diagnostico.find((item) => item.chave === "conexao")!;
      const detalhe = traduzir(conexao.detalhe, "it");
      expect(detalhe).toContain("account è collegato");
      expect(detalhe).toContain(habilitada ? "invio è attivo" : "invio è disattivato");
      expect(conexao.saude).toBe(habilitada ? "ok" : "atencao");
      if (!habilitada) expect(traduzir(conexao.titulo, "it")).toBe("Invio sospeso");
      expect(detalhe).not.toContain("caricamento");
    },
  );

  it("mantém as instruções executáveis de rastreio, não traduz nomes de atributos HTML", () => {
    const chave = Object.keys(catalogo).find((s) =>
      s.startsWith("Para não guardar a origem na aba,"),
    )!;
    const instrucao = traduzir(chave, "it");
    expect(instrucao).toContain('data-storage="none"');
    expect(instrucao).toContain("data-rastreio-ignorar");
    expect(instrucao).toContain("escludere un link dal tracciamento");
    expect(instrucao).not.toContain("data-track-ignor");
  });

  it("explica o CSV mantendo os cabeçalhos reconhecidos pelo importador", () => {
    const chave = Object.keys(catalogo).find((s) =>
      s.startsWith("Envie um arquivo .csv com cabeçalho"),
    )!;
    const instrucao = traduzir(chave, "it");
    expect(instrucao).toContain("nome, telefone, email, cpf, nascimento, tags");
    expect(instrucao).toContain("500 righe per file");
    expect(traduzir("Importar", "it")).toBe("Importa");
    expect(traduzir("Nome da etapa", "it")).toBe("Nome della fase");
    expect(traduzir("Novo lead", "it")).toBe("Nuovo lead");
  });
});
