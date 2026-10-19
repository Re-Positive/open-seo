// AI OS (Re:Positive): DATAFORSEO_API_URL and DATAFORSEO_SANDBOX_URL point every DataForSEO call at
// our cost meter, which books it per client and forwards it. Unset, the official hosts are used.
// Reads the env itself (process.env first, then the Workers env, like runtime-env.ts) so that tests
// which mock runtime-env without these names keep working.
async function envValue(name: string): Promise<string | undefined> {
  const fromProcess =
    typeof process !== "undefined" ? process.env?.[name] : undefined;
  if (fromProcess) return fromProcess;
  try {
    const { env } = await import("cloudflare:workers");
    const value: unknown = Reflect.get(env, name);
    return typeof value === "string" && value !== "" ? value : undefined;
  } catch {
    return undefined;
  }
}

export async function dataforseoBase(fallback: string, sandbox = false) {
  const url = await envValue(
    sandbox ? "DATAFORSEO_SANDBOX_URL" : "DATAFORSEO_API_URL",
  );
  return (url ?? fallback).replace(/\/+$/, "");
}
