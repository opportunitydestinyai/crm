/**
 * LER UM SITE E TRANSFORMÁ-LO EM MATERIAL DA BASE DE CONHECIMENTO.
 *
 * A pessoa informa o endereço do site da empresa; este módulo baixa as páginas
 * públicas, tira o que não é conteúdo (script, estilo, menu, formulário),
 * converte o resto em texto e devolve um Markdown único. Quem guarda o Markdown
 * e dispara a indexação é a rota (`/api/v1/ai/knowledge/sources/site`): o
 * material entra pelo MESMO caminho de um documento colado, então o chunking, o
 * embedding e a busca já existentes valem sem nada novo no banco.
 *
 * ## O que ele faz de propósito
 *
 * - **Só o site informado.** Mesmo domínio (com ou sem `www.`). Link para fora
 *   é ignorado, e redirecionamento para fora também.
 * - **Educado.** Lê o `robots.txt` e respeita `Disallow`; identifica-se com um
 *   User-Agent próprio; limita páginas, bytes e tempo.
 * - **Seguro.** Todo destino passa pelo guard anti-SSRF do projeto
 *   (`assertSafeOutboundUrl` + `assertDestinoResolvidoSeguro`): o leitor nunca
 *   chega a `localhost`, rede interna ou metadados de nuvem, mesmo que o site
 *   redirecione para lá. Cada salto de redirecionamento é conferido de novo.
 * - **Sem dependência nova.** O HTML é lido por um conversor próprio, simples.
 *
 * ## O que ele NÃO faz (e diz quando isso acontece)
 *
 * - **Não executa JavaScript.** Site que só monta o texto no navegador (SPA sem
 *   renderização no servidor) volta quase vazio; o resultado traz um aviso
 *   dizendo isso, em vez de fingir que leu.
 * - Não lê PDF, imagem nem vídeo do site: para isso existe o envio de arquivo.
 * - Não entra em área com login.
 */
import { assertSafeOutboundUrl } from "@/lib/automation/outbound-url";
import { assertDestinoResolvidoSeguro } from "@/lib/automation/outbound-ip";

export const USER_AGENT_DO_LEITOR =
  "DeskcommBot/1.0 (leitura do site da própria empresa para a base de conhecimento)";

export const LIMITES_PADRAO = {
  maxPaginas: 40,
  maxPaginasTeto: 80,
  timeoutMs: 12_000,
  maxBytesPorPagina: 1_500_000,
  /** Teto do Markdown final: acima disso o indexador gastaria embedding à toa. */
  maxCaracteres: 600_000,
  maxRedirecionamentos: 5,
} as const;

// ---------------------------------------------------------------------------
// Tipos
// ---------------------------------------------------------------------------

export interface PaginaLida {
  url: string;
  titulo: string;
  descricao: string;
  blocos: string[];
}

export interface PaginaIgnorada {
  url: string;
  motivo: string;
}

export interface ResultadoDoSite {
  host: string;
  origem: string;
  paginas: PaginaLida[];
  ignoradas: PaginaIgnorada[];
  /** Blocos de texto que se repetem na maioria das páginas (menu, rodapé, contato). */
  comuns: string[];
  contatos: string[];
  avisos: string[];
}

export interface DependenciasDoLeitor {
  fetchFn?: typeof fetch;
  /** Troca o guard anti-SSRF (só os testes devem trocar). */
  validarDestino?: (url: string) => Promise<void>;
}

export interface OpcoesDoLeitor {
  maxPaginas?: number;
  timeoutMs?: number;
  maxBytesPorPagina?: number;
}

// ---------------------------------------------------------------------------
// URL
// ---------------------------------------------------------------------------

/** "opportunity.ia.br" vira "https://opportunity.ia.br/". Lança se não for um site. */
export function normalizarUrlDoSite(entrada: string): URL {
  const bruta = entrada.trim();
  if (bruta === "") throw new Error("url_vazia");
  const comEsquema = /^[a-z][a-z0-9+.-]*:\/\//i.test(bruta) ? bruta : `https://${bruta}`;
  let u: URL;
  try {
    u = new URL(comEsquema);
  } catch {
    throw new Error("url_invalida");
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") throw new Error("url_esquema");
  if (!u.hostname.includes(".")) throw new Error("url_invalida");
  u.hash = "";
  return u;
}

function semWww(host: string): string {
  return host.toLowerCase().replace(/^www\./, "");
}

export function mesmoSite(a: string, b: string): boolean {
  return semWww(a) === semWww(b);
}

const EXTENSOES_QUE_NAO_SAO_PAGINA =
  /\.(?:png|jpe?g|gif|webp|svg|ico|avif|bmp|pdf|zip|rar|7z|gz|mp3|mp4|webm|mov|avi|wav|css|js|mjs|json|xml|txt|woff2?|ttf|eot|doc|docx|xls|xlsx|ppt|pptx|apk|exe|dmg)$/i;

/** Normaliza um link achado numa página; devolve null se não vale a pena visitar. */
export function linkVisitavel(href: string, paginaUrl: string, host: string): string | null {
  const bruto = href.trim();
  if (bruto === "" || /^(?:#|javascript:|mailto:|tel:|data:|whatsapp:|sms:)/i.test(bruto)) return null;
  let u: URL;
  try {
    u = new URL(bruto, paginaUrl);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (!mesmoSite(u.hostname, host)) return null;
  if (EXTENSOES_QUE_NAO_SAO_PAGINA.test(u.pathname)) return null;
  u.hash = "";
  // Parâmetros de rastreio geram "páginas" repetidas.
  for (const k of [...u.searchParams.keys()]) {
    if (/^(?:utm_|fbclid|gclid|ref$|mc_)/i.test(k)) u.searchParams.delete(k);
  }
  if (u.pathname.length > 1 && u.pathname.endsWith("/")) u.pathname = u.pathname.slice(0, -1);
  return u.toString();
}

// ---------------------------------------------------------------------------
// HTML -> texto
// ---------------------------------------------------------------------------

const ENTIDADES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", copy: "©", reg: "®",
  ndash: "–", mdash: "—", hellip: "…", laquo: "«", raquo: "»", lsquo: "‘", rsquo: "’",
  ldquo: "“", rdquo: "”", bull: "•", middot: "·", euro: "€", deg: "°",
  aacute: "á", agrave: "à", acirc: "â", atilde: "ã", auml: "ä", ccedil: "ç",
  eacute: "é", egrave: "è", ecirc: "ê", euml: "ë", iacute: "í", igrave: "ì", icirc: "î",
  oacute: "ó", ograve: "ò", ocirc: "ô", otilde: "õ", ouml: "ö", uacute: "ú", ugrave: "ù",
  ucirc: "û", uuml: "ü", ntilde: "ñ",
  Aacute: "Á", Agrave: "À", Acirc: "Â", Atilde: "Ã", Ccedil: "Ç", Eacute: "É", Ecirc: "Ê",
  Iacute: "Í", Oacute: "Ó", Ocirc: "Ô", Otilde: "Õ", Uacute: "Ú",
};

export function decodificarEntidades(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z][a-z0-9]*);/gi, (todo, ent: string) => {
    if (ent[0] === "#") {
      const n = ent[1] === "x" || ent[1] === "X" ? parseInt(ent.slice(2), 16) : parseInt(ent.slice(1), 10);
      if (!Number.isFinite(n) || n <= 0 || n > 0x10ffff) return todo;
      try {
        return String.fromCodePoint(n);
      } catch {
        return todo;
      }
    }
    return ENTIDADES[ent] ?? ENTIDADES[ent.toLowerCase()] ?? todo;
  });
}

function tirarBlocos(html: string, tags: readonly string[]): string {
  let out = html;
  for (const t of tags) {
    out = out.replace(new RegExp(`<${t}\\b[^>]*>[\\s\\S]*?<\\/${t}\\s*>`, "gi"), " ");
  }
  return out;
}

function atributo(tag: string, nome: string): string | null {
  const m = new RegExp(`\\b${nome}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? "") : null;
}

/**
 * A Cloudflare troca e-mails do HTML por "[email protected]" e guarda o endereço
 * em `data-cfemail` (hex: o primeiro byte é a chave, os demais são XOR com ela).
 * Sem decodificar, o contato mais importante do site some do material.
 */
export function decodificarEmailCloudflare(hex: string): string | null {
  if (!/^(?:[0-9a-f]{2}){3,}$/i.test(hex)) return null;
  const chave = parseInt(hex.slice(0, 2), 16);
  let out = "";
  for (let i = 2; i < hex.length; i += 2) out += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16) ^ chave);
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(out) ? out : null;
}

export interface PaginaConvertida {
  titulo: string;
  descricao: string;
  blocos: string[];
  links: string[];
  contatos: string[];
}

/** Converte o HTML de UMA página em blocos de texto + links + contatos. */
export function converterHtml(htmlBruto: string, paginaUrl: string, host: string): PaginaConvertida {
  let html = htmlBruto;
  const titulo = decodificarEntidades(
    (/<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(html)?.[1] ?? "").replace(/<[^>]+>/g, " "),
  )
    .replace(/\s+/g, " ")
    .trim();

  let descricao = "";
  for (const m of html.matchAll(/<meta\b[^>]*>/gi)) {
    const tag = m[0];
    if (/name\s*=\s*["']description["']/i.test(tag)) {
      descricao = decodificarEntidades(atributo(tag, "content") ?? "").replace(/\s+/g, " ").trim();
      break;
    }
  }

  const links: string[] = [];
  const contatos: string[] = [];
  // E-mail protegido pela Cloudflare: troca o elemento pelo endereço de verdade.
  html = html.replace(/<(a|span)\b[^>]*\bdata-cfemail\s*=\s*["']([0-9a-f]+)["'][^>]*>[\s\S]*?<\/\1\s*>/gi, (_t, _tag: string, hex: string) => {
    const email = decodificarEmailCloudflare(hex);
    if (!email) return " ";
    contatos.push(`E-mail: ${email}`);
    return ` ${email} `;
  });
  for (const m of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = atributo(m[0], "href");
    if (!href) continue;
    const h = decodificarEntidades(href).trim();
    if (/^mailto:/i.test(h)) contatos.push(`E-mail: ${h.replace(/^mailto:/i, "").split("?")[0]}`);
    else if (/^tel:/i.test(h)) contatos.push(`Telefone: ${h.replace(/^tel:/i, "")}`);
    else if (/(?:wa\.me|api\.whatsapp\.com|whatsapp\.com\/send)/i.test(h)) contatos.push(`WhatsApp: ${h}`);
    else if (/(?:instagram\.com|linkedin\.com|facebook\.com|tiktok\.com|youtube\.com|x\.com|twitter\.com)\//i.test(h)) {
      contatos.push(`Rede social: ${h}`);
    }
    const v = linkVisitavel(h, paginaUrl, host);
    if (v) links.push(v);
  }

  // Só o corpo: o <head> já foi lido acima.
  const corpoBruto = /<body\b[^>]*>([\s\S]*?)(?:<\/body\s*>|$)/i.exec(html)?.[1] ?? html;
  let corpo = corpoBruto.replace(/<!--[\s\S]*?-->/g, " ");
  corpo = tirarBlocos(corpo, ["script", "style", "noscript", "svg", "template", "iframe", "canvas", "nav", "form", "button", "select", "textarea"]);

  const principal = /<main\b[^>]*>([\s\S]*?)<\/main\s*>/i.exec(corpo)?.[1];
  // <main> só vale se tiver conteúdo de verdade; senão o rodapé e o resto perdem o texto.
  const escopo = principal && principal.replace(/<[^>]+>/g, "").trim().length > 200 ? principal : corpo;

  let texto = escopo;
  texto = texto.replace(/<h([1-6])\b[^>]*>([\s\S]*?)<\/h\1\s*>/gi, (_t, n: string, c: string) => {
    return `\n\n${"#".repeat(Math.min(6, Number(n) + 2))} ${c.replace(/<[^>]+>/g, " ")}\n\n`;
  });
  texto = texto.replace(/<li\b[^>]*>/gi, "\n- ");
  texto = texto.replace(/<br\s*\/?>/gi, "\n");
  texto = texto.replace(/<\/(?:td|th)\s*>/gi, " | ");
  texto = texto.replace(/<\/?(?:p|div|section|article|header|footer|address|ul|ol|table|thead|tbody|tr|blockquote|figure|figcaption|details|summary|dl|dt|dd|hr|h[1-6])\b[^>]*>/gi, "\n\n");
  texto = texto.replace(/<[^>]+>/g, " ");
  texto = decodificarEntidades(texto);

  const blocos: string[] = [];
  for (const parte of texto.split(/\n\s*\n/)) {
    const linhas = parte
      .split("\n")
      .map((l) => l.replace(/[ \t ]+/g, " ").trim())
      .filter((l) => l !== "" && l !== "|");
    const bloco = linhas.join("\n").trim();
    if (bloco.length >= 2 && /[\p{L}\p{N}]/u.test(bloco)) blocos.push(bloco);
  }

  return {
    titulo,
    descricao,
    blocos,
    links: [...new Set(links)],
    contatos: [...new Set(contatos)],
  };
}

// ---------------------------------------------------------------------------
// robots.txt e sitemap
// ---------------------------------------------------------------------------

export interface RegrasDeRobots {
  permite(caminho: string): boolean;
  sitemaps: string[];
}

export function lerRobots(txt: string): RegrasDeRobots {
  const sitemaps: string[] = [];
  const regras: Array<{ ua: string[]; disallow: string[]; allow: string[] }> = [];
  let atual: { ua: string[]; disallow: string[]; allow: string[] } | null = null;
  let ultimoFoiUa = false;
  for (const crua of txt.split(/\r?\n/)) {
    const linha = crua.replace(/#.*$/, "").trim();
    if (linha === "") continue;
    const i = linha.indexOf(":");
    if (i < 0) continue;
    const chave = linha.slice(0, i).trim().toLowerCase();
    const valor = linha.slice(i + 1).trim();
    if (chave === "sitemap") {
      if (valor) sitemaps.push(valor);
      continue;
    }
    if (chave === "user-agent") {
      if (!atual || !ultimoFoiUa) {
        atual = { ua: [], disallow: [], allow: [] };
        regras.push(atual);
      }
      atual.ua.push(valor.toLowerCase());
      ultimoFoiUa = true;
      continue;
    }
    ultimoFoiUa = false;
    if (!atual) continue;
    if (chave === "disallow") atual.disallow.push(valor);
    else if (chave === "allow") atual.allow.push(valor);
  }
  const meu = regras.filter((r) => r.ua.some((u) => u !== "*" && USER_AGENT_DO_LEITOR.toLowerCase().includes(u)));
  const todos = regras.filter((r) => r.ua.includes("*"));
  const aplicavel = meu.length > 0 ? meu : todos;
  return {
    sitemaps,
    permite(caminho: string): boolean {
      let melhor: { len: number; permite: boolean } | null = null;
      for (const r of aplicavel) {
        for (const d of r.disallow) {
          if (d !== "" && caminho.startsWith(d.replace(/\*.*$/, "")) && (!melhor || d.length > melhor.len)) {
            melhor = { len: d.length, permite: false };
          }
        }
        for (const a of r.allow) {
          if (a !== "" && caminho.startsWith(a.replace(/\*.*$/, "")) && (!melhor || a.length >= melhor.len)) {
            melhor = { len: a.length, permite: true };
          }
        }
      }
      return melhor ? melhor.permite : true;
    },
  };
}

export function lerSitemap(xml: string): { paginas: string[]; sitemaps: string[] } {
  const paginas: string[] = [];
  const sitemaps: string[] = [];
  const ehIndice = /<sitemapindex\b/i.test(xml);
  for (const m of xml.matchAll(/<loc>\s*([\s\S]*?)\s*<\/loc>/gi)) {
    const loc = decodificarEntidades((m[1] ?? "").replace(/<!\[CDATA\[|\]\]>/g, "")).trim();
    if (loc === "") continue;
    (ehIndice ? sitemaps : paginas).push(loc);
  }
  return { paginas, sitemaps };
}

// ---------------------------------------------------------------------------
// Rede
// ---------------------------------------------------------------------------

async function validarPadrao(url: string): Promise<void> {
  assertSafeOutboundUrl(url);
  await assertDestinoResolvidoSeguro(new URL(url).hostname);
}

interface Baixada {
  url: string;
  status: number;
  tipo: string;
  corpo: string;
}

/** Baixa uma URL seguindo redirecionamentos À MÃO, conferindo cada salto. */
async function baixar(
  inicial: string,
  host: string,
  o: { timeoutMs: number; maxBytes: number; fetchFn: typeof fetch; validar: (u: string) => Promise<void> },
): Promise<Baixada | { erro: string }> {
  let url = inicial;
  for (let salto = 0; salto <= LIMITES_PADRAO.maxRedirecionamentos; salto++) {
    try {
      await o.validar(url);
    } catch (e) {
      return { erro: `destino não permitido (${e instanceof Error ? e.message : "bloqueado"})` };
    }
    if (!mesmoSite(new URL(url).hostname, host)) return { erro: "redirecionou para outro site" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), o.timeoutMs);
    try {
      const r = await o.fetchFn(url, {
        redirect: "manual",
        signal: ctrl.signal,
        headers: {
          "User-Agent": USER_AGENT_DO_LEITOR,
          Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8",
          "Accept-Language": "pt-BR,pt;q=0.9,en;q=0.5",
        },
      });
      if (r.status >= 300 && r.status < 400) {
        const loc = r.headers.get("location");
        if (!loc) return { erro: `redirecionamento sem destino (${r.status})` };
        url = new URL(loc, url).toString();
        continue;
      }
      const tipo = (r.headers.get("content-type") ?? "").toLowerCase();
      const decl = Number(r.headers.get("content-length") ?? "0");
      if (decl > o.maxBytes) return { erro: "página grande demais" };
      const buf = await r.arrayBuffer();
      if (buf.byteLength > o.maxBytes) return { erro: "página grande demais" };
      const corpo = new TextDecoder("utf-8", { fatal: false }).decode(buf);
      return { url, status: r.status, tipo, corpo };
    } catch (e) {
      const abortou = e instanceof Error && e.name === "AbortError";
      return { erro: abortou ? "demorou demais para responder" : "não foi possível baixar" };
    } finally {
      clearTimeout(timer);
    }
  }
  return { erro: "redirecionamentos demais" };
}

// ---------------------------------------------------------------------------
// O leitor
// ---------------------------------------------------------------------------

function chaveDoBloco(b: string): string {
  return b.toLowerCase().replace(/\s+/g, " ").trim();
}

export async function lerSite(
  entrada: string,
  opcoes: OpcoesDoLeitor = {},
  deps: DependenciasDoLeitor = {},
): Promise<ResultadoDoSite> {
  const inicio = normalizarUrlDoSite(entrada);
  const host = inicio.hostname;
  const maxPaginas = Math.max(1, Math.min(opcoes.maxPaginas ?? LIMITES_PADRAO.maxPaginas, LIMITES_PADRAO.maxPaginasTeto));
  const cfg = {
    timeoutMs: opcoes.timeoutMs ?? LIMITES_PADRAO.timeoutMs,
    maxBytes: opcoes.maxBytesPorPagina ?? LIMITES_PADRAO.maxBytesPorPagina,
    fetchFn: deps.fetchFn ?? fetch,
    validar: deps.validarDestino ?? validarPadrao,
  };
  const avisos: string[] = [];
  const ignoradas: PaginaIgnorada[] = [];
  const paginas: PaginaLida[] = [];

  // robots.txt: falha ao ler = permitido (a ausência de regra é o caso comum).
  let robots: RegrasDeRobots = { permite: () => true, sitemaps: [] };
  const rb = await baixar(new URL("/robots.txt", inicio).toString(), host, cfg);
  if (!("erro" in rb) && rb.status === 200 && !rb.tipo.includes("html")) robots = lerRobots(rb.corpo);

  const fila: string[] = [];
  const vistos = new Set<string>();
  const entrar = (u: string | null) => {
    if (!u) return;
    const ch = (() => {
      try {
        const x = new URL(u);
        x.hash = "";
        return `${semWww(x.hostname)}${x.pathname}${x.search}`;
      } catch {
        return u;
      }
    })();
    if (vistos.has(ch)) return;
    vistos.add(ch);
    fila.push(u);
  };
  const inicial = linkVisitavel(inicio.toString(), inicio.toString(), host) ?? inicio.toString();
  entrar(inicial);

  // Sitemap: dá as páginas que o dono QUER que apareçam, mesmo sem link no menu.
  const candidatosDeSitemap = [...new Set([...robots.sitemaps, new URL("/sitemap.xml", inicio).toString()])].slice(0, 4);
  for (const sm of candidatosDeSitemap) {
    const r = await baixar(sm, host, cfg);
    if ("erro" in r || r.status !== 200) continue;
    const lido = lerSitemap(r.corpo);
    for (const loc of lido.paginas) entrar(linkVisitavel(loc, inicio.toString(), host));
    for (const sub of lido.sitemaps.slice(0, 3)) {
      const rs = await baixar(sub, host, cfg);
      if ("erro" in rs || rs.status !== 200) continue;
      for (const loc of lerSitemap(rs.corpo).paginas) entrar(linkVisitavel(loc, inicio.toString(), host));
    }
    if (fila.length >= maxPaginas * 2) break;
  }

  const contatos = new Set<string>();
  let semTexto = 0;
  while (fila.length > 0 && paginas.length < maxPaginas) {
    const lote = fila.splice(0, Math.min(3, maxPaginas - paginas.length));
    const resultados = await Promise.all(
      lote.map(async (url): Promise<{ url: string; ignorada: string } | { url: string; html: string }> => {
        const caminho = new URL(url).pathname + new URL(url).search;
        if (!robots.permite(caminho)) return { url, ignorada: "bloqueada pelo robots.txt do site" };
        const b = await baixar(url, host, cfg);
        if ("erro" in b) return { url, ignorada: b.erro };
        if (b.status >= 400) return { url, ignorada: `o site respondeu ${b.status}` };
        if (!b.tipo.includes("html") && !b.tipo.includes("xml") && b.tipo !== "") return { url, ignorada: "não é uma página de texto" };
        return { url: b.url, html: b.corpo };
      }),
    );
    for (const r of resultados) {
      if ("ignorada" in r) {
        ignoradas.push({ url: r.url, motivo: r.ignorada });
        continue;
      }
      const c = converterHtml(r.html, r.url, host);
      c.contatos.forEach((x) => contatos.add(x));
      c.links.forEach((l) => entrar(l));
      const total = c.blocos.reduce((s, b) => s + b.length, 0);
      if (total < 80) {
        semTexto++;
        ignoradas.push({ url: r.url, motivo: "quase sem texto (provavelmente montada por JavaScript)" });
        continue;
      }
      paginas.push({ url: r.url, titulo: c.titulo || r.url, descricao: c.descricao, blocos: c.blocos });
    }
  }

  if (fila.length > 0) {
    avisos.push(`Parei em ${paginas.length} páginas (limite). O site tem mais páginas; aumente o limite ou envie as que faltam como arquivo.`);
  }
  if (paginas.length === 0 && semTexto > 0) {
    avisos.push("As páginas voltaram sem texto: o site provavelmente monta o conteúdo no navegador (JavaScript), e este leitor não executa JavaScript. Cole o texto ou envie um PDF.");
  }

  // Texto que se repete na maioria das páginas (menu, rodapé, chamada) vira
  // UMA seção "comuns", em vez de poluir cada página e inflar a indexação.
  const comuns: string[] = [];
  if (paginas.length >= 3) {
    const contagem = new Map<string, number>();
    for (const p of paginas) {
      for (const k of new Set(p.blocos.map(chaveDoBloco))) contagem.set(k, (contagem.get(k) ?? 0) + 1);
    }
    const limite = Math.ceil(paginas.length * 0.6);
    const comumSet = new Set([...contagem].filter(([, n]) => n >= limite).map(([k]) => k));
    const jaVistos = new Set<string>();
    for (const p of paginas) {
      p.blocos = p.blocos.filter((b) => {
        const k = chaveDoBloco(b);
        if (!comumSet.has(k)) return true;
        if (!jaVistos.has(k)) {
          jaVistos.add(k);
          comuns.push(b);
        }
        return false;
      });
    }
  }

  return {
    host,
    origem: inicio.origin,
    paginas,
    ignoradas,
    comuns: comuns.slice(0, 40),
    contatos: [...contatos].slice(0, 30),
    avisos,
  };
}

// ---------------------------------------------------------------------------
// Markdown final
// ---------------------------------------------------------------------------

/** Tamanho alvo de cada parágrafo do material (o divisor da base corta em ~1500). */
const ALVO_DO_PARAGRAFO = 1100;

/**
 * O divisor da base (`lib/ai/rag/chunker.ts`) faz UM trecho por parágrafo, sem
 * juntar os curtos. Uma página de site tem dezenas de linhas de uma frase
 * ("Saiba mais", itens de lista): sem agrupar, 52 mil caracteres viravam 900
 * trechos de ~60 caracteres — caros de indexar e ruins para achar resposta.
 * Aqui os blocos de uma página são juntados em parágrafos de ~1.100 caracteres;
 * um título sempre abre um parágrafo novo, e cada parágrafo diz de que página
 * veio (o trecho é lido sozinho pela busca, longe do título da página).
 */
export function agruparBlocos(blocos: readonly string[], rotulo: string | null): string[] {
  const grupos: string[] = [];
  let atual: string[] = [];
  let tamanho = 0;
  const fechar = () => {
    if (atual.length === 0) return;
    const corpo = atual.join("\n");
    grupos.push(rotulo ? `(${rotulo})\n${corpo}` : corpo);
    atual = [];
    tamanho = 0;
  };
  for (const b of blocos) {
    // Título de seção (### e ####) abre grupo novo, mas só se o atual já tem
    // corpo; subtítulos de cartão (#####) ficam junto com o que vem antes.
    const abreSecao = /^#{3,4}\s/.test(b) && tamanho >= 400;
    if (atual.length > 0 && (abreSecao || tamanho + b.length > ALVO_DO_PARAGRAFO)) fechar();
    atual.push(b);
    tamanho += b.length + 1;
  }
  fechar();
  return grupos;
}

export function montarMarkdownDoSite(r: ResultadoDoSite, lidoEm: Date = new Date()): { markdown: string; truncado: boolean } {
  const partes: string[] = [];
  partes.push(`# Site ${r.host}`);
  partes.push(
    `Conteúdo lido automaticamente do site ${r.origem} em ${lidoEm.toISOString().slice(0, 10)} (${r.paginas.length} páginas). ` +
      "Quando um dado deste texto conflitar com o que a empresa informar depois, vale o que a empresa informar.",
  );
  if (r.comuns.length > 0 || r.contatos.length > 0) {
    partes.push("## Informações que se repetem no site (menu, rodapé, contato)");
    partes.push(...agruparBlocos([...r.comuns, ...r.contatos.map((c) => `- ${c}`)], "Informações gerais do site"));
  }
  for (const p of r.paginas) {
    partes.push(`## Página: ${p.titulo}\nEndereço: ${p.url}`);
    const corpo = p.descricao ? [p.descricao, ...p.blocos] : p.blocos;
    partes.push(...agruparBlocos(corpo, p.titulo.replace(/\s*\|\s*[^|]*$/, "")));
  }
  let markdown = partes.join("\n\n");
  let truncado = false;
  if (markdown.length > LIMITES_PADRAO.maxCaracteres) {
    markdown = markdown.slice(0, LIMITES_PADRAO.maxCaracteres);
    truncado = true;
  }
  return { markdown, truncado };
}
