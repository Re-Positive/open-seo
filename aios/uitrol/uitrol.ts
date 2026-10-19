// De uitrol van de module SEO: per klant een eigen installatie van deze fork op Cloudflare
// (seo-engine#12, ADR-0008). Draaien vanuit de root van de fork:
//
//   node aios/uitrol/uitrol.ts nieuwe klant <client_id>
//   node aios/uitrol/uitrol.ts nieuwe site <client_id> <domein>
//
// Wat `nieuwe klant` doet, en wat bij herhalen gelijk blijft:
// 1. Klant (naam, site) uit `clients` van het client-dashboard.
// 2. Een Access-servicetoken `aios-seo-<client_id>`; id en geheim naar Doppler.
// 3. Een Access-applicatie op de Worker-hostname die alleen dat servicetoken doorlaat.
// 4. Een build met het basispad /seo, en de deploy via Alchemy (stage `klant-<client_id>`),
//    met ons eigen Access (TEAM_DOMAIN + POLICY_AUD), dus zonder e-mailpolicy van open-seo.
// 5. Een project per site (NL, nl) in de D1 van de installatie.
// 6. De Worker-URL naar Doppler, en de toets: zonder token 403, met token laadt /seo.
// 7. Klant en site in schema seo van de AI OS (seo.klant, seo.site), zodat de SEO-poort ze kent.
//
// `nieuwe site` (seo-engine#18) voegt bij een klant met een installatie een site toe: een project in zijn
// D1, en een rij in seo.site met het project-id. In de AI OS staat hij daarna in het keuzemenu van de
// kopbalk (na hoogstens tien minuten, de klantcookie van de poort). Herhalen mag.
import { spawnSync } from "node:child_process";
import { rmSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  cloudflare,
  d1Query,
  dopplerGet,
  dopplerNamen,
  dopplerSet,
  domeinVan,
  installatieVan,
  klantVan,
  stageVan,
} from "./cloudflare.ts";
import { klanttoken } from "../meter/meter.ts";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
// De AI OS (os.resketch.nl), waar schema seo staat. De database-URL staat in Doppler resketch-ai, en
// het Doppler-token is per map gescoped: daarom draait psql vanuit die map.
const AI_OS = fileURLToPath(
  new URL(
    "../../../../../02-resketch/OtherWorlds/ai-os-beheer",
    import.meta.url,
  ),
);
const PSQL = "/opt/homebrew/opt/libpq/bin/psql";
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

async function zorgVoorProject(stage: string, domein: string): Promise<string> {
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
  const [project] = await d1Query(
    stage,
    "select id from projects where organization_id = ? and domain = ? and archived_at is null order by created_at limit 1",
    [WERKRUIMTE, domein],
  );
  if (!project) throw new Error(`Geen project voor ${domein} in ${stage}.`);
  return String(project.id);
}

// SQL naar schema seo van de AI OS. De waarden gaan als psql-variabelen mee (`:'naam'`), nooit in de
// tekst van de SQL. Geeft de regels van `returning` terug.
function aiOsSql(sql: string, waarden: Record<string, string>) {
  const vars = Object.keys(waarden).flatMap((naam, i) => [
    "-v",
    `${naam}=\${${i + 1}}`,
  ]);
  const uitkomst = spawnSync(
    "doppler",
    [
      "run",
      "-p",
      "resketch-ai",
      "-c",
      "prd",
      "--",
      "bash",
      "-c",
      `exec ${PSQL} "$(scripts/db-url.py "$CLIENT_PORTAL_DB_URL")" -X -q -At -v ON_ERROR_STOP=1 ${vars
        .map((v) => (v === "-v" ? v : `"${v}"`))
        .join(" ")}`,
      "aios-sql",
      ...Object.values(waarden),
    ],
    { cwd: AI_OS, input: sql, encoding: "utf8" },
  );
  if (uitkomst.status !== 0) {
    throw new Error(
      `schema seo: ${uitkomst.stderr.trim() || `exit ${uitkomst.status}`}`,
    );
  }
  return uitkomst.stdout.trim().split("\n").filter(Boolean);
}

function registreerKlant(klant: string, naam: string, url: string) {
  aiOsSql(
    `insert into seo.klant (client_id, naam, installatie_url) values (:'client_id', :'naam', :'url')
     on conflict (client_id) do update set naam = excluded.naam, installatie_url = excluded.installatie_url
     returning client_id;`,
    { client_id: klant, naam, url },
  );
}

function registreerSite(klant: string, domein: string, projectId: string) {
  const [rij] = aiOsSql(
    `insert into seo.site (client_id, domein, project_id)
     select :'client_id', :'domein', :'project_id'
      where exists (select 1 from seo.klant where client_id = :'client_id')
     on conflict (client_id, domein) do update set project_id = excluded.project_id
     returning domein || ' ' || project_id;`,
    { client_id: klant, domein, project_id: projectId },
  );
  if (!rij) {
    throw new Error(
      `Klant ${klant} staat niet in seo.klant van de AI OS; draai eerst \`nieuwe klant ${klant}\`.`,
    );
  }
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
  const projectId = await zorgVoorProject(stage, domein);

  const namen = dopplerNamen(klant);
  const url = `https://${hostname}`;
  dopplerSet(namen.url, url);
  await toets(url, dopplerGet(namen.clientId), dopplerGet(namen.clientSecret));
  registreerKlant(klant, naam, url);
  registreerSite(klant, domein, projectId);
  console.log(
    `Klaar: ${url}/seo (Doppler: ${namen.url}, ${namen.clientId}, ${namen.clientSecret}; site ${domein} in seo.site).`,
  );
}

async function nieuweSite(klant: string, invoer: string) {
  const domein = domeinVan(invoer);
  const installatie = await installatieVan(klant);
  const projectId = await zorgVoorProject(installatie.stage, domein);
  registreerSite(klant, domein, projectId);
  console.log(
    `Klaar: site ${domein} bij ${klant}, project ${projectId} (${installatie.url}/seo/p/${projectId}).`,
  );
}

const [opdracht, soort, klant, domein] = process.argv.slice(2);
if (opdracht === "nieuwe" && soort === "klant" && klant) {
  await nieuweKlant(klant);
} else if (opdracht === "nieuwe" && soort === "site" && klant && domein) {
  await nieuweSite(klant, domein);
} else {
  console.error(
    "Gebruik: node aios/uitrol/uitrol.ts nieuwe klant <client_id>\n" +
      "         node aios/uitrol/uitrol.ts nieuwe site <client_id> <domein>",
  );
  process.exit(2);
}
