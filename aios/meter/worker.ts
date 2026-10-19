// De Cloudflare Worker om de kostenmeter (meter.ts). Het grootboek bereikt hij via Hyperdrive, dat de
// verbinding met Supabase openhoudt en het certificaat toetst tegen de CA van Supabase (verify-full);
// een Worker zelf vertrouwt die CA niet.
import postgres from "postgres";
import { meter } from "./meter.ts";

type Env = {
  DATAFORSEO_API_KEY: string;
  METER_SLEUTEL: string;
  CHAT_WEBHOOK: string;
  GROOTBOEK: { connectionString: string };
};

const DATAFORSEO = "https://api.dataforseo.com";
const SANDBOX = "https://sandbox.dataforseo.com";

export default {
  async fetch(
    req: Request,
    env: Env,
    ctx: { waitUntil(p: Promise<unknown>): void },
  ) {
    const sql = postgres(env.GROOTBOEK.connectionString, {
      max: 1,
      prepare: false,
      fetch_types: false,
    });
    return meter(req, {
      dataforseoUrl: DATAFORSEO,
      sandboxUrl: SANDBOX,
      dataforseoSleutel: env.DATAFORSEO_API_KEY,
      meterSleutel: env.METER_SLEUTEL,
      sql,
      naBoeking: (boeking) => ctx.waitUntil(boeking.finally(() => sql.end())),
      meld: async (tekst) => {
        const r = await fetch(env.CHAT_WEBHOOK, {
          method: "POST",
          headers: { "content-type": "application/json; charset=utf-8" },
          body: JSON.stringify({ text: tekst }),
        });
        if (!r.ok)
          console.error(`melding naar Google Chat mislukt: ${r.status}`);
      },
    });
  },
};
