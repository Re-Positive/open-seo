// Naad 2, zoekdatabudget (seo-engine#17): plafond en meldingen. Draaien: npm test (in aios/meter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { klanttoken } from "./meter.ts";
import {
  METER_SLEUTEL,
  eigenaar,
  gezien,
  heeftPostgres,
  meldingen,
  sql,
  vraag,
} from "./testopzet.ts";

// Zoekdatabudget (seo-engine#17). Elke call van de nep-DataForSEO kost 0.0301.
async function budget(klant: string, bedrag: number) {
  await eigenaar`insert into seo.budget (client_id, maandbedrag) values (${klant}, ${bedrag})
                 on conflict (client_id) do update set maandbedrag = excluded.maandbedrag`;
}
const BETAALD = "/v3/dataforseo_labs/google/keyword_ideas/live";

test(
  "bij een vol budget gaat een betaalde call niet door en komt een 401 in DataForSEO-vorm terug",
  { skip: !heeftPostgres },
  async () => {
    await budget("volbudget", 0.03);
    const token = await klanttoken(METER_SLEUTEL, "volbudget");
    assert.equal(
      (await vraag(BETAALD, token)).status,
      200,
      "de eerste call past nog",
    );
    gezien.length = 0;
    const r = await vraag(BETAALD, token);
    assert.equal(r.status, 401);
    assert.equal(
      ((await r.json()) as { status_code: number }).status_code,
      40100,
    );
    assert.equal(gezien.length, 0, "DataForSEO wordt niet bereikt");
    const [{ n }] =
      await eigenaar`select count(*)::int as n from seo.grootboek where client_id = 'volbudget'`;
    assert.equal(n, 2, "alleen de eerste call is geboekt (twee taken)");
  },
);

test(
  "zonder budget gaat er geen betaalde call door (dicht, niet open)",
  { skip: !heeftPostgres },
  async () => {
    gezien.length = 0;
    const r = await vraag(
      BETAALD,
      await klanttoken(METER_SLEUTEL, "geenbudget"),
    );
    assert.equal(r.status, 401);
    assert.equal(gezien.length, 0);
  },
);

test(
  "ook bij een vol budget gaan gratis calls en de sandbox door",
  { skip: !heeftPostgres },
  async () => {
    const token = await klanttoken(METER_SLEUTEL, "geenbudget");
    assert.equal(
      (
        await vraag("/v3/appendix/user_data", token, {
          method: "GET",
          body: undefined,
        })
      ).status,
      200,
    );
    assert.equal(
      (
        await vraag("/v3/serp/google/locations", token, {
          method: "GET",
          body: undefined,
        })
      ).status,
      200,
    );
    assert.equal(
      (await vraag("/sandbox/v3/serp/google/organic/live/advanced", token))
        .status,
      200,
    );
  },
);

test(
  "melding bij 80% en bij 100%, elk een keer per maand",
  { skip: !heeftPostgres },
  async () => {
    await budget("melder", 0.07);
    const token = await klanttoken(METER_SLEUTEL, "melder");
    meldingen.length = 0;
    await vraag(BETAALD, token); // 0.0301 = 43%
    assert.deepEqual(meldingen, []);
    await vraag(BETAALD, token); // 0.0602 = 86%
    assert.equal(meldingen.length, 1);
    assert.match(meldingen[0], /melder.*80%.*0,06.*0,07/s);
    await vraag(BETAALD, token); // 0.0903 = 129%
    assert.equal(meldingen.length, 2);
    assert.match(meldingen[1], /melder.*op/s);
    await vraag(BETAALD, token); // geblokkeerd
    assert.equal(meldingen.length, 2, "geen herhaling");
  },
);

test(
  "de rol van de meter leest het budget niet rechtstreeks",
  { skip: !heeftPostgres },
  async () => {
    await assert.rejects(sql`select * from seo.budget`, /permission denied/);
    await assert.rejects(
      sql`insert into seo.budget (client_id, maandbedrag) values ('x', 1000)`,
      /permission denied/,
    );
    await assert.rejects(
      sql`select * from seo.budget_melding`,
      /permission denied/,
    );
  },
);
