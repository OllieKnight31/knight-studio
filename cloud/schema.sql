-- Ainable Studio sharing service: the database.
--
-- One Supabase project, run by whoever publishes the app, holds every customer's
-- workspaces, people, shared videos and watch history. Run this whole file in that
-- project's SQL Editor. It is safe to run again: it only adds what is missing.
--
-- How access is decided
--   * Every table has row level security ON and NO policies, so nothing can be read or
--     written directly with the public key or a signed-in person's key.
--   * Everything goes through the functions below, each of which checks who is asking.
--   * A video file sits in storage under a long random path. The path is only ever
--     handed out by ks_watch(), to someone allowed to watch.
--
-- Roles
--   admin   — a workspace's owner or anyone they promote: sees every video, every viewer
--             and every member in the workspace, and can change all of it.
--   member  — someone on the team who records: sees and manages only their own videos.
--   viewer  — anyone a video or folder has been shared with. Not a member of anything;
--             they simply see "Shared with me".

create extension if not exists pgcrypto;

create table if not exists public.workspaces (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  created_by uuid not null,
  created_at timestamptz not null default now()
);

create table if not exists public.members (
  workspace_id uuid not null references public.workspaces on delete cascade,
  email text not null,
  user_id uuid,                      -- filled in the first time that person signs in
  role text not null check (role in ('admin', 'member')),
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, email)
);
create index if not exists members_user on public.members (user_id);

create table if not exists public.videos (
  id text primary key,
  workspace_id uuid not null references public.workspaces on delete cascade,
  owner_id uuid not null,
  owner_email text not null,
  project_id text not null,          -- the app's own id for the recording
  title text not null default 'Untitled video',
  folder text not null default '',
  duration numeric not null default 0,
  file_path text,
  poster_path text,
  meta jsonb not null default '{}',  -- summary, chapters, steps, captions, brand
  access text not null default 'invited' check (access in ('invited', 'link')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, owner_id, project_id)
);

-- Who a single video is shared with.
create table if not exists public.grants (
  video_id text not null references public.videos on delete cascade,
  email text not null,
  required boolean not null default false,
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (video_id, email)
);
create index if not exists grants_email on public.grants (email);

-- Who a whole folder is shared with: covers every video its owner files there, now or later.
create table if not exists public.folder_grants (
  workspace_id uuid not null references public.workspaces on delete cascade,
  owner_id uuid not null,
  folder text not null,
  email text not null,
  required boolean not null default false,
  invited_by uuid,
  created_at timestamptz not null default now(),
  primary key (workspace_id, owner_id, folder, email)
);
create index if not exists folder_grants_email on public.folder_grants (email);

-- One row per sitting: how long was actually played. Signed-in or not.
create table if not exists public.views (
  id bigint generated always as identity primary key,
  video_id text not null references public.videos on delete cascade,
  viewer_email text,
  session text not null,
  seconds numeric not null default 0,
  duration numeric not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (video_id, session)
);
create index if not exists views_video on public.views (video_id);

-- One row per signed-in person per video: WHICH parts they have watched, across every
-- sitting. One bit per five seconds of video, so watching the first half twice is still
-- half, and skipping to the end does not count as finishing.
create table if not exists public.progress (
  video_id text not null references public.videos on delete cascade,
  email text not null,
  coverage bit varying not null,
  first_at timestamptz not null default now(),
  last_at timestamptz not null default now(),
  completed_at timestamptz,
  primary key (video_id, email)
);

alter table public.workspaces enable row level security;
alter table public.members enable row level security;
alter table public.videos enable row level security;
alter table public.grants enable row level security;
alter table public.folder_grants enable row level security;
alter table public.views enable row level security;
alter table public.progress enable row level security;

/* ------------------------------------------------------------------ helpers */

create or replace function public.ks_email() returns text language sql stable as $$
  select nullif(lower(trim(coalesce(auth.jwt() ->> 'email', ''))), '')
$$;

create or replace function public.ks_clean_emails(p text[]) returns text[] language sql immutable as $$
  select coalesce(array_agg(distinct e), '{}') from (
    select lower(trim(x)) as e from unnest(coalesce(p, '{}')) x
  ) t where e ~ '^[^@\s]+@[^@\s]+\.[^@\s]+$' and length(e) <= 254
$$;

-- The workspace the caller belongs to and their role there. Internal.
create or replace function public.ks_membership(out workspace_id uuid, out role text)
language sql stable security definer set search_path = public as $$
  select m.workspace_id, m.role from public.members m
  where m.user_id = auth.uid() order by m.created_at limit 1
$$;

-- May the caller manage this video? Its owner, or an admin of its workspace.
create or replace function public.ks_can_manage(p_video text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (
    select 1 from public.videos v
    where v.id = p_video and (
      v.owner_id = auth.uid()
      or exists (select 1 from public.members m where m.workspace_id = v.workspace_id and m.user_id = auth.uid() and m.role = 'admin')
    )
  )
$$;

-- May this email watch this video? Shared directly, or through its folder.
create or replace function public.ks_granted(p_video text, p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select p_email is not null and (
    exists (select 1 from public.grants g where g.video_id = p_video and g.email = p_email)
    or exists (
      select 1 from public.videos v join public.folder_grants f
        on f.workspace_id = v.workspace_id and f.owner_id = v.owner_id and f.folder = v.folder
      where v.id = p_video and v.folder <> '' and f.email = p_email
    )
  )
$$;

create or replace function public.ks_required(p_video text, p_email text) returns boolean
language sql stable security definer set search_path = public as $$
  select coalesce((select g.required from public.grants g where g.video_id = p_video and g.email = p_email), false)
      or exists (
        select 1 from public.videos v join public.folder_grants f
          on f.workspace_id = v.workspace_id and f.owner_id = v.owner_id and f.folder = v.folder
        where v.id = p_video and v.folder <> '' and f.email = p_email and f.required
      )
$$;

create or replace function public.ks_percent(p bit varying) returns numeric language sql immutable as $$
  select case when p is null or length(p) = 0 then 0
    else round(100.0 * length(replace(p::text, '0', '')) / length(p), 0) end
$$;

-- The workspaces the caller belongs to, as text. Used by the storage rule at the bottom.
create or replace function public.ks_my_workspaces() returns text[]
language sql stable security definer set search_path = public as $$
  select coalesce(array_agg(workspace_id::text), '{}') from public.members where user_id = auth.uid()
$$;

/* ------------------------------------------------------------------ account */

-- Called right after signing in to the app. Joins the workspace the person was invited
-- to; if they were not invited anywhere, gives them a workspace of their own to run.
create or replace function public.ks_me(p_workspace_name text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare
  v_email text := public.ks_email();
  v_ws uuid; v_role text; v_name text;
begin
  if auth.uid() is null or v_email is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  update public.members set user_id = auth.uid() where email = v_email and user_id is null;
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_ws is null then
    insert into public.workspaces (name, created_by)
      values (coalesce(nullif(trim(p_workspace_name), ''), initcap(split_part(split_part(v_email, '@', 2), '.', 1)) || ' videos'), auth.uid())
      returning id into v_ws;
    insert into public.members (workspace_id, email, user_id, role) values (v_ws, v_email, auth.uid(), 'admin');
    v_role := 'admin';
  end if;
  select name into v_name from public.workspaces where id = v_ws;
  return jsonb_build_object('userId', auth.uid(), 'email', v_email, 'workspaceId', v_ws, 'workspace', v_name, 'role', v_role);
end $$;

create or replace function public.ks_rename_workspace(p_name text) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text;
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_role is distinct from 'admin' then raise exception 'Only an admin can do that.' using errcode = '42501'; end if;
  update public.workspaces set name = left(trim(p_name), 80) where id = v_ws and trim(p_name) <> '';
end $$;

/* ------------------------------------------------------------- the team (admin) */

create or replace function public.ks_team() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text;
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_role is distinct from 'admin' then raise exception 'Only an admin can see the team.' using errcode = '42501'; end if;
  return coalesce((select jsonb_agg(jsonb_build_object(
      'email', m.email, 'role', m.role, 'joined', m.user_id is not null, 'you', m.user_id = auth.uid(),
      'videos', (select count(*) from public.videos v where v.workspace_id = v_ws and v.owner_email = m.email)
    ) order by m.created_at) from public.members m where m.workspace_id = v_ws), '[]'::jsonb);
end $$;

create or replace function public.ks_set_member(p_email text, p_role text) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text; v_email text := lower(trim(p_email));
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_role is distinct from 'admin' then raise exception 'Only an admin can change the team.' using errcode = '42501'; end if;
  if p_role not in ('admin', 'member') then raise exception 'A team role is admin or member.'; end if;
  if cardinality(public.ks_clean_emails(array[v_email])) = 0 then raise exception 'That is not an email address.'; end if;
  if exists (select 1 from public.members where email = v_email and workspace_id <> v_ws) then
    raise exception 'That person already belongs to another workspace.';
  end if;
  if p_role = 'member' and (select count(*) from public.members where workspace_id = v_ws and role = 'admin' and email <> v_email) = 0 then
    raise exception 'A workspace needs at least one admin.';
  end if;
  insert into public.members (workspace_id, email, role, invited_by) values (v_ws, v_email, p_role, auth.uid())
    on conflict (workspace_id, email) do update set role = excluded.role;
end $$;

create or replace function public.ks_remove_member(p_email text) returns void
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text; v_email text := lower(trim(p_email));
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_role is distinct from 'admin' then raise exception 'Only an admin can change the team.' using errcode = '42501'; end if;
  if (select count(*) from public.members where workspace_id = v_ws and role = 'admin' and email <> v_email) = 0 then
    raise exception 'A workspace needs at least one admin.';
  end if;
  delete from public.members where workspace_id = v_ws and email = v_email;
end $$;

/* ------------------------------------------------------------------ videos */

-- Adds or updates the caller's video. The same recording always keeps the same id,
-- so its link never changes.
create or replace function public.ks_save_video(
  p_project text, p_title text, p_folder text, p_duration numeric, p_file text, p_poster text, p_meta jsonb
) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text; v_id text; v_old_file text; v_old_poster text;
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_ws is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  if p_file is not null and split_part(p_file, '/', 1) <> v_ws::text then raise exception 'That file is not in your workspace.' using errcode = '42501'; end if;
  select id, file_path, poster_path into v_id, v_old_file, v_old_poster from public.videos
    where workspace_id = v_ws and owner_id = auth.uid() and project_id = p_project;
  if v_id is null then
    v_id := translate(encode(gen_random_bytes(9), 'base64'), '+/=', 'xyz');
    insert into public.videos (id, workspace_id, owner_id, owner_email, project_id, title, folder, duration, file_path, poster_path, meta)
      values (v_id, v_ws, auth.uid(), public.ks_email(), p_project, coalesce(nullif(trim(p_title), ''), 'Untitled video'), coalesce(p_folder, ''), coalesce(p_duration, 0), p_file, p_poster, coalesce(p_meta, '{}'));
    v_old_file := null; v_old_poster := null;
  else
    update public.videos set title = coalesce(nullif(trim(p_title), ''), title), folder = coalesce(p_folder, ''), duration = coalesce(p_duration, duration),
      file_path = coalesce(p_file, file_path), poster_path = coalesce(p_poster, poster_path), meta = coalesce(p_meta, meta), updated_at = now()
      where id = v_id;
  end if;
  return jsonb_build_object('id', v_id,
    'replaced', to_jsonb(array_remove(array[case when p_file is not null and v_old_file is distinct from p_file then v_old_file end,
                                             case when p_poster is not null and v_old_poster is distinct from p_poster then v_old_poster end], null)));
end $$;

create or replace function public.ks_delete_video(p_video text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_files text[];
begin
  if not public.ks_can_manage(p_video) then raise exception 'You cannot change that video.' using errcode = '42501'; end if;
  select array_remove(array[file_path, poster_path], null) into v_files from public.videos where id = p_video;
  delete from public.videos where id = p_video;
  return to_jsonb(coalesce(v_files, '{}'));
end $$;

create or replace function public.ks_set_access(p_video text, p_access text) returns void
language plpgsql security definer set search_path = public as $$
begin
  if not public.ks_can_manage(p_video) then raise exception 'You cannot change that video.' using errcode = '42501'; end if;
  if p_access not in ('invited', 'link') then raise exception 'Access is “invited” or “link”.'; end if;
  update public.videos set access = p_access where id = p_video;
end $$;

-- Share one video (p_folder false) or the whole folder it is filed in (p_folder true).
create or replace function public.ks_share(p_video text, p_emails text[], p_required boolean default false, p_folder boolean default false) returns integer
language plpgsql security definer set search_path = public as $$
declare v public.videos; v_emails text[] := public.ks_clean_emails(p_emails);
begin
  if not public.ks_can_manage(p_video) then raise exception 'You cannot share that video.' using errcode = '42501'; end if;
  if cardinality(v_emails) = 0 then raise exception 'Add at least one email address.'; end if;
  if cardinality(v_emails) > 200 then raise exception 'Add up to 200 people at a time.'; end if;
  select * into v from public.videos where id = p_video;
  if p_folder then
    if v.folder = '' then raise exception 'This video is not in a folder.'; end if;
    insert into public.folder_grants (workspace_id, owner_id, folder, email, required, invited_by)
      select v.workspace_id, v.owner_id, v.folder, e, coalesce(p_required, false), auth.uid() from unnest(v_emails) e
      on conflict (workspace_id, owner_id, folder, email) do update set required = excluded.required;
  else
    insert into public.grants (video_id, email, required, invited_by)
      select p_video, e, coalesce(p_required, false), auth.uid() from unnest(v_emails) e
      on conflict (video_id, email) do update set required = excluded.required;
  end if;
  return cardinality(v_emails);
end $$;

create or replace function public.ks_unshare(p_video text, p_email text, p_folder boolean default false) returns void
language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  if not public.ks_can_manage(p_video) then raise exception 'You cannot change that video.' using errcode = '42501'; end if;
  select * into v from public.videos where id = p_video;
  if p_folder then
    delete from public.folder_grants where workspace_id = v.workspace_id and owner_id = v.owner_id and folder = v.folder and email = lower(trim(p_email));
  else
    delete from public.grants where video_id = p_video and email = lower(trim(p_email));
  end if;
end $$;

-- Everything the share box shows for one video: who has access, how, and what each has watched.
create or replace function public.ks_video_sharing(p_video text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.videos;
begin
  if not public.ks_can_manage(p_video) then raise exception 'You cannot see that video.' using errcode = '42501'; end if;
  select * into v from public.videos where id = p_video;
  return jsonb_build_object(
    'id', v.id, 'title', v.title, 'folder', v.folder, 'access', v.access, 'owner', v.owner_email, 'duration', v.duration, 'updatedAt', v.updated_at,
    'people', coalesce((
      select jsonb_agg(jsonb_build_object(
        'email', p.email, 'via', p.via, 'required', public.ks_required(v.id, p.email),
        'opened', pr.email is not null, 'percent', public.ks_percent(pr.coverage),
        'completed', pr.completed_at is not null, 'completedAt', pr.completed_at, 'lastWatched', pr.last_at,
        'seconds', coalesce((select sum(w.seconds) from public.views w where w.video_id = v.id and w.viewer_email = p.email), 0)
      ) order by p.email)
      from (
        select g.email, 'video' as via from public.grants g where g.video_id = v.id
        union
        select f.email, 'folder' from public.folder_grants f
          where v.folder <> '' and f.workspace_id = v.workspace_id and f.owner_id = v.owner_id and f.folder = v.folder
            and not exists (select 1 from public.grants g where g.video_id = v.id and g.email = f.email)
      ) p left join public.progress pr on pr.video_id = v.id and pr.email = p.email), '[]'::jsonb),
    'totals', (select jsonb_build_object(
        'views', count(*), 'avgSeconds', coalesce(round(avg(seconds), 1), 0),
        'avgPercent', coalesce(round(avg(case when duration > 0 then least(1, seconds / duration) end) * 100, 0), 0),
        'anonymous', count(*) filter (where viewer_email is null))
      from public.views where video_id = v.id)
  );
end $$;

-- The list in the app's Sharing screen. A member gets their own videos; an admin gets everyone's.
create or replace function public.ks_videos() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text;
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_ws is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(row order by updated_at desc) from (
      select v.updated_at, jsonb_build_object(
        'id', v.id, 'projectId', v.project_id, 'title', v.title, 'folder', v.folder, 'owner', v.owner_email, 'mine', v.owner_id = auth.uid(),
        'access', v.access, 'duration', v.duration, 'updatedAt', v.updated_at,
        'people', (select count(*) from (
            select email from public.grants g where g.video_id = v.id
            union select email from public.folder_grants f where v.folder <> '' and f.workspace_id = v.workspace_id and f.owner_id = v.owner_id and f.folder = v.folder) x),
        'views', (select count(*) from public.views w where w.video_id = v.id),
        'viewers', (select count(*) from public.progress p where p.video_id = v.id),
        'avgPercent', coalesce((select round(avg(case when duration > 0 then least(1, seconds / duration) end) * 100, 0) from public.views w where w.video_id = v.id), 0),
        'required', (select count(*) from (
            select email from public.grants g where g.video_id = v.id and g.required
            union select email from public.folder_grants f where v.folder <> '' and f.workspace_id = v.workspace_id and f.owner_id = v.owner_id and f.folder = v.folder and f.required) x),
        'completed', (select count(*) from public.progress p where p.video_id = v.id and p.completed_at is not null and public.ks_required(v.id, p.email))
      ) as row
      from public.videos v
      where v.workspace_id = v_ws and (v_role = 'admin' or v.owner_id = auth.uid())
    ) t), '[]'::jsonb);
end $$;

-- Admin only: every person anything has been shared with, and how they are getting on.
create or replace function public.ks_people() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text;
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_role is distinct from 'admin' then raise exception 'Only an admin can see everyone.' using errcode = '42501'; end if;
  return coalesce((
    select jsonb_agg(b.person order by b.email) from (
    select a.email, jsonb_build_object(
      'email', a.email, 'videos', count(*), 'opened', count(*) filter (where a.opened),
      'required', count(*) filter (where a.required), 'completed', count(*) filter (where a.required and a.completed),
      'lastWatched', max(a.last_at),
      'items', jsonb_agg(jsonb_build_object('id', a.id, 'title', a.title, 'required', a.required, 'percent', a.percent, 'completed', a.completed, 'lastWatched', a.last_at) order by a.title)
    ) as person
    from (
      select x.email, v.id, v.title, public.ks_required(v.id, x.email) as required,
             pr.email is not null as opened, public.ks_percent(pr.coverage) as percent, pr.completed_at is not null as completed, pr.last_at
      from public.videos v
      join lateral (
        select g.email from public.grants g where g.video_id = v.id
        union select f.email from public.folder_grants f where v.folder <> '' and f.workspace_id = v.workspace_id and f.owner_id = v.owner_id and f.folder = v.folder
      ) x on true
      left join public.progress pr on pr.video_id = v.id and pr.email = x.email
      where v.workspace_id = v_ws
    ) a group by a.email) b), '[]'::jsonb);
end $$;

-- Admin only: take one person off everything in the workspace.
create or replace function public.ks_remove_person(p_email text) returns integer
language plpgsql security definer set search_path = public as $$
declare v_ws uuid; v_role text; v_n integer; v_m integer;
begin
  select workspace_id, role into v_ws, v_role from public.ks_membership();
  if v_role is distinct from 'admin' then raise exception 'Only an admin can do that.' using errcode = '42501'; end if;
  delete from public.grants g using public.videos v where g.video_id = v.id and v.workspace_id = v_ws and g.email = lower(trim(p_email));
  get diagnostics v_n = row_count;
  delete from public.folder_grants where workspace_id = v_ws and email = lower(trim(p_email));
  get diagnostics v_m = row_count;
  return v_n + v_m;
end $$;

/* ------------------------------------------------------------- the viewer's side */

-- Opens a video for whoever is asking. Hands over the file only if they may watch.
--   {"need": "signin"}   it is for invited people and nobody is signed in
--   {"need": "access"}   signed in, but it has not been shared with this person
--   {"need": "gone"}     no such video
create or replace function public.ks_watch(p_video text) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.videos; v_email text := public.ks_email(); v_ok boolean; v_member boolean;
begin
  select * into v from public.videos where id = p_video;
  if v.id is null or v.file_path is null then return jsonb_build_object('need', 'gone'); end if;
  v_member := auth.uid() is not null and (v.owner_id = auth.uid()
    or exists (select 1 from public.members m where m.workspace_id = v.workspace_id and m.user_id = auth.uid() and m.role = 'admin'));
  v_ok := v.access = 'link' or v_member or public.ks_granted(v.id, v_email);
  if not v_ok then
    return jsonb_build_object('need', case when v_email is null then 'signin' else 'access' end, 'email', v_email);
  end if;
  return jsonb_build_object(
    'id', v.id, 'title', v.title, 'duration', v.duration, 'file', v.file_path, 'poster', v.poster_path, 'meta', v.meta,
    'publishedAt', v.created_at, 'workspace', (select name from public.workspaces where id = v.workspace_id),
    'email', v_email, 'required', public.ks_required(v.id, v_email),
    'percent', coalesce((select public.ks_percent(coverage) from public.progress where video_id = v.id and email = v_email), 0),
    'completed', exists (select 1 from public.progress where video_id = v.id and email = v_email and completed_at is not null)
  );
end $$;

-- Records watching. p_bits has one character per five seconds of video: '1' = watched.
create or replace function public.ks_view(p_video text, p_session text, p_seconds numeric, p_duration numeric, p_bits text default null) returns jsonb
language plpgsql security definer set search_path = public as $$
declare v public.videos; v_email text := public.ks_email(); v_bits bit varying; v_cur bit varying; v_new bit varying; v_pct numeric;
begin
  select * into v from public.videos where id = p_video;
  if v.id is null then return jsonb_build_object('ok', false); end if;
  if not (v.access = 'link' or public.ks_granted(v.id, v_email) or public.ks_can_manage(v.id)) then return jsonb_build_object('ok', false); end if;
  -- Owners and admins previewing their own video are not viewers.
  if public.ks_can_manage(v.id) then return jsonb_build_object('ok', true, 'counted', false); end if;

  insert into public.views (video_id, viewer_email, session, seconds, duration)
    values (v.id, v_email, left(p_session, 40),
      greatest(0, least(coalesce(p_seconds, 0), case when coalesce(p_duration, 0) > 0 then p_duration else 86400 end)),
      greatest(0, least(coalesce(p_duration, 0), 86400)))
    on conflict (video_id, session) do update
      set seconds = greatest(public.views.seconds, excluded.seconds), duration = excluded.duration, updated_at = now(),
          viewer_email = coalesce(public.views.viewer_email, excluded.viewer_email);

  if v_email is null or p_bits is null or p_bits !~ '^[01]+$' or length(p_bits) > 20000 then return jsonb_build_object('ok', true, 'counted', true); end if;
  v_bits := p_bits::bit varying;
  select coverage into v_cur from public.progress where video_id = v.id and email = v_email;
  v_new := case when v_cur is null or length(v_cur) <> length(v_bits) then v_bits else v_cur | v_bits end;
  v_pct := public.ks_percent(v_new);
  insert into public.progress (video_id, email, coverage, completed_at)
    values (v.id, v_email, v_new, case when v_pct >= 90 then now() end)
    on conflict (video_id, email) do update
      set coverage = excluded.coverage, last_at = now(),
          completed_at = coalesce(public.progress.completed_at, excluded.completed_at);
  return jsonb_build_object('ok', true, 'counted', true, 'percent', v_pct, 'completed', v_pct >= 90);
end $$;

-- "Shared with me": everything this person has been given, newest first.
create or replace function public.ks_shared_with_me() returns jsonb
language plpgsql security definer set search_path = public as $$
declare v_email text := public.ks_email();
begin
  if v_email is null then raise exception 'Sign in first.' using errcode = '28000'; end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', v.id, 'title', v.title, 'duration', v.duration, 'poster', v.poster_path, 'from', w.name, 'folder', v.folder,
      'required', public.ks_required(v.id, v_email), 'percent', coalesce(public.ks_percent(pr.coverage), 0),
      'completed', pr.completed_at is not null, 'sharedAt', v.updated_at
    ) order by v.updated_at desc)
    from public.videos v join public.workspaces w on w.id = v.workspace_id
    left join public.progress pr on pr.video_id = v.id and pr.email = v_email
    where v.file_path is not null and public.ks_granted(v.id, v_email)), '[]'::jsonb);
end $$;

/* -------------------------------------------------------------- who may call what */

do $$
declare f record;
begin
  for f in select p.oid::regprocedure as sig, p.proname from pg_proc p join pg_namespace n on n.oid = p.pronamespace
           where n.nspname = 'public' and p.proname like 'ks\_%' loop
    execute format('revoke execute on function %s from public, anon, authenticated', f.sig);
    if f.proname in ('ks_watch', 'ks_view') then
      execute format('grant execute on function %s to anon, authenticated, service_role', f.sig);
    elsif f.proname in ('ks_email', 'ks_clean_emails', 'ks_percent', 'ks_membership', 'ks_can_manage', 'ks_my_workspaces') then
      -- helpers: used inside the functions above; ks_email and ks_percent are harmless to expose
      execute format('grant execute on function %s to authenticated, anon, service_role', f.sig);
    elsif f.proname in ('ks_granted', 'ks_required') then
      -- internal: would let anyone ask "is this email on that video?"
      execute format('grant execute on function %s to service_role', f.sig);
    else
      execute format('grant execute on function %s to authenticated, service_role', f.sig);
    end if;
  end loop;
end $$;

/* ------------------------------------------------------------------ storage */
-- Video files live in one public bucket, each under a long random path that is only
-- ever revealed by ks_watch(). Signed-in team members may add, replace and remove files
-- inside their own workspace's folder, and nowhere else.
do $$
begin
  if exists (select 1 from pg_namespace where nspname = 'storage') then
    insert into storage.buckets (id, name, public) values ('videos', 'videos', true) on conflict (id) do nothing;
    execute 'drop policy if exists "ks team writes own workspace" on storage.objects';
    execute $p$create policy "ks team writes own workspace" on storage.objects for all to authenticated
      using (bucket_id = 'videos' and (storage.foldername(name))[1] = any(public.ks_my_workspaces()))
      with check (bucket_id = 'videos' and (storage.foldername(name))[1] = any(public.ks_my_workspaces()))$p$;
  end if;
end $$;

notify pgrst, 'reload schema';
