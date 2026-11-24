/**
 * Brand token validation and normalization (CORP-DSH-DESIGN-006 §5–§8).
 *
 * Every field degrades to an upstream-compatible default instead of failing
 * the mount: a broken brand must never blank the product name or the logo.
 * External references are the one hard refusal — a logo the package cannot
 * serve locally is dropped, never fetched.
 *
 * The default tokens ARE the Heluo Forge Enterprise identity; they live in
 * the package, not in a patch layer, so public bundles stay neutral.
 */

/** The two surfaces an accent must remain visible on (brand palette). */
export const BRAND_BACKGROUNDS = Object.freeze(['#FFFFFF', '#070C16']);

/** WCAG 2.x non-text contrast floor for a UI accent colour. */
export const MIN_ACCENT_CONTRAST = 3;

export const THEMES = Object.freeze(['light', 'dark', 'system']);

export const PRODUCT_NAME_MAX = 32;

/** The shipped Heluo Forge Enterprise identity (accent passes both backgrounds). */
export const BRAND_DEFAULTS = Object.freeze({
  productName: '河洛 Forge 企业版',
  accent: '#2563eb',
  theme: 'system',
  footerText: '企业内部使用',
  supportLink: '',
  logoPath: './assets/wordmark-color.svg',
});

const HEX_COLOR = /^#(?:[0-9a-f]{3}|[0-9a-f]{6})$/iu;
const EXTERNAL_REFERENCE = /^(?:[a-z][a-z0-9+.-]*:|\/\/)/iu;

export class BrandConfigError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'BrandConfigError';
    this.code = code;
  }
}

function channel(value) {
  const scaled = value / 255;
  return scaled <= 0.03928 ? scaled / 12.92 : ((scaled + 0.055) / 1.055) ** 2.4;
}

/** WCAG 2.x relative luminance of a `#rgb`/`#rrggbb` colour. */
export function relativeLuminance(hex) {
  const digits = hex.slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  const value = Number.parseInt(full, 16);
  return 0.2126 * channel((value >> 16) & 0xff) + 0.7152 * channel((value >> 8) & 0xff) + 0.0722 * channel(value & 0xff);
}

/** WCAG 2.x contrast ratio between two hex colours, `1` for identical colours. */
export function contrastRatio(hexA, hexB) {
  const first = relativeLuminance(hexA);
  const second = relativeLuminance(hexB);
  const [lighter, darker] = first >= second ? [first, second] : [second, first];
  return (lighter + 0.05) / (darker + 0.05);
}

/** `true` when the accent keeps the non-text contrast floor on every brand surface. */
export function passesAccentContrast(hex) {
  return BRAND_BACKGROUNDS.every((background) => contrastRatio(hex, background) >= MIN_ACCENT_CONTRAST);
}

function normalizeHexColor(value) {
  if (typeof value !== 'string' || !HEX_COLOR.test(value.trim())) return null;
  const digits = value.trim().slice(1);
  const full = digits.length === 3 ? [...digits].map((d) => d + d).join('') : digits;
  return `#${full.toLowerCase()}`;
}

function normalizeProductName(value, notes) {
  if (value === undefined || value === null) return BRAND_DEFAULTS.productName;
  if (typeof value !== 'string' || value.trim() === '') {
    notes.push({ field: 'productName', code: 'PRODUCT_NAME_DEFAULTED' });
    return BRAND_DEFAULTS.productName;
  }
  const trimmed = value.trim();
  if (trimmed.length > PRODUCT_NAME_MAX) {
    notes.push({ field: 'productName', code: 'PRODUCT_NAME_TRUNCATED', from: trimmed.length, to: PRODUCT_NAME_MAX });
    return [...[...trimmed].slice(0, PRODUCT_NAME_MAX - 1), '…'].join('');
  }
  return trimmed;
}

function normalizeAccent(value, notes) {
  if (value === undefined || value === null) return BRAND_DEFAULTS.accent;
  const accent = normalizeHexColor(value);
  if (accent === null) {
    notes.push({ field: 'accent', code: 'ACCENT_DEFAULTED' });
    return BRAND_DEFAULTS.accent;
  }
  if (!passesAccentContrast(accent)) {
    notes.push({ field: 'accent', code: 'ACCENT_CONTRAST_FALLBACK', value: accent });
    return BRAND_DEFAULTS.accent;
  }
  return accent;
}

function normalizeTheme(value, notes) {
  if (value === undefined || value === null) return BRAND_DEFAULTS.theme;
  if (typeof value !== 'string' || !THEMES.includes(value)) {
    notes.push({ field: 'theme', code: 'THEME_DEFAULTED' });
    return BRAND_DEFAULTS.theme;
  }
  return value;
}

function normalizeFooterText(value, notes) {
  if (value === undefined || value === null) return BRAND_DEFAULTS.footerText;
  if (typeof value !== 'string') {
    notes.push({ field: 'footerText', code: 'FOOTER_DEFAULTED' });
    return BRAND_DEFAULTS.footerText;
  }
  return value.trim();
}

function normalizeSupportLink(value, notes) {
  if (value === undefined || value === null || value === '') return '';  if (typeof value !== 'string') {
    notes.push({ field: 'supportLink', code: 'SUPPORT_LINK_DROPPED' });
    return '';
  }
  try {
    const url = new URL(value.trim());
    if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('scheme');
    return url.toString();
  } catch {
    notes.push({ field: 'supportLink', code: 'SUPPORT_LINK_DROPPED' });
    return '';
  }
}

/**
 * Validate and normalize the six `brand` fields into a render-ready token set.
 *
 * @param {object} raw layer config as received from the patch row
 * @returns {{brand: object, notes: Array<object>}} the normalized tokens plus
 *   one note per fallback that fired; never throws for a bad value
 */
export function normalizeBrandConfig(raw = {}) {
  const notes = [];
  return {
    brand: {
      productName: normalizeProductName(raw?.productName, notes),
      accent: normalizeAccent(raw?.accent, notes),
      theme: normalizeTheme(raw?.theme, notes),
      footerText: normalizeFooterText(raw?.footerText, notes),
      supportLink: normalizeSupportLink(raw?.supportLink, notes),
      logoPath: normalizeLogoPath(raw?.logoPath, notes),
    },
    notes,
  };
}

/**
 * A logo reference must be a package-relative path; anything with a scheme, a
 * protocol-relative `//` or an escaping `..` is refused (design §8). An absent
 * field keeps the packaged wordmark; a refused or unreadable one falls back to
 * the upstream logo.
 */
export function normalizeLogoPath(value, notes) {
  if (value === undefined || value === null) return BRAND_DEFAULTS.logoPath;
  if (typeof value !== 'string' || value === '') {
    notes.push({ field: 'logoPath', code: 'LOGO_DEFAULTED' });
    return null;
  }
  if (EXTERNAL_REFERENCE.test(value.trim())) {
    notes.push({ field: 'logoPath', code: 'LOGO_EXTERNAL_REFUSED' });
    return null;
  }
  const trimmed = value.trim();
  if (trimmed.split('/').includes('..')) {
    notes.push({ field: 'logoPath', code: 'LOGO_PATH_ESCAPES_PACKAGE' });
    return null;
  }
  return trimmed;
}
