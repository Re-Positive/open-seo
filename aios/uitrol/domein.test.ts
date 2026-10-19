// Het domein van een site, zoals `uitrol nieuwe site` het bewaart (seo-engine#18).
// Draaien: node --test --experimental-strip-types aios/uitrol/domein.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { domeinVan } from "./cloudflare.ts";

test("een domein komt schoon terug, met of zonder schema, www of pad", () => {
  for (const invoer of [
    "fint.nl",
    "FINT.nl",
    "https://www.fint.nl/",
    "www.fint.nl/winkel?x=1",
    " fint.nl ",
  ]) {
    assert.equal(domeinVan(invoer), "fint.nl", invoer);
  }
  assert.equal(domeinVan("shop.lumenix.com"), "shop.lumenix.com");
});

test("iets wat geen domein is, wordt geweigerd", () => {
  for (const invoer of [
    "",
    "localhost",
    "fint",
    "fint.nl'; drop table x",
    "http://",
  ]) {
    assert.throws(() => domeinVan(invoer), /Geen geldig domein/, invoer);
  }
});
