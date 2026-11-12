import { type NextRequest } from "next/server";
import { randomUUID } from "node:crypto";
import { z } from "zod";

import { audit } from "@/lib/audit";
import { ok, fail } from "@/lib/api/wrappers";
import {
  falhaDaEscritaDePlatformAdmin,
  requirePlatformAdmin,
  requirePlatformAdminEscrita,
  type PlatformAdminContext,
} from "@/lib/auth/requirePlatformAdmin";
import { requireSupportWrite } from "@/lib/impersonate/support";
import { createAdminClient } from "@/lib/supabase/admin";

/**
 * Conta comercial do cliente no CRM mestre (migration 0536).
 *
 * Só a plataforma lê e escreve: as tabelas `platform_customer_*` não têm grant
 * para `authenticated`, então o único caminho até elas é esta rota, depois de
 * `requirePlatformAdmin`. O `organization_id` vem do CAMINHO, nunca do corpo, e
 * toda consulta o filtra (service role ignora RLS).
 */

const ETAPAS = ["contratou", "configurando", "em_operacao", "renovacao", "encerrado", "cancelou"] as const;
const PAGAMENTOS = ["pago", "pendente", "atrasado"] as const;
const COBRANCAS = ["assinatura", "unico"] as const;

const data = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Use AAAA-MM-DD");

const contaSchema = z
  .object({
    stage: z.enum(ETAPAS),
    payment_status: z.enum(PAGAMENTOS),
    billing: z.enum(COBRANCAS),
    contract_start: data.nullable(),
    contract_end: data.nullable(),
    value_cents: z.number().int().min(0).max(10_000_000_000),
    renewal_notice_days: z.number().int().min(0).max(365),
    cancellation_fee_cents: z.number().int().min(0).nullable(),
    cancellation_note: z.string().trim().max(2000).nullable(),
    notes: z.string().trim().max(4000).nullable(),
  })
  .partial()
  .strict();

const novoSchema = z.discriminatedUnion("acao", [
  z.object({
    acao: z.literal("pagamento"),
    amount_cents: z.number().int().min(0),
    paid_at: z.string().datetime().optional(),
    method: z.string().trim().max(60).optional(),
    reference: z.string().trim().max(60).optional(),
    note: z.string().trim().max(500).optional(),
  }),
  z.object({ acao: z.literal("nota"), body: z.string().trim().min(1).max(4000) }),
  z.object({
    acao: z.literal("produto"),
    name: z.string().trim().min(1).max(120),
    kind: z.enum(["servico", "produto"]).default("produto"),
    billing: z.enum(COBRANCAS).default("assinatura"),
    price_cents: z.number().int().min(0).default(0),
    starts_on: data.nullable().optional(),
    ends_on: data.nullable().optional(),
  }),
]);

type Admin = ReturnType<typeof createAdminClient>;

async function carregaConta(admin: Admin, orgId: string) {
  const { data: conta } = await admin
    .from("platform_customer_accounts")
    .select("*")
    .eq("organization_id", orgId)
    .maybeSingle();
  return conta;
}

/** A conta nasce na primeira escrita: não há "cliente sem conta" para o operador cuidar. */
async function garanteConta(admin: Admin, orgId: string) {
  const existente = await carregaConta(admin, orgId);
  if (existente) return existente;
  const { data: criada, error } = await admin
    .from("platform_customer_accounts")
    .insert({ organization_id: orgId })
    .select("*")
    .single();
  if (error?.code === "23505") return carregaConta(admin, orgId); // corrida: outra chamada criou
  if (error) throw new Error(error.message);
  return criada;
}

async function organizacaoExiste(admin: Admin, id: string) {
  const { data: org } = await admin.from("organizations").select("id, slug").eq("id", id).maybeSingle();
  return org;
}

type Ctx = { params: Promise<{ id: string }> };

export async function GET(_req: NextRequest, { params }: Ctx) {
  const requestId = randomUUID();
  const { id } = await params;
  try {
    await requirePlatformAdmin();
  } catch {
    return fail("forbidden", "Platform admin required", 403, { requestId });
  }
  if (!z.string().uuid().safeParse(id).success) return fail("validation_error", "id inválido", 400, { requestId });

  const admin = createAdminClient();
  if (!(await organizacaoExiste(admin, id))) return fail("not_found", "Cliente não encontrado", 404, { requestId });

  const conta = await carregaConta(admin, id);
  if (!conta) return ok({ conta: null, produtos: [], pagamentos: [], notas: [] }, { requestId });

  const [produtos, pagamentos, notas] = await Promise.all([
    admin.from("platform_customer_products").select("*").eq("account_id", conta.id).order("created_at", { ascending: false }),
    admin.from("platform_customer_payments").select("*").eq("account_id", conta.id).order("paid_at", { ascending: false }).limit(100),
    admin.from("platform_customer_notes").select("*").eq("account_id", conta.id).order("created_at", { ascending: false }).limit(100),
  ]);
  return ok(
    { conta, produtos: produtos.data ?? [], pagamentos: pagamentos.data ?? [], notas: notas.data ?? [] },
    { requestId },
  );
}

export async function PUT(req: NextRequest, { params }: Ctx) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id } = await params;

  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  if (!z.string().uuid().safeParse(id).success) return fail("validation_error", "id inválido", 400, { requestId });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "JSON inválido", 400, { requestId });
  }
  const parsed = contaSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados inválidos", 400, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  if (!(await organizacaoExiste(admin, id))) return fail("not_found", "Cliente não encontrado", 404, { requestId });
  const antes = await garanteConta(admin, id);
  if (!antes) return fail("internal_error", "Não foi possível abrir a conta", 500, { requestId });

  const patch: Record<string, unknown> = { ...parsed.data, updated_at: new Date().toISOString() };
  // Cancelar carimba a data; sair de "cancelou" limpa — a data nunca fica órfã da etapa.
  if (parsed.data.stage === "cancelou" && antes.stage !== "cancelou") patch.cancelled_at = new Date().toISOString();
  if (parsed.data.stage && parsed.data.stage !== "cancelou") patch.cancelled_at = null;

  const { data: conta, error } = await admin
    .from("platform_customer_accounts")
    .update(patch)
    .eq("id", antes.id)
    .eq("organization_id", id)
    .select("*")
    .single();
  if (error) {
    if (error.code === "23514") {
      return fail("validation_error", "Confira as datas: o fim não pode ser antes do início.", 400, { requestId });
    }
    return fail("internal_error", "Não foi possível salvar", 500, { requestId });
  }

  void audit({
    action: "platform_admin.customer_account_updated",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "platform_customer_account",
    resourceId: antes.id,
    requestId,
    metadata: { campos: Object.keys(parsed.data), etapa_antes: antes.stage, etapa_depois: conta.stage },
  });
  return ok({ conta }, { requestId });
}

export async function POST(req: NextRequest, { params }: Ctx) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id } = await params;

  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  if (!z.string().uuid().safeParse(id).success) return fail("validation_error", "id inválido", 400, { requestId });

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return fail("validation_error", "JSON inválido", 400, { requestId });
  }
  const parsed = novoSchema.safeParse(body);
  if (!parsed.success) {
    return fail("validation_error", "Dados inválidos", 400, { requestId, details: parsed.error.flatten() });
  }

  const admin = createAdminClient();
  if (!(await organizacaoExiste(admin, id))) return fail("not_found", "Cliente não encontrado", 404, { requestId });
  const conta = await garanteConta(admin, id);
  if (!conta) return fail("internal_error", "Não foi possível abrir a conta", 500, { requestId });
  const d = parsed.data;

  if (d.acao === "pagamento") {
    const { data: linha, error } = await admin
      .from("platform_customer_payments")
      .insert({
        account_id: conta.id,
        amount_cents: d.amount_cents,
        paid_at: d.paid_at ?? new Date().toISOString(),
        method: d.method ?? null,
        reference: d.reference ?? null,
        note: d.note ?? null,
        created_by: ctx.user.id,
      })
      .select("*")
      .single();
    if (error) return fail("internal_error", "Não foi possível registrar o pagamento", 500, { requestId });
    // Pagamento registrado = cliente em dia. O operador pode voltar para "pendente" se quiser.
    await admin
      .from("platform_customer_accounts")
      .update({ payment_status: "pago", updated_at: new Date().toISOString() })
      .eq("id", conta.id)
      .eq("organization_id", id);
    void audit({
      action: "platform_admin.customer_payment_registered",
      actorUserId: ctx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: id,
      resourceType: "platform_customer_payment",
      resourceId: linha.id,
      requestId,
      metadata: { amount_cents: d.amount_cents },
    });
    return ok({ pagamento: linha }, { requestId, status: 201 });
  }

  if (d.acao === "nota") {
    const { data: linha, error } = await admin
      .from("platform_customer_notes")
      .insert({ account_id: conta.id, body: d.body, created_by: ctx.user.id })
      .select("*")
      .single();
    if (error) return fail("internal_error", "Não foi possível salvar a observação", 500, { requestId });
    void audit({
      action: "platform_admin.customer_note_added",
      actorUserId: ctx.user.id,
      actingAsPlatformAdmin: true,
      bypassedRls: true,
      organizationId: id,
      resourceType: "platform_customer_note",
      resourceId: linha.id,
      requestId,
    });
    return ok({ nota: linha }, { requestId, status: 201 });
  }

  const { data: linha, error } = await admin
    .from("platform_customer_products")
    .insert({
      account_id: conta.id,
      name: d.name,
      kind: d.kind,
      billing: d.billing,
      price_cents: d.price_cents,
      starts_on: d.starts_on ?? null,
      ends_on: d.ends_on ?? null,
    })
    .select("*")
    .single();
  if (error) return fail("internal_error", "Não foi possível adicionar o produto", 500, { requestId });
  void audit({
    action: "platform_admin.customer_product_changed",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: "platform_customer_product",
    resourceId: linha.id,
    requestId,
    metadata: { acao: "adicionado", name: d.name },
  });
  return ok({ produto: linha }, { requestId, status: 201 });
}

export async function DELETE(req: NextRequest, { params }: Ctx) {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const requestId = randomUUID();
  const { id } = await params;

  let ctx: PlatformAdminContext;
  try {
    ctx = await requirePlatformAdminEscrita();
  } catch (err) {
    return falhaDaEscritaDePlatformAdmin(err, requestId);
  }
  const produtoId = req.nextUrl.searchParams.get("produto_id");
  const pagamentoId = req.nextUrl.searchParams.get("pagamento_id");
  const alvo = produtoId ?? pagamentoId;
  if (!alvo || !z.string().uuid().safeParse(id).success || !z.string().uuid().safeParse(alvo).success) {
    return fail("validation_error", "Informe produto_id ou pagamento_id", 400, { requestId });
  }

  const admin = createAdminClient();
  const conta = await carregaConta(admin, id);
  if (!conta) return fail("not_found", "Conta não encontrada", 404, { requestId });

  const tabela = produtoId ? "platform_customer_products" : "platform_customer_payments";
  const { error, count } = await admin
    .from(tabela)
    .delete({ count: "exact" })
    .eq("id", alvo)
    .eq("account_id", conta.id);
  if (error) return fail("internal_error", "Não foi possível remover", 500, { requestId });
  if (!count) return fail("not_found", "Registro não encontrado", 404, { requestId });

  void audit({
    action: "platform_admin.customer_product_changed",
    actorUserId: ctx.user.id,
    actingAsPlatformAdmin: true,
    bypassedRls: true,
    organizationId: id,
    resourceType: produtoId ? "platform_customer_product" : "platform_customer_payment",
    resourceId: alvo,
    requestId,
    metadata: { acao: "removido" },
  });
  return ok({ removido: true }, { requestId });
}
