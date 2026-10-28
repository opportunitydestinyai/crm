"use client";

/**
 * LER UM SITE E TRANSFORMÁ-LO EM MATERIAL.
 *
 * Cartão da tela de materiais (IA › Conhecimento): a pessoa digita o endereço do
 * site da empresa e o sistema lê as páginas públicas e as guarda como um
 * material. Ler de novo o mesmo site atualiza o material, em vez de criar outro.
 *
 * A tela diz o que aconteceu com palavras simples (quantas páginas, o que ficou
 * de fora e por quê), porque "leu o site" sem número nenhum não deixa ninguém
 * confiar que o agente passou a saber o que está lá.
 */
import { useState } from "react";
import { Globe } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Card } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { apiClient } from "@/lib/api/client";
import { showApiError } from "@/components/feedback/ApiErrorToast";
import { useT } from "@/hooks/i18n/useT";

interface RespostaDoSite {
  data: {
    id: string;
    nome: string;
    atualizado: boolean;
    paginas: number;
    caracteres: number;
    ignoradas: Array<{ url: string; motivo: string }>;
    avisos: string[];
    indexacao_habilitada: boolean;
  };
}

interface Props {
  onLido: () => void;
}

export function LerSiteCard({ onLido }: Props) {
  const t = useT();
  const [url, setUrl] = useState("");
  const [lendo, setLendo] = useState(false);
  const [resumo, setResumo] = useState<RespostaDoSite["data"] | null>(null);

  async function ler() {
    if (url.trim().length < 4 || lendo) return;
    setLendo(true);
    setResumo(null);
    try {
      const r = await apiClient.post<RespostaDoSite>("/api/v1/ai/knowledge/sources/site", { url: url.trim() });
      setResumo(r.data);
      toast.success(
        r.data.atualizado
          ? t("Site atualizado no material.")
          : t("Site lido e guardado como material."),
      );
      onLido();
    } catch (err) {
      showApiError(err);
    } finally {
      setLendo(false);
    }
  }

  return (
    <Card className="p-4" data-testid="acervo-ler-site">
      <div className="flex items-start gap-3">
        <Globe className="mt-1 h-5 w-5 shrink-0 text-text-muted" aria-hidden />
        <div className="flex-1 space-y-3">
          <div>
            <h3 className="text-sm font-semibold">{t("Ler o site da empresa")}</h3>
            <p className="text-sm text-text-muted">
              {t(
                "Digite o endereço do site. O sistema lê as páginas públicas e guarda o texto como material, para o agente responder com base no que está lá. Para ler de novo (o site mudou), repita o mesmo endereço.",
              )}
            </p>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="flex-1 space-y-1">
              <Label htmlFor="ler-site-url">{t("Endereço do site")}</Label>
              <Input
                id="ler-site-url"
                value={url}
                onChange={(e) => setUrl(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") void ler();
                }}
                placeholder="minhaempresa.com.br"
                disabled={lendo}
                inputMode="url"
                autoComplete="off"
              />
            </div>
            <Button onClick={() => void ler()} disabled={lendo || url.trim().length < 4} data-testid="ler-site-botao">
              {lendo ? t("Lendo o site…") : t("Ler o site")}
            </Button>
          </div>

          {resumo ? (
            <div className="rounded-md border border-border p-3 text-sm" data-testid="ler-site-resumo">
              <p>
                {`${resumo.paginas} ${resumo.paginas === 1 ? t("página lida") : t("páginas lidas")}`}
                {` · ${resumo.caracteres.toLocaleString("pt-BR")} ${t("caracteres")}`}
              </p>
              {!resumo.indexacao_habilitada ? (
                <p className="mt-1 text-text-muted">
                  {t("Ainda falta uma chave de IA para o sistema indexar este material (veja o aviso acima).")}
                </p>
              ) : (
                <p className="mt-1 text-text-muted">{t("O material começa a ser preparado em instantes.")}</p>
              )}
              {resumo.avisos.map((a) => (
                <p key={a} className="mt-1 text-text-muted">
                  {a}
                </p>
              ))}
              {resumo.ignoradas.length > 0 ? (
                <details className="mt-2">
                  <summary className="cursor-pointer text-text-muted">
                    {`${resumo.ignoradas.length} ${t("página(s) ficaram de fora")}`}
                  </summary>
                  <ul className="mt-1 space-y-0.5 text-xs text-text-muted">
                    {resumo.ignoradas.map((i) => (
                      <li key={i.url}>
                        {i.url}: {i.motivo}
                      </li>
                    ))}
                  </ul>
                </details>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </Card>
  );
}
