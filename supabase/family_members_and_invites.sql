-- Household Helper: family members, invite codes and roles.
-- Run once in the Supabase SQL Editor for the household-helper project.
--
-- A family (household) has members, each with their own login and a role:
--   owner: set the family up; can do everything, including deleting the family
--   adult: can change everything and invite people
--   kid:   can see everything, tick chores and use shopping lists
-- Each login belongs to at most one family. People join with an invite code.

create table public.households (
  id uuid primary key default gen_random_uuid(),
  name text not null check (char_length(name) between 1 and 40),
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create table public.members (
  household_id uuid not null references public.households(id) on delete cascade,
  user_id uuid not null unique references auth.users(id) on delete cascade,
  role text not null check (role in ('owner','adult','kid')),
  name text not null check (char_length(name) between 1 and 30),
  created_at timestamptz not null default now(),
  primary key (household_id, user_id)
);
create table public.invites (
  code text primary key,
  household_id uuid not null references public.households(id) on delete cascade,
  role text not null check (role in ('adult','kid')),
  created_by uuid references auth.users(id) on delete set null,
  expires_at timestamptz not null default now() + interval '7 days',
  created_at timestamptz not null default now()
);
alter table public.households enable row level security;
alter table public.members enable row level security;
alter table public.invites enable row level security;
create index invites_household_idx on public.invites(household_id);

create function public.my_household() returns uuid language sql stable security definer set search_path = '' as $$
  select household_id from public.members where user_id = auth.uid()
$$;
create function public.my_role() returns text language sql stable security definer set search_path = '' as $$
  select role from public.members where user_id = auth.uid()
$$;
create function public.can_write(p_path text) returns boolean language sql stable security definer set search_path = '' as $$
  select coalesce((select role in ('owner','adult') or (role = 'kid' and (p_path like 'done/%' or p_path like 'shop/%'))
                   from public.members where user_id = auth.uid()), false)
$$;

create policy "members see their family" on public.households for select to authenticated using (id = (select public.my_household()));
create policy "members see each other" on public.members for select to authenticated using (household_id = (select public.my_household()));
create policy "adults see invites" on public.invites for select to authenticated using (household_id = (select public.my_household()) and (select public.my_role()) in ('owner','adult'));
create policy "adults cancel invites" on public.invites for delete to authenticated using (household_id = (select public.my_household()) and (select public.my_role()) in ('owner','adult'));
revoke all on public.households, public.members, public.invites from anon;
grant select on public.households, public.members to authenticated;
grant select, delete on public.invites to authenticated;

-- Family data now belongs to the family, not to one login
alter table public.docs drop constraint docs_household_id_fkey;
alter table public.docs alter column household_id drop default;
alter table public.docs add constraint docs_household_fk foreign key (household_id) references public.households(id) on delete cascade;
drop policy "family reads own" on public.docs;
drop policy "family adds own" on public.docs;
drop policy "family changes own" on public.docs;
drop policy "family removes own" on public.docs;
create policy "family reads" on public.docs for select to authenticated using (household_id = (select public.my_household()));
create policy "family adds" on public.docs for insert to authenticated with check (household_id = (select public.my_household()) and public.can_write(path));
create policy "family changes" on public.docs for update to authenticated using (household_id = (select public.my_household()) and public.can_write(path)) with check (household_id = (select public.my_household()) and public.can_write(path));
create policy "family removes" on public.docs for delete to authenticated using (household_id = (select public.my_household()) and public.can_write(path));

-- Storage cap: 5,000 saved items per family
create function public.docs_cap() returns trigger language plpgsql set search_path = '' as $$
begin
  if (select count(*) from public.docs where household_id = new.household_id) >= 5000 then
    raise exception 'storage_full' using errcode = 'P0001';
  end if;
  return new;
end $$;
create trigger docs_cap before insert on public.docs for each row execute function public.docs_cap();

-- ---------- Actions the app calls ----------
create function public.create_household(p_family text, p_name text) returns uuid language plpgsql security definer set search_path = '' as $$
declare h uuid;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already_in_family'; end if;
  insert into public.households(name, created_by) values (left(trim(p_family), 40), auth.uid()) returning id into h;
  insert into public.members(household_id, user_id, role, name) values (h, auth.uid(), 'owner', left(trim(p_name), 30));
  return h;
end $$;

create function public.norm_code(p text) returns text language sql immutable set search_path = '' as $$
  select upper(regexp_replace(coalesce(p, ''), '[^A-Za-z0-9]', '', 'g'))
$$;

-- Lets someone check an invite code before signing up; reveals only the family name
create function public.check_invite(p_code text) returns text language sql stable security definer set search_path = '' as $$
  select h.name from public.invites i join public.households h on h.id = i.household_id
  where i.code = public.norm_code(p_code) and i.expires_at > now()
$$;

create function public.join_household(p_code text, p_name text) returns uuid language plpgsql security definer set search_path = '' as $$
declare inv public.invites;
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if exists (select 1 from public.members where user_id = auth.uid()) then raise exception 'already_in_family'; end if;
  select * into inv from public.invites where code = public.norm_code(p_code) and expires_at > now();
  if not found then raise exception 'invite_not_found'; end if;
  insert into public.members(household_id, user_id, role, name) values (inv.household_id, auth.uid(), inv.role, left(trim(p_name), 30));
  return inv.household_id;
end $$;

create function public.create_invite(p_role text) returns text language plpgsql security definer set search_path = '' as $$
declare h uuid; c text; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea; i int;
begin
  if public.my_role() not in ('owner','adult') then raise exception 'not_allowed'; end if;
  if p_role not in ('adult','kid') then raise exception 'bad_role'; end if;
  h := public.my_household();
  delete from public.invites where household_id = h and expires_at <= now();
  if (select count(*) from public.invites where household_id = h) >= 20 then raise exception 'too_many_invites'; end if;
  loop
    b := extensions.gen_random_bytes(6); c := '';
    for i in 0..5 loop c := c || substr(alphabet, (get_byte(b, i) % 32) + 1, 1); end loop;
    exit when not exists (select 1 from public.invites where code = c);
  end loop;
  insert into public.invites(code, household_id, role, created_by) values (c, h, p_role, auth.uid());
  return c;
end $$;

create function public.remove_member(p_user uuid) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() not in ('owner','adult') then raise exception 'not_allowed'; end if;
  if p_user = auth.uid() then raise exception 'use_leave'; end if;
  delete from public.members where user_id = p_user and household_id = public.my_household() and role <> 'owner';
end $$;

create function public.set_member_role(p_user uuid, p_role text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() <> 'owner' then raise exception 'not_allowed'; end if;
  if p_role not in ('adult','kid') or p_user = auth.uid() then raise exception 'bad_role'; end if;
  update public.members set role = p_role where user_id = p_user and household_id = public.my_household();
end $$;

create function public.rename_household(p_name text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() not in ('owner','adult') then raise exception 'not_allowed'; end if;
  update public.households set name = left(trim(p_name), 40) where id = public.my_household();
end $$;

create function public.rename_me(p_name text) returns void language plpgsql security definer set search_path = '' as $$
begin
  update public.members set name = left(trim(p_name), 30) where user_id = auth.uid();
end $$;

-- Delete your own login. A family's owner deletes the whole family instead.
create function public.delete_my_login() returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if public.my_role() = 'owner' then raise exception 'owner_delete_family'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- Owner only: delete the family, everything it saved, and every member's login
create function public.delete_household() returns void language plpgsql security definer set search_path = '' as $$
declare h uuid; ids uuid[];
begin
  if public.my_role() <> 'owner' then raise exception 'not_allowed'; end if;
  h := public.my_household();
  select array_agg(user_id) into ids from public.members where household_id = h;
  delete from public.households where id = h;
  delete from auth.users where id = any(ids);
end $$;

revoke execute on function public.create_household(text, text), public.join_household(text, text), public.create_invite(text),
  public.remove_member(uuid), public.set_member_role(uuid, text), public.rename_household(text), public.rename_me(text),
  public.delete_my_login(), public.delete_household(), public.check_invite(text),
  public.my_household(), public.my_role(), public.can_write(text) from public, anon;
grant execute on function public.create_household(text, text), public.join_household(text, text), public.create_invite(text),
  public.remove_member(uuid), public.set_member_role(uuid, text), public.rename_household(text), public.rename_me(text),
  public.delete_my_login(), public.delete_household(), public.check_invite(text),
  public.my_household(), public.my_role(), public.can_write(text) to authenticated;
grant execute on function public.check_invite(text) to anon;
