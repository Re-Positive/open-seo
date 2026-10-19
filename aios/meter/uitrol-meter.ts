// Rolt de kostenmeter uit (seo-engine#16). Draaien vanuit de root van de fork, na grootboek-db.sh:
//
//   node aios/meter/uitrol-meter.ts sleutels    # eenmalig: METER_SLEUTEL en het DB-wachtwoord naar Doppler
//   bash aios/meter/grootboek-db.sh             # grootboek en rol seo_meter op de portal-Supabase
//   node aios/meter/uitrol-meter.ts             # CA, Hyperdrive, secrets en deploy van de Worker
//
// Herhalen mag: wat er al staat, blijft staan.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { cloudflare, dopplerGet, dopplerSet } from "../uitrol/cloudflare.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const HIER = fileURLToPath(new URL(".", import.meta.url));
// De portal-Supabase waar os.resketch.nl en schema seo op draaien.
const SUPABASE_REF = "hpbughfjwkvwzesphmyc";
const POOLER = "aws-0-eu-west-3.pooler.supabase.com";
const CA_NAAM = "supabase-root-2021";
const HYPERDRIVE_NAAM = "aios-seo-grootboek";
const WORKER = "aios-seo-meter";

function sleutels() {
  for (const naam of ["SEO_METER_SLEUTEL", "SEO_METER_DB_WACHTWOORD"]) {
    if (dopplerGet(naam)) {
      console.log(`${naam} staat al in Doppler.`);
      continue;
    }
    dopplerSet(naam, randomBytes(24).toString("hex"));
    console.log(`${naam} aangemaakt in Doppler.`);
  }
}

async function zorgVoorCa() {
  const lijst =
    await cloudflare<{ id: string; name: string }[]>("/mtls_certificates");
  const bestaand = lijst.find((c) => c.name === CA_NAAM);
  if (bestaand) return bestaand.id;
  const nieuw = await cloudflare<{ id: string }>("/mtls_certificates", {
    method: "POST",
    body: JSON.stringify({
      name: CA_NAAM,
      ca: true,
      certificates: readFileSync(`${HIER}/supabase-ca.pem`, "utf8"),
    }),
  });
  console.log("CA van Supabase geüpload.");
  return nieuw.id;
}

async function zorgVoorHyperdrive(caId: string) {
  const config = {
    name: HYPERDRIVE_NAAM,
    origin: {
      scheme: "postgres",
      host: POOLER,
      port: 5432,
      database: "postgres",
      user: `seo_meter.${SUPABASE_REF}`,
      password: dopplerGet("SEO_METER_DB_WACHTWOORD"),
    },
    caching: { disabled: true },
    mtls: { ca_certificate_id: caId, sslmode: "verify-full" },
  };
  const lijst = await cloudflare<{ id: string; name: string }[]>(
    "/hyperdrive/configs",
  );
  const bestaand = lijst.find((h) => h.name === HYPERDRIVE_NAAM);
  const uit = bestaand
    ? await cloudflare<{ id: string }>(`/hyperdrive/configs/${bestaand.id}`, {
        method: "PUT",
        body: JSON.stringify(config),
      })
    : await cloudflare<{ id: string }>("/hyperdrive/configs", {
        method: "POST",
        body: JSON.stringify(config),
      });
  console.log(
    `Hyperdrive ${HYPERDRIVE_NAAM} ${bestaand ? "bijgewerkt" : "aangemaakt"}.`,
  );
  return uit.id;
}

function wrangler(args: string[], invoer?: string) {
  const uitkomst = spawnSync(
    "pnpm",
    ["exec", "wrangler", ...args, "-c", "aios/meter/wrangler.jsonc"],
    {
      cwd: ROOT,
      input: invoer,
      stdio: [invoer === undefined ? "inherit" : "pipe", "inherit", "inherit"],
      env: {
        ...process.env,
        CLOUDFLARE_API_TOKEN: dopplerGet("CLOUDFLARE_API_TOKEN"),
        CLOUDFLARE_ACCOUNT_ID: dopplerGet("CLOUDFLARE_ACCOUNT_ID"),
      },
    },
  );
  if (uitkomst.status !== 0)
    throw new Error(`wrangler ${args[0]} faalde (exit ${uitkomst.status}).`);
}

async function uitrol() {
  const caId = await zorgVoorCa();
  const hyperdriveId = await zorgVoorHyperdrive(caId);
  const pad = `${HIER}/wrangler.jsonc`;
  writeFileSync(
    pad,
    readFileSync(pad, "utf8").replace(
      /("binding": "GROOTBOEK", "id": ")[^"]*(")/,
      `$1${hyperdriveId}$2`,
    ),
  );

  wrangler(["deploy"]);
  wrangler(
    ["secret", "put", "DATAFORSEO_API_KEY"],
    dopplerGet("DATAFORSEO_API_KEY"),
  );
  wrangler(["secret", "put", "METER_SLEUTEL"], dopplerGet("SEO_METER_SLEUTEL"));

  const { subdomain } = await cloudflare<{ subdomain: string }>(
    "/workers/subdomain",
  );
  const url = `https://${WORKER}.${subdomain}.workers.dev`;
  dopplerSet("SEO_METER_URL", url);
  console.log(`Klaar: ${url} (Doppler: SEO_METER_URL).`);
}

if (process.argv[2] === "sleutels") sleutels();
else await uitrol();
