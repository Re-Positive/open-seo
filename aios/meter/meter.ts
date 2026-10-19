// De kostenmeter van de module SEO (Re-Positive/seo-engine#16, spec #12). Elke installatie van open-seo
// stuurt zijn DataForSEO-calls hierheen (DATAFORSEO_API_URL, schil-commit in de fork) met een
// klanttoken als sleutel. De meter herkent de klant, stuurt de call met onze echte sleutel door, en
// boekt wat DataForSEO rekende in platform.usage_events (module seo) van het project AI OS. Onze sleutel staat alleen hier.
//
// Het klanttoken is base64("<client_id>:<hmac>"), met de HMAC-SHA256 over de client_id onder
// METER_SLEUTEL. Zo hoeft de meter geen tokenlijst op te zoeken, en heeft een token dezelfde vorm als
// een DataForSEO-sleutel (login:password), die open-seo verwacht.
import type { Sql } from "postgres";

export type MeterOmgeving = {
  dataforseoUrl: string;
  sandboxUrl: string;
  dataforseoSleutel: string;
  meterSleutel: string;
  sql: Sql;
  // Boeken gebeurt na het antwoord (ctx.waitUntil in de Worker), zodat grote antwoorden doorstromen.
  naBoeking(boeking: Promise<unknown>): void;
  // Een melding naar Google Chat (budgetdrempels, seo-engine#17).
  meld(tekst: string): Promise<void>;
};

type Taak = { id?: unknown; cost?: unknown };

const tekst = new TextEncoder();

function hex(buf: ArrayBuffer) {
  return [...new Uint8Array(buf)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function sleutel(geheim: string) {
  return crypto.subtle.importKey(
    "raw",
    tekst.encode(geheim),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

export async function klanttoken(
  meterSleutel: string,
  clientId: string,
): Promise<string> {
  const hmac = hex(
    await crypto.subtle.sign(
      "HMAC",
      await sleutel(meterSleutel),
      tekst.encode(clientId),
    ),
  );
  return Buffer.from(`${clientId}:${hmac}`).toString("base64");
}

// De client_id bij een geldig token, anders null. Vergelijken gebeurt via verify (vaste tijd).
async function klantVan(
  authorization: string | null,
  meterSleutel: string,
): Promise<string | null> {
  const basic = authorization?.match(/^Basic\s+([A-Za-z0-9+/=]+)$/);
  if (!basic) return null;
  const [clientId, hmac, ...rest] = Buffer.from(basic[1], "base64")
    .toString("utf8")
    .split(":");
  if (
    rest.length ||
    !clientId ||
    !/^[A-Za-z0-9_]+$/.test(clientId) ||
    !/^[0-9a-f]{64}$/.test(hmac ?? "")
  )
    return null;
  const bytes = new Uint8Array(hmac.match(/../g)!.map((h) => parseInt(h, 16)));
  return (await crypto.subtle.verify(
    "HMAC",
    await sleutel(meterSleutel),
    bytes,
    tekst.encode(clientId),
  ))
    ? clientId
    : null;
}

// Zoals DataForSEO zelf een verkeerde sleutel weigert, zodat open-seo het als fout toont. Ook een vol
// budget antwoordt zo: alleen een 401 toont open-seo in elk onderdeel met dezelfde tekst, en die tekst
// vervangt de schil door de Nederlandse budgetmelding (seo-engine#17). De log zegt welke van de twee.
function geweigerd() {
  return Response.json(
    {
      status_code: 40100,
      status_message: "You are not authorized to access this resource.",
    },
    { status: 401 },
  );
}

// Gratis bij DataForSEO: naslag (saldo, locaties, talen) en het ophalen van al betaalde taken. Die
// gaan ook bij een vol budget door.
function gratis(pad: string) {
  return (
    pad.startsWith("/v3/appendix/") ||
    /\/(locations|languages|tasks_ready|id_list|errors)(\/|$)/.test(pad) ||
    pad.includes("/task_get/")
  );
}

type Stand = { budget: number | null; verbruikt: number };

async function stand(sql: Sql, clientId: string): Promise<Stand> {
  const [rij] = await sql<{ budget: string | null; verbruikt: string }[]>`
    select budget, verbruikt from seo.budget_stand(${clientId})`;
  return {
    budget: rij.budget === null ? null : Number(rij.budget),
    verbruikt: Number(rij.verbruikt),
  };
}

const euro = (n: number) => `$${n.toFixed(2).replace(".", ",")}`;

// Na een boeking: bij 80% en bij 100% een melding, elk een keer per maand.
async function meldDrempels(o: MeterOmgeving, clientId: string) {
  const s = await stand(o.sql, clientId);
  if (s.budget === null || s.budget <= 0) return;
  for (const drempel of [80, 100]) {
    if (s.verbruikt < (s.budget * drempel) / 100) continue;
    const [{ nieuw }] = await o.sql<
      { nieuw: boolean }[]
    >`select seo.meld_drempel(${clientId}, ${drempel}) as nieuw`;
    if (!nieuw) continue;
    await o.meld(
      drempel === 100
        ? `AI OS SEO: het zoekdatabudget van klant ${clientId} is op (${euro(s.verbruikt)} van ${euro(s.budget)} deze maand). Betaalde zoekacties staan stil tot de nieuwe maand of een hoger budget.`
        : `AI OS SEO: klant ${clientId} heeft ${drempel}% van het zoekdatabudget gebruikt (${euro(s.verbruikt)} van ${euro(s.budget)} deze maand).`,
    );
  }
}

async function boek(
  antwoord: Response,
  clientId: string,
  endpoint: string,
  sql: Sql,
) {
  let body: { cost?: unknown; tasks?: Taak[] };
  try {
    body = await antwoord.json();
  } catch {
    return;
  }
  const taken = Array.isArray(body.tasks) ? body.tasks : [];
  const regels = taken
    .filter((t) => typeof t.cost === "number" && t.cost > 0)
    .map((t) => ({
      client_id: clientId,
      module: "seo",
      endpoint,
      bedrag: t.cost as number,
      taak_id: typeof t.id === "string" ? t.id : null,
    }));
  if (!regels.length && typeof body.cost === "number" && body.cost > 0) {
    regels.push({
      client_id: clientId,
      module: "seo",
      endpoint,
      bedrag: body.cost,
      taak_id: null,
    });
  }
  if (regels.length) {
    await sql`insert into platform.usage_events ${sql(regels, "client_id", "module", "endpoint", "bedrag", "taak_id")}`;
  }
}

export async function meter(req: Request, o: MeterOmgeving): Promise<Response> {
  const clientId = await klantVan(
    req.headers.get("authorization"),
    o.meterSleutel,
  );
  if (!clientId) return geweigerd();

  const url = new URL(req.url);
  const sandbox = url.pathname.startsWith("/sandbox/");
  const pad = sandbox ? url.pathname.slice("/sandbox".length) : url.pathname;
  if (!pad.startsWith("/v3/"))
    return Response.json(
      { status_code: 40400, status_message: "Not Found." },
      { status: 404 },
    );

  // Het plafond: geen budget of een vol budget, dan gaat een betaalde call niet door. Calls die
  // tegelijk lopen, kunnen er samen nog iets overheen gaan; dat ziet het grootboek wel.
  if (!sandbox && !gratis(pad)) {
    const s = await stand(o.sql, clientId);
    if (s.budget === null || s.verbruikt >= s.budget) {
      console.warn(
        `budget: ${clientId} geweigerd op ${pad} (${s.verbruikt} van ${s.budget ?? "geen budget"})`,
      );
      return geweigerd();
    }
  }

  const heen = new Headers({ authorization: `Basic ${o.dataforseoSleutel}` });
  for (const naam of ["content-type", "accept"]) {
    const waarde = req.headers.get(naam);
    if (waarde) heen.set(naam, waarde);
  }
  const antwoord = await fetch(
    new URL(pad + url.search, sandbox ? o.sandboxUrl : o.dataforseoUrl),
    {
      method: req.method,
      headers: heen,
      body:
        req.method === "GET" || req.method === "HEAD"
          ? undefined
          : await req.arrayBuffer(),
    },
  );

  if (!sandbox && antwoord.ok) {
    o.naBoeking(
      boek(antwoord.clone(), clientId, pad, o.sql)
        .then(() => meldDrempels(o, clientId))
        .catch((fout) => {
          console.error(
            `grootboek: boeking voor ${clientId} op ${pad} mislukt:`,
            fout,
          );
        }),
    );
  }
  const terug = new Headers(antwoord.headers);
  terug.delete("content-encoding");
  terug.delete("content-length");
  return new Response(antwoord.body, {
    status: antwoord.status,
    headers: terug,
  });
}
