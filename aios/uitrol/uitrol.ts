// De uitrol van de module SEO: per klant een eigen installatie van deze fork op Cloudflare
// (seo-engine#12, ADR-0008). Draaien vanuit de root van de fork:
//
//   node aios/uitrol/uitrol.ts nieuwe klant <client_id>
//
// Wat `nieuwe klant` doet, en wat bij herhalen gelijk blijft:
// 1. Klant (naam, site) uit `clients` van het client-dashboard.
// 2. Een Access-servicetoken `aios-seo-<client_id>`; id en geheim naar Doppler.
// 3. Een Access-applicatie op de Worker-hostname die alleen dat servicetoken doorlaat.
// 4. Een build met het basispad /seo, en de deploy via Alchemy (stage `klant-<client_id>`),
//    met ons eigen Access (TEAM_DOMAIN + POLICY_AUD), dus zonder e-mailpolicy van open-seo.
// 5. Een project per site (NL, nl) in de D1 van de installatie.
// 6. De Worker-URL naar Doppler, en de toets: zonder token 403, met token laadt /seo.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cloudflare,
  d1Query,
  dopplerGet,
  dopplerNamen,
  dopplerSet,
  klantVan,
  stageVan,
} from "./cloudflare.ts";
import { klanttoken } from "../meter/meter.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// DataForSEO: Nederland en Nederlands.
const NL = { locationCode: 2528, languageCode: "nl" };
// Waar open-seo de gedeelde werkruimte van een Access-installatie bewaart (delegated-organization.ts).
const WERKRUIMTE = "shared-workspace";

type ServiceToken = {
  id: string;
  name: string;
  client_id: string;
  client_secret?: string;
};
type AccessApp = { id: string; domain: string; aud: string };

function draai(
  commando: string,
  args: string[],
  env: Record<string, string> = {},
) {
  const uitkomst = spawnSync(commando, args, {
    cwd: ROOT,
    stdio: "inherit",
    env: { ...process.env, ...env },
  });
  if (uitkomst.status !== 0) {
    throw new Error(
      `${commando} ${args.join(" ")} faalde (exit ${uitkomst.status}).`,
    );
  }
}

async function zorgVoorServicetoken(klant: string) {
  const naam = `aios-seo-${klant}`;
  const namen = dopplerNamen(klant);
  const tokens = await cloudflare<ServiceToken[]>("/access/service_tokens");
  const bestaand = tokens.find((t) => t.name === naam);

  if (bestaand && dopplerGet(namen.clientSecret)) {
    return bestaand;
  }
  // Het geheim toont Cloudflare alleen bij aanmaken of roteren; staat het niet in Doppler, dan roteren.
  const nieuw = bestaand
    ? await cloudflare<ServiceToken>(
        `/access/service_tokens/${bestaand.id}/rotate`,
        {
          method: "POST",
        },
      )
    : await cloudflare<ServiceToken>("/access/service_tokens", {
        method: "POST",
        body: JSON.stringify({ name: naam, duration: "forever" }),
      });
  dopplerSet(namen.clientId, nieuw.client_id ?? bestaand!.client_id);
  dopplerSet(namen.clientSecret, nieuw.client_secret!);
  console.log(
    `Servicetoken ${naam} ${bestaand ? "geroteerd" : "aangemaakt"}, staat in Doppler.`,
  );
  return { ...nieuw, id: bestaand?.id ?? nieuw.id };
}

async function zorgVoorAccessApp(
  klant: string,
  hostname: string,
  tokenId: string,
) {
  const app = {
    type: "self_hosted",
    name: `AI OS SEO ${klant}`,
    domain: hostname,
    session_duration: "24h",
    policies: [
      {
        name: "Alleen de SEO-poort",
        decision: "non_identity",
        include: [{ service_token: { token_id: tokenId } }],
        precedence: 1,
      },
    ],
  };
  const apps = await cloudflare<AccessApp[]>("/access/apps");
  const bestaand = apps.find((a) => a.domain === hostname);
  return bestaand
    ? cloudflare<AccessApp>(`/access/apps/${bestaand.id}`, {
        method: "PUT",
        body: JSON.stringify(app),
      })
    : cloudflare<AccessApp>("/access/apps", {
        method: "POST",
        body: JSON.stringify(app),
      });
}

// De installatie krijgt nooit onze DataForSEO-sleutel (spec #12): alle calls gaan naar de kostenmeter
// (aios/meter), met een klanttoken als sleutel. De meter boekt per klant en stuurt door.
async function meterVoor(klant: string) {
  const url = dopplerGet("SEO_METER_URL");
  const sleutel = dopplerGet("SEO_METER_SLEUTEL");
  if (!url || !sleutel) {
    throw new Error(
      "De kostenmeter staat er nog niet: draai eerst aios/meter/uitrol-meter.ts.",
    );
  }
  return { url, token: await klanttoken(sleutel, klant) };
}

function bouwEnDeploy(
  stage: string,
  subdomein: string,
  aud: string,
  heeftStateStore: boolean,
  meter: { url: string; token: string },
) {
  const teamDomein = `https://${dopplerGet("CLOUDFLARE_ACCESS_TEAM")}.cloudflareaccess.com`;
  const envBestand = `.env.uitrol-${stage}`;
  const cloudflareEnv = {
    CLOUDFLARE_API_TOKEN: dopplerGet("CLOUDFLARE_API_TOKEN"),
    CLOUDFLARE_ACCOUNT_ID: dopplerGet("CLOUDFLARE_ACCOUNT_ID"),
    CI: "true",
  };
  writeFileSync(
    `${ROOT}/${envBestand}`,
    [
      `DATAFORSEO_API_KEY=${meter.token}`,
      `DATAFORSEO_API_URL=${meter.url}`,
      `DATAFORSEO_SANDBOX_URL=${meter.url}/sandbox`,
      "AUTH_MODE=cloudflare_access",
      `TEAM_DOMAIN=${teamDomein}`,
      `POLICY_AUD=${aud}`,
      `WORKERS_SUBDOMAIN=${subdomein}`,
      "OPENSEO_TELEMETRY_DISABLED=1",
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  try {
    draai("pnpm", ["exec", "vite", "build", "--mode", "selfhost"], {
      AIOS_BASISPAD: "/seo",
      AUTH_MODE: "cloudflare_access",
      OPENSEO_TELEMETRY_DISABLED: "1",
    });
    if (!heeftStateStore) {
      draai("pnpm", ["alchemy", "cloudflare", "bootstrap"], cloudflareEnv);
    }
    draai(
      "pnpm",
      [
        "alchemy",
        "deploy",
        "deploy/alchemy/alchemy.run.ts",
        "--env-file",
        envBestand,
        "--stage",
        stage,
        "--yes",
      ],
      cloudflareEnv,
    );
  } finally {
    rmSync(`${ROOT}/${envBestand}`, { force: true });
  }
}

async function zorgVoorProject(stage: string, domein: string) {
  await d1Query(
    stage,
    "insert into organization (id, name, slug, created_at) values (?, 'Shared organization', ?, ?) on conflict(id) do nothing",
    [WERKRUIMTE, WERKRUIMTE, Date.now()],
  );
  await d1Query(
    stage,
    `insert into projects (id, organization_id, name, domain, location_code, language_code)
     select ?, ?, ?, ?, ?, ?
     where not exists (select 1 from projects where organization_id = ? and domain = ? and archived_at is null)`,
    [
      crypto.randomUUID(),
      WERKRUIMTE,
      domein,
      domein,
      NL.locationCode,
      NL.languageCode,
      WERKRUIMTE,
      domein,
    ],
  );
}

async function toets(url: string, clientId: string, clientSecret: string) {
  const zonder = await fetch(`${url}/seo/`, { redirect: "manual" });
  const met = await fetch(`${url}/seo/`, {
    headers: {
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    },
  });
  console.log(
    `Toets: zonder servicetoken ${zonder.status}, met servicetoken ${met.status}.`,
  );
  if (zonder.status !== 403 || met.status !== 200) {
    throw new Error(
      "De installatie staat er, maar de toets klopt niet (verwacht 403 en 200).",
    );
  }
}

async function nieuweKlant(klant: string) {
  const { naam, domein } = await klantVan(klant);
  const stage = stageVan(klant);
  const { subdomain } = await cloudflare<{ subdomain: string }>(
    "/workers/subdomain",
  );
  const subdomein = `${subdomain}.workers.dev`;
  const hostname = `open-seo-${stage}.${subdomein}`;
  console.log(
    `Nieuwe klant ${naam} (${klant}): site ${domein}, installatie ${hostname}.`,
  );

  const token = await zorgVoorServicetoken(klant);
  const app = await zorgVoorAccessApp(klant, hostname, token.id);
  // De state-opslag van Alchemy staat één keer per account; de bootstrap blijft na "Done" hangen.
  const workers = await cloudflare<{ id: string }[]>("/workers/scripts");
  bouwEnDeploy(
    stage,
    subdomein,
    app.aud,
    workers.some((w) => w.id === "alchemy-state-store"),
    await meterVoor(klant),
  );
  await zorgVoorProject(stage, domein);

  const namen = dopplerNamen(klant);
  const url = `https://${hostname}`;
  dopplerSet(namen.url, url);
  await toets(url, dopplerGet(namen.clientId), dopplerGet(namen.clientSecret));
  console.log(
    `Klaar: ${url}/seo (Doppler: ${namen.url}, ${namen.clientId}, ${namen.clientSecret}).`,
  );
}

const [opdracht, soort, klant] = process.argv.slice(2);
if (opdracht === "nieuwe" && soort === "klant" && klant) {
  await nieuweKlant(klant);
} else {
  console.error("Gebruik: node aios/uitrol/uitrol.ts nieuwe klant <client_id>");
  process.exit(2);
}
