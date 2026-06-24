create table if not exists public.ai_usage_events (
  id uuid primary key default gen_random_uuid(),
  org_id uuid not null references public.organizations(id) on delete cascade,
  user_id uuid references auth.users(id) on delete set null,
  feature text not null,
  model text not null,
  prompt_tokens integer not null default 0,
  completion_tokens integer not null default 0,
  total_tokens integer not null default 0,
  estimated_cost_usd numeric(12, 6),
  latency_ms integer,
  status text not null default 'success',
  request_id text,
  meta jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists ai_usage_events_org_created_idx
  on public.ai_usage_events (org_id, created_at desc);

create index if not exists ai_usage_events_feature_created_idx
  on public.ai_usage_events (feature, created_at desc);

alter table public.ai_usage_events enable row level security;

drop policy if exists "org members read ai usage" on public.ai_usage_events;
create policy "org members read ai usage"
  on public.ai_usage_events
  for select
  using (public.is_org_member(org_id, auth.uid()));

drop policy if exists "service role manages ai usage" on public.ai_usage_events;
create policy "service role manages ai usage"
  on public.ai_usage_events
  for all
  to service_role
  using (true)
  with check (true);

create table if not exists public.ai_token_budgets (
  org_id uuid primary key references public.organizations(id) on delete cascade,
  monthly_token_limit integer not null default 5000000,
  hard_limit_enabled boolean not null default true,
  alert_threshold_percent integer not null default 80,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

alter table public.ai_token_budgets enable row level security;

drop policy if exists "owners and partners read ai budgets" on public.ai_token_budgets;
create policy "owners and partners read ai budgets"
  on public.ai_token_budgets
  for select
  using (
    public.has_org_role(org_id, auth.uid(), array['owner', 'partner'])
  );

drop policy if exists "service role manages ai budgets" on public.ai_token_budgets;
create policy "service role manages ai budgets"
  on public.ai_token_budgets
  for all
  to service_role
  using (true)
  with check (true);

create trigger touch_ai_token_budgets_updated_at
  before update on public.ai_token_budgets
  for each row
  execute function public.touch_updated_at();
