/**
 * @heluo/forge-brand — the Heluo Forge Enterprise brand token bundle.
 *
 * The plugin validates and normalizes the brand fields (CORP-DSH-DESIGN-006
 * §5), then provides the token set through `ctx.provide('forge-brand')`.
 * Consumption by the host brand/theme surface is pending real-host probing
 * (design §12): a missing seam degrades to a note, it never fails the mount.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BrandConfigError, normalizeBrandConfig } from './config.mjs';

export const name = 'forge-brand';
export const inject = [];

export const BRAND_SERVICE = 'forge-brand';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export {
  BRAND_BACKGROUNDS,
  BRAND_DEFAULTS,
  MIN_ACCENT_CONTRAST,
  PRODUCT_NAME_MAX,
  THEMES,
  BrandConfigError,
  contrastRatio,
  normalizeBrandConfig,
  normalizeLogoPath,
  passesAccentContrast,
  relativeLuminance,
} from './config.mjs';

/**
 * Read the packaged logo bytes. A missing or unreadable file is reported as a
 * note and yields `null`: the host keeps its upstream logo (design §8).
 */
function readLogoBytes(logoPath, notes) {
  if (logoPath === null) return null;
  const resolved = resolve(PACKAGE_ROOT, logoPath);
  if (!resolved.startsWith(PACKAGE_ROOT) || !existsSync(resolved)) {
    notes.push({ field: 'logoPath', code: 'LOGO_MISSING' });
    return null;
  }
  try {
    return readFileSync(resolved);
  } catch {
    notes.push({ field: 'logoPath', code: 'LOGO_MISSING' });
    return null;
  }
}

/**
 * Mount the brand bundle: normalize the config, load the local logo and
 * provide both under the `forge-brand` service.
 *
 * @param {object} ctx plugin context
 * @param {object} [rawConfig] patch-row config
 * @returns {{brand: object, logoBytes: Buffer|null, notes: Array<object>}}
 */
export function apply(ctx, rawConfig = {}) {
  if (rawConfig === null || typeof rawConfig !== 'object' || Array.isArray(rawConfig)) {
    throw new BrandConfigError('BRAND_CONFIG_INVALID', 'brand config must be an object when present');
  }
  const { brand, notes } = normalizeBrandConfig(rawConfig);
  const logoBytes = readLogoBytes(brand.logoPath, notes);
  if (typeof ctx?.provide === 'function') {
    ctx.provide(BRAND_SERVICE, { brand, logoBytes });
  } else {
    notes.push({ field: 'host', code: 'HOST_SEAM_UNAVAILABLE' });
  }
  return { brand, logoBytes, notes };
}
