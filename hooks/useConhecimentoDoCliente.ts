"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";

export interface MaterialDoCliente {
  id: string;
  nome: string;
  origem: "site" | "arquivo" | "texto";
  detalhe: string | null;
  status: string;
  trechos: number;
  indexacao: string | null;
  erro_de_indexacao: string | null;
  atualizado_em: string;
  em_uso_pela_ruby: boolean;
}

export interface PainelDeConhecimento {
  materiais: MaterialDoCliente[];
  agente: { id: string; nome: string; versao: number } | null;
  chave_de_embedding: boolean;
  fora_da_ruby: number;
}

const chave = (id: string) => ["admin", "tenant", id, "conhecimento"] as const;
const rota = (id: string) => `/api/v1/admin/tenants/${id}/conhecimento`;

export function useConhecimentoDoCliente(id: string) {
  return useQuery({
    queryKey: chave(id),
    queryFn: async () => (await apiClient.get<{ data: PainelDeConhecimento }>(rota(id))).data,
    // Enquanto algum material ainda está sendo indexado, confere de novo.
    refetchInterval: (q) => {
      const d = q.state.data;
      return d?.materiais.some((m) => m.status === "ready" && m.trechos === 0 && m.indexacao !== "failed" && m.indexacao !== "sem_credencial") ? 5000 : false;
    },
  });
}

export function useEscritaDoConhecimento(id: string) {
  const qc = useQueryClient();
  const aoTerminar = () => void qc.invalidateQueries({ queryKey: chave(id) });
  return {
    adicionar: useMutation({
      mutationFn: (corpo: Record<string, unknown>) => apiClient.post<{ data: Record<string, unknown> }>(rota(id), corpo),
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
    enviarArquivo: useMutation({
      mutationFn: async (args: { arquivo: File; nome: string }) => {
        const form = new FormData();
        form.set("file", args.arquivo);
        form.set("name", args.nome);
        // O cliente de API põe Content-Type JSON; FormData precisa do boundary do navegador.
        const res = await fetch(`${rota(id)}/arquivo`, { method: "POST", body: form, credentials: "same-origin" });
        const json = (await res.json().catch(() => ({}))) as { error?: { message?: string } };
        if (!res.ok) throw new Error(json.error?.message ?? "Não foi possível enviar o arquivo.");
        return json;
      },
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
    remover: useMutation({
      mutationFn: (fonteId: string) => apiClient.delete(`${rota(id)}?fonte_id=${fonteId}`),
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
  };
}
