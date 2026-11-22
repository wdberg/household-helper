-- Household Helper: password resets inside the family (no email needed), and more than one owner.
-- Run once in the Supabase SQL Editor for the household-helper project, after family_members_and_invites.sql.
--
-- - An owner can reset the password of anyone else in the family; an adult can reset a kid's.
--   The app shows a temporary password to pass on; the person is asked to choose their own when they sign in.
-- - An owner can make another member an owner too, so there's always someone who can help.

alter table public.members add column if not exists must_change_password boolean not null default false;

-- Owner only: change someone's role to owner, adult or kid (there must always be at least one owner)
create or replace function public.set_member_role(p_user uuid, p_role text) returns void language plpgsql security definer set search_path = '' as $$
begin
  if public.my_role() <> 'owner' then raise exception 'not_allowed'; end if;
  if p_role not in ('owner','adult','kid') or p_user = auth.uid() then raise exception 'bad_role'; end if;
  update public.members set role = p_role where user_id = p_user and household_id = public.my_household();
end $$;

-- An owner can leave if another owner remains; the last owner deletes the family instead
create or replace function public.delete_my_login() returns void language plpgsql security definer set search_path = '' as $$
begin
  if auth.uid() is null then raise exception 'not_signed_in'; end if;
  if public.my_role() = 'owner' and not exists (
    select 1 from public.members where household_id = public.my_household() and role = 'owner' and user_id <> auth.uid()
  ) then raise exception 'owner_delete_family'; end if;
  delete from auth.users where id = auth.uid();
end $$;

-- Give a family member a temporary password. Returns it so it can be passed on.
create or replace function public.reset_member_password(p_user uuid) returns text language plpgsql security definer set search_path = '' as $$
declare me_role text := public.my_role(); target_role text; pw text := ''; alphabet text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; b bytea; i int;
begin
  if p_user = auth.uid() then raise exception 'use_change_password'; end if;
  select role into target_role from public.members where user_id = p_user and household_id = public.my_household();
  if target_role is null then raise exception 'not_in_family'; end if;
  if not (me_role = 'owner' or (me_role = 'adult' and target_role = 'kid')) then raise exception 'not_allowed'; end if;
  b := extensions.gen_random_bytes(12);
  for i in 0..11 loop
    pw := pw || substr(alphabet, (get_byte(b, i) % 32) + 1, 1);
    if i in (3, 7) then pw := pw || '-'; end if;
  end loop;
  update auth.users set encrypted_password = extensions.crypt(pw, extensions.gen_salt('bf')), updated_at = now() where id = p_user;
  -- Sign them out everywhere, so only the new password works
  delete from auth.refresh_tokens where user_id = p_user::text;
  delete from auth.sessions where user_id = p_user;
  update public.members set must_change_password = true where user_id = p_user;
  return pw;
end $$;

-- Called by the app after someone chooses their own password
create or replace function public.password_changed() returns void language sql security definer set search_path = '' as $$
  update public.members set must_change_password = false where user_id = auth.uid()
$$;

revoke execute on function public.reset_member_password(uuid), public.password_changed() from public, anon;
grant execute on function public.reset_member_password(uuid), public.password_changed() to authenticated;
