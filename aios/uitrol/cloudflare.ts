// De naden van de uitrol naar buiten: Doppler (geheimen), de Cloudflare-API en het
// client-dashboard (klantgegevens). Gedeeld door de uitrol en de live-tests.
import { execFileSync } from "node:child_process";

const DOPPLER = ["-p", "repositive-ai", "-c", "prd"];

export function dopplerGet(naam: string): string {
  try {
    return execFileSync(
      "doppler",
      ["secrets", "get", naam, "--plain", ...DOPPLER],
      {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      },
    ).trim();
  } catch {
    return "";
  }
}

export function dopplerSet(naam: string, waarde: string) {
  execFileSync("doppler", ["secrets", "set", naam, "--silent", ...DOPPLER], {
    input: waarde,
    stdio: ["pipe", "ignore", "inherit"],
  });
}

function vereist(naam: string) {
  const waarde = dopplerGet(naam);
  if (!waarde)
    throw new Error(`${naam} staat niet in Doppler (repositive-ai/prd).`);
  return waarde;
}

export async function cloudflare<T>(
  pad: string,
  init: RequestInit = {},
): Promise<T> {
  const account = vereist("CLOUDFLARE_ACCOUNT_ID");
  const antwoord = await fetch(
    `https://api.cloudflare.com/client/v4/accounts/${account}${pad}`,
    {
      ...init,
      headers: {
        Authorization: `Bearer ${vereist("CLOUDFLARE_API_TOKEN")}`,
        "Content-Type": "application/json",
        ...init.headers,
      },
    },
  );
  const body = (await antwoord.json()) as {
    success: boolean;
    errors: unknown;
    result: T;
  };
  if (!body.success) {
    throw new Error(
      `Cloudflare ${init.method ?? "GET"} ${pad}: ${JSON.stringify(body.errors)}`,
    );
  }
  return body.result;
}

/** De stage van een klant: ook de naam van zijn Worker (`open-seo-<stage>`) en zijn D1/KV/R2. */
export function stageVan(klant: string) {
  return `klant-${klant.toLowerCase().replace(/[^a-z0-9]+/g, "-")}`;
}

/** Waar de uitrol de installatie van een klant in Doppler zet. */
export function dopplerNamen(klant: string) {
  const id = klant.toUpperCase().replace(/[^A-Z0-9]+/g, "_");
  return {
    url: `SEO_${id}_URL`,
    clientId: `SEO_${id}_ACCESS_CLIENT_ID`,
    clientSecret: `SEO_${id}_ACCESS_CLIENT_SECRET`,
  };
}

export async function installatieVan(klant: string) {
  const namen = dopplerNamen(klant);
  return {
    stage: stageVan(klant),
    url: vereist(namen.url),
    clientId: vereist(namen.clientId),
    clientSecret: vereist(namen.clientSecret),
  };
}

export async function d1Query(
  stage: string,
  sql: string,
  params: unknown[] = [],
) {
  const [database] = await cloudflare<{ uuid: string }[]>(
    `/d1/database?name=${encodeURIComponent(`open-seo-db-${stage}`)}`,
  );
  if (!database) throw new Error(`Geen D1-database voor ${stage}.`);
  const [uitkomst] = await cloudflare<{ results: Record<string, unknown>[] }[]>(
    `/d1/database/${database.uuid}/query`,
    { method: "POST", body: JSON.stringify({ sql, params }) },
  );
  return uitkomst.results;
}

/** Naam en site van een klant, uit `clients` in het client-dashboard (dezelfde client_id, ADR-0005). */
export async function klantVan(klant: string) {
  // De URL in Doppler kan al een pad hebben (/rest/v1); alleen de origin telt.
  const basis = new URL(vereist("CLIENT_DASHBOARD_SUPABASE_URL")).origin;
  const sleutel = vereist("CLIENT_DASHBOARD_SUPABASE_SERVICE_ROLE_KEY");
  const antwoord = await fetch(
    `${basis}/rest/v1/clients?clickup_task_id=eq.${encodeURIComponent(klant)}&select=name,website`,
    { headers: { apikey: sleutel, Authorization: `Bearer ${sleutel}` } },
  );
  if (!antwoord.ok)
    throw new Error(
      `client-dashboard ${antwoord.status}: ${await antwoord.text()}`,
    );
  const [rij] = (await antwoord.json()) as {
    name: string;
    website: string | null;
  }[];
  if (!rij)
    throw new Error(
      `Klant ${klant} staat niet in clients van het client-dashboard.`,
    );
  if (!rij.website)
    throw new Error(
      `Klant ${klant} (${rij.name}) heeft geen website in clients.`,
    );
  return { naam: rij.name, domein: domeinVan(rij.website) };
}

/** Het domein van een site zoals de AI OS het bewaart (`seo.site.domein`): kleine letters, zonder www. */
export function domeinVan(invoer: string) {
  const tekst = invoer.trim();
  let domein: string;
  try {
    domein = new URL(
      tekst.includes("://") ? tekst : `https://${tekst}`,
    ).hostname
      .toLowerCase()
      .replace(/^www\./, "");
  } catch {
    throw new Error(`Geen geldig domein: ${invoer}`);
  }
  if (!/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(domein)) {
    throw new Error(`Geen geldig domein: ${invoer}`);
  }
  return domein;
}
