#!/usr/bin/env node
import { resolve } from 'node:path';
import { checkDocs } from './lib/doc-rules.mjs';

const args = process.argv.slice(2);
const showCatalog = args[0] === '--catalog';
const root = resolve(args[showCatalog ? 1 : 0] ?? process.cwd());
const { errors, counts, catalog } = checkDocs(root);

if (showCatalog && errors.length === 0) {
  const rows = [
    ['编号', '文档名称', '路径', '版本', '状态', '负责', '门禁'],
    ['---', '---', '---', '---', '---', '---', '---'],
    ...catalog.map(({ id, name, path, version, status, owner, gate }) => [id, name, path, version, status, owner, gate]),
  ];
  for (const row of rows) {
    console.log(`| ${row.map((value) => (value ?? '—').replace(/(?<!\\)\|/gu, '\\|')).join(' | ')} |`);
  }
} else {
  console.log(
    `docs: ${counts.files} files, ${counts.tables} tables, ${counts.links} local links, ` +
      `${counts.fragments} fragments, ${counts.controlled} controlled documents`,
  );
  for (const error of errors) console.error(`- ${error}`);
  if (errors.length) {
    console.error(`docs: ${errors.length} error(s)`);
    process.exitCode = 1;
  } else {
    console.log('docs: ok');
  }
}
