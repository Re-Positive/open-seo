// AI OS (Re:Positive): the base path the app is served under inside the AI OS (e.g. "/seo"),
// or "" when served from the root. Set at build time from AIOS_BASISPAD (vite.config.ts).
export const AIOS_BASISPAD: string = import.meta.env.VITE_AIOS_BASISPAD ?? "";
