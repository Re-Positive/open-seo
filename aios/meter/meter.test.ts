// Naad 2 van de module SEO (Re-Positive/seo-engine#12 en #16): de kostenmeter over HTTP, met een
// nep-DataForSEO erachter en een wegwerp-Postgres als grootboek, waarop de meter met zijn eigen smalle
// rol seo_meter schrijft. Draaien: npm test (in aios/meter). Slaat zichzelf over zonder postgresql@17.
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { klanttoken, meter, type MeterOmgeving } from "./meter.ts";

const PGBIN = "/opt/homebrew/opt/postgresql@17/bin";
const POORT = "5461";
const HIER = path.dirname(new URL(import.meta.url).pathname);
const ONZE_SLEUTEL = Buffer.from("wij@repositive.nl:geheim").toString("base64");
const METER_SLEUTEL = "m".repeat(40);
const heeftPostgres = existsSync(`${PGBIN}/initdb`);

type Gezien = {
  host: string;
  pad: string;
  auth: string | undefined;
  body: string;
};
const gezien: Gezien[] = [];

// Nep-DataForSEO: betaalde calls rekenen per taak, de saldo-call is gratis, de sandbox ook.
function nepDataForSeo(host: string) {
  return http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      gezien.push({
        host,
        pad: req.url!,
        auth: req.headers.authorization,
        body,
      });
      res.writeHead(200, { "content-type": "application/json" });
      if (req.url === "/v3/appendix/user_data") {
        return res.end(
          JSON.stringify({
            status_code: 20000,
            cost: 0,
            tasks: [
              { id: "gratis", cost: 0, result: [{ money: { balance: 50 } }] },
            ],
          }),
        );
      }
      if (host === "sandbox")
        return res.end(
          JSON.stringify({
            status_code: 20000,
            cost: 0,
            tasks: [{ id: "sb", cost: 0 }],
          }),
        );
      res.end(
        JSON.stringify({
          status_code: 20000,
          cost: 0.0301,
          tasks: [
            { id: "taak-1", cost: 0.0101 },
            { id: "taak-2", cost: 0.02 },
          ],
        }),
      );
    });
  });
}

let tmp = "";
let sql: postgres.Sql;
let eigenaar: postgres.Sql;
const api = nepDataForSeo("api");
const sandbox = nepDataForSeo("sandbox");
let omgeving: MeterOmgeving;
const boekingen: Promise<unknown>[] = [];

async function luister(s: http.Server) {
  await new Promise<void>((r) => s.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
}

before(async () => {
  if (!heeftPostgres) return;
  tmp = mkdtempSync(path.join(tmpdir(), "seometer-"));
  const env = { ...process.env, LC_ALL: "C", LANG: "C" };
  execFileSync(
    `${PGBIN}/initdb`,
    ["-D", `${tmp}/data`, "-U", "test", "--auth=trust", "--no-locale"],
    { env, stdio: "ignore" },
  );
  execFileSync(
    `${PGBIN}/pg_ctl`,
    [
      "-D",
      `${tmp}/data`,
      "-l",
      `${tmp}/log`,
      "-w",
      "-o",
      `-c unix_socket_directories='' -c listen_addresses=127.0.0.1 -p ${POORT} -c fsync=off`,
      "start",
    ],
    { env, stdio: "ignore" },
  );
  const url = `postgres://test@127.0.0.1:${POORT}/postgres`;
  execFileSync(
    `${PGBIN}/psql`,
    [url, "-X", "-q", "-c", "create role anon; create role authenticated"],
    { stdio: "ignore" },
  );
  for (let i = 0; i < 2; i++) {
    execFileSync(
      `${PGBIN}/psql`,
      [
        url,
        "-X",
        "-q",
        "-v",
        "ON_ERROR_STOP=1",
        "-f",
        path.join(HIER, "grootboek.sql"),
      ],
      { stdio: "ignore" },
    );
  }
  eigenaar = postgres(url, { max: 1, onnotice: () => {} });
  sql = postgres(`postgres://seo_meter@127.0.0.1:${POORT}/postgres`, {
    max: 1,
    prepare: false,
  });
  omgeving = {
    dataforseoUrl: await luister(api),
    sandboxUrl: await luister(sandbox),
    dataforseoSleutel: ONZE_SLEUTEL,
    meterSleutel: METER_SLEUTEL,
    sql,
    naBoeking: (p) => boekingen.push(p),
  };
});

after(async () => {
  api.close();
  sandbox.close();
  if (!heeftPostgres) return;
  await sql.end();
  await eigenaar.end();
  execFileSync(
    `${PGBIN}/pg_ctl`,
    ["-D", `${tmp}/data`, "-m", "immediate", "stop"],
    { stdio: "ignore" },
  );
  rmSync(tmp, { recursive: true, force: true });
});

async function vraag(
  pad: string,
  token: string | null,
  init: RequestInit = {},
) {
  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (token) headers.authorization = `Basic ${token}`;
  const r = await meter(
    new Request(`https://meter.example${pad}`, {
      method: "POST",
      body: "[{}]",
      headers,
      ...init,
    }),
    omgeving,
  );
  await Promise.all(boekingen.splice(0));
  return r;
}

async function grootboek() {
  return eigenaar`select client_id, endpoint, bedrag::text, taak_id from seo.grootboek order by id`;
}

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
    await assert.rejects(sql`select * from seo.grootboek`, /permission denied/);
    await assert.rejects(
      sql`update seo.grootboek set bedrag = 0`,
      /permission denied/,
    );
    await assert.rejects(sql`delete from seo.grootboek`, /permission denied/);
  },
);

test(
  "het grootboek is append-only, ook voor de eigenaar",
  { skip: !heeftPostgres },
  async () => {
    await assert.rejects(
      eigenaar`update seo.grootboek set bedrag = 1`,
      /append-only/,
    );
    await assert.rejects(eigenaar`delete from seo.grootboek`, /append-only/);
    await assert.rejects(eigenaar`truncate seo.grootboek`, /append-only/);
  },
);
