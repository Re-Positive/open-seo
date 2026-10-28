// De uitrol van de module SEO: per klant een eigen installatie van deze fork op Cloudflare
// (seo-engine#12, ADR-0008). Draaien vanuit de root van de fork:
//
//   node aios/uitrol/uitrol.ts nieuwe klant <client_id> [eerste domein]
//   node aios/uitrol/uitrol.ts nieuwe site <client_id> <domein>
//   node aios/uitrol/uitrol.ts bijwerken <tag>
//   node aios/uitrol/uitrol.ts gemist [aantal]
//
// Wat `nieuwe klant` doet, en wat bij herhalen gelijk blijft:
// 1. Klant (naam, site) uit `clients` van het client-dashboard.
// 2. Een Access-servicetoken `aios-seo-<client_id>`; id en geheim naar Doppler.
// 3. Een Access-applicatie op de Worker-hostname die alleen dat servicetoken doorlaat.
// 4. Een build met het basispad /seo, en de deploy via Alchemy (stage `klant-<client_id>`),
//    met ons eigen Access (TEAM_DOMAIN + POLICY_AUD), dus zonder e-mailpolicy van open-seo.
// 5. Een project per site (NL, nl) in de D1 van de installatie.
// 6. De Worker-URL naar Doppler, en de toets: zonder token 403, met token laadt /seo.
// 7. Klant en site in de AI OS (platform.klanten, seo.installatie, seo.site), zodat de SEO-poort ze kent.
//
// `bijwerken <tag>` (seo-engine#20) merget een release van open-seo in de fork, draait de tests,
// zet nieuwe teksten klaar in de woordenlijst, rolt uit bij Re:Positive met de rooktest door de SEO-poort,
// en pas als die slaagt bij de andere klanten. Daarna gaat de fork naar origin.
//
// `nieuwe site` (seo-engine#18) voegt bij een klant met een installatie een site toe: een project in zijn
// D1, en een rij in seo.site met het project-id. In de AI OS staat hij daarna in het keuzemenu van de
// kopbalk (na hoogstens tien minuten, de klantcookie van de poort). Herhalen mag.
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
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
import { AI_OS, AI_OS_ORIGIN, aiOsSql } from "./aios.ts";

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

// Search Console en GA4 (seo-engine#22): één Google-client voor alle klanten (project ai-os-512117 onder
// info@resketch.nl), met de redirect via os.resketch.nl. De tokens versleutelt de installatie met een
// eigen geheim per klant, dat hier één keer ontstaat en daarna gelijk blijft.
function googleVoor(klant: string) {
  const clientId = dopplerGet("SEO_GOOGLE_CLIENT_ID");
  const clientSecret = dopplerGet("SEO_GOOGLE_CLIENT_SECRET");
  if (!clientId || !clientSecret) return [];
  const naam = dopplerNamen(klant).authSecret;
  let authSecret = dopplerGet(naam);
  if (!authSecret) {
    authSecret = randomBytes(32).toString("hex");
    dopplerSet(naam, authSecret);
  }
  return [
    `GOOGLE_CLIENT_ID=${clientId}`,
    `GOOGLE_CLIENT_SECRET=${clientSecret}`,
    `BETTER_AUTH_SECRET=${authSecret}`,
  ];
}

// Shopify-crawlersignaturen (werk#582): zonder dit geheim weigert de installatie een signatuur op te slaan
// en houdt Shopify de crawler tegen met 429. Ontstaat één keer per klant, zoals het Google-geheim.
function crawlerVoor(klant: string) {
  const naam = dopplerNamen(klant).crawlerSecret;
  let geheim = dopplerGet(naam);
  if (!geheim) {
    geheim = randomBytes(32).toString("hex");
    dopplerSet(naam, geheim);
  }
  return [`CRAWLER_ACCESS_SECRET=${geheim}`];
}

function bouwEnDeploy(
  stage: string,
  subdomein: string,
  aud: string,
  heeftStateStore: boolean,
  meter: { url: string; token: string },
  geheimen: string[],
  bouwen = true,
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
      ...geheimen,
      "",
    ].join("\n"),
    { mode: 0o600 },
  );
  try {
    // De build is voor elke klant dezelfde; wat per klant verschilt, gaat via het env-bestand mee.
    if (bouwen) {
      draai("pnpm", ["exec", "vite", "build", "--mode", "selfhost"], {
        AIOS_BASISPAD: "/seo",
        AIOS_ORIGIN: AI_OS_ORIGIN,
        AUTH_MODE: "cloudflare_access",
        OPENSEO_TELEMETRY_DISABLED: "1",
      });
    }
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

// De klant in platform.klanten (de naam) en zijn installatie in seo.installatie. Een boeking van de meter
// voor een klant die niet in platform.klanten staat, weigert de database.
function registreerKlant(klant: string, naam: string, url: string) {
  aiOsSql(
    `begin;
     insert into platform.klanten (client_id, naam) values (:'client_id', :'naam')
     on conflict (client_id) do update set naam = excluded.naam;
     insert into seo.installatie (client_id, installatie_url) values (:'client_id', :'url')
     on conflict (client_id) do update set installatie_url = excluded.installatie_url
     returning client_id;
     commit;`,
    { client_id: klant, naam, url },
  );
}

function registreerSite(klant: string, domein: string, projectId: string) {
  const [rij] = aiOsSql(
    `insert into seo.site (client_id, domein, project_id)
     select :'client_id', :'domein', :'project_id'
      where exists (select 1 from seo.installatie where client_id = :'client_id')
     on conflict (client_id, domein) do update set project_id = excluded.project_id
     returning domein || ' ' || project_id;`,
    { client_id: klant, domein, project_id: projectId },
  );
  if (!rij) {
    throw new Error(
      `Klant ${klant} staat niet in seo.installatie van de AI OS; draai eerst \`nieuwe klant ${klant}\`.`,
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

// `domein` kiest de eerste site als de website van de klant niet de site is die SEO krijgt, zoals bij
// EVD (evd-group.nl): `nieuwe klant evd_group lumenix-beamers.nl`, daarna `nieuwe site` voor de rest.
async function nieuweKlant(klant: string, eersteSite?: string) {
  const gegevens = await klantVan(klant);
  const naam = gegevens.naam;
  const domein = eersteSite ? domeinVan(eersteSite) : gegevens.domein;
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
    [...googleVoor(klant), ...crawlerVoor(klant)],
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

// Re:Positive krijgt een nieuwe versie altijd eerst, met de rooktest (spec #12, seo-engine#20).
const EERST = "86c7h8f96";
// De woordenlijst (Engels naar Nederlands) en het script dat de teksten uit de code haalt, uit de proef.
const WOORDENLIJST = fileURLToPath(
  new URL("../../../open-seo-lokaal/schil/teksten.mjs", import.meta.url),
);

function git(args: string[]) {
  const uitkomst = spawnSync(
    "git",
    [
      "-c",
      "credential.helper=",
      "-c",
      "credential.helper=!gh auth git-credential",
      ...args,
    ],
    { cwd: ROOT, encoding: "utf8" },
  );
  if (uitkomst.status !== 0) {
    throw new Error(`git ${args.join(" ")}: ${uitkomst.stderr.trim()}`);
  }
  return uitkomst.stdout.trim();
}

// Een bestaande installatie opnieuw deployen met de huidige code van de fork.
async function deployKlant(klant: string, bouwen: boolean) {
  const installatie = await installatieVan(klant);
  const hostname = new URL(installatie.url).hostname;
  const subdomein = hostname.slice(`open-seo-${installatie.stage}.`.length);
  const apps = await cloudflare<AccessApp[]>("/access/apps");
  const app = apps.find((a) => a.domain === hostname);
  if (!app) throw new Error(`Geen Access-applicatie voor ${hostname}.`);
  console.log(`Uitrollen bij ${klant} (${hostname}).`);
  bouwEnDeploy(
    installatie.stage,
    subdomein,
    app.aud,
    true,
    await meterVoor(klant),
    [...googleVoor(klant), ...crawlerVoor(klant)],
    bouwen,
  );
  await toets(installatie.url, installatie.clientId, installatie.clientSecret);
}

function rooktest() {
  const uitkomst = spawnSync(
    "pnpm",
    [
      "exec",
      "playwright",
      "test",
      "-c",
      "aios/playwright.live.config.ts",
      "rooktest",
    ],
    { cwd: ROOT, stdio: "inherit", env: { ...process.env } },
  );
  return uitkomst.status === 0;
}

async function bijwerken(tag: string) {
  if (!/^v\d+\.\d+\.\d+$/.test(tag)) {
    throw new Error(`Geen release-tag van open-seo: ${tag}`);
  }
  if (git(["branch", "--show-current"]) !== "aios") {
    throw new Error("De fork staat niet op de branch aios.");
  }
  if (git(["status", "--porcelain", "--untracked-files=no"])) {
    throw new Error(
      "De werkmap van de fork is niet schoon; commit of zet eerst weg.",
    );
  }

  // 1. De nieuwe versie in de fork. Conflicten zitten alleen in bestanden met een schil:-commit.
  git(["fetch", "upstream", "--tags"]);
  const voor = git(["rev-parse", "HEAD"]);
  try {
    git(["merge", "--no-edit", "-m", `aios: open-seo ${tag}`, tag]);
  } catch (fout) {
    const botst = spawnSync("git", ["diff", "--name-only", "--diff-filter=U"], {
      cwd: ROOT,
      encoding: "utf8",
    }).stdout.trim();
    spawnSync("git", ["merge", "--abort"], { cwd: ROOT });
    throw new Error(
      `Merge van ${tag} botst, teruggedraaid. Los het met de hand op in:\n${botst || (fout as Error).message}`,
    );
  }
  console.log(
    voor === git(["rev-parse", "HEAD"])
      ? `${tag} zat al in de fork; ik rol de huidige code opnieuw uit.`
      : `${tag} gemerged.`,
  );

  // 2. Hun tests en de onze, voordat er iets live gaat.
  draai("pnpm", ["exec", "tsc", "--noEmit"]);
  draai("pnpm", ["exec", "vitest", "run", "--reporter=dot"]);

  // 3. De woordenlijst: nieuwe Engelse teksten komen leeg in nl.json, klaar om te vertalen.
  const lijst = spawnSync("node", [WOORDENLIJST, ROOT, "--schrijf"], {
    encoding: "utf8",
  });
  if (lijst.status !== 0) throw new Error(`Woordenlijst: ${lijst.stderr}`);
  const nieuw = Number(
    lijst.stdout.match(/nog te vertalen:\s+(\d+)/)?.[1] ?? NaN,
  );

  // 4. Eerst Re:Positive, met de rooktest door de SEO-poort. Faalt die, dan stopt het hier.
  await deployKlant(EERST, true);
  if (!rooktest()) {
    throw new Error(
      `De rooktest op Re:Positive faalt met ${tag}. De andere klanten blijven op de vorige versie; ` +
        `terug bij Re:Positive: git reset --hard ${voor.slice(0, 8)} en opnieuw bijwerken.`,
    );
  }

  // 5. Daarna de andere klanten (seo.installatie in de AI OS), met dezelfde build.
  const anderen = aiOsSql(
    "select client_id from seo.installatie where client_id <> :'eerst' order by client_id;",
    { eerst: EERST },
  );
  for (const klant of anderen) await deployKlant(klant, false);

  git(["push", "origin", "aios"]);
  console.log("\nDe meest geziene Engelse teksten (alle klanten):");
  gemist(15);
  console.log(
    `Klaar: ${tag} live bij ${[EERST, ...anderen].join(", ")}. ` +
      `Woordenlijst: ${nieuw} teksten te vertalen in open-seo-lokaal/schil/nl.json ` +
      `(daarna public/seo-schil/nl.js in ${AI_OS} opnieuw maken).`,
  );
}

// Welke Engelse teksten gebruikers het vaakst zagen, over alle klanten heen (seo-engine#21). De schil
// meldt ze aan de SEO-poort, die ze per klant in seo.gemiste_tekst zet (db/seo/002 in Re-Positive/seo-engine).
// "onvertaald" staat in de woordenlijst zonder vertaling; "onbekend" staat er niet in.
function gemist(aantal: number) {
  const rijen = aiOsSql(
    `select aantal || chr(9) || klanten || chr(9) || soort || chr(9) || tekst
       from seo.gemist_overzicht
      order by aantal desc, klanten desc, tekst
      limit :'aantal';`,
    { aantal: String(aantal) },
  );
  if (!rijen.length) {
    console.log("Geen gemiste teksten gemeld.");
    return rijen;
  }
  console.log("gezien\tklanten\tsoort\ttekst");
  for (const rij of rijen) console.log(rij);
  return rijen;
}

const [opdracht, soort, klant, domein] = process.argv.slice(2);
if (opdracht === "nieuwe" && soort === "klant" && klant) {
  await nieuweKlant(klant, domein);
} else if (opdracht === "nieuwe" && soort === "site" && klant && domein) {
  await nieuweSite(klant, domein);
} else if (opdracht === "bijwerken" && soort) {
  await bijwerken(soort);
} else if (opdracht === "gemist" && (!soort || /^\d+$/.test(soort))) {
  gemist(Number(soort ?? 50));
} else {
  console.error(
    "Gebruik: node aios/uitrol/uitrol.ts nieuwe klant <client_id> [eerste domein]\n" +
      "         node aios/uitrol/uitrol.ts nieuwe site <client_id> <domein>\n" +
      "         node aios/uitrol/uitrol.ts bijwerken <tag>\n" +
      "         node aios/uitrol/uitrol.ts gemist [aantal]",
  );
  process.exit(2);
}
