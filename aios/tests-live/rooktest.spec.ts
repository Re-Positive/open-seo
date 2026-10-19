// Rooktest na een uitrol (seo-engine#12 en #20): de echte installatie van een klant, door de SEO-poort
// op os.resketch.nl heen, met de schil erop. Zo toetst hij wat een gebruiker ziet, niet alleen de build.
// `uitrol bijwerken` draait hem op Re:Positive; faalt hij, dan gaan de andere klanten niet mee.
//
// Los draaien: AIOS_EMAIL=rex@repositive.nl pnpm exec playwright test -c aios/playwright.live.config.ts rooktest
// De zoekactie kost hoogstens één betaalde DataForSEO-call per dag (de cache van open-seo houdt een
// resultaat 24 uur vast), op het zoekdatabudget van de klant van AIOS_EMAIL.
import { expect, test, type Page } from "@playwright/test";
import { aiOsSessie } from "../uitrol/aios.ts";

const ADRES = process.env.AIOS_ADRES ?? "https://os.resketch.nl";
const EMAIL = process.env.AIOS_EMAIL ?? "rex@repositive.nl";
// Een vaste zoekterm, zodat een tweede rooktest op dezelfde dag uit de cache komt.
const ZOEKTERM = "leadgeneratie";
const FOUTEN = [
  "Something went wrong",
  "Er ging iets mis",
  "The page you are looking for does not exist.",
  "De pagina die je zoekt bestaat niet.",
];

test.describe.configure({ mode: "serial" });

let sessie = "";
test.beforeAll(() => {
  sessie = aiOsSessie(EMAIL);
});

async function ingelogd(page: Page) {
  await page
    .context()
    .addCookies([
      {
        name: "beheer_sessie",
        value: sessie,
        url: ADRES,
        httpOnly: true,
        secure: true,
      },
    ]);
}

async function zonderFout(page: Page, pad: string) {
  // De schil vertaalt na het laden; even wachten tot hij klaar is.
  await page.waitForLoadState("networkidle");
  await page.waitForTimeout(500);
  const tekst = await page.locator("body").innerText();
  for (const fout of FOUTEN)
    expect(tekst, `${pad}: "${fout}"`).not.toContain(fout);
  expect(tekst, `${pad}: OpenSEO in de pagina`).not.toContain("OpenSEO");
  expect(await page.title(), `${pad}: OpenSEO in de titel`).not.toContain(
    "OpenSEO",
  );
}

test("elke pagina uit het SEO-menu laadt zonder fout en zonder OpenSEO", async ({
  page,
}) => {
  await ingelogd(page);
  const start = await page.goto(`${ADRES}/seo`);
  expect(start?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/seo\/p\/[^/]+/);
  await expect(page.locator("#aios-menu")).toBeVisible();
  const paden = await page
    .locator('#aios-menu a.aios-pagina[href^="/seo/"]')
    .evaluateAll((as) => [
      ...new Set(as.map((a) => a.getAttribute("href") ?? "")),
    ]);
  expect(paden.length, "pagina's in het SEO-menu").toBeGreaterThan(10);
  for (const pad of paden) {
    const antwoord = await page.goto(`${ADRES}${pad}`);
    expect(antwoord?.status(), pad).toBeLessThan(400);
    await zonderFout(page, pad);
  }
});

test("een zoekactie op een vaste zoekterm geeft resultaten", async ({
  page,
}) => {
  await ingelogd(page);
  await page.goto(`${ADRES}/seo`);
  await expect(page).toHaveURL(/\/seo\/p\/[^/]+/);
  const project = new URL(page.url()).pathname.split("/")[3];
  await page.goto(`${ADRES}/seo/p/${project}/keywords?q=${ZOEKTERM}`);
  // Een rij in de resultaten met de zoekterm (of een verwante term die hem bevat).
  await expect(
    page.locator("table tbody tr", { hasText: ZOEKTERM }).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  await zonderFout(page, "zoekactie");
});
