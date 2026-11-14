import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, childDirectory, readSmallJSON } from './files';

export interface Account { id: string; name: string; created_at: string }
const accountID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
function checkName(value: string): string {
  const name = value.trim();
  if (!name || [...name].length > 40 || /[\x00-\x1f\x7f]/.test(name)) throw Error('账号名称需要 1–40 个字，不能换行');
  return name;
}
export class AccountStore {
  readonly root: string;
  constructor(dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.root = childDirectory(dataDir, 'accounts');
  }
  list(): Account[] {
    return fs.readdirSync(this.root).filter(name => accountID.test(name)).map(id => this.get(id))
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }
  get(id: string): Account {
    if (!accountID.test(id)) throw Error('账号编号无效');
    const dir = path.join(this.root, id);
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) throw Error('找不到这个账号，请刷新账号列表');
    const value = readSmallJSON(path.join(dir, 'account.json')) as Account;
    if (value?.id !== id || typeof value.name !== 'string' || typeof value.created_at !== 'string') throw Error('账号资料无效');
    checkName(value.name);
    return { id, name: value.name, created_at: value.created_at };
  }
  add(rawName: string): Account {
    const release = acquireLock(this.root);
    try {
      const name = checkName(rawName);
      if (this.list().some(a => a.name === name)) throw Error('已有同名账号，请直接选择或换一个名称');
      const account = { id: randomUUID(), name, created_at: new Date().toISOString() };
      const dir = childDirectory(this.root, account.id);
      atomicJSON(path.join(dir, 'account.json'), account);
      return account;
    } finally { release(); }
  }
  rename(id: string, rawName: string): Account {
    const release = acquireLock(this.root);
    try {
      const account = this.get(id), name = checkName(rawName);
      if (this.list().some(a => a.id !== id && a.name === name)) throw Error('已有同名账号');
      const renamed = { ...account, name };
      atomicJSON(path.join(this.root, id, 'account.json'), renamed);
      return renamed;
    } finally { release(); }
  }
  profile(id: string): string {
    this.get(id);
    return childDirectory(this.root, `${id}/browser`);
  }
}

function acquireLock(dir: string): () => void {
  const file = path.join(dir, 'operation.lock');
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, 'wx', 0o600);
      fs.writeFileSync(fd, String(process.pid)); fs.closeSync(fd);
      return () => fs.rmSync(file, { force: true });
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const pid = Number(fs.readFileSync(file, 'utf8'));
      if (!Number.isInteger(pid) || pid < 1) throw Error('账号正在使用，或锁文件损坏');
      try { process.kill(pid, 0); }
      catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ESRCH') { fs.rmSync(file); continue; }
      }
      throw Error('这个账号正在处理另一项操作，请稍后再试');
    }
  }
  throw Error('无法取得账号使用权，请重试');
}
export async function withAccountLock<T>(profile: string, run: () => Promise<T>): Promise<T> {
  const release = acquireLock(profile);
  try { return await run(); } finally { release(); }
}
