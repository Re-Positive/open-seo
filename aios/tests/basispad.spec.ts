// Ticket Re-Positive/seo-engine#13: open-seo draait volledig onder het basispad /seo, zodat de
// AI OS het op os.resketch.nl/seo kan tonen naast zijn eigen pagina's.
import { expect, test, type Page } from "@playwright/test";

const BASIS = "/seo";
// Pictogrammen en manifest blijven op de root: daar levert de AI OS zijn eigen versies.
const ROOT_TOEGESTAAN = /^\/(favicon[^/]*|apple-touch-icon[^/]*|site\.webmanifest)$/;

function verzoekenBuitenBasis(page: Page) {
  const buiten: string[] = [];
  page.on("request", (req) => {
    const url = new URL(req.url());
    if (url.host !== "localhost:3102" && url.host !== "127.0.0.1:3102") return;
    if (ROOT_TOEGESTAAN.test(url.pathname)) return;
    if (!url.pathname.startsWith(`${BASIS}/`) && url.pathname !== BASIS) {
      buiten.push(`${req.method()} ${url.pathname}`);
    }
  });
  return buiten;
}

async function geenFoutscherm(page: Page) {
  await expect(page.getByText("Something went wrong")).toHaveCount(0);
  await expect(page.getByText("The page you are looking for does not exist.")).toHaveCount(0);
}

test("de app opent onder /seo en vraagt niets op buiten /seo", async ({ page }) => {
  const buiten = verzoekenBuitenBasis(page);
  const antwoord = await page.goto(`${BASIS}/`);
  expect(antwoord?.status()).toBeLessThan(400);
  await expect(page).toHaveURL(new RegExp(`${BASIS}/(p/[^/]+|projects|onboarding)`));
  await page.waitForLoadState("networkidle");
  await geenFoutscherm(page);
  expect(buiten).toEqual([]);
});

test("elke pagina uit het menu ligt onder /seo en laadt zonder fout", async ({ page }) => {
  const buiten = verzoekenBuitenBasis(page);
  await page.goto(`${BASIS}/`);
  await page.waitForLoadState("networkidle");
  const links = await page
    .locator('[data-slot="sidebar"] a[href]')
    .evaluateAll((as) => [...new Set(as.map((a) => a.getAttribute("href") ?? ""))]);
  const intern = links.filter((h) => h.startsWith("/"));
  expect(intern.length).toBeGreaterThan(5);
  for (const href of intern) {
    expect(href, `menulink ${href}`).toMatch(new RegExp(`^${BASIS}(/|$)`));
  }
  for (const href of intern) {
    const antwoord = await page.goto(href);
    expect(antwoord?.status(), href).toBeLessThan(400);
    await page.waitForLoadState("networkidle");
    await geenFoutscherm(page);
  }
  expect(buiten).toEqual([]);
});

test("klikken binnen de app blijft onder /seo", async ({ page }) => {
  const buiten = verzoekenBuitenBasis(page);
  await page.goto(`${BASIS}/`);
  await page.waitForLoadState("networkidle");
  // Zonder DataForSEO-sleutel opent een instelmelding over het menu; die sluiten we eerst.
  await page.keyboard.press("Escape");
  const eerste = page.locator('[data-slot="sidebar"] a[href*="/keywords"]').first();
  await eerste.click();
  await expect(page).toHaveURL(new RegExp(`${BASIS}/p/[^/]+/keywords`));
  await page.waitForLoadState("networkidle");
  await geenFoutscherm(page);
  expect(buiten).toEqual([]);
});
