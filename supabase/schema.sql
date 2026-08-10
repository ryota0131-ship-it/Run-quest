-- RUN QUEST: Supabase schema
-- Run this once in your Supabase project's SQL editor (Database > SQL Editor).

-- ---------------------------------------------------------------------------
-- 1) Generic key-value store
--    Mirrors the old window.storage API: one row per player, keyed by
--    "runquest:<nickname>", storing the whole player state as a JSON string.
-- ---------------------------------------------------------------------------
create table if not exists kv_store (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

alter table kv_store enable row level security;

-- MVP-simple policy: anyone with the anon key can read/write.
-- There is no real auth in this app (identity = nickname), so this matches
-- the original Claude-artifact version's trust model. Tighten this later if
-- you add real authentication.
create policy "public read" on kv_store for select using (true);
create policy "public write" on kv_store for insert with check (true);
create policy "public update" on kv_store for update using (true);
create policy "public delete" on kv_store for delete using (true);


-- ---------------------------------------------------------------------------
-- 2) Clan monster (shared boss everyone can damage together)
--    A single row, updated atomically so concurrent hits from different
--    players don't overwrite each other (this fixes the "last write wins"
--    limitation the old window.storage version had).
-- ---------------------------------------------------------------------------
create table if not exists clan_state (
  id int primary key default 1,
  generation int not null default 0,
  hp int not null default 2000,
  damage int not null default 0,
  contributors jsonb not null default '{}'::jsonb,
  last_generation int not null default -1,
  last_contributors jsonb not null default '{}'::jsonb,
  updated_at timestamptz not null default now(),
  constraint single_row check (id = 1)
);

insert into clan_state (id, generation, hp, damage, contributors)
values (1, 0, 2000, 0, '{}'::jsonb)
on conflict (id) do nothing;

alter table clan_state enable row level security;
create policy "public read clan" on clan_state for select using (true);

-- Atomic damage function. Locks the single row (FOR UPDATE) so two players
-- recording a run at the same moment can't clobber each other's contribution.
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

-- Allow the anon role to call the function (RLS on the table still applies
-- to direct reads; the function itself runs with elevated privilege via
-- `security definer` so it can update despite the read-only policy above).
grant execute on function damage_clan_monster(int, text) to anon, authenticated;
