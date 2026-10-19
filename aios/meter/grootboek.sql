-- Het grootboek van de kostenmeter (Re-Positive/seo-engine#16, spec #12): per betaalde DataForSEO-call
-- een regel. Staat in schema seo van de portal-Supabase, naast seo.klant/site/gebruiker
-- (Resketch-ai/ai-os-beheer, migratie 013). Deze tabel hoort bij de meter, daarom staat hij hier.
--
-- Beveiliging:
-- - Append-only: een trigger weigert elke update en delete, voor iedereen. Een correctie is een
--   nieuwe regel (contract ADR-0005 in seo-engine).
-- - De meter heeft een eigen rol seo_meter die alleen mag invoegen, met RLS, en verder niets: niet
--   lezen, niet wijzigen, geen andere tabellen. Het wachtwoord zet de deploy, niet dit bestand.
-- - anon en authenticated (de API-rollen van Supabase) mogen niets.
-- Idempotent.
begin;

create schema if not exists seo;

do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'seo_meter') then
    create role seo_meter login;
  end if;
end $$;
alter role seo_meter connection limit 10;

create table if not exists seo.grootboek (
  id bigint generated always as identity primary key,
  client_id text not null check (client_id ~ '^[A-Za-z0-9_]+$'),
  endpoint text not null,
  bedrag numeric(12, 6) not null check (bedrag > 0),
  taak_id text,
  geboekt_op timestamptz not null default now()
);
create index if not exists grootboek_klant_tijd on seo.grootboek (client_id, geboekt_op);

create or replace function seo.grootboek_alleen_toevoegen() returns trigger language plpgsql as $$
begin
  raise exception 'seo.grootboek is append-only: boek een correctie als nieuwe regel';
end $$;
drop trigger if exists grootboek_alleen_toevoegen on seo.grootboek;
create trigger grootboek_alleen_toevoegen before update or delete on seo.grootboek
  for each row execute function seo.grootboek_alleen_toevoegen();
-- truncate omzeilt rij-triggers
drop trigger if exists grootboek_geen_truncate on seo.grootboek;
create trigger grootboek_geen_truncate before truncate on seo.grootboek
  for each statement execute function seo.grootboek_alleen_toevoegen();

alter table seo.grootboek enable row level security;
drop policy if exists meter_boekt on seo.grootboek;
create policy meter_boekt on seo.grootboek for insert to seo_meter with check (true);

revoke all on seo.grootboek from public;
grant usage on schema seo to seo_meter;
grant insert (client_id, endpoint, bedrag, taak_id) on seo.grootboek to seo_meter;

-- Zoekdatabudget (seo-engine#17): per klant een bedrag per kalendermaand (Europe/Amsterdam), en welke
-- drempelmeldingen (80% en 100%) deze maand al uitgingen. De meter leest en schrijft dit alleen via
-- de twee functies hieronder (security definer), niet rechtstreeks.
create table if not exists seo.budget (
  client_id text primary key check (client_id ~ '^[A-Za-z0-9_]+$'),
  maandbedrag numeric(10, 2) not null check (maandbedrag >= 0),
  gewijzigd_op timestamptz not null default now()
);
create table if not exists seo.budget_melding (
  client_id text not null,
  maand date not null,
  drempel int not null check (drempel in (80, 100)),
  gemeld_op timestamptz not null default now(),
  primary key (client_id, maand, drempel)
);
alter table seo.budget enable row level security;
alter table seo.budget_melding enable row level security;
revoke all on seo.budget, seo.budget_melding from public;

-- Budget en verbruik van deze maand. Budget null betekent: geen budget, dus dicht.
create or replace function seo.budget_stand(p_client text)
  returns table (budget numeric, verbruikt numeric)
  language sql stable security definer set search_path = pg_catalog, pg_temp as $$
  select (select b.maandbedrag from seo.budget b where b.client_id = p_client),
         coalesce((select sum(g.bedrag) from seo.grootboek g
                    where g.client_id = p_client
                      and g.geboekt_op >= (date_trunc('month', now() at time zone 'Europe/Amsterdam') at time zone 'Europe/Amsterdam')), 0)
$$;

-- True als deze drempel deze maand nog niet gemeld was (en nu als gemeld staat).
create or replace function seo.meld_drempel(p_client text, p_drempel int)
  returns boolean language plpgsql security definer set search_path = pg_catalog, pg_temp as $$
begin
  insert into seo.budget_melding (client_id, maand, drempel)
  values (p_client, (date_trunc('month', now() at time zone 'Europe/Amsterdam'))::date, p_drempel)
  on conflict do nothing;
  return found;
end $$;

revoke all on function seo.budget_stand(text), seo.meld_drempel(text, int) from public;
grant execute on function seo.budget_stand(text), seo.meld_drempel(text, int) to seo_meter;

do $$
declare rol text;
begin
  foreach rol in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = rol) then
      execute format('revoke all on seo.grootboek, seo.budget, seo.budget_melding from %I', rol);
      execute format('revoke all on function seo.budget_stand(text), seo.meld_drempel(text, int) from %I', rol);
    end if;
  end loop;
end $$;

commit;
