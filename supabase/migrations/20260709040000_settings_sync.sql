create table if not exists public.settings_sync (
  user_id uuid not null references auth.users(id) on delete cascade,
  field_group text not null check (field_group in ('appSettings','operatorConfig','keybindings','remoteBindings')),
  payload jsonb not null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  check (pg_column_size(payload) <= 65536),
  check (payload::text !~* '(sk_live_|sk_test_|whsec_|ghp_|gho_|xoxb-|AKIA[0-9A-Z]{16})'),
  check (updated_at <= now() + interval '5 minutes'),
  primary key (user_id, field_group)
);

alter table public.settings_sync enable row level security;

drop policy if exists "settings_sync_select_own" on public.settings_sync;
create policy "settings_sync_select_own"
  on public.settings_sync
  for select
  to authenticated
  using (auth.uid() = user_id);

drop policy if exists "settings_sync_insert_own" on public.settings_sync;
create policy "settings_sync_insert_own"
  on public.settings_sync
  for insert
  to authenticated
  with check (auth.uid() = user_id);

drop policy if exists "settings_sync_update_own" on public.settings_sync;
create policy "settings_sync_update_own"
  on public.settings_sync
  for update
  to authenticated
  using (auth.uid() = user_id)
  with check (auth.uid() = user_id);

drop policy if exists "settings_sync_delete_own" on public.settings_sync;
