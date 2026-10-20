import { gzipSync } from 'node:zlib';

function header(name, size, type = '0') {
  const block = Buffer.alloc(512);
  block.write(name, 0, 'utf8');
  block.write(size.toString(8).padStart(11, '0') + '\0', 124, 'utf8');
  block.write('0000000\0', 136, 'utf8');
  block.write(type, 156, 'utf8');
  block.write('ustar\0', 257, 'utf8');
  block.write('00', 263, 'utf8');
  let sum = 0;
  for (const byte of block) sum += byte;
  block.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 'utf8');
  return block;
}

export function makeTarball(entries) {
  const parts = [];
  for (const [path, content] of entries) {
    const body = Buffer.from(content);
    parts.push(header(path, body.length), body, Buffer.alloc((512 - (body.length % 512)) % 512));
  }
  parts.push(Buffer.alloc(1024));
  return gzipSync(Buffer.concat(parts));
}
