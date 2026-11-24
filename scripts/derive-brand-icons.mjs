/**
 * Brand platform-icon derivation (plan CORP-DSH-PLAN-026 §4.2 item 3).
 *
 * Derives the Windows `.ico` and macOS `.icns` from the committed Heluo brand
 * assets, plus the small app-icon PNG cuts the asset set is missing. Inputs
 * are fail-closed: every committed file used here must match the SHA-256 in
 * `manifest.json` (byte-identical discipline, plan §5) and every committed
 * PNG must be square at its advertised size. Missing sizes are rasterized
 * from `primary/app-icon.svg` with rsvg-convert when available, otherwise
 * downscaled with macOS `sips` (the locally verified fallback chain);
 * `--rasterizer none` forbids both and fails on any missing size.
 *
 * Packaging is pure Node (no dependencies): the ICO embeds PNG entries
 * (Vista+ format) and the ICNS uses the modern PNG-based chunk types.
 * Derived outputs are new artifacts — committed sources are never rewritten —
 * and every output is recorded in `derivation-manifest.json` for the release
 * digest lane.
 *
 * 用法：
 *   node scripts/derive-brand-icons.mjs [--brand-dir DIR] [--output DIR]
 *     [--rasterizer auto|rsvg-convert|sips|none] [--json] [--repo-root DIR]
 *
 * 退出码：0 成功；2 INVALID/SOURCE_MISMATCH/UNREGISTERED_ASSET/尺寸校验失败；
 * 4 MISSING_RASTERIZER（需要派生但栅格化工具不可用）。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

export const DERIVATION_SCHEMA = 'heluo-brand-icons/1';
export const TOOL_NAME = 'heluo-derive-brand-icons';

/** Sizes embedded in the .ico (Windows Vista+ PNG-in-ICO; 256 encodes as 0). */
export const ICO_SIZES = [16, 32, 48, 64, 128, 256];
/** Modern PNG-based ICNS chunk types and their pixel sizes. */
export const ICNS_ENTRIES = [
  { type: 'ic11', size: 32 },
  { type: 'ic12', size: 64 },
  { type: 'ic07', size: 128 },
  { type: 'ic08', size: 256 },
  { type: 'ic09', size: 512 },
  { type: 'ic10', size: 1024 },
];
export const ALL_PNG_SIZES = [...new Set([...ICO_SIZES, ...ICNS_ENTRIES.map((entry) => entry.size)])].sort(
  (a, b) => a - b,
);

const SOURCE_ASSET = 'primary/app-icon.svg';
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

export class IconError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export function sha256Hex(buffer) {
  return createHash('sha256').update(buffer).digest('hex');
}

/** Read PNG dimensions from the IHDR chunk; containers without an IHDR report null. */
export function pngSize(buffer, source = 'png') {
  if (!(buffer instanceof Buffer) || buffer.length < 24 || !buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
    // ICO/ICNS containers intentionally keep PNG payloads after headers, so
    // callers pass real PNGs; anything else is rejected unless it starts with
    // a container signature, which has no IHDR to report.
    if (buffer instanceof Buffer && isContainer(buffer)) return { width: null, height: null };
    throw new IconError('INVALID_PNG', `${source}: 不是合法的 PNG 文件`);
  }
  return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
}

function isContainer(buffer) {
  if (buffer.length < 4) return false;
  if (buffer.readUInt16LE(0) === 0 && buffer.readUInt16LE(2) === 1) return true; // ICO
  return buffer.subarray(0, 4).toString('ascii') === 'icns';
}

/** Build a Vista+ ICO whose entries embed PNG payloads. */
export function buildIco(entries) {
  const sorted = [...entries].sort((a, b) => a.size - b.size);
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0);
  header.writeUInt16LE(1, 2); // icon type
  header.writeUInt16LE(sorted.length, 4);
  const directory = Buffer.alloc(sorted.length * 16);
  let offset = header.length + directory.length;
  const blobs = [];
  sorted.forEach((entry, index) => {
    const { width, height } = pngSize(entry.png, `ico entry ${entry.size}`);
    if (width !== entry.size || height !== entry.size) {
      throw new IconError('SIZE_MISMATCH', `ico 条目 ${entry.size} 的 PNG 实际为 ${width}x${height}`);
    }
    const base = index * 16;
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base); // 0 encodes 256
    directory.writeUInt8(entry.size >= 256 ? 0 : entry.size, base + 1);
    directory.writeUInt8(0, base + 2); // palette colors
    directory.writeUInt8(0, base + 3);
    directory.writeUInt16LE(1, base + 4); // color planes
    directory.writeUInt16LE(32, base + 6); // bits per pixel
    directory.writeUInt32LE(entry.png.length, base + 8);
    directory.writeUInt32LE(offset, base + 12);
    blobs.push(entry.png);
    offset += entry.png.length;
  });
  return Buffer.concat([header, directory, ...blobs]);
}

/** Build a modern ICNS: 'icns' magic, total length, PNG chunks. */
export function buildIcns(entries) {
  const chunks = entries.map((entry) => {
    const { width, height } = pngSize(entry.png, `icns ${entry.type}`);
    const expected = ICNS_ENTRIES.find((candidate) => candidate.type === entry.type)?.size;
    if (expected == null) throw new IconError('INVALID_PNG', `未知 ICNS 类型 ${entry.type}`);
    if (width !== expected || height !== expected) {
      throw new IconError('SIZE_MISMATCH', `icns ${entry.type} 应为 ${expected}px，实际 ${width}x${height}`);
    }
    const chunk = Buffer.alloc(8);
    chunk.write(entry.type, 0, 'ascii');
    chunk.writeUInt32BE(entry.png.length + 8, 4);
    return Buffer.concat([chunk, entry.png]);
  });
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0) + 8;
  const header = Buffer.alloc(8);
  header.write('icns', 0, 'ascii');
  header.writeUInt32BE(total, 4);
  return Buffer.concat([header, ...chunks]);
}

/** Load manifest.json and index its entries by path. */
export function readManifest(brandDir) {
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(join(brandDir, 'manifest.json'), 'utf8'));
  } catch (error) {
    throw new IconError('INVALID', `manifest.json 不可读：${error.message}`);
  }
  if (!Array.isArray(manifest.assets)) throw new IconError('INVALID', 'manifest.json 缺少 assets 数组');
  const byPath = new Map(manifest.assets.map((asset) => [asset.path, asset]));
  return { manifest, byPath };
}

/** Fail-closed committed-asset verification against the manifest. */
export function verifyAsset(brandDir, byPath, relPath) {
  const entry = byPath.get(relPath);
  if (!entry?.sha256 || !entry.bytes) {
    throw new IconError('UNREGISTERED_ASSET', `${relPath} 未登记于 manifest.json，拒绝使用`);
  }
  const assetPath = join(brandDir, relPath);
  const bytes = readFileSync(assetPath);
  if (bytes.length !== entry.bytes) {
    throw new IconError('SOURCE_MISMATCH', `${relPath} 字节数 ${bytes.length} 与 manifest ${entry.bytes} 不符`);
  }
  const digest = sha256Hex(bytes);
  if (digest !== entry.sha256) {
    throw new IconError('SOURCE_MISMATCH', `${relPath} SHA-256 ${digest} 与 manifest 不符`);
  }
  return { bytes, entry };
}

function toolAvailable(name) {
  try {
    execFileSync(name, name === 'sips' ? ['--version'] : ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    try {
      execFileSync(name, ['--help'], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
}

/** Rasterize one missing size; falls back from rsvg-convert (SVG) to sips (downscale). */
function rasterize({ rasterizer, brandDir, svgBytes, sourcePngPath, size, workDir }) {
  if (rasterizer === 'none') {
    throw new IconError(
      'MISSING_RASTERIZER',
      `缺少 ${size}px 切图且 --rasterizer none：补齐 sizes/app-icon-${size}.png 或提供 rsvg-convert / sips`,
    );
  }
  const outPath = join(workDir, `app-icon-${size}.png`);
  if ((rasterizer === 'auto' || rasterizer === 'rsvg-convert') && toolAvailable('rsvg-convert')) {
    const svgPath = join(workDir, 'app-icon.svg');
    writeFileSync(svgPath, svgBytes);
    execFileSync('rsvg-convert', ['-w', String(size), '-h', String(size), '-o', outPath, svgPath]);
    return { png: readFileSync(outPath), generator: 'rsvg-convert' };
  }
  if ((rasterizer === 'auto' || rasterizer === 'sips') && toolAvailable('sips') && sourcePngPath) {
    execFileSync('sips', ['-z', String(size), String(size), sourcePngPath, '--out', outPath], { stdio: 'ignore' });
    return { png: readFileSync(outPath), generator: 'sips' };
  }
  throw new IconError(
    'MISSING_RASTERIZER',
    `无法派生 ${size}px：rsvg-convert 不可用${sourcePngPath ? '' : '（且无可缩放的已提交大图）'}、sips 不可用`,
  );
}

function usage() {
  return [
    '用法: node scripts/derive-brand-icons.mjs [选项]',
    '  --brand-dir <dir>   品牌资产目录（默认 docs/assets/branding/cyber-long）',
    '  --output <dir>      输出目录（默认 dist/brand-icons）',
    '  --rasterizer <mode> auto | rsvg-convert | sips | none（默认 auto）',
    '  --json              把 derivation-manifest.json 打到 stdout',
    '  --repo-root <dir>   仓库根（默认脚本上级目录）',
  ].join('\n');
}

function parseArgs(argv) {
  const options = { brandDir: null, output: null, rasterizer: 'auto', json: false, repoRoot: null };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = () => {
      if (index + 1 >= argv.length) throw new IconError('INVALID', `选项 ${arg} 缺少取值`);
      index += 1;
      return argv[index];
    };
    switch (arg) {
      case '--brand-dir': options.brandDir = next(); break;
      case '--output': options.output = next(); break;
      case '--rasterizer': {
        const value = next();
        if (!['auto', 'rsvg-convert', 'sips', 'none'].includes(value)) {
          throw new IconError('INVALID', `--rasterizer 不支持 ${value}`);
        }
        options.rasterizer = value;
        break;
      }
      case '--json': options.json = true; break;
      case '--repo-root': options.repoRoot = next(); break;
      case '--help': case '-h': options.help = true; break;
      default: throw new IconError('INVALID', `未知参数 ${arg}`);
    }
  }
  return options;
}

export function main(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    process.stderr.write(`${usage()}\n${error.message}\n`);
    return 2;
  }
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return 0;
  }
  const repoRoot = resolve(options.repoRoot ?? dirnameOfScript());
  const brandDir = isAbsolute(options.brandDir ?? '')
    ? options.brandDir
    : resolve(repoRoot, options.brandDir ?? 'docs/assets/branding/cyber-long');
  if (!existsSync(brandDir) || !statSync(brandDir).isDirectory()) {
    process.stderr.write(`品牌目录不存在：${brandDir}\n`);
    return 2;
  }
  const outputDir = isAbsolute(options.output ?? '') ? options.output : resolve(repoRoot, options.output ?? 'dist/brand-icons');

  try {
    const derivation = deriveAll({ brandDir, outputDir, rasterizer: options.rasterizer });
    // With --json, stdout carries the record alone, for whatever reads it next.
    const done = `[heluo] 品牌图标派生完成：${outputDir}（ico ${ICO_SIZES.length} 条 / icns ${ICNS_ENTRIES.length} 块 / png ${ALL_PNG_SIZES.length} 张）\n`;
    if (options.json) {
      process.stdout.write(`${JSON.stringify(derivation, null, 2)}\n`);
      process.stderr.write(done);
    } else {
      process.stdout.write(done);
    }
    return 0;
  } catch (error) {
    if (error instanceof IconError) {
      process.stderr.write(`[heluo] ${error.code}: ${error.message}\n`);
      return error.code === 'MISSING_RASTERIZER' ? 4 : 2;
    }
    throw error;
  }
}

function dirnameOfScript() {
  return dirname(dirname(fileURLToPath(import.meta.url)));
}

export function deriveAll({ brandDir, outputDir, rasterizer = 'auto', now = () => new Date() }) {
  const { manifest, byPath } = readManifest(brandDir);
  const source = verifyAsset(brandDir, byPath, SOURCE_ASSET);

  // Committed PNG cuts are canonical where present; missing ones are derived.
  const pngs = new Map();
  const generators = new Map();
  for (const size of ALL_PNG_SIZES) {
    const relPath = `sizes/app-icon-${size}.png`;
    if (byPath.has(relPath) && existsSync(join(brandDir, relPath))) {
      const { bytes } = verifyAsset(brandDir, byPath, relPath);
      const { width, height } = pngSize(bytes, relPath);
      if (width !== size || height !== size) {
        throw new IconError('SIZE_MISMATCH', `${relPath} 声明 ${size}px，实际 ${width}x${height}`);
      }
      pngs.set(size, bytes);
      generators.set(size, 'committed');
    }
  }
  const missing = ALL_PNG_SIZES.filter((size) => !pngs.has(size));
  let generator = null;
  if (missing.length > 0) {
    // sips fallback downscales from the largest verified committed cut.
    const sourceSize = [...pngs.keys()].sort((a, b) => b - a)[0];
    const sourcePngPath = sourceSize ? join(brandDir, `sizes/app-icon-${sourceSize}.png`) : null;
    // Scratch files go to the system temp dir so they never leak into the
    // release artifact directory.
    const workDir = mkdtempSync(join(tmpdir(), 'heluo-icons-'));
    try {
      for (const size of missing) {
        const { png, generator: used } = rasterize({ rasterizer, svgBytes: source.bytes, sourcePngPath, size, workDir });
        const { width, height } = pngSize(png, `derived ${size}`);
        if (width !== size || height !== size) {
          throw new IconError('SIZE_MISMATCH', `派生 ${size}px 实际为 ${width}x${height}`);
        }
        pngs.set(size, png);
        generators.set(size, `derived:${used}`);
        generator = used;
      }
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  }

  mkdirSync(join(outputDir, 'sizes'), { recursive: true });
  const outputs = [];
  const record = (relPath, buffer, origin) => {
    writeFileSync(join(outputDir, relPath), buffer);
    const dimensions = pngSize(buffer, relPath);
    outputs.push({
      path: relPath,
      bytes: buffer.length,
      sha256: sha256Hex(buffer),
      width: dimensions?.width ?? null,
      height: dimensions?.height ?? null,
      origin,
    });
  };
  for (const size of ALL_PNG_SIZES) record(`sizes/app-icon-${size}.png`, pngs.get(size), generators.get(size));
  record('app-icon.ico', buildIco(ICO_SIZES.map((size) => ({ size, png: pngs.get(size) }))), 'built');
  record('app-icon.icns', buildIcns(ICNS_ENTRIES.map(({ type, size }) => ({ type, png: pngs.get(size) }))), 'built');

  const derivation = {
    schema: DERIVATION_SCHEMA,
    tool: TOOL_NAME,
    generatedAt: now().toISOString(),
    source: {
      manifest: 'manifest.json',
      manifestVersion: manifest.version ?? null,
      asset: SOURCE_ASSET,
      bytes: source.entry.bytes,
      sha256: source.entry.sha256,
    },
    rasterizer: missing.length === 0 ? 'none-needed' : `${generator}（补齐 ${missing.join('/')}px）`,
    outputs,
  };
  writeFileSync(join(outputDir, 'derivation-manifest.json'), `${JSON.stringify(derivation, null, 2)}\n`);
  return derivation;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exit(main(process.argv.slice(2)));
}
