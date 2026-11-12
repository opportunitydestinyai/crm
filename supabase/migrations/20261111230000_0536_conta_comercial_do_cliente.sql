-- manifest: **Conta comercial do cliente no CRM mestre.** Quatro tabelas só da plataforma (`platform_customer_accounts`, `_products`, `_payments`, `_notes`): etapa do cliente (Contratou…Cancelou), status de pagamento manual, vigência do contrato, produtos contratados, histórico de pagamentos e observações. Sem acesso por PostgREST (RLS ligada, só `service_role`); quem lê e escreve são as rotas `/api/v1/admin/tenants/[id]/conta`.

-- ---- conta comercial do cliente (migration 0536) ----
--
-- O CRM mestre (o painel /admin) cadastra CLIENTES. Até aqui o produto só sabia
-- "ativo/suspenso" de cada organização; não sabia se o cliente paga, desde
-- quando, até quando, nem o que contratou. Estas tabelas guardam isso.
--
-- São da PLATAFORMA, não de uma organização: o cliente nunca as lê. Por isso
-- seguem o molde de `platform_support_sessions` — RLS ligada, tudo revogado de
-- public/anon/authenticated e concedido só ao service_role. O isolamento entre
-- organizações não depende de policy: ninguém além das rotas de
-- `requirePlatformAdmin` chega aqui.

create table if not exists public.platform_customer_accounts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null unique references public.organizations(id) on delete cascade,
  stage text not null default 'contratou',
  payment_status text not null default 'pendente',
  billing text not null default 'assinatura',
  contract_start date,
  contract_end date,
  value_cents bigint not null default 0,
  currency text not null default 'BRL',
  renewal_notice_days integer not null default 30,
  cancelled_at timestamptz,
  cancellation_fee_cents bigint,
  cancellation_note text,
  notes text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint platform_customer_accounts_stage_check
    check (stage in ('contratou','configurando','em_operacao','renovacao','encerrado','cancelou')),
  constraint platform_customer_accounts_payment_check
    check (payment_status in ('pago','pendente','atrasado')),
  constraint platform_customer_accounts_billing_check
    check (billing in ('assinatura','unico')),
  constraint platform_customer_accounts_value_check check (value_cents >= 0),
  constraint platform_customer_accounts_notice_check check (renewal_notice_days between 0 and 365),
  constraint platform_customer_accounts_vigencia_check
    check (contract_end is null or contract_start is null or contract_end >= contract_start)
);

create table if not exists public.platform_customer_products (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.platform_customer_accounts(id) on delete cascade,
  name text not null,
  kind text not null default 'produto',
  billing text not null default 'assinatura',
  price_cents bigint not null default 0,
  starts_on date,
  ends_on date,
  status text not null default 'ativo',
  created_at timestamptz not null default now(),
  constraint platform_customer_products_kind_check check (kind in ('servico','produto')),
  constraint platform_customer_products_billing_check check (billing in ('assinatura','unico')),
  constraint platform_customer_products_status_check check (status in ('ativo','encerrado')),
  constraint platform_customer_products_price_check check (price_cents >= 0),
  constraint platform_customer_products_name_check check (length(btrim(name)) between 1 and 120)
);

create table if not exists public.platform_customer_payments (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.platform_customer_accounts(id) on delete cascade,
  paid_at timestamptz not null default now(),
  amount_cents bigint not null,
  method text,
  reference text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint platform_customer_payments_amount_check check (amount_cents >= 0)
);

create table if not exists public.platform_customer_notes (
  id uuid primary key default gen_random_uuid(),
  account_id uuid not null references public.platform_customer_accounts(id) on delete cascade,
  body text not null,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint platform_customer_notes_body_check check (length(btrim(body)) between 1 and 4000)
);

create index if not exists platform_customer_products_account_idx on public.platform_customer_products (account_id);
create index if not exists platform_customer_payments_account_idx on public.platform_customer_payments (account_id, paid_at desc);
create index if not exists platform_customer_notes_account_idx on public.platform_customer_notes (account_id, created_at desc);

alter table public.platform_customer_accounts enable row level security;
alter table public.platform_customer_products enable row level security;
alter table public.platform_customer_payments enable row level security;
alter table public.platform_customer_notes enable row level security;

revoke all on public.platform_customer_accounts from public, anon, authenticated;
revoke all on public.platform_customer_products from public, anon, authenticated;
revoke all on public.platform_customer_payments from public, anon, authenticated;
revoke all on public.platform_customer_notes from public, anon, authenticated;
grant select, insert, update, delete on public.platform_customer_accounts to service_role;
grant select, insert, update, delete on public.platform_customer_products to service_role;
grant select, insert, update, delete on public.platform_customer_payments to service_role;
grant select, insert, update, delete on public.platform_customer_notes to service_role;

comment on table public.platform_customer_accounts is
  'Conta comercial de um cliente no CRM mestre: etapa, pagamento (manual), vigência e valor. Só a plataforma lê e escreve (service_role).';
comment on table public.platform_customer_products is
  'Produtos e serviços que o cliente contratou, com preço e vigência. Só a plataforma.';
comment on table public.platform_customer_payments is
  'Histórico de pagamentos registrados à mão pelo operador da plataforma. Só a plataforma.';
comment on table public.platform_customer_notes is
  'Observações de acompanhamento do cliente. Só a plataforma.';
