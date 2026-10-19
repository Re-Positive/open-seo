// De naad van de uitrol naar de AI OS (os.resketch.nl, Resketch-ai/ai-os-beheer): de schema's platform en
// seo in het Supabase-project AI OS (migraties in Re-Positive/seo-engine, db/), en een sessie voor de
// rooktest. De klanten van de portal (public.tenants) staan nog in de portal-Supabase. De database-URL's en
// de sessiesleutel staan in Doppler resketch-ai, en het Doppler-token is per map gescoped: daarom draait
// alles vanuit die map.
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const AI_OS = fileURLToPath(
  new URL(
    "../../../../../02-resketch/OtherWorlds/ai-os-beheer",
    import.meta.url,
  ),
);
const PSQL = "/opt/homebrew/opt/libpq/bin/psql";
/** Waar de AI OS de installaties toont (de SEO-poort); ook het adres van de Google-redirects. */
export const AI_OS_ORIGIN = "https://os.resketch.nl";

const DATABASE = {
  // Het project AI OS, eigenaarsrol, al in pooler-vorm.
  aiOs: '"$AI_OS_PLATFORM_DB_URL"',
  // De portal-Supabase, alleen nog voor public.tenants.
  portal: '"$(scripts/db-url.py "$CLIENT_PORTAL_DB_URL")"',
};

// SQL naar de AI OS (of, met `portal`, naar de portal-Supabase). De waarden gaan als psql-variabelen mee
// (`:'naam'`), nooit in de tekst van de SQL. Geeft de regels van `returning` terug.
export function aiOsSql(
  sql: string,
  waarden: Record<string, string>,
  database: keyof typeof DATABASE = "aiOs",
) {
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
      `exec ${PSQL} ${DATABASE[database]} -X -q -At -v ON_ERROR_STOP=1 ${vars
        .map((v) => (v === "-v" ? v : `"${v}"`))
        .join(" ")}`,
      "aios-sql",
      ...Object.values(waarden),
    ],
    { cwd: AI_OS, input: sql, encoding: "utf8" },
  );
  if (uitkomst.status !== 0) {
    throw new Error(
      `${database === "aiOs" ? "AI OS" : "portal"}: ${uitkomst.stderr.trim() || `exit ${uitkomst.status}`}`,
    );
  }
  return uitkomst.stdout.trim().split("\n").filter(Boolean);
}

/** Een sessiecookie van de AI OS voor `email`, om de rooktest door de SEO-poort te laten lopen. */
export function aiOsSessie(email: string): string {
  const uitkomst = spawnSync(
    "doppler",
    [
      "run",
      "-p",
      "resketch-ai",
      "-c",
      "prd",
      "--",
      "node",
      "--experimental-strip-types",
      "--no-warnings",
      "--input-type=module",
      "-e",
      'const { maakSessie } = await import("./lib/sessie.ts"); process.stdout.write(await maakSessie(process.argv[1]) ?? "");',
      email,
    ],
    { cwd: AI_OS, encoding: "utf8" },
  );
  const sessie = uitkomst.stdout.trim();
  if (uitkomst.status !== 0 || sessie.split(".").length !== 3) {
    throw new Error(
      `Geen sessie van de AI OS voor ${email}: ${uitkomst.stderr.trim()}`,
    );
  }
  return sessie;
}
