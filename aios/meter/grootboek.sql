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

do $$
declare rol text;
begin
  foreach rol in array array['anon', 'authenticated'] loop
    if exists (select 1 from pg_roles where rolname = rol) then
      execute format('revoke all on seo.grootboek from %I', rol);
    end if;
  end loop;
end $$;

commit;
