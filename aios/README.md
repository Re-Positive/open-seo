# AI OS-fork van open-seo

Deze fork (Re-Positive/open-seo) is open-seo van every-app, met zo min mogelijk aanpassingen, zodat
het in de AI OS van Re:Positive draait als de module SEO. Waarom: ADR-0008 in Re-Positive/seo-engine.
Spec: Re-Positive/seo-engine#12.

## Branches

- `main` volgt upstream (`every-app/open-seo`) en krijgt van ons geen commits.
- `aios` is een release-tag van upstream plus onze commits. Elke commit die de code van open-seo
  raakt, begint met `schil:`. Wat in `aios/` staat, is van ons en raakt hun code niet.

## Aanpassingen in hun code

1. **Basispad** (`schil: basispad`, seo-engine#13). Met `AIOS_BASISPAD=/seo` bij de build draait de
   app onder `/seo`: router, assets (in `seo/assets`, omdat Workers static assets op bestandspad
   zoeken), serverfuncties, de sessie van Better Auth, en de terugkeer-URL's van de Google-koppelingen.
   Zonder `AIOS_BASISPAD` werkt alles zoals upstream. Pictogrammen en het manifest blijven op de root:
   die levert de AI OS zelf.
   - Niet onder het basispad (buiten scope, staat uit bij ons): de chatagent SAM (`/agents/...`), de
     MCP-server (`/mcp`) en de OAuth-toestemming voor MCP.
2. **Adres van DataForSEO instelbaar** (`schil: adres DataForSEO instelbaar`, seo-engine#16). Met
   `DATAFORSEO_API_URL` en `DATAFORSEO_SANDBOX_URL` gaan alle calls naar de kostenmeter. Het lezen
   gebeurt in een eigen bestand (`src/server/lib/dataforseo/aios-adres.ts`), zodat hun tests die
   `runtime-env` nadoen ongemoeid blijven. Zonder die variabelen werkt het zoals upstream.
3. **Servicetoken** (`schil: servicetoken van Cloudflare Access als vaste gebruiker`, seo-engine#14).
   De SEO-poort komt binnen met een Access-servicetoken. Dat JWT heeft geen sub en geen e-mail, alleen
   `common_name`; open-seo weigerde het. Nu wordt het een vaste gebruiker
   `servicetoken-<common_name>`. De Access-policy blijft de grens. Een derde aanpassing, buiten de twee
   uit de spec: besloten door Donny op 19 oktober 2026, omdat `local_noauth` achter Access de app zelf
   niets meer liet toetsen.

## Uitrol

`aios/uitrol/uitrol.ts` zet per klant een eigen installatie op Cloudflare (Worker, D1, KV, R2):

```bash
node aios/uitrol/uitrol.ts nieuwe klant <client_id> [eerste domein]   # bv. 86c7h8f96 voor Re:Positive
node aios/uitrol/uitrol.ts nieuwe site <client_id> <domein>
```

- Klant en site komen uit `clients` van het client-dashboard (zelfde `client_id`, ADR-0005 in seo-engine),
  of voor een klant van Resketch uit `tenants` van de portal. Daar is de `client_id` het subdomein met `_`
  in plaats van `-`, bv. `evd_group` (seo-engine#19). Is de website van de klant niet de site die SEO krijgt,
  geef dan de eerste site mee: `nieuwe klant evd_group lumenix-beamers.nl`.
- Cloudflare-gegevens uit Doppler `repositive-ai/prd`: `CLOUDFLARE_API_TOKEN` (Workers, D1, KV, R2,
  Access-apps en -servicetokens, Secrets Store), `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_ACCESS_TEAM`.
- Per klant schrijft hij naar Doppler: `SEO_<ID>_URL`, `SEO_<ID>_ACCESS_CLIENT_ID`,
  `SEO_<ID>_ACCESS_CLIENT_SECRET`.
- De Access-applicatie laat alleen het servicetoken van die klant door; de deploy gebruikt die app
  (`TEAM_DOMAIN` + `POLICY_AUD`) in plaats van de e-mailpolicy van open-seo.
- De installatie krijgt nooit onze DataForSEO-sleutel, maar een klanttoken en het adres van de kostenmeter.
- Telemetrie staat uit. Herhalen mag: wat er al staat, blijft staan.
- Beide schrijven klant en site naar schema `seo` van de AI OS (`seo.klant`, `seo.site`, in de
  portal-Supabase van os.resketch.nl). psql draait daarvoor vanuit `02-resketch/OtherWorlds/ai-os-beheer`
  met Doppler `resketch-ai/prd`, want het Doppler-token is per map gescoped. Waarden gaan als
  psql-variabelen mee, nooit in de SQL-tekst. Wie de klant ziet (`seo.gebruiker`) blijft handwerk.
- `nieuwe site` (seo-engine#18) voegt een project (NL, nl) toe in de D1 van een bestaande installatie en
  zet het project-id in `seo.site`; de SEO-poort toont hem in het keuzemenu van de kopbalk. Het domein
  wordt schoongemaakt (`domeinVan`, getest in `aios/uitrol/domein.test.ts`). Hij deployt niets, dus de
  classifier laat hem door.
- Vanuit een agent-sessie blokkeert de classifier het deployen; draai hem dan via het wizard-paneel
  (actie op klik) of in een eigen terminal.

Na de uitrol: `pnpm exec playwright test -c aios/playwright.live.config.ts` toetst de echte installatie
(403 zonder token, `/seo` met token, project NL/nl, telemetrie uit).

## Bijwerken naar een nieuwe versie van open-seo

```bash
node aios/uitrol/uitrol.ts bijwerken <tag>     # bv. v0.1.14
```

`bijwerken` (seo-engine#20) doet in deze volgorde, en stopt bij de eerste fout:

1. Toetst dat de fork op `aios` staat met een schone werkmap, haalt `upstream --tags` op en merget de
   tag. Botst de merge, dan draait hij hem terug en noemt hij de bestanden. Conflicten horen alleen in
   bestanden met een `schil:`-commit te zitten.
2. `tsc --noEmit` en `vitest run`.
3. De woordenlijst: `open-seo-lokaal/schil/teksten.mjs --schrijf` zet nieuwe Engelse teksten met een lege
   waarde in `nl.json`. Vertaal ze daar en maak daarna `public/seo-schil/nl.js` in ai-os-beheer opnieuw.
4. Uitrollen bij Re:Positive (`86c7h8f96`) en de rooktest (`aios/tests-live/rooktest.spec.ts`).
5. Slaagt die, dan dezelfde build bij de andere klanten uit `seo.klant`. Faalt hij, dan blijven zij op
   de vorige versie.
6. De fork naar origin, en de top 15 van de gemiste teksten.

De **rooktest** loopt door de SEO-poort op os.resketch.nl, met een sessie voor `AIOS_EMAIL` (standaard
rex@repositive.nl) die `aios/uitrol/aios.ts` maakt. Hij opent elke pagina uit het SEO-menu: er mag geen
foutscherm en nergens "OpenSEO" staan. Daarna zoekt hij op `leadgeneratie`. open-seo houdt dat resultaat 24 uur in zijn
cache, dus hij kost hoogstens één betaalde call per dag. Los draaien:
`pnpm exec playwright test -c aios/playwright.live.config.ts rooktest`.

Op 19-10-2026 is de keten één keer echt doorlopen met `v0.1.13`. Er was geen nieuwere release, dus de
merge veranderde niets; de rest van de keten heeft wel echt gedraaid.

## Gemiste teksten

De schil meldt Engelse teksten die een gebruiker zag aan de SEO-poort, en die zet ze per klant in
`seo.gemiste_tekst` (seo-engine#21, migratie 014 in ai-os-beheer). `onvertaald` staat in de woordenlijst zonder
vertaling; `onbekend` staat er niet in. Het overzicht over alle klanten, de vaakst geziene eerst:

```bash
node aios/uitrol/uitrol.ts gemist [aantal]     # standaard 50
```

## Tests

`aios/tests/` test onze aanpassingen op een productiebuild (`vite build` plus `vite preview`):

- `basispad.spec.ts`: de app opent onder `/seo`, elke pagina uit het menu laadt, klikken blijft onder
  `/seo`, en er gaat geen verzoek naar de root.

Draaien: `pnpm exec playwright test -c aios/playwright.config.ts` (bouwt eerst, duurt ongeveer een minuut).

## Kostenmeter

`aios/meter/` is een eigen Cloudflare Worker, `aios-seo-meter.repositive.workers.dev`, met een eigen
`package.json` los van open-seo. Elke installatie stuurt er zijn DataForSEO-calls heen. De meter:

- herkent de klant aan het klanttoken, `base64(<client_id>:<HMAC onder SEO_METER_SLEUTEL>)`, zonder
  een tokenlijst;
- stuurt de call door met onze sleutel;
- boekt elke taak met `cost > 0` in `seo.grootboek` op de portal-Supabase. Dat boeken gebeurt na het
  antwoord (`waitUntil`). Gratis calls en de sandbox worden niet geboekt.

Het grootboek is append-only: een trigger weigert update, delete en truncate. De rol `seo_meter` mag
alleen invoegen (RLS). De Worker bereikt Supabase via Hyperdrive, met `verify-full` tegen de CA van
Supabase (`supabase-ca.pem`).

Uitrollen, eenmalig en daarna herhaalbaar:

```bash
node aios/meter/uitrol-meter.ts sleutels   # SEO_METER_SLEUTEL en SEO_METER_DB_WACHTWOORD in Doppler
bash aios/meter/grootboek-db.sh            # grootboek en rol op de portal-Supabase
node aios/meter/uitrol-meter.ts            # CA, Hyperdrive, Worker met secrets, SEO_METER_URL
```

**Zoekdatabudget** (seo-engine#17) werkt per klant, per kalendermaand, en wordt ingesteld met
`bash aios/meter/budget.sh <client_id> <dollar>`. Zonder budget of met een vol budget gaat er geen
betaalde call door. Gratis naslag en de sandbox gaan altijd door. Een geweigerde call krijgt een 401
in DataForSEO-vorm; de schil op os.resketch.nl toont dan "Het SEO-budget van deze maand is op". Bij 80%
en bij 100% gaat er per maand één melding naar Google Chat (`REX_GOOGLE_CHAT_WEBHOOK`). Calls die
tegelijk lopen, kunnen samen iets over het budget heen gaan. De proefklant `rooktest` heeft budget 0.

Testen: `cd aios/meter && npm install && npm test` (`meter.test.ts`, `budget.test.ts`; naad 2: nep-DataForSEO en een wegwerp-Postgres).

## Licentie

MIT, Copyright (c) 2026 Ben Senescu (zie `LICENSE`). De naam OpenSEO, hun logo's en de beelden in
`web/public/` gebruiken we niet.
