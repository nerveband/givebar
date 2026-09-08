/**
 * Presentation settings contract: allowlists, strict validation, and derived values.
 *
 * Every value here is applied client-side as a local CSS token. No webfont or
 * remote stylesheet URL is ever accepted: font_family is a key from a fixed
 * allowlist that maps to a system-safe stack in the client stylesheets.
 */

export const FONT_FAMILY_KEYS = ["system", "brandon", "humanist", "grotesk", "mono", "serif"] as const;
export type FontFamilyKey = (typeof FONT_FAMILY_KEYS)[number];

export const CHART_ORIENTATIONS = ["horizontal", "vertical"] as const;
export type ChartOrientation = (typeof CHART_ORIENTATIONS)[number];

const HEX_COLOR = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const OKLCH_COLOR = /^oklch\(\s*\d*\.?\d+%?\s+\d*\.?\d+%?\s+\d*\.?\d+(?:deg)?\s*(?:\/\s*\d*\.?\d+%?\s*)?\)$/;

export function isFontFamilyKey(value: string): value is FontFamilyKey {
  return (FONT_FAMILY_KEYS as readonly string[]).includes(value);
}

export function isChartOrientation(value: string): value is ChartOrientation {
  return (CHART_ORIENTATIONS as readonly string[]).includes(value);
}

/** Empty string means "inherit the theme"; otherwise strict hex or oklch only. */
export function isValidColor(value: string): boolean {
  if (value === "") return true;
  return HEX_COLOR.test(value) || OKLCH_COLOR.test(value);
}

/** QR targets must be empty or absolute http(s). Blocks javascript:/data: payloads. */
export function isValidQrUrl(value: string): boolean {
  if (value === "") return true;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Human-readable URL printed under the QR. When the operator leaves it blank we
 * derive it from the encoded QR target by stripping the query string, fragment,
 * and trailing slash so UTM parameters never reach the ballroom screen.
 */
export function deriveDisplayUrl(qrUrl: string, displayUrl: string): string {
  const explicit = (displayUrl || "").trim();
  if (explicit !== "") return explicit;

  const raw = (qrUrl || "").trim();
  if (raw === "") return "";

  const withoutFragment = raw.split("#")[0];
  const withoutQuery = withoutFragment.split("?")[0];
  return withoutQuery.replace(/\/+$/, "");
}
