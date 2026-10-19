# AI OS-fork van open-seo

Deze fork (Re-Positive/open-seo) is open-seo van every-app, met zo min mogelijk aanpassingen, zodat
het in de AI OS van Re:Positive draait als de module SEO. Waarom: ADR-0008 in Re-Positive/seo-engine.
Spec: Re-Positive/seo-engine#12.

## Branches

- `main` volgt upstream (`every-app/open-seo`) en krijgt van ons geen commits.
- `aios` is een release-tag van upstream plus onze commits. Elke commit die de code van open-seo
  raakt, begint met `schil:`. Wat in `aios/` staat, is van ons en raakt hun code niet.

## Aanpassingen in hun code

1. **Basispad** (`schil: basispad`, seo-engine#13). Met `AIOS_BASISPAD=/seo` bij de build draait de
   app onder `/seo`: router, assets (in `seo/assets`, omdat Workers static assets op bestandspad
   zoeken), serverfuncties, de sessie van Better Auth, en de terugkeer-URL's van de Google-koppelingen.
   Zonder `AIOS_BASISPAD` werkt alles zoals upstream. Pictogrammen en het manifest blijven op de root:
   die levert de AI OS zelf.
   - Niet onder het basispad (buiten scope, staat uit bij ons): de chatagent SAM (`/agents/...`), de
     MCP-server (`/mcp`) en de OAuth-toestemming voor MCP.
2. **Adres van DataForSEO instelbaar**: volgt in seo-engine#16.

## Bijwerken naar een nieuwe versie van open-seo

```bash
git fetch upstream --tags
git checkout aios
git merge <nieuwe-tag>        # conflicten zitten alleen in bestanden met een schil:-commit
pnpm exec tsc --noEmit && pnpm exec vitest run
pnpm exec playwright test -c aios/playwright.config.ts
```

## Tests

`aios/tests/` test onze aanpassingen op een productiebuild (`vite build` plus `vite preview`):

- `basispad.spec.ts`: de app opent onder `/seo`, elke pagina uit het menu laadt, klikken blijft onder
  `/seo`, en er gaat geen verzoek naar de root.

Draaien: `pnpm exec playwright test -c aios/playwright.config.ts` (bouwt eerst, duurt ongeveer een minuut).

## Licentie

MIT, Copyright (c) 2026 Ben Senescu (zie `LICENSE`). De naam OpenSEO, hun logo's en de beelden in
`web/public/` gebruiken we niet.
