#!/usr/bin/env node
import { resolve } from 'node:path';
import { checkRepo } from './lib/repo-rules.mjs';

const root = resolve(process.argv[2] ?? process.cwd());
const { errors, counts } = checkRepo(root);

console.log(
  `repo: ${counts.required} required entries, ${counts.packages} packages, ` +
    `${counts.services} services, ${counts.workflows} workflows, ${counts.tracked} tracked files`,
);
for (const error of errors) console.error(`- ${error}`);
if (errors.length > 0) {
  console.error(`repo: ${errors.length} error(s)`);
  process.exit(1);
}
console.log('repo: ok');