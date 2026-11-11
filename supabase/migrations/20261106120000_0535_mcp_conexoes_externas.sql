-- manifest: **Canal de conectores MCP por cliente (`mcp_external_connections`).** A organização cadastra o endereço (e, se houver, o cabeçalho de autenticação) do servidor MCP da plataforma que ela já usa; o agente lista e chama as ferramentas dele. Genérico: nada aqui é específico de um sistema. O segredo é cifrado (AES-GCM, mesma chave de `ai_provider_credentials`); a tela lê só a view `_safe`.

-- ---- canal de conectores MCP por cliente (migration 0535) ----
--
-- Espelha `external_db_connections` (banco externo): uma linha por conexão, por
-- organização, segredo cifrado, RLS por organização com escrita só para `admin`.
-- O que muda é o alvo: em vez de host/porta de um Postgres, um endereço HTTPS de
-- servidor MCP. Nenhuma função nova em `public` => nenhuma superfície
-- `security definer` nova.

create table if not exists public.mcp_external_connections (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references public.organizations(id) on delete cascade,
  label text not null,
  url text not null,
  auth_header_name text not null default 'Authorization',
  auth_encrypted bytea,
  auth_iv bytea,
  auth_tag bytea,
  enabled boolean not null default true,
  tools_cache jsonb,
  last_tested_at timestamptz,
  last_test_ok boolean,
  last_test_error text,
  created_by uuid references auth.users(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint mcp_external_connections_label_uk unique (organization_id, label),
  constraint mcp_external_connections_url_https check (url ~* '^https://'),
  constraint mcp_external_connections_auth_completa
    check ((auth_encrypted is null and auth_iv is null and auth_tag is null)
        or (auth_encrypted is not null and auth_iv is not null and auth_tag is not null))
);

comment on table public.mcp_external_connections is
  'Servidor MCP externo que a organização conectou (a plataforma que ela já usa). O valor do cabeçalho de autenticação é cifrado com AES-GCM (AI_CRED_AES_KEY) e nunca é exposto: a tela lê a view mcp_external_connections_safe.';
comment on column public.mcp_external_connections.tools_cache is
  'Lista de ferramentas do último teste bem-sucedido (nome, descrição, schema). Só informativa: a lista viva vem do servidor a cada chamada.';

create index if not exists mcp_external_connections_org_idx
  on public.mcp_external_connections (organization_id)
  where enabled;

alter table public.mcp_external_connections enable row level security;

drop policy if exists tenant_isolation_mcp_external_connections_select on public.mcp_external_connections;
create policy tenant_isolation_mcp_external_connections_select on public.mcp_external_connections
  for select
  using (organization_id in (select * from public.fn_user_org_ids()));

drop policy if exists tenant_isolation_mcp_external_connections_write on public.mcp_external_connections;
create policy tenant_isolation_mcp_external_connections_write on public.mcp_external_connections
  for all
  using (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  )
  with check (
    organization_id in (select * from public.fn_user_org_ids())
      and public.fn_role_at_least(organization_id, 'admin')
  );

revoke all on public.mcp_external_connections from anon;

drop view if exists public.mcp_external_connections_safe;
create view public.mcp_external_connections_safe
  with (security_invoker = true)
  as
  select id, organization_id, label, url, auth_header_name,
         (auth_encrypted is not null) as tem_autenticacao,
         enabled, tools_cache, last_tested_at, last_test_ok, last_test_error,
         created_by, created_at, updated_at
  from public.mcp_external_connections;

revoke all on public.mcp_external_connections_safe from anon;
