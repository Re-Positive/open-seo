// Ticket Re-Positive/seo-engine#14: `uitrol nieuwe klant 86c7h8f96` heeft voor Re:Positive een eigen
// installatie op Cloudflare neergezet. Draait tegen de echte installatie, niet tegen een build.
import { expect, test } from "@playwright/test";
import { cloudflare, installatieVan, d1Query } from "../uitrol/cloudflare.ts";

const KLANT = "86c7h8f96";

test("zonder servicetoken weigert Cloudflare Access de installatie", async ({
  request,
}) => {
  const { url } = await installatieVan(KLANT);
  const antwoord = await request.get(`${url}/seo/`, { maxRedirects: 0 });
  expect(antwoord.status()).toBe(403);
});

test("met servicetoken laadt /seo met project repositive.nl", async ({
  browser,
}) => {
  const { url, clientId, clientSecret } = await installatieVan(KLANT);
  const context = await browser.newContext({
    extraHTTPHeaders: {
      "CF-Access-Client-Id": clientId,
      "CF-Access-Client-Secret": clientSecret,
    },
  });
  const page = await context.newPage();
  const antwoord = await page.goto(`${url}/seo/`);
  expect(antwoord?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(/\/seo\/p\/[^/]+/);
  await expect(page.getByText("repositive.nl").first()).toBeVisible();
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await context.close();
});

test("project repositive.nl staat in de installatie met NL en nl", async () => {
  const { stage } = await installatieVan(KLANT);
  const rijen = await d1Query(
    stage,
    "select location_code, language_code from projects where domain = 'repositive.nl' and archived_at is null",
  );
  expect(rijen).toEqual([{ location_code: 2528, language_code: "nl" }]);
});

test("telemetrie staat uit", async () => {
  const { stage } = await installatieVan(KLANT);
  const instellingen = await cloudflare<{
    bindings: { name: string; text?: string }[];
  }>(`/workers/scripts/open-seo-${stage}/settings`);
  const optOut = instellingen.bindings.find(
    (b) => b.name === "OPENSEO_TELEMETRY_DISABLED",
  );
  expect(optOut?.text).toBe("1");
});
