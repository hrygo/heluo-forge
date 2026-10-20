#!/usr/bin/env node
import { resolve } from 'node:path';
import { checkDocs } from './lib/doc-rules.mjs';

const root = resolve(process.argv[2] ?? process.cwd());
const { errors, counts } = checkDocs(root);

console.log(
  `docs: ${counts.files} files, ${counts.tables} tables, ${counts.links} local links, ` +
    `${counts.fragments} fragments, ${counts.controlled} controlled documents`,
);
for (const error of errors) console.error(`- ${error}`);
if (errors.length > 0) {
  console.error(`docs: ${errors.length} error(s)`);
  process.exit(1);
}
console.log('docs: ok');