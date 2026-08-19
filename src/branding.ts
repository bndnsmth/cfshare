export interface SiteBranding {
  name: string;
  summary: string;
  logoUrl?: string;
  background: string;
  foreground: string;
  accent: string;
}

export const CFSHARE_PROJECT_URL = "https://github.com/bndnsmth/cfshare";

export const DEFAULT_SITE_BRANDING: SiteBranding = {
  name: "cfshare",
  summary: "",
  background: "#11120f",
  foreground: "#eeeadd",
  accent: "#d9ff43",
};

const HEX_COLOR = /^#[0-9a-f]{6}$/i;

function normalizeText(value: unknown, maximumLength: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }

  const normalized = value.trim().replace(/\s+/g, " ");

  return normalized.length > 0 && normalized.length <= maximumLength ? normalized : undefined;
}

function normalizeLogoUrl(value: unknown): string | undefined {
  const candidate = normalizeText(value, 2048);

  if (!candidate) {
    return undefined;
  }

  try {
    const url = new URL(candidate);

    return url.protocol === "https:" && !url.username && !url.password ? url.href : undefined;
  } catch {
    return undefined;
  }
}

function normalizeColor(value: unknown, fallback: string): string {
  return typeof value === "string" && HEX_COLOR.test(value) ? value.toLowerCase() : fallback;
}

export function normalizeSiteBranding(
  input: Partial<Record<keyof SiteBranding, unknown>> = {},
): SiteBranding {
  const branding: SiteBranding = {
    name: normalizeText(input.name, 80) ?? DEFAULT_SITE_BRANDING.name,
    summary: normalizeText(input.summary, 240) ?? DEFAULT_SITE_BRANDING.summary,
    background: normalizeColor(input.background, DEFAULT_SITE_BRANDING.background),
    foreground: normalizeColor(input.foreground, DEFAULT_SITE_BRANDING.foreground),
    accent: normalizeColor(input.accent, DEFAULT_SITE_BRANDING.accent),
  };
  const logoUrl = normalizeLogoUrl(input.logoUrl);

  return logoUrl ? { ...branding, logoUrl } : branding;
}

export function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (character) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!,
  );
}

export function createContentSecurityPolicy(branding: SiteBranding): string {
  const logoOrigin = branding.logoUrl ? ` ${new URL(branding.logoUrl).origin}` : "";

  return `default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; connect-src 'self'; img-src 'self' data:${logoOrigin}; object-src 'none'; base-uri 'none'; frame-ancestors 'none'`;
}
