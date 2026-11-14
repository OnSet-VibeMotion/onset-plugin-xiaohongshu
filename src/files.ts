import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

function relativeParts(relative: string): string[] {
  if (!relative || path.isAbsolute(relative) || /[\\:\x00]/.test(relative)) throw Error('需要项目内的相对路径');
  const parts = relative.split('/');
  if (parts.some(p => !p || p === '.' || p === '..')) throw Error('路径不能越出项目');
  return parts;
}

/** Walk before creating: never write through a symlink in a project or profile. */
export function childDirectory(root: string, relative: string): string {
  let current = fs.realpathSync(root);
  for (const part of relativeParts(relative)) {
    current = path.join(current, part);
    try { fs.mkdirSync(current, { mode: 0o700 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
    const stat = fs.lstatSync(current);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('目录不能是符号链接');
  }
  return current;
}

export function projectFile(root: string, relative: string): string {
  const canonical = fs.realpathSync(root);
  const file = fs.realpathSync(path.join(canonical, ...relativeParts(relative)));
  if (!file.startsWith(canonical + path.sep) || !fs.statSync(file).isFile()) throw Error('文件必须位于项目内');
  return file;
}

export function atomicJSON(file: string, value: unknown): void {
  const tmp = `${file}.${randomUUID()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600, flag: 'wx' });
    fs.renameSync(tmp, file);
  } finally { fs.rmSync(tmp, { force: true }); }
}

export function writeProjectJSON(root: string, relative: string, value: unknown): void {
  const parts = relativeParts(relative);
  const name = parts.pop()!;
  const parent = parts.length ? childDirectory(root, parts.join('/')) : fs.realpathSync(root);
  atomicJSON(path.join(parent, name), value);
}

export function readSmallJSON(file: string): unknown {
  const stat = fs.lstatSync(file);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 262_144) throw Error('数据文件无效');
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}
