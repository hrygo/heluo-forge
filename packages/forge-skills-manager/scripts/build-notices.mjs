import { readFile, readdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

/** Use only dependencies that contributed bytes to esbuild's actual output. */
export async function bundledNotices(metafiles, root) {
  const packages = new Map();
  for (const metadata of metafiles) for (const output of Object.values(metadata.outputs)) {
    for (const [input, contribution] of Object.entries(output.inputs)) {
      if (!contribution.bytesInOutput || !input.replaceAll('\\', '/').includes('node_modules/')) continue;
      let directory = dirname(resolve(root, input));
      let manifest;
      while (true) {
        try {
          const candidate = JSON.parse(await readFile(join(directory, 'package.json'), 'utf8'));
          if (candidate.name && candidate.version) { manifest = candidate; break; }
        } catch (error) { if (error.code !== 'ENOENT') throw error; }
        const parent = dirname(directory);
        if (parent === directory) throw new Error('Bundled dependency manifest is missing');
        directory = parent;
      }
      const id = `${manifest.name}@${manifest.version}`;
      if (packages.has(id)) continue;
      const names = (await readdir(directory)).filter(name => /^(?:licen[sc]e|copying|notice)(?:[.-].*)?$/i.test(name)).sort();
      if (!names.some(name => /^(?:licen[sc]e|copying)/i.test(name))) throw new Error(`Bundled dependency has no license file: ${id}`);
      const texts = await Promise.all(names.map(async name => `${name}\n${(await readFile(join(directory, name), 'utf8')).replaceAll('\r\n', '\n').trimEnd()}\n`));
      packages.set(id, `${id}\nLicense: ${typeof manifest.license === 'string' ? manifest.license : 'See original text below'}\n\n${texts.join('\n')}`);
    }
  }
  return 'Third-party notices for code bundled in this plugin\n\n' + [...packages].sort(([a], [b]) => a.localeCompare(b, 'en')).map(([, text]) => text).join('\n------------------------------------------------------------\n\n');
}
