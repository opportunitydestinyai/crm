"use client";

import { useEffect, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Skeleton } from "@/components/ui/skeleton";
import { Textarea } from "@/components/ui/textarea";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { useContaDoCliente, useEscritaDaConta, type ContaDoCliente } from "@/hooks/useContaDoCliente";
import { useT } from "@/hooks/i18n/useT";
import {
  AJUDA_DA_ETAPA,
  ETAPAS_DO_CLIENTE,
  PAGAMENTOS_DO_CLIENTE,
  ROTULO_DA_ETAPA,
  ROTULO_DO_PAGAMENTO,
  centavosParaReais,
  diasDesdeOInicio,
  reaisParaCentavos,
  situacaoDaVigencia,
  type EtapaDoCliente,
  type PagamentoDoCliente,
  type TomDoAviso,
} from "@/lib/admin/conta-do-cliente";
import { Question } from "@/lib/ui/icons";

const SUGESTOES_DE_PRODUTO = [
  "Agentes de IA personalizados",
  "Atendimento digital e WhatsApp",
  "CRMs e automações de vendas",
  "Workflows e automações",
  "Relatórios inteligentes",
  "Agentes de voz e Android",
  "Opportunity CRM",
  "Cineform",
  "Kirana",
  "Gabi",
  "Kit Armada",
  "Kit Creator",
  "Comics Chronicles",
  "Site",
  "Site 3D",
  "Plataforma de jogos",
];

const TOM: Record<TomDoAviso, "success" | "warning" | "error" | "secondary"> = {
  ok: "success",
  atencao: "warning",
  problema: "error",
  neutro: "secondary",
};

/** O "?" que explica o campo ao passar o mouse (ou tocar). */
function Ajuda({ texto }: { texto: string }) {
  const t = useT();
  return (
    <TooltipProvider delayDuration={100}>
      <Tooltip>
        <TooltipTrigger asChild>
          <button
            type="button"
            aria-label={t("Ajuda")}
            className="inline-flex h-4 w-4 items-center justify-center rounded-full text-muted-foreground hover:text-foreground"
          >
            <Question size={14} aria-hidden />
          </button>
        </TooltipTrigger>
        <TooltipContent>{texto}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

function Rotulo({ children, ajuda, htmlFor }: { children: string; ajuda?: string; htmlFor?: string }) {
  return (
    <div className="mb-1 flex items-center gap-1">
      <Label htmlFor={htmlFor} className="text-xs text-muted-foreground">
        {children}
      </Label>
      {ajuda ? <Ajuda texto={ajuda} /> : null}
    </div>
  );
}

const CAMPO = "h-9 w-full rounded-md border border-input bg-background px-2 text-sm";

export function CartaoDoCliente({ organizationId }: { organizationId: string }) {
  const t = useT();
  const { data, isLoading, isError } = useContaDoCliente(organizationId);
  const escrita = useEscritaDaConta(organizationId);

  const conta = data?.conta ?? null;
  const [form, setForm] = useState({
    inicio: "",
    fim: "",
    valor: "",
    aviso: "30",
    cobranca: "assinatura" as "assinatura" | "unico",
    multa: "",
    motivo: "",
    observacoes: "",
  });
  useEffect(() => {
    if (!conta) return;
    setForm({
      inicio: conta.contract_start ?? "",
      fim: conta.contract_end ?? "",
      valor: conta.value_cents ? (conta.value_cents / 100).toFixed(2).replace(".", ",") : "",
      aviso: String(conta.renewal_notice_days),
      cobranca: conta.billing,
      multa: conta.cancellation_fee_cents ? (conta.cancellation_fee_cents / 100).toFixed(2).replace(".", ",") : "",
      motivo: conta.cancellation_note ?? "",
      observacoes: conta.notes ?? "",
    });
  }, [conta]);

  const [pag, setPag] = useState({ valor: "", forma: "", referencia: "", obs: "" });
  const [nota, setNota] = useState("");
  const [prod, setProd] = useState({ nome: "", preco: "", tipo: "produto" as "servico" | "produto", cobranca: "assinatura" as "assinatura" | "unico" });

  if (isLoading) return <Skeleton className="h-64 w-full rounded-lg" />;
  if (isError || !data) {
    return (
      <div className="rounded-lg border border-destructive/30 bg-destructive/5 px-6 py-6 text-sm text-destructive">
        {t("Não foi possível carregar o cartão do cliente. Tente recarregar a página.")}
      </div>
    );
  }

  const etapa: EtapaDoCliente = conta?.stage ?? "contratou";
  const pagamento: PagamentoDoCliente = conta?.payment_status ?? "pendente";
  const hoje = new Date();
  const vigencia = situacaoDaVigencia(conta?.contract_end ?? null, conta?.renewal_notice_days ?? 30, etapa, hoje);
  const desde = diasDesdeOInicio(conta?.contract_start ?? null, hoje);

  const salvarContrato = () => {
    const valor = form.valor.trim() === "" ? 0 : reaisParaCentavos(form.valor);
    const multa = form.multa.trim() === "" ? null : reaisParaCentavos(form.multa);
    if (valor === null || (form.multa.trim() !== "" && multa === null)) return;
    escrita.salvar.mutate({
      contract_start: form.inicio || null,
      contract_end: form.fim || null,
      value_cents: valor,
      renewal_notice_days: Math.max(0, Math.min(365, Number(form.aviso) || 0)),
      billing: form.cobranca,
      cancellation_fee_cents: multa,
      cancellation_note: form.motivo.trim() || null,
      notes: form.observacoes.trim() || null,
    });
  };

  const valorInvalido = form.valor.trim() !== "" && reaisParaCentavos(form.valor) === null;

  return (
    <div className="space-y-4" data-testid="cartao-do-cliente">
      {/* ── Resumo: o que importa de relance ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {t("Cartão do cliente")}
            <Ajuda texto={t("Aqui fica tudo do contrato deste cliente: em que fase está, se está pagando, até quando vai e o que contratou.")} />
          </CardTitle>
        </CardHeader>
        <CardContent className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <div>
            <Rotulo ajuda={t(AJUDA_DA_ETAPA[etapa])}>{t("Fase do cliente")}</Rotulo>
            <select
              className={CAMPO}
              value={etapa}
              onChange={(e) => escrita.salvar.mutate({ stage: e.target.value as EtapaDoCliente })}
              aria-label={t("Fase do cliente")}
            >
              {ETAPAS_DO_CLIENTE.map((e) => (
                <option key={e} value={e}>
                  {t(ROTULO_DA_ETAPA[e])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Rotulo ajuda={t("Você marca à mão: Pago, Pendente ou Atrasado. Ao registrar um pagamento, ele vira Pago sozinho.")}>{t("Pagamento")}</Rotulo>
            <select
              className={CAMPO}
              value={pagamento}
              onChange={(e) => escrita.salvar.mutate({ payment_status: e.target.value as PagamentoDoCliente })}
              aria-label={t("Pagamento")}
            >
              {PAGAMENTOS_DO_CLIENTE.map((p) => (
                <option key={p} value={p}>
                  {t(ROTULO_DO_PAGAMENTO[p])}
                </option>
              ))}
            </select>
          </div>
          <div>
            <Rotulo ajuda={t("Quanto falta para o contrato acabar. Fica amarelo quando entra no prazo de aviso de renovação e vermelho quando vence.")}>{t("Vigência")}</Rotulo>
            <Badge variant={TOM[vigencia.tom]} className="h-9 whitespace-normal px-2 text-xs leading-tight">
              {vigencia.texto}
            </Badge>
          </div>
          <div>
            <Rotulo ajuda={t("Valor do contrato por cobrança (mensal, se for assinatura).")}>{t("Valor")}</Rotulo>
            <p className="flex h-9 items-center text-sm font-medium">
              {conta && conta.value_cents > 0 ? centavosParaReais(conta.value_cents) : "—"}
            </p>
          </div>
          {desde !== null ? (
            <p className="text-xs text-muted-foreground sm:col-span-2 lg:col-span-4">
              {t("Cliente há")} {desde} {desde === 1 ? t("dia") : t("dias")}
            </p>
          ) : null}
        </CardContent>
      </Card>

      {/* ── Contrato ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-base">{t("Contrato")}</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <div>
              <Rotulo htmlFor="cc-inicio">{t("Início do contrato")}</Rotulo>
              <Input id="cc-inicio" type="date" value={form.inicio} onChange={(e) => setForm({ ...form, inicio: e.target.value })} />
            </div>
            <div>
              <Rotulo htmlFor="cc-fim" ajuda={t("Quando o contrato termina. É daqui que sai o aviso de renovação.")}>{t("Fim do contrato")}</Rotulo>
              <Input id="cc-fim" type="date" value={form.fim} onChange={(e) => setForm({ ...form, fim: e.target.value })} />
            </div>
            <div>
              <Rotulo htmlFor="cc-valor" ajuda={t("Ex.: 287,00")}>{t("Valor (R$)")}</Rotulo>
              <Input id="cc-valor" inputMode="decimal" value={form.valor} onChange={(e) => setForm({ ...form, valor: e.target.value })} aria-invalid={valorInvalido} />
              {valorInvalido ? <p className="mt-1 text-xs text-destructive">{t("Digite só números, ex.: 287,00")}</p> : null}
            </div>
            <div>
              <Rotulo htmlFor="cc-aviso" ajuda={t("Quantos dias antes do fim avisar que é hora de renovar.")}>{t("Avisar renovação (dias antes)")}</Rotulo>
              <Input id="cc-aviso" type="number" min={0} max={365} value={form.aviso} onChange={(e) => setForm({ ...form, aviso: e.target.value })} />
            </div>
            <div>
              <Rotulo htmlFor="cc-cobranca">{t("Cobrança")}</Rotulo>
              <select id="cc-cobranca" className={CAMPO} value={form.cobranca} onChange={(e) => setForm({ ...form, cobranca: e.target.value as "assinatura" | "unico" })}>
                <option value="assinatura">{t("Assinatura")}</option>
                <option value="unico">{t("Pagamento único")}</option>
              </select>
            </div>
          </div>

          {etapa === "cancelou" ? (
            <div className="grid gap-4 rounded-md border border-dashed p-3 sm:grid-cols-2">
              <div>
                <Rotulo htmlFor="cc-multa" ajuda={t("Multa por cancelar antes do fim do contrato.")}>{t("Multa (R$)")}</Rotulo>
                <Input id="cc-multa" inputMode="decimal" value={form.multa} onChange={(e) => setForm({ ...form, multa: e.target.value })} />
              </div>
              <div>
                <Rotulo htmlFor="cc-motivo">{t("Motivo do cancelamento")}</Rotulo>
                <Input id="cc-motivo" value={form.motivo} onChange={(e) => setForm({ ...form, motivo: e.target.value })} />
              </div>
            </div>
          ) : null}

          <div>
            <Rotulo htmlFor="cc-obs">{t("Observações do contrato")}</Rotulo>
            <Textarea id="cc-obs" rows={2} value={form.observacoes} onChange={(e) => setForm({ ...form, observacoes: e.target.value })} />
          </div>
          <Button size="sm" onClick={salvarContrato} disabled={escrita.salvar.isPending || valorInvalido}>
            {escrita.salvar.isPending ? t("Salvando...") : t("Salvar contrato")}
          </Button>
        </CardContent>
      </Card>

      {/* ── Produtos ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {t("Produtos e serviços contratados")}
            <Ajuda texto={t("Serviços são as frentes de trabalho. Produtos são soluções prontas (Kirana, Kit Armada, sites…). Um cliente pode ter vários.")} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.produtos.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nada contratado ainda.")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.produtos.map((p) => (
                <li key={p.id} className="flex items-center justify-between gap-3 px-3 py-2 text-sm">
                  <span className="min-w-0">
                    <span className="font-medium">{p.name}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {p.kind === "servico" ? t("Serviço") : t("Produto")} · {p.billing === "assinatura" ? t("Assinatura") : t("Pagamento único")}
                      {p.price_cents > 0 ? ` · ${centavosParaReais(p.price_cents)}` : ""}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => escrita.remover.mutate({ produto_id: p.id })} disabled={escrita.remover.isPending}>
                    {t("Remover")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-[2fr_1fr_1fr_1fr_auto]">
            <Input list="cc-sugestoes" placeholder={t("Nome (escolha ou digite)")} value={prod.nome} onChange={(e) => setProd({ ...prod, nome: e.target.value })} />
            <datalist id="cc-sugestoes">
              {SUGESTOES_DE_PRODUTO.map((s) => (
                <option key={s} value={s} />
              ))}
            </datalist>
            <select className={CAMPO} value={prod.tipo} onChange={(e) => setProd({ ...prod, tipo: e.target.value as "servico" | "produto" })} aria-label={t("Tipo")}>
              <option value="produto">{t("Produto")}</option>
              <option value="servico">{t("Serviço")}</option>
            </select>
            <select className={CAMPO} value={prod.cobranca} onChange={(e) => setProd({ ...prod, cobranca: e.target.value as "assinatura" | "unico" })} aria-label={t("Cobrança")}>
              <option value="assinatura">{t("Assinatura")}</option>
              <option value="unico">{t("Pagamento único")}</option>
            </select>
            <Input inputMode="decimal" placeholder={t("Preço (R$)")} value={prod.preco} onChange={(e) => setProd({ ...prod, preco: e.target.value })} />
            <Button
              size="sm"
              disabled={escrita.adicionar.isPending || prod.nome.trim() === "" || (prod.preco.trim() !== "" && reaisParaCentavos(prod.preco) === null)}
              onClick={() =>
                escrita.adicionar.mutate(
                  { acao: "produto", name: prod.nome.trim(), kind: prod.tipo, billing: prod.cobranca, price_cents: prod.preco.trim() ? reaisParaCentavos(prod.preco) : 0 },
                  { onSuccess: () => setProd({ ...prod, nome: "", preco: "" }) },
                )
              }
            >
              {t("Adicionar")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Pagamentos ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {t("Pagamentos")}
            <Ajuda texto={t("Registre cada pagamento recebido: valor, quando, como e a que mês se refere. O status do cliente vira Pago.")} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          {data.pagamentos.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhum pagamento registrado.")}</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {data.pagamentos.map((p) => (
                <li key={p.id} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
                  <span>
                    <span className="font-medium">{centavosParaReais(p.amount_cents)}</span>{" "}
                    <span className="text-xs text-muted-foreground">
                      {new Date(p.paid_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                      {p.method ? ` · ${p.method}` : ""}
                      {p.reference ? ` · ${p.reference}` : ""}
                      {p.note ? ` · ${p.note}` : ""}
                    </span>
                  </span>
                  <Button size="sm" variant="ghost" onClick={() => escrita.remover.mutate({ pagamento_id: p.id })} disabled={escrita.remover.isPending}>
                    {t("Remover")}
                  </Button>
                </li>
              ))}
            </ul>
          )}
          <div className="grid gap-2 sm:grid-cols-[1fr_1fr_1fr_2fr_auto]">
            <Input inputMode="decimal" placeholder={t("Valor (R$)")} value={pag.valor} onChange={(e) => setPag({ ...pag, valor: e.target.value })} />
            <Input placeholder={t("Forma (Pix, boleto…)")} value={pag.forma} onChange={(e) => setPag({ ...pag, forma: e.target.value })} />
            <Input placeholder={t("Mês (ex.: 2026-11)")} value={pag.referencia} onChange={(e) => setPag({ ...pag, referencia: e.target.value })} />
            <Input placeholder={t("Observação")} value={pag.obs} onChange={(e) => setPag({ ...pag, obs: e.target.value })} />
            <Button
              size="sm"
              disabled={escrita.adicionar.isPending || reaisParaCentavos(pag.valor) === null}
              onClick={() =>
                escrita.adicionar.mutate(
                  {
                    acao: "pagamento",
                    amount_cents: reaisParaCentavos(pag.valor),
                    ...(pag.forma.trim() ? { method: pag.forma.trim() } : {}),
                    ...(pag.referencia.trim() ? { reference: pag.referencia.trim() } : {}),
                    ...(pag.obs.trim() ? { note: pag.obs.trim() } : {}),
                  },
                  { onSuccess: () => setPag({ valor: "", forma: "", referencia: "", obs: "" }) },
                )
              }
            >
              {t("Registrar")}
            </Button>
          </div>
        </CardContent>
      </Card>

      {/* ── Observações de acompanhamento ── */}
      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="flex items-center gap-2 text-base">
            {t("Acompanhamento")}
            <Ajuda texto={t("Anote o que foi combinado, pedidos do cliente e o que ficou para depois. Cada anotação guarda a data.")} />
          </CardTitle>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex gap-2">
            <Textarea rows={2} placeholder={t("Escreva uma anotação…")} value={nota} onChange={(e) => setNota(e.target.value)} />
            <Button
              size="sm"
              className="self-end"
              disabled={escrita.adicionar.isPending || nota.trim() === ""}
              onClick={() => escrita.adicionar.mutate({ acao: "nota", body: nota.trim() }, { onSuccess: () => setNota("") })}
            >
              {t("Anotar")}
            </Button>
          </div>
          {data.notas.length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("Nenhuma anotação ainda.")}</p>
          ) : (
            <ul className="space-y-2">
              {data.notas.map((n) => (
                <li key={n.id} className="rounded-md border px-3 py-2 text-sm">
                  <p className="whitespace-pre-wrap">{n.body}</p>
                  <p className="mt-1 text-xs text-muted-foreground">
                    {new Date(n.created_at).toLocaleString("pt-BR", { dateStyle: "short", timeStyle: "short" })}
                  </p>
                </li>
              ))}
            </ul>
          )}
        </CardContent>
      </Card>
    </div>
  );
}

export type { ContaDoCliente };
