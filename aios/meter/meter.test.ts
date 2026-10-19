// Naad 2 van de module SEO (seo-engine#16): de kostenmeter boekt per klant. Draaien: npm test (in aios/meter).
import { test } from "node:test";
import assert from "node:assert/strict";
import { klanttoken } from "./meter.ts";
import {
  METER_SLEUTEL,
  ONZE_SLEUTEL,
  eigenaar,
  gezien,
  grootboek,
  heeftPostgres,
  sql,
  vraag,
} from "./testopzet.ts";

test(
  "een betaalde call gaat met onze sleutel naar DataForSEO en wordt per taak geboekt",
  { skip: !heeftPostgres },
  async () => {
    gezien.length = 0;
    const token = await klanttoken(METER_SLEUTEL, "86c7h8f96");
    const r = await vraag(
      "/v3/dataforseo_labs/google/keyword_ideas/live",
      token,
    );
    assert.equal(r.status, 200);
    assert.equal(
      ((await r.json()) as { cost: number }).cost,
      0.0301,
      "het antwoord komt ongewijzigd terug",
    );
    assert.equal(gezien.length, 1);
    assert.equal(gezien[0].host, "api");
    assert.equal(gezien[0].auth, `Basic ${ONZE_SLEUTEL}`);
    assert.equal(gezien[0].body, "[{}]");
    assert.deepEqual(
      [...(await grootboek())],
      [
        {
          client_id: "86c7h8f96",
          endpoint: "/v3/dataforseo_labs/google/keyword_ideas/live",
          bedrag: "0.010100",
          taak_id: "taak-1",
        },
        {
          client_id: "86c7h8f96",
          endpoint: "/v3/dataforseo_labs/google/keyword_ideas/live",
          bedrag: "0.020000",
          taak_id: "taak-2",
        },
      ],
    );
  },
);

test(
  "een gratis call gaat door en wordt niet geboekt",
  { skip: !heeftPostgres },
  async () => {
    const voor = (await grootboek()).length;
    const r = await vraag(
      "/v3/appendix/user_data",
      await klanttoken(METER_SLEUTEL, "86c7h8f96"),
      { method: "GET", body: undefined },
    );
    assert.equal(r.status, 200);
    assert.equal((await grootboek()).length, voor);
  },
);

test(
  "de sandbox gaat naar de sandbox van DataForSEO en wordt niet geboekt",
  { skip: !heeftPostgres },
  async () => {
    gezien.length = 0;
    const voor = (await grootboek()).length;
    await vraag(
      "/sandbox/v3/serp/google/organic/live/advanced",
      await klanttoken(METER_SLEUTEL, "86c7h8f96"),
    );
    assert.deepEqual(
      gezien.map((g) => [g.host, g.pad]),
      [["sandbox", "/v3/serp/google/organic/live/advanced"]],
    );
    assert.equal((await grootboek()).length, voor);
  },
);

test(
  "een onbekend, geknoeid of ontbrekend token wordt geweigerd in de vorm van DataForSEO",
  { skip: !heeftPostgres },
  async () => {
    gezien.length = 0;
    const echt = Buffer.from(
      await klanttoken(METER_SLEUTEL, "86c7h8f96"),
      "base64",
    ).toString();
    const geknoeid = Buffer.from(
      echt.replace("86c7h8f96", "andereklant"),
    ).toString("base64");
    const anderGeheim = await klanttoken("x".repeat(40), "86c7h8f96");
    for (const token of [geknoeid, anderGeheim, ONZE_SLEUTEL, null]) {
      const r = await vraag(
        "/v3/dataforseo_labs/google/keyword_ideas/live",
        token,
      );
      assert.equal(r.status, 401);
      assert.equal(
        ((await r.json()) as { status_code: number }).status_code,
        40100,
      );
    }
    assert.equal(gezien.length, 0, "niets bereikt DataForSEO");
  },
);

test(
  "de rol van de meter mag alleen boeken: niet lezen, niet wijzigen, niet wissen",
  { skip: !heeftPostgres },
  async () => {
    await assert.rejects(sql`select * from platform.usage_events`, /permission denied/);
    await assert.rejects(
      sql`update platform.usage_events set bedrag = 0`,
      /permission denied/,
    );
    await assert.rejects(sql`delete from platform.usage_events`, /permission denied/);
  },
);

test(
  "het grootboek is append-only, ook voor de eigenaar",
  { skip: !heeftPostgres },
  async () => {
    await assert.rejects(
      eigenaar`update platform.usage_events set bedrag = 1`,
      /append-only/,
    );
    await assert.rejects(eigenaar`delete from platform.usage_events`, /append-only/);
    await assert.rejects(eigenaar`truncate platform.usage_events`, /append-only/);
  },
);
