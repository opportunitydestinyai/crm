"use client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { showApiError } from "@/components/feedback/ApiErrorToast";
import { apiClient } from "@/lib/api/client";
import type { EtapaDoCliente, PagamentoDoCliente } from "@/lib/admin/conta-do-cliente";

export interface ContaDoCliente {
  id: string;
  organization_id: string;
  stage: EtapaDoCliente;
  payment_status: PagamentoDoCliente;
  billing: "assinatura" | "unico";
  contract_start: string | null;
  contract_end: string | null;
  value_cents: number;
  currency: string;
  renewal_notice_days: number;
  cancelled_at: string | null;
  cancellation_fee_cents: number | null;
  cancellation_note: string | null;
  notes: string | null;
}

export interface ProdutoDoCliente {
  id: string;
  name: string;
  kind: "servico" | "produto";
  billing: "assinatura" | "unico";
  price_cents: number;
  starts_on: string | null;
  ends_on: string | null;
  status: "ativo" | "encerrado";
}

export interface PagamentoRegistrado {
  id: string;
  paid_at: string;
  amount_cents: number;
  method: string | null;
  reference: string | null;
  note: string | null;
}

export interface NotaDoCliente {
  id: string;
  body: string;
  created_at: string;
}

export interface ContaCompleta {
  conta: ContaDoCliente | null;
  produtos: ProdutoDoCliente[];
  pagamentos: PagamentoRegistrado[];
  notas: NotaDoCliente[];
}

const chave = (id: string) => ["admin", "tenant", id, "conta"] as const;
const rota = (id: string) => `/api/v1/admin/tenants/${id}/conta`;

export function useContaDoCliente(id: string) {
  return useQuery({
    queryKey: chave(id),
    queryFn: async () => (await apiClient.get<{ data: ContaCompleta }>(rota(id))).data,
  });
}

/** Salvar a conta, registrar pagamento/nota/produto e remover: todas invalidam a mesma leitura. */
export function useEscritaDaConta(id: string) {
  const qc = useQueryClient();
  const aoTerminar = () => {
    void qc.invalidateQueries({ queryKey: chave(id) });
    void qc.invalidateQueries({ queryKey: ["admin", "tenants"] });
  };
  return {
    salvar: useMutation({
      mutationFn: (campos: Partial<Omit<ContaDoCliente, "id" | "organization_id" | "currency" | "cancelled_at">>) =>
        apiClient.put(rota(id), campos),
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
    adicionar: useMutation({
      mutationFn: (corpo: Record<string, unknown>) => apiClient.post(rota(id), corpo),
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
    remover: useMutation({
      mutationFn: (alvo: { produto_id?: string; pagamento_id?: string }) => {
        const q = new URLSearchParams(alvo as Record<string, string>).toString();
        return apiClient.delete(`${rota(id)}?${q}`);
      },
      onSuccess: aoTerminar,
      onError: (e) => showApiError(e),
    }),
  };
}
