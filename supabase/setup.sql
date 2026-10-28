-- Prop Workshop: database, access rules and file storage.
-- Paste the whole file into Supabase > SQL Editor > New query, and press Run. Safe to run again.

-- Only signed-in people with a CSULB email may use the workshop.
create or replace function public.is_csulb() returns boolean
language sql stable as $$
  select coalesce(lower(auth.jwt() ->> 'email') like '%@csulb.edu', false);
$$;

create table if not exists public.requests (
  id               uuid primary key default gen_random_uuid(),
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  requested_by     uuid not null default auth.uid() references auth.users (id),
  requester_email  text not null default (auth.jwt() ->> 'email'),
  name             text not null check (length(name) between 1 and 80),
  notes            text not null default '' check (length(notes) <= 2000),
  project          text not null default '' check (length(project) <= 80),
  output           text not null default 'files' check (output in ('files', 'unity', 'vr')),
  aged             boolean not null default false,
  size_mm          jsonb not null default '{}'::jsonb,
  photo_paths      text[] not null default '{}',
  scan             jsonb,
  status           text not null default 'queued'
                   check (status in ('queued', 'building', 'review', 'changes', 'approved', 'lowpoly', 'done')),
  versions         jsonb not null default '[]'::jsonb,   -- [{n, sheet_path, preview_path, note, at}]
  feedback         jsonb not null default '[]'::jsonb,   -- [{by, by_email, verdict, text, at, version}]
  slug             text,
  job_dir          text,
  glb_path         text,
  model_paths      jsonb not null default '[]'::jsonb,   -- finished model files for download
  tris_lod0        integer,
  developer_step   text,
  legacy_id        text unique                           -- id on the old claude.ai page, for the move
);

alter table public.requests enable row level security;

drop policy if exists "csulb reads all requests" on public.requests;
create policy "csulb reads all requests" on public.requests
  for select to authenticated using (public.is_csulb());

drop policy if exists "csulb sends own requests" on public.requests;
create policy "csulb sends own requests" on public.requests
  for insert to authenticated
  with check (public.is_csulb() and requested_by = auth.uid() and status = 'queued'
              and versions = '[]'::jsonb and feedback = '[]'::jsonb);
-- No update/delete policy for people: only the cloud worker (secret key) changes requests,
-- and reviews go through submit_review() below.

-- Approve or ask for changes. Only the person who sent the request, only while it is in review.
create or replace function public.submit_review(request_id uuid, verdict text, review_text text)
returns void language plpgsql security definer set search_path = public as $$
declare r public.requests;
begin
  if not public.is_csulb() then raise exception 'Sign in with your CSULB email.'; end if;
  if verdict not in ('approve', 'changes') then raise exception 'Unknown verdict.'; end if;
  if verdict = 'changes' and coalesce(btrim(review_text), '') = '' then
    raise exception 'Write what should change.';
  end if;
  select * into r from public.requests where id = request_id for update;
  if not found then raise exception 'Request not found.'; end if;
  if r.requested_by <> auth.uid() then raise exception 'Only the person who sent this request can review it.'; end if;
  if r.status <> 'review' then raise exception 'This request is not waiting for a review.'; end if;
  update public.requests set
    feedback = feedback || jsonb_build_array(jsonb_build_object(
      'by', auth.uid(), 'by_email', auth.jwt() ->> 'email', 'verdict', verdict,
      'text', left(coalesce(review_text, ''), 2000), 'at', now(),
      'version', (select max((v ->> 'n')::int) from jsonb_array_elements(r.versions) v))),
    status = case when verdict = 'approve' then 'approved' else 'changes' end,
    updated_at = now()
  where id = request_id;
end $$;
revoke all on function public.submit_review(uuid, text, text) from public, anon;
grant execute on function public.submit_review(uuid, text, text) to authenticated;

-- Live updates on the page.
do $$ begin
  alter publication supabase_realtime add table public.requests;
exception when duplicate_object then null; end $$;

-- Files: one private bucket. People upload into uploads/<their user id>/...; the worker writes results/...
insert into storage.buckets (id, name, public, file_size_limit)
values ('workshop', 'workshop', false, 50 * 1024 * 1024)
on conflict (id) do update set public = false, file_size_limit = excluded.file_size_limit;

drop policy if exists "csulb reads workshop files" on storage.objects;
create policy "csulb reads workshop files" on storage.objects
  for select to authenticated using (bucket_id = 'workshop' and public.is_csulb());

drop policy if exists "csulb uploads own files" on storage.objects;
create policy "csulb uploads own files" on storage.objects
  for insert to authenticated
  with check (bucket_id = 'workshop' and public.is_csulb()
              and (storage.foldername(name))[1] = 'uploads'
              and (storage.foldername(name))[2] = auth.uid()::text);
