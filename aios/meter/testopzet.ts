// Gedeelde opzet voor de tests van de kostenmeter (naad 2, seo-engine#12, #16 en #17): een nep-DataForSEO
// en een wegwerp-Postgres met de schema's van AI OS, waarop de meter met zijn eigen smalle rol seo_meter
// boekt in platform.usage_events.
// Slaat zichzelf over zonder postgresql@17.
import { after, before } from "node:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import postgres from "postgres";
import { meter, type MeterOmgeving } from "./meter.ts";

const PGBIN = "/opt/homebrew/opt/postgresql@17/bin";
// Elk testbestand draait in een eigen proces: een eigen poort per proces.
const POORT = String(5400 + (process.pid % 500));
const HIER = path.dirname(new URL(import.meta.url).pathname);
const MIGREER = path.join(HIER, "../../../seo-engine/db/migreer.py");
export const ONZE_SLEUTEL = Buffer.from("wij@repositive.nl:geheim").toString(
  "base64",
);
export const METER_SLEUTEL = "m".repeat(40);
export const heeftPostgres = existsSync(`${PGBIN}/initdb`);

type Gezien = {
  host: string;
  pad: string;
  auth: string | undefined;
  body: string;
};
export const gezien: Gezien[] = [];

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
export let sql: postgres.Sql;
export let eigenaar: postgres.Sql;
const api = nepDataForSeo("api");
const sandbox = nepDataForSeo("sandbox");
let omgeving: MeterOmgeving;
const boekingen: Promise<unknown>[] = [];
export const meldingen: string[] = [];

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
    [
      url,
      "-X",
      "-q",
      "-c",
      "create role anon; create role authenticated; create role service_role",
    ],
    { stdio: "ignore" },
  );
  // De schema's platform en seo van het project AI OS, uit Re-Positive/seo-engine (db/), twee keer: idempotent.
  for (let i = 0; i < 2; i++) {
    execFileSync("/opt/homebrew/bin/python3.12", [MIGREER, "platform", "seo"], {
      env: { ...process.env, DB_URL: url, PSQL: `${PGBIN}/psql` },
      stdio: "ignore",
    });
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
    meld: async (tekst) => {
      meldingen.push(tekst);
    },
  };
  // Een boeking hoort bij een klant in platform.klanten (foreign key).
  await eigenaar`insert into platform.klanten (client_id, naam)
    values ('86c7h8f96', 'Re:Positive'), ('geenbudget', 'geenbudget'), ('melder', 'melder'), ('volbudget', 'volbudget')`;
  await eigenaar`insert into seo.budget (client_id, maandbedrag) values ('86c7h8f96', 20)`;
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

export async function vraag(
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

export async function grootboek() {
  return eigenaar`select client_id, endpoint, bedrag::text, taak_id from platform.usage_events where module = 'seo' order by id`;
}
