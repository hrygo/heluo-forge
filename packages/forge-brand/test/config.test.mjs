/**
 * Brand token validation tests (CORP-DSH-DESIGN-006 §5–§10).
 *
 * Four families required by the packaging plan: config validation, accent
 * contrast fallback, missing-field fallback and external-reference refusal —
 * plus the mount seam. Every fallback test pins both the surviving value and
 * the recorded note, so a silently dropped degradation fails the suite.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  BRAND_DEFAULTS,
  BRAND_SERVICE,
  MIN_ACCENT_CONTRAST,
  PRODUCT_NAME_MAX,
  apply,
  contrastRatio,
  normalizeBrandConfig,
  passesAccentContrast,
} from '../src/index.mjs';

const HERE = fileURLToPath(new URL('.', import.meta.url));

const codesOf = (result) => result.notes.map((note) => note.code);

test('默认令牌即「河洛 Forge 企业版」身份，且自身通过对比度门槛', () => {
  assert.equal(BRAND_DEFAULTS.productName, '河洛 Forge 企业版');
  assert.ok(passesAccentContrast(BRAND_DEFAULTS.accent));
  assert.ok(contrastRatio(BRAND_DEFAULTS.accent, '#FFFFFF') >= MIN_ACCENT_CONTRAST);
  assert.ok(contrastRatio(BRAND_DEFAULTS.accent, '#070C16') >= MIN_ACCENT_CONTRAST);
  const { brand, notes } = normalizeBrandConfig({});
  assert.deepEqual(brand, { ...BRAND_DEFAULTS });
  assert.deepEqual(notes, []);
});

test('配置校验：合法输入全字段通过且无回退记录', () => {
  const { brand, notes } = normalizeBrandConfig({
    productName: '河洛企业研发平台',
    accent: '#22AA33',
    theme: 'dark',
    footerText: '内部资料',
    supportLink: 'https://servicedesk.corp.example/',
    logoPath: './assets/wordmark-color.svg',
  });
  assert.equal(brand.productName, '河洛企业研发平台');
  assert.equal(brand.accent, '#22aa33');
  assert.equal(brand.theme, 'dark');
  assert.equal(brand.footerText, '内部资料');
  assert.equal(brand.supportLink, 'https://servicedesk.corp.example/');
  assert.equal(brand.logoPath, './assets/wordmark-color.svg');
  assert.deepEqual(notes, []);
});

test('对比度数学：同色为 1，黑白为 21；过浅或过深都不通过', () => {
  assert.equal(contrastRatio('#FFFFFF', '#FFFFFF'), 1);
  assert.equal(Math.round(contrastRatio('#000000', '#FFFFFF')), 21);
  assert.equal(passesAccentContrast('#999999'), false);
  assert.equal(passesAccentContrast('#1D4ED8'), false);
});

test('对比度回退：主色在任一品牌底色不足 3:1 即回退默认并记录', () => {
  // #1D4ED8 深底 2.92:1 —— 调色板中的 royalBlue 也不豁免
  const royalBlue = normalizeBrandConfig({ accent: '#1D4ED8' });
  assert.equal(royalBlue.brand.accent, BRAND_DEFAULTS.accent);
  assert.deepEqual(codesOf(royalBlue), ['ACCENT_CONTRAST_FALLBACK']);
  assert.equal(royalBlue.notes[0].value, '#1d4ed8');
  // #999999 白底 2.24:1
  const washed = normalizeBrandConfig({ accent: '#999999' });
  assert.equal(washed.brand.accent, BRAND_DEFAULTS.accent);
  assert.deepEqual(codesOf(washed), ['ACCENT_CONTRAST_FALLBACK']);
});

test('对比度回退反向：3 位缩写与大小写归一后仍按同一门槛判定', () => {
  const shorthand = normalizeBrandConfig({ accent: '#25E' });
  assert.equal(shorthand.brand.accent, '#2255ee');
  const upper = normalizeBrandConfig({ accent: '#2563EB ' });
  assert.equal(upper.brand.accent, BRAND_DEFAULTS.accent);
  assert.deepEqual(codesOf(upper), []);
});

test('缺失回退：非法字段回退品牌默认并记录，缺省输入即完整品牌身份', () => {
  const broken = normalizeBrandConfig({ theme: 'sepia', productName: 42, accent: 'blue', footerText: 7 });
  assert.equal(broken.brand.theme, 'system');
  assert.equal(broken.brand.productName, BRAND_DEFAULTS.productName);
  assert.equal(broken.brand.accent, BRAND_DEFAULTS.accent);
  assert.equal(broken.brand.footerText, BRAND_DEFAULTS.footerText);
  for (const code of ['THEME_DEFAULTED', 'PRODUCT_NAME_DEFAULTED', 'ACCENT_DEFAULTED', 'FOOTER_DEFAULTED']) {
    assert.ok(broken.notes.some((note) => note.code === code), code);
  }
  const absent = normalizeBrandConfig({});
  assert.deepEqual(absent.brand, { ...BRAND_DEFAULTS });
});

test('超长截断：产品名超过 32 字符按字符截断加省略号', () => {
  const long = '河洛'.repeat(24);
  const { brand, notes } = normalizeBrandConfig({ productName: long });
  assert.equal([...brand.productName].length, PRODUCT_NAME_MAX);
  assert.ok(brand.productName.endsWith('…'));
  assert.ok(notes.some((note) => note.code === 'PRODUCT_NAME_TRUNCATED' && note.from === long.length));
});

test('外链拒绝：带协议、协议相对与 data: 的 Logo 引用一律回退上游默认', () => {
  for (const bad of [
    'https://cdn.example.com/logo.svg',
    'http://intra.corp.example/logo.svg',
    '//cdn.example.com/logo.svg',
    'data:image/svg+xml,<svg/>',
    'file:///etc/hostname',
  ]) {
    const { brand, notes } = normalizeBrandConfig({ logoPath: bad });
    assert.equal(brand.logoPath, null, bad);
    assert.ok(notes.some((note) => note.code === 'LOGO_EXTERNAL_REFUSED'), bad);
  }
});

test('路径逃逸拒绝：包含 .. 的 Logo 路径回退上游默认', () => {
  const { brand, notes } = normalizeBrandConfig({ logoPath: './../../etc/passwd' });
  assert.equal(brand.logoPath, null);
  assert.ok(notes.some((note) => note.code === 'LOGO_PATH_ESCAPES_PACKAGE'));
});

test('支持链接：非 URL 与非 http(s) 方案被丢弃并记录', () => {
  for (const bad of ['not a url', 'javascript:alert(1)', 'ftp://files.corp.example/']) {
    const { brand, notes } = normalizeBrandConfig({ supportLink: bad });
    assert.equal(brand.supportLink, '', bad);
    assert.ok(notes.some((note) => note.code === 'SUPPORT_LINK_DROPPED'), bad);
  }
});

test('装载：结构垃圾拒绝，正常输入经 ctx.provide 暴露品牌与 Logo 字节', () => {
  const provided = [];
  const ctx = { provide: (name, payload) => provided.push({ name, payload }) };
  assert.throws(() => apply(ctx, 'nope'), (error) => error.code === 'BRAND_CONFIG_INVALID');
  assert.throws(() => apply(ctx, ['array']), (error) => error.code === 'BRAND_CONFIG_INVALID');

  const mounted = apply(ctx, {});
  assert.equal(provided.length, 1);
  assert.equal(provided[0].name, BRAND_SERVICE);
  assert.equal(provided[0].payload.brand.productName, '河洛 Forge 企业版');
  const packaged = readFileSync(join(HERE, '..', 'assets', 'wordmark-color.svg'));
  assert.ok(provided[0].payload.logoBytes.equals(packaged));
  assert.equal(mounted.logoBytes.equals(packaged), true);
});

test('装载降级：Logo 文件缺失按缺失处理，无宿主接缝记录 HOST_SEAM_UNAVAILABLE', () => {
  const missing = apply({}, { logoPath: './assets/does-not-exist.svg' });
  assert.equal(missing.logoBytes, null);
  assert.ok(missing.notes.some((note) => note.code === 'LOGO_MISSING'));
  const noSeam = apply({}, {});
  assert.equal(noSeam.brand.productName, BRAND_DEFAULTS.productName);
  assert.ok(noSeam.notes.some((note) => note.code === 'HOST_SEAM_UNAVAILABLE'));
});
