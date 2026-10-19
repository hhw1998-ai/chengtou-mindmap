-- ============================================================
-- 城投思维导图 · 多人标注同步（Supabase / Postgres）
-- 文档前缀 mm_，doc_key 对应页面里的 DOC_KEY 文档指纹
-- 权限模型：所有人可读；只能增删改自己名下的记录（RLS）
-- ============================================================

-- ---------- 用户 ----------
create table if not exists public.mm_members (
  id           uuid primary key,                 -- = auth.uid()（匿名登录生成的稳定 ID）
  nickname     text not null,
  created_at   timestamptz not null default now(),
  last_seen_at timestamptz not null default now()
);
create unique index if not exists mm_members_nickname_uniq
  on public.mm_members (lower(nickname));

-- ---------- 标注 ----------
create table if not exists public.mm_annotations (
  id         uuid primary key default gen_random_uuid(),
  doc_key    text not null,
  node_id    text not null,
  author_id  uuid not null references public.mm_members(id) on delete cascade,
  body       text not null default '',
  anno_state smallint not null default 4 check (anno_state between 0 and 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_key, node_id, author_id)
);

-- ---------- 高亮（首批/第二批/第三批/重点/存疑） ----------
create table if not exists public.mm_highlights (
  id         uuid primary key default gen_random_uuid(),
  doc_key    text not null,
  node_id    text not null,
  author_id  uuid not null references public.mm_members(id) on delete cascade,
  mark       smallint not null check (mark between 0 and 4),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (doc_key, node_id, author_id)
);

-- ---------- 对齐页 ----------
create table if not exists public.mm_pages (
  id         uuid primary key default gen_random_uuid(),
  doc_key    text not null,
  author_id  uuid not null references public.mm_members(id) on delete cascade,
  name       text not null,
  descr      text not null default '',
  marks      smallint[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- ---------- 索引 ----------
create index if not exists mm_annotations_doc_idx on public.mm_annotations (doc_key);
create index if not exists mm_annotations_node_idx on public.mm_annotations (doc_key, node_id);
create index if not exists mm_highlights_doc_idx on public.mm_highlights (doc_key);
create index if not exists mm_highlights_node_idx on public.mm_highlights (doc_key, node_id);
create index if not exists mm_pages_doc_idx on public.mm_pages (doc_key);

-- ---------- updated_at 自动更新 ----------
create or replace function public.mm_touch_updated_at()
returns trigger language plpgsql as $$
begin
  new.updated_at = now();
  return new;
end $$;

drop trigger if exists mm_annotations_touch on public.mm_annotations;
create trigger mm_annotations_touch before update on public.mm_annotations
  for each row execute function public.mm_touch_updated_at();

drop trigger if exists mm_highlights_touch on public.mm_highlights;
create trigger mm_highlights_touch before update on public.mm_highlights
  for each row execute function public.mm_touch_updated_at();

drop trigger if exists mm_pages_touch on public.mm_pages;
create trigger mm_pages_touch before update on public.mm_pages
  for each row execute function public.mm_touch_updated_at();

-- ---------- 行级安全 ----------
alter table public.mm_members     enable row level security;
alter table public.mm_annotations enable row level security;
alter table public.mm_highlights  enable row level security;
alter table public.mm_pages       enable row level security;

-- mm_members：人人可读，只能写自己
drop policy if exists mm_members_select on public.mm_members;
create policy mm_members_select on public.mm_members for select using (true);
drop policy if exists mm_members_insert on public.mm_members;
create policy mm_members_insert on public.mm_members for insert with check (auth.uid() = id);
drop policy if exists mm_members_update on public.mm_members;
create policy mm_members_update on public.mm_members for update
  using (auth.uid() = id) with check (auth.uid() = id);
drop policy if exists mm_members_delete on public.mm_members;
create policy mm_members_delete on public.mm_members for delete using (auth.uid() = id);

-- 通用：读全部，写自己的（annotations / highlights / pages）
do $$
declare t text;
begin
  foreach t in array array['mm_annotations','mm_highlights','mm_pages'] loop
    execute format('drop policy if exists %I on public.%I', t || '_select', t);
    execute format('create policy %I on public.%I for select using (true)', t || '_select', t);
    execute format('drop policy if exists %I on public.%I', t || '_insert', t);
    execute format('create policy %I on public.%I for insert with check (auth.uid() = author_id)', t || '_insert', t);
    execute format('drop policy if exists %I on public.%I', t || '_update', t);
    execute format('create policy %I on public.%I for update using (auth.uid() = author_id) with check (auth.uid() = author_id)', t || '_update', t);
    execute format('drop policy if exists %I on public.%I', t || '_delete', t);
    execute format('create policy %I on public.%I for delete using (auth.uid() = author_id)', t || '_delete', t);
  end loop;
end $$;

-- ---------- 授权 ----------
grant select, insert, update, delete on public.mm_members     to anon, authenticated;
grant select, insert, update, delete on public.mm_annotations to anon, authenticated;
grant select, insert, update, delete on public.mm_highlights  to anon, authenticated;
grant select, insert, update, delete on public.mm_pages       to anon, authenticated;

-- ---------- 实时订阅 ----------
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime') then
    begin alter publication supabase_realtime add table public.mm_annotations; exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.mm_highlights;  exception when duplicate_object then null; end;
    begin alter publication supabase_realtime add table public.mm_pages;       exception when duplicate_object then null; end;
  end if;
end $$;

alter table public.mm_annotations replica identity full;
alter table public.mm_highlights  replica identity full;
alter table public.mm_pages       replica identity full;

-- ---------- 表注释 ----------
comment on table public.mm_members     is '思维导图标注用户：id 即 Supabase 匿名登录 uid，昵称唯一';
comment on table public.mm_annotations is '节点标注：每人每节点一条，后写覆盖';
comment on table public.mm_highlights  is '节点高亮：mark 0首批/1第二批/2第三批/3重点/4存疑';
comment on table public.mm_pages       is '按高亮类别生成的对齐页';
