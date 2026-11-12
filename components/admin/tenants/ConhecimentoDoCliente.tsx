"use client";

import { useRef, useState } from "react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useConhecimentoDoCliente, useEscritaDoConhecimento } from "@/hooks/useConhecimentoDoCliente";
import { useT } from "@/hooks/i18n/useT";
import { Question } from "@/lib/ui/icons";

type Modo = "site" | "arquivo" | "texto";

const ORIGEM: Record<"site" | "arquivo" | "texto", string> = {
  site: "Site",
  arquivo: "Arquivo",
  texto: "Texto",
};

/**
 * O que a Ruby deste cliente sabe — e onde alimentar. Fica dentro do cartão do
 * cliente: a pessoa não precisa entrar no CRM dele. O conhecimento é POR CLIENTE
 * (a rota filtra pela organização do caminho), então a Ruby de um nunca lê o de outro.
 */
export function ConhecimentoDoCliente({ organizationId }: { organizationId: string }) {
  const t = useT();
  const { data, isLoading, isError } = useConhecimentoDoCliente(organizationId);
  const escrita = useEscritaDoConhecimento(organizationId);
  const [modo, setModo] = useState<Modo>("site");
  const [url, setUrl] = useState("");
  const [nome, setNome] = useState("");
  const [texto, setTexto] = useState("");
  const arquivoRef = useRef<HTMLInputElement>(null);
  const [arquivo, setArquivo] = useState<File | null>(null);

  if (isLoading) return <Skeleton className="h-48 w-full rounded-lg" />;
  if (isError || !data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-6 text-sm text-destructive">
        {t("Não foi possível carregar o conhecimento do cliente. Tente recarregar a página.")}
      </div>
    );
  }

  const ocupado = escrita.adicionar.isPending || escrita.enviarArquivo.isPending;
  const limpar = () => {
    setUrl("");
    setNome("");
    setTexto("");
    setArquivo(null);
    if (arquivoRef.current) arquivoRef.current.value = "";
  };

  const enviar = () => {
    const aoDar = { onSuccess: () => limpar() };
    if (modo === "site") {
      escrita.adicionar.mutate(
        { acao: "site", url: url.trim(), ...(nome.trim() ? { name: nome.trim() } : {}) },
        { ...aoDar, onSuccess: () => { limpar(); toast.success(t("Site lido e guardado como material.")); } },
      );
    } else if (modo === "texto") {
      escrita.adicionar.mutate({ acao: "texto", name: nome.trim(), texto }, { ...aoDar, onSuccess: () => { limpar(); toast.success(t("Texto guardado como material.")); } });
    } else if (arquivo) {
      escrita.enviarArquivo.mutate(
        { arquivo, nome: nome.trim() || arquivo.name.replace(/\.[^.]+$/, "") },
        { ...aoDar, onSuccess: () => { limpar(); toast.success(t("Arquivo guardado como material.")); } },
      );
    }
  };

  const podeEnviar =
    !ocupado &&
    (modo === "site" ? url.trim().length >= 4 : modo === "texto" ? nome.trim().length >= 2 && texto.trim().length >= 10 : arquivo !== null);

  return (
    <Card data-testid="conhecimento-do-cliente">
      <CardHeader className="pb-2">
        <CardTitle className="flex items-center gap-2 text-base">
          {t("Conhecimento da Ruby")}
          <TooltipProvider delayDuration={100}>
            <Tooltip>
              <TooltipTrigger asChild>
                <button type="button" aria-label={t("Ajuda")} className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground">
                  <Question size={14} aria-hidden />
                </button>
              </TooltipTrigger>
              <TooltipContent>
                {t("Tudo o que você colocar aqui a Ruby deste cliente passa a consultar: preços, serviços, regras. Cada cliente tem o seu, separado dos demais.")}
              </TooltipContent>
            </Tooltip>
          </TooltipProvider>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {!data.chave_de_embedding ? (
          <p role="alert" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-sm">
            {t("Falta uma chave de IA para indexar os materiais deste cliente. Eles ficam guardados, mas a Ruby só os lê depois que a chave for cadastrada.")}
          </p>
        ) : null}

        {/* ── O que já tem ── */}
        {data.materiais.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("Nenhum material ainda. Adicione um site, um arquivo ou um texto abaixo.")}</p>
        ) : (
          <ul className="divide-y rounded-md border">
            {data.materiais.map((m) => (
              <li key={m.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                <span className="min-w-0 flex-1 basis-56">
                  <span className="font-medium">{m.nome}</span>{" "}
                  <span className="text-xs text-muted-foreground">
                    {t(ORIGEM[m.origem])}
                    {m.detalhe ? ` · ${m.detalhe}` : ""} · {m.trechos} {t("trechos")}
                  </span>
                  {m.indexacao === "failed" && m.erro_de_indexacao ? (
                    <span className="block text-xs text-destructive">{m.erro_de_indexacao}</span>
                  ) : null}
                </span>
                <span className="flex items-center gap-2">
                  {m.trechos === 0 && m.indexacao !== "failed" ? <Badge variant="warning">{t("Indexando")}</Badge> : null}
                  {m.indexacao === "failed" ? <Badge variant="error">{t("Falhou")}</Badge> : null}
                  {data.agente ? (
                    <Badge variant={m.em_uso_pela_ruby ? "success" : "neutral"}>
                      {m.em_uso_pela_ruby ? t("A Ruby usa") : t("Ainda não ligado")}
                    </Badge>
                  ) : null}
                  <Button size="sm" variant="ghost" onClick={() => escrita.remover.mutate(m.id)} disabled={escrita.remover.isPending}>
                    {t("Remover")}
                  </Button>
                </span>
              </li>
            ))}
          </ul>
        )}

        {data.agente && data.fora_da_ruby > 0 ? (
          <div className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-dashed px-3 py-2 text-sm">
            <span>
              {data.fora_da_ruby} {data.fora_da_ruby === 1 ? t("material ainda não está ligado") : t("materiais ainda não estão ligados")} {t("à")} {data.agente.nome}.
            </span>
            <Button
              size="sm"
              disabled={escrita.adicionar.isPending}
              onClick={() =>
                escrita.adicionar.mutate({ acao: "ligar" }, { onSuccess: () => toast.success(t("Pronto: a Ruby deste cliente já consulta tudo.")) })
              }
            >
              {escrita.adicionar.isPending ? t("Ligando...") : t("Ligar tudo à Ruby")}
            </Button>
          </div>
        ) : null}
        {!data.agente ? (
          <p className="text-xs text-muted-foreground">{t("Este cliente ainda não tem um agente publicado; quando tiver, é aqui que você liga os materiais a ele.")}</p>
        ) : null}

        {/* ── Alimentar ── */}
        <div className="space-y-3 rounded-md border p-3">
          <div className="flex flex-wrap gap-2" role="tablist" aria-label={t("Como adicionar")}>
            {(["site", "arquivo", "texto"] as const).map((m) => (
              <Button key={m} size="sm" variant={modo === m ? "default" : "outline"} role="tab" aria-selected={modo === m} onClick={() => setModo(m)}>
                {m === "site" ? t("Endereço de site") : m === "arquivo" ? t("Enviar arquivo") : t("Colar texto")}
              </Button>
            ))}
          </div>

          {modo === "site" ? (
            <Input placeholder={t("minhaempresa.com.br")} value={url} onChange={(e) => setUrl(e.target.value)} aria-label={t("Endereço do site")} />
          ) : null}
          {modo === "arquivo" ? (
            <div className="space-y-1">
              <input
                ref={arquivoRef}
                type="file"
                accept=".pdf,.md,.txt,.csv"
                aria-label={t("Arquivo")}
                className="block w-full text-sm file:mr-3 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:py-1.5 file:text-sm"
                onChange={(e) => setArquivo(e.target.files?.[0] ?? null)}
              />
              <p className="text-xs text-muted-foreground">{t("PDF, Markdown, CSV ou texto, até 20 MB. Vídeo ainda não é lido.")}</p>
            </div>
          ) : null}
          {modo === "texto" ? (
            <Textarea rows={5} placeholder={t("Cole aqui o texto (preços, regras, perguntas frequentes…)")} value={texto} onChange={(e) => setTexto(e.target.value)} aria-label={t("Texto")} />
          ) : null}

          <div className="flex flex-wrap items-center gap-2">
            <Input
              className="max-w-xs"
              placeholder={modo === "site" ? t("Nome (opcional)") : t("Nome do material")}
              value={nome}
              onChange={(e) => setNome(e.target.value)}
              aria-label={t("Nome do material")}
            />
            <Button size="sm" onClick={enviar} disabled={!podeEnviar}>
              {ocupado ? t("Enviando...") : modo === "site" ? t("Ler o site") : t("Adicionar")}
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
