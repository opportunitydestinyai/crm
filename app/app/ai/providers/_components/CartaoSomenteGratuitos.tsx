"use client";

/**
 * O cartão "Somente modelos gratuitos" em Provedores.
 *
 * Ligado, o seletor de modelo do agente só oferece modelos que não cobram.
 * Desligado, libera todos — inclusive os pagos, que cobram na conta da chave
 * cadastrada em IA › Credenciais (Anthropic, OpenAI, etc.).
 */
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";

import { Card } from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";
import { apiClient } from "@/lib/api/client";
import { useT } from "@/hooks/i18n/useT";

interface Resposta {
  data: { somente_gratuitos: boolean };
}

export function CartaoSomenteGratuitos() {
  const t = useT();
  const [ligado, setLigado] = useState<boolean | null>(null);
  const [salvando, setSalvando] = useState(false);

  useEffect(() => {
    apiClient
      .get<Resposta>("/api/v1/ai/somente-gratuitos")
      .then((r) => setLigado(r.data.somente_gratuitos))
      .catch(() => setLigado(null));
  }, []);

  const alternar = useCallback(
    async (valor: boolean) => {
      setSalvando(true);
      try {
        const r = await apiClient.put<Resposta>("/api/v1/ai/somente-gratuitos", {
          somente_gratuitos: valor,
        });
        setLigado(r.data.somente_gratuitos);
        toast.success(valor ? t("Somente modelos gratuitos ligado.") : t("Modelos pagos liberados."));
      } catch {
        toast.error(t("Não consegui salvar. Só administradores podem mudar isto."));
      } finally {
        setSalvando(false);
      }
    },
    [t],
  );

  if (ligado === null) return null;

  return (
    <Card className="p-4" data-testid="cartao-somente-gratuitos">
      <div className="flex items-start justify-between gap-4">
        <div className="space-y-1">
          <h3 className="text-sm font-semibold">{t("Somente modelos gratuitos")}</h3>
          <p className="text-sm text-muted-foreground">
            {ligado
              ? t("O seletor de modelo mostra só os modelos gratuitos.")
              : t("Todos os modelos estão liberados, inclusive os pagos. Eles cobram na conta da chave que você cadastrou em Credenciais.")}
          </p>
        </div>
        <Switch
          checked={ligado}
          disabled={salvando}
          onCheckedChange={alternar}
          aria-label={t("Somente modelos gratuitos")}
        />
      </div>
    </Card>
  );
}
