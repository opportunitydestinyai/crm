import { describe, expect, it } from "vitest";

import {
  converterHtml,
  decodificarEmailCloudflare,
  lerRobots,
  lerSitemap,
  lerSite,
  linkVisitavel,
  montarMarkdownDoSite,
  normalizarUrlDoSite,
} from "./site";

/** Site falso em memória: caminho -> resposta. Nada sai para a rede. */
function siteFalso(paginas: Record<string, { status?: number; tipo?: string; corpo?: string; local?: string }>) {
  const pedidos: string[] = [];
  const fetchFn = (async (entrada: RequestInfo | URL) => {
    const url = typeof entrada === "string" ? entrada : entrada.toString();
    pedidos.push(url);
    const u = new URL(url);
    const chave = `${u.origin}${u.pathname}${u.search}`;
    const p = paginas[chave];
    if (!p) return new Response("não achei", { status: 404, headers: { "content-type": "text/html" } });
    const headers: Record<string, string> = { "content-type": p.tipo ?? "text/html; charset=utf-8" };
    if (p.local) headers.location = p.local;
    return new Response(p.corpo ?? "", { status: p.status ?? 200, headers });
  }) as typeof fetch;
  return { fetchFn, pedidos };
}

const semGuard = async () => {};

const pagina = (titulo: string, corpo: string) =>
  `<!doctype html><html><head><title>${titulo}</title><meta name="description" content="Descrição de ${titulo}"></head><body>${corpo}</body></html>`;

describe("normalizarUrlDoSite", () => {
  it("aceita endereço sem esquema e tira o hash", () => {
    expect(normalizarUrlDoSite("minhaempresa.com.br").toString()).toBe("https://minhaempresa.com.br/");
    expect(normalizarUrlDoSite(" https://x.com/a#topo ").toString()).toBe("https://x.com/a");
  });
  it("recusa o que não é um site", () => {
    expect(() => normalizarUrlDoSite("")).toThrow("url_vazia");
    expect(() => normalizarUrlDoSite("ftp://x.com")).toThrow("url_esquema");
    expect(() => normalizarUrlDoSite("localhost")).toThrow("url_invalida");
  });
});

describe("linkVisitavel", () => {
  const base = "https://site.com.br/a/";
  it("aceita link do mesmo site (com ou sem www) e resolve link relativo", () => {
    expect(linkVisitavel("/sobre", base, "site.com.br")).toBe("https://site.com.br/sobre");
    expect(linkVisitavel("https://www.site.com.br/x/", base, "site.com.br")).toBe("https://www.site.com.br/x");
  });
  it("ignora outro domínio, âncora, e-mail, imagem e PDF", () => {
    for (const h of ["https://outro.com/x", "#topo", "mailto:a@b.com", "tel:123", "/logo.png", "/arquivo.pdf", "javascript:void(0)"]) {
      expect(linkVisitavel(h, base, "site.com.br")).toBeNull();
    }
  });
  it("tira parâmetros de rastreio", () => {
    expect(linkVisitavel("/p?utm_source=x&id=2&fbclid=z", base, "site.com.br")).toBe("https://site.com.br/p?id=2");
  });
});

describe("converterHtml", () => {
  it("vira texto: títulos, listas e parágrafos; descarta script, estilo, menu e formulário", () => {
    const html = pagina(
      "Início",
      `<nav><a href="/">Menu inútil</a></nav><script>var x = "não deve aparecer";</script><style>.a{color:red}</style>
       <h1>Bem-vindo</h1><p>Somos uma empresa de &quot;tecnologia&quot; &amp; inovação, atendemos em S&atilde;o Paulo.</p>
       <ul><li>Item um</li><li>Item dois</li></ul><form><input name="q"><button>Enviar</button></form>`,
    );
    const c = converterHtml(html, "https://s.com/", "s.com");
    const texto = c.blocos.join("\n");
    expect(c.titulo).toBe("Início");
    expect(c.descricao).toBe("Descrição de Início");
    expect(texto).toContain("### Bem-vindo");
    expect(texto).toContain('Somos uma empresa de "tecnologia" & inovação, atendemos em São Paulo.');
    expect(texto).toContain("- Item um");
    expect(texto).toContain("- Item dois");
    expect(texto).not.toContain("não deve aparecer");
    expect(texto).not.toContain("color:red");
    expect(texto).not.toContain("Menu inútil");
    expect(texto).not.toContain("Enviar");
  });

  it("junta contatos de mailto, telefone, WhatsApp e redes sociais", () => {
    const html = pagina(
      "Contato",
      `<p>Fale conosco com bastante calma e atenção, por favor.</p>
       <a href="mailto:oi@empresa.com?subject=x">e</a><a href="tel:+5585999990000">t</a>
       <a href="https://wa.me/5585999990000?text=oi">w</a><a href="https://www.instagram.com/empresa/">i</a>`,
    );
    const c = converterHtml(html, "https://s.com/contato", "s.com");
    expect(c.contatos).toEqual(
      expect.arrayContaining([
        "E-mail: oi@empresa.com",
        "Telefone: +5585999990000",
        "WhatsApp: https://wa.me/5585999990000?text=oi",
        "Rede social: https://www.instagram.com/empresa/",
      ]),
    );
  });

  it("decodifica o e-mail protegido pela Cloudflare", () => {
    // "contato@x.com" cifrado com chave 0x42
    const chave = 0x42;
    const hex = chave.toString(16).padStart(2, "0") + [...("contato@x.com")].map((ch) => (ch.charCodeAt(0) ^ chave).toString(16).padStart(2, "0")).join("");
    expect(decodificarEmailCloudflare(hex)).toBe("contato@x.com");
    const html = pagina("C", `<p>Escreva para nós, respondemos em até um dia útil.</p><a class="__cf_email__" data-cfemail="${hex}">[email&#160;protected]</a>`);
    const c = converterHtml(html, "https://s.com/", "s.com");
    expect(c.blocos.join(" ")).toContain("contato@x.com");
    expect(c.blocos.join(" ")).not.toContain("protected");
    expect(c.contatos).toContain("E-mail: contato@x.com");
  });

  it("devolve só links navegáveis do mesmo site", () => {
    const c = converterHtml(pagina("L", `<a href="/a">a</a><a href="https://fora.com/b">b</a><a href="/c.png">c</a>`), "https://s.com/", "s.com");
    expect(c.links).toEqual(["https://s.com/a"]);
  });
});

describe("robots.txt e sitemap", () => {
  it("respeita Disallow do grupo *, com Allow mais específico vencendo", () => {
    const r = lerRobots("User-agent: *\nDisallow: /privado\nAllow: /privado/publico\nSitemap: https://s.com/mapa.xml\n");
    expect(r.permite("/privado/x")).toBe(false);
    expect(r.permite("/privado/publico/p")).toBe(true);
    expect(r.permite("/sobre")).toBe(true);
    expect(r.sitemaps).toEqual(["https://s.com/mapa.xml"]);
  });
  it("Disallow vazio libera tudo", () => {
    expect(lerRobots("User-agent: *\nDisallow:\n").permite("/qualquer")).toBe(true);
  });
  it("lê as páginas e os sub-sitemaps do XML", () => {
    expect(lerSitemap("<urlset><url><loc>https://s.com/a</loc></url><url><loc> https://s.com/b?x=1&amp;y=2 </loc></url></urlset>").paginas).toEqual([
      "https://s.com/a",
      "https://s.com/b?x=1&y=2",
    ]);
    expect(lerSitemap("<sitemapindex><sitemap><loc>https://s.com/sm1.xml</loc></sitemap></sitemapindex>").sitemaps).toEqual(["https://s.com/sm1.xml"]);
  });
});

describe("lerSite", () => {
  const longo = "Texto bem comprido para passar do mínimo de caracteres de uma página de verdade. ".repeat(3);

  it("segue os links do mesmo site, ignora os de fora e junta o resultado", async () => {
    const { fetchFn } = siteFalso({
      "https://s.com/robots.txt": { tipo: "text/plain", corpo: "User-agent: *\nDisallow:\n" },
      "https://s.com/": { corpo: pagina("Início", `<h1>Início</h1><p>${longo}</p><a href="/sobre">Sobre</a><a href="https://fora.com/x">fora</a>`) },
      "https://s.com/sobre": { corpo: pagina("Sobre", `<h1>Sobre nós</h1><p>${longo} Fundada em 2020.</p>`) },
    });
    const r = await lerSite("s.com", {}, { fetchFn, validarDestino: semGuard });
    expect(r.paginas.map((p) => p.url)).toEqual(["https://s.com/", "https://s.com/sobre"]);
    expect(r.paginas[1]?.blocos.join(" ")).toContain("Fundada em 2020.");
    const { markdown } = montarMarkdownDoSite(r, new Date("2026-10-28T12:00:00Z"));
    expect(markdown).toContain("# Site s.com");
    expect(markdown).toContain("## Página: Sobre");
    expect(markdown).toContain("2026-10-28");
  });

  it("usa o sitemap para achar páginas que o menu não linka", async () => {
    const { fetchFn } = siteFalso({
      "https://s.com/robots.txt": { status: 404 },
      "https://s.com/sitemap.xml": { tipo: "application/xml", corpo: "<urlset><url><loc>https://s.com/escondida</loc></url></urlset>" },
      "https://s.com/": { corpo: pagina("Início", `<p>${longo}</p>`) },
      "https://s.com/escondida": { corpo: pagina("Escondida", `<p>${longo} Só no sitemap.</p>`) },
    });
    const r = await lerSite("https://s.com", {}, { fetchFn, validarDestino: semGuard });
    expect(r.paginas.map((p) => p.url)).toContain("https://s.com/escondida");
  });

  it("respeita o robots.txt: não baixa o que o site proíbe", async () => {
    const { fetchFn, pedidos } = siteFalso({
      "https://s.com/robots.txt": { tipo: "text/plain", corpo: "User-agent: *\nDisallow: /admin\n" },
      "https://s.com/": { corpo: pagina("Início", `<p>${longo}</p><a href="/admin/painel">Painel</a><a href="/loja">Loja</a>`) },
      "https://s.com/loja": { corpo: pagina("Loja", `<p>${longo}</p>`) },
      "https://s.com/admin/painel": { corpo: pagina("Painel", `<p>${longo} segredo</p>`) },
    });
    const r = await lerSite("s.com", {}, { fetchFn, validarDestino: semGuard });
    expect(r.paginas.map((p) => p.url)).not.toContain("https://s.com/admin/painel");
    expect(pedidos.some((p) => p.includes("/admin/painel"))).toBe(false);
    expect(r.ignoradas.some((i) => i.motivo.includes("robots.txt"))).toBe(true);
  });

  it("não segue redirecionamento para outro site", async () => {
    const { fetchFn, pedidos } = siteFalso({
      "https://s.com/robots.txt": { status: 404 },
      "https://s.com/": { corpo: pagina("Início", `<p>${longo}</p><a href="/vai">vai</a>`) },
      "https://s.com/vai": { status: 301, local: "https://mal.com/roubo" },
      "https://mal.com/roubo": { corpo: pagina("Mal", `<p>${longo}</p>`) },
    });
    const r = await lerSite("s.com", {}, { fetchFn, validarDestino: semGuard });
    expect(pedidos.some((p) => p.startsWith("https://mal.com"))).toBe(false);
    expect(r.ignoradas.some((i) => i.motivo.includes("outro site"))).toBe(true);
  });

  it("barra destino perigoso pelo guard anti-SSRF, sem baixar nada", async () => {
    const { fetchFn, pedidos } = siteFalso({});
    const bloqueia = async (u: string) => {
      if (u.includes("interno")) throw new Error("unsafe_url:private_host");
    };
    const r = await lerSite("interno.s.com", {}, { fetchFn, validarDestino: bloqueia });
    expect(r.paginas).toHaveLength(0);
    expect(pedidos).toHaveLength(0);
    expect(r.ignoradas[0]?.motivo).toContain("destino não permitido");
  });

  it("avisa quando as páginas voltam sem texto (site montado por JavaScript)", async () => {
    const { fetchFn } = siteFalso({
      "https://s.com/robots.txt": { status: 404 },
      "https://s.com/": { corpo: `<html><head><title>App</title></head><body><div id="root"></div><script src="/app.js"></script></body></html>` },
    });
    const r = await lerSite("s.com", {}, { fetchFn, validarDestino: semGuard });
    expect(r.paginas).toHaveLength(0);
    expect(r.avisos.join(" ")).toContain("JavaScript");
  });

  it("tira o texto repetido em várias páginas (menu e rodapé) para uma seção só", async () => {
    const rodape = `<footer><p>Rua das Flores 123, Fortaleza. Telefone 85 99999-0000.</p></footer>`;
    const { fetchFn } = siteFalso({
      "https://s.com/robots.txt": { status: 404 },
      "https://s.com/": { corpo: pagina("A", `<p>${longo} Página A.</p>${rodape}<a href="/b">b</a><a href="/c">c</a>`) },
      "https://s.com/b": { corpo: pagina("B", `<p>${longo} Página B.</p>${rodape}`) },
      "https://s.com/c": { corpo: pagina("C", `<p>${longo} Página C.</p>${rodape}`) },
    });
    const r = await lerSite("s.com", {}, { fetchFn, validarDestino: semGuard });
    expect(r.comuns.join(" ")).toContain("Rua das Flores 123");
    for (const p of r.paginas) expect(p.blocos.join(" ")).not.toContain("Rua das Flores 123");
    const { markdown } = montarMarkdownDoSite(r);
    expect(markdown.match(/Rua das Flores 123/g)).toHaveLength(1);
  });

  it("para no limite de páginas e avisa", async () => {
    const mapa: Record<string, { corpo: string }> = {
      "https://s.com/": { corpo: pagina("0", `<p>${longo}</p>${[1, 2, 3, 4, 5].map((n) => `<a href="/p${n}">p${n}</a>`).join("")}`) },
    };
    for (const n of [1, 2, 3, 4, 5]) mapa[`https://s.com/p${n}`] = { corpo: pagina(`P${n}`, `<p>${longo} única ${n}.</p>`) };
    const { fetchFn } = siteFalso({ "https://s.com/robots.txt": { status: 404 } as never, ...mapa });
    const r = await lerSite("s.com", { maxPaginas: 3 }, { fetchFn, validarDestino: semGuard });
    expect(r.paginas).toHaveLength(3);
    expect(r.avisos.join(" ")).toContain("limite");
  });
});
