/**
 * 归档布局取证（CORP-DSH-DESIGN-025，CORP-DSH-PLAN-026 §4.3）：内嵌运行时从应用归档里加载之后，
 * 它交给操作系统的东西是否都落在归档之外的真实文件上。
 *
 * 由 `run-primary-runtime-probe.mjs --app` 经内置运行时探针插件在真实 DSH 宿主进程内调用；
 * 这里只收集事实，判定由驱动完成。只读，不改宿主行为，不外联。
 *
 * 核对六件事：壳入口在 dsh 链接之前装好的物理路径层在位；闭包里的原生库都能经归档路径加载；
 * dsh 自己把 ripgrep 解析到归档之外的解包副本，那份副本能跑，按归档路径拉起它也成功（Electron
 * 自身拒绝的调用）；node-pty 的 helper 在归档之外，终端真的能起一个 pty；dsh 把 Office 引擎包
 * 解析到归档之外，引擎把一份 docx 真的转成 PDF——它是原生进程，读的是自己所在的目录。
 *
 * Office 工具只在某个 Office 技能激活后才暴露给 agent，所以引擎走工具自己走的那条路：
 * `dsh-office-kit` 定位 Kit 与引擎包，Kit 的转换器做转换。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readdirSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, relative } from 'node:path';
import { pathToFileURL } from 'node:url';

/** The functions the shell's entry wraps; see `services/forge-desktop/src/physical-paths.mjs`. */
export const PROGRAM_STARTS = ['spawn', 'spawnSync', 'execFile', 'execFileSync'];
/** Packages whose own loader opens their native library; whichever the target's closure holds. */
const PACKAGES_WITH_A_LOADER = ['node-pty', 'koffi', 'sharp', 'sherpa-onnx-darwin-arm64', 'sherpa-onnx-win32-x64'];
const ADDON_SUFFIX = /\.node$/u;
/** How long the Office engine and a pty get before the probe gives up on them. */
const WAIT_MS = 120_000;

/** Whether a path still leads into the archive, as opposed to the unpacked tree beside it. */
export function insideArchive(path) {
  return typeof path === 'string' && /[\\/]app\.asar[\\/]/u.test(path);
}

/**
 * Where a path inside the archive, or inside the unpacked tree beside it, names
 * its counterpart across the boundary. The archive and its tree themselves are
 * left alone: nothing lies across from them but each other.
 */
function acrossArchive(path, toUnpacked) {
  if (typeof path !== 'string') return path;
  return toUnpacked
    ? path.replace(/([\\/])app\.asar([\\/])/u, (_match, before, after) => `${before}app.asar.unpacked${after}`)
    : path.replace(/\.asar\.unpacked([\\/])/u, (_match, separator) => `.asar${separator}`);
}

/** `<platform>-<arch>` as a path spells it, for the target this process runs on. */
const TARGET_TAG = new RegExp(`(?:${process.platform}|${process.platform === 'win32' ? 'win' : process.platform === 'darwin' ? 'macos' : 'linux'})[-_]${process.arch}(?:[^a-z0-9]|$)`, 'u');
const ANY_TARGET_TAG = /(?:darwin|win32|linux|win|macos)[-_](?:arm64|x64|ia32|universal)/gu;

/**
 * Whether a path names a platform or architecture other than the one this
 * process runs on: a prebuild for another target, shipped beside this one's.
 */
export function builtElsewhere(path) {
  const tags = typeof path === 'string' ? path.match(ANY_TARGET_TAG) ?? [] : [];
  return tags.length > 0 && !tags.some((tag) => TARGET_TAG.test(tag));
}

/** Regular files under a directory on disk, by `/`-separated path from it. */
function filesUnder(root) {
  return readdirSync(root, { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile()).map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

const describe = (error) => String(error?.message ?? error).slice(0, 300);

/**
 * @param {{archive: string, modules: string, dir: string, docx: string, ctx: object, agent: object}} input
 *   `modules` is the runtime's `dsh/node_modules`, inside the archive; `dir` is this launch's scratch
 *   directory; `docx` the document to convert, written by the driver with the bundled Python.
 * @returns {Promise<object>} the facts, each shaped for one check of the driver
 */
export async function packedRuntimeFacts({ archive, modules, dir, docx, ctx, agent }) {
  const facts = { archive, modules, modulesInsideArchive: insideArchive(modules) };
  const unpacked = `${archive}.unpacked`;
  const attempt = async (key, gather) => {
    try {
      facts[key] = await gather();
    } catch (error) {
      facts[key] = { error: String(error?.stack ?? error).slice(0, 600) };
    }
  };

  await attempt('physicalLayer', async () => {
    const childProcess = createRequire(import.meta.url)('node:child_process');
    return Object.fromEntries(PROGRAM_STARTS.map((name) => [name, childProcess[name].name === 'physicalPaths']));
  });

  // Native libraries, the way the runtime reaches them: packages with a loader of their own by name,
  // and every addon the unpacked tree holds for this target by its path into the archive. The closure
  // ships prebuilds for other targets beside this one's; they are unpacked too, and load nowhere but there.
  await attempt('natives', async () => {
    const fromRuntime = createRequire(join(modules, '@deepseek-ai', 'dsh', 'package.json'));
    const byLoader = PACKAGES_WITH_A_LOADER.filter((name) => existsSync(join(modules, name))).map((name) => {
      try {
        fromRuntime(name);
        return { name, loaded: true };
      } catch (error) {
        return { name, loaded: false, error: describe(error) };
      }
    });
    const scope = join(unpacked, relative(archive, modules));
    const unpackedFiles = filesUnder(scope);
    const addons = unpackedFiles
      .filter((path) => ADDON_SUFFIX.test(path) && !builtElsewhere(path))
      .sort()
      .map((path) => {
        try {
          fromRuntime(acrossArchive(join(scope, path), false));
          return { path, loaded: true };
        } catch (error) {
          return { path, loaded: false, error: describe(error) };
        }
      });
    return {
      byLoader,
      addons,
      // Unpacked, built for another target: carried, and not this target's to load.
      builtElsewhere: unpackedFiles.filter((path) => ADDON_SUFFIX.test(path) && builtElsewhere(path)),
      physical: unpackedFiles.length,
    };
  });

  await attempt('ripgrep', async () => {
    const { resolveRgPath } = await import(pathToFileURL(join(modules, '@deepseek-ai', 'dsh-util-ripgrep', 'lib', 'index.js')).href);
    const resolved = await resolveRgPath();
    const runs = (executable) => {
      const result = spawnSync(executable, ['--version'], { encoding: 'utf8' });
      return { executable, status: result.status, out: `${result.stdout ?? ''}${result.stderr ?? ''}`.trim().slice(0, 120), error: result.error?.code ?? null };
    };
    return {
      resolved,
      physical: !insideArchive(resolved) && lstatSync(resolved).isFile(),
      runs: runs(resolved),
      // By the path into the archive: what Electron refuses by itself, and the shell's entry provides for.
      byArchivePath: runs(acrossArchive(resolved, false)),
    };
  });

  await attempt('pty', async () => {
    const fromRuntime = createRequire(join(modules, '@deepseek-ai', 'dsh', 'package.json'));
    const nodePty = fromRuntime('node-pty');
    // node-pty names its helper beside its own loader, and maps the archive to the unpacked tree itself.
    const helper = acrossArchive(join(dirname(fromRuntime.resolve('node-pty/package.json')), 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper'), true);
    const outsideArchive = !insideArchive(helper);
    const executable = outsideArchive && existsSync(helper) && (lstatSync(helper).mode & 0o111) !== 0;
    // A real terminal: the helper's one job. It ends when the shell exits, or when the probe gives up.
    const spawned = await new Promise((settle) => {
      let output = '';
      let terminal;
      let settled = false;
      let timer;
      const done = (value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        settle(value);
      };
      try {
        const shell = process.platform === 'win32' ? [process.env.ComSpec ?? 'cmd.exe', ['/c', 'echo PTY_OK']] : ['/bin/sh', ['-c', 'echo PTY_OK']];
        terminal = nodePty.spawn(shell[0], shell[1], { name: 'xterm-color', cols: 80, rows: 24, cwd: dir, env: { ...process.env } });
      } catch (error) {
        done({ error: describe(error) });
        return;
      }
      terminal.onData((data) => {
        output += data;
      });
      terminal.onExit(({ exitCode }) => done({ exitCode, output: output.slice(0, 200) }));
      timer = setTimeout(() => {
        try {
          terminal.kill();
        } catch {
          // Already gone.
        }
        done({ exitCode: null, output: output.slice(0, 200), timedOut: true });
      }, WAIT_MS);
    });
    return { helper, outsideArchive, executable, spawned };
  });

  await attempt('office', async () => {
    const agentSeesTool = ctx.tools.get('office_convert', agent) !== undefined;
    // The tool's own road to the engine: dsh-office-kit locates the Kit and resolves the engine package.
    const locate = await import(pathToFileURL(join(modules, '@deepseek-ai', 'dsh-office-kit', 'lib', 'types', 'locate.js')).href);
    const kit = locate.resolveKitModule(() => pathToFileURL(join(modules, '@deepseek-ai', 'libreoffice-kit', 'lib', 'index.js')).href);
    if (kit.kind !== 'available') throw new Error(`LibreOffice Kit is not located: ${describe(kit.error?.message ?? kit.error)}`);
    const packages = Object.fromEntries(
      readdirSync(join(modules, '@deepseek-ai'))
        .filter((name) => /^libreoffice-kit-(?:darwin|win32|linux)-/u.test(name))
        .map((name) => [name, kit.resolveEnginePackage(`@deepseek-ai/${name}`)]),
    );
    const { createConverter } = await import(kit.entry);
    const converter = await createConverter({ resolveEnginePackage: kit.resolveEnginePackage });
    const inputPath = docx;
    const outputPath = join(dir, 'probe.pdf');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WAIT_MS);
    try {
      await converter.convert({ inputPath, outputPath }, controller.signal);
    } finally {
      clearTimeout(timer);
      await converter.dispose?.();
    }
    const pdf = existsSync(outputPath) ? readFileSync(outputPath).subarray(0, 4).toString('latin1') : null;
    return { agentSeesTool, enginePackages: packages, outputPath, pdf };
  });

  return facts;
}
