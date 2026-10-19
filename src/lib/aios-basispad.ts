// AI OS (Re:Positive): the base path the app is served under inside the AI OS (e.g. "/seo"),
// or "" when served from the root. Set at build time from AIOS_BASISPAD (vite.config.ts).
export const AIOS_BASISPAD: string = import.meta.env.VITE_AIOS_BASISPAD ?? "";

// AI OS (Re:Positive): the public origin the AI OS serves the app from (e.g. "https://os.resketch.nl"),
// or "" when the app is reached directly. The installation itself runs on https workers.dev behind a
// gateway, so the request URL never shows the public address. Set at build time from AIOS_ORIGIN.
export const AIOS_ORIGIN: string = import.meta.env.VITE_AIOS_ORIGIN ?? "";
