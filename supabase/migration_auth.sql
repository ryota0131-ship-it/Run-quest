-- RUN QUEST: migration for Google login
-- Run this AFTER schema.sql, once, in the SQL Editor.
--
-- What changes:
--   - kv_store rows now carry a user_id (the signed-in Google account).
--   - Nickname is no longer the identity — it's just a display name.
--     Row lookup switches from "by key text" to "by user_id", which also
--     removes the old nickname-collision/rename headaches.
--   - RLS is tightened: everyone can only read/write their OWN row.
--     (clan_state stays publicly readable — that data isn't private.)

-- ---------------------------------------------------------------------------
-- 1) Add the ownership column
-- ---------------------------------------------------------------------------
alter table kv_store add column if not exists user_id uuid references auth.users(id) on delete cascade;

create index if not exists kv_store_user_id_idx on kv_store (user_id);

-- ---------------------------------------------------------------------------
-- 2) Replace the old "anyone can read/write anything" policies
-- ---------------------------------------------------------------------------
drop policy if exists "public read" on kv_store;
drop policy if exists "public write" on kv_store;
drop policy if exists "public update" on kv_store;
drop policy if exists "public delete" on kv_store;

create policy "select own row" on kv_store
  for select using (auth.uid() = user_id);

create policy "insert own row" on kv_store
  for insert with check (auth.uid() = user_id);

create policy "update own row" on kv_store
  for update using (auth.uid() = user_id);

create policy "delete own row" on kv_store
  for delete using (auth.uid() = user_id);

-- ---------------------------------------------------------------------------
-- 3) (Optional but recommended) require login to join the clan fight.
--    damage_clan_monster runs as `security definer`, so RLS above doesn't
--    apply to it directly — this check enforces login inside the function.
-- ---------------------------------------------------------------------------
create or replace function damage_clan_monster(p_amount int, p_nickname text)
returns table (
  generation int,
  hp int,
  damage int,
  contributors jsonb,
  just_defeated boolean,
  last_generation int,
  last_contributors jsonb
) as $$
declare
  cur clan_state%rowtype;
  new_damage int;
  defeated boolean := false;
  new_contributors jsonb;
begin
  if auth.uid() is null then
    raise exception 'login required';
  end if;

  select * into cur from clan_state where id = 1 for update;

  new_damage := cur.damage + p_amount;
  new_contributors := jsonb_set(
    coalesce(cur.contributors, '{}'::jsonb),
    array[p_nickname],
    to_jsonb(coalesce((cur.contributors ->> p_nickname)::int, 0) + p_amount)
  );

  if new_damage >= cur.hp then
    defeated := true;
    update clan_state
      set generation = cur.generation + 1,
          hp = 2000 + (cur.generation + 1) * 1000,
          damage = 0,
          contributors = '{}'::jsonb,
          last_generation = cur.generation,
          last_contributors = new_contributors,
          updated_at = now()
      where id = 1;
  else
    update clan_state
      set damage = new_damage,
          contributors = new_contributors,
          updated_at = now()
      where id = 1;
  end if;

  return query select
    cs.generation, cs.hp, cs.damage, cs.contributors,
    defeated, cs.last_generation, cs.last_contributors
  from clan_state cs where cs.id = 1;
end;
$$ language plpgsql security definer;

grant execute on function damage_clan_monster(int, text) to authenticated;
revoke execute on function damage_clan_monster(int, text) from anon;

-- ---------------------------------------------------------------------------
-- Note on existing test data:
-- Rows created before this migration have user_id = NULL, so they will no
-- longer be readable/writable by anyone (RLS blocks NULL != auth.uid()).
-- For an early-stage test, the simplest move is to just let players sign in
-- and start fresh. If you need to preserve a specific old row, manually set
-- its user_id in the Table Editor after that player's first Google login.
-- ---------------------------------------------------------------------------
