import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { atomicJSON, childDirectory, readSmallJSON } from './files';

/**
 * 一个已登录的小红书账号。名字与头像是登录后从小红书页面读到的，不让用户自己填；
 * user_id 用来认出同一个小红书账号重新登录了一次。登录状态在片场为它开的独立网页存储里（data_dir/web-sessions/<id>）。
 */
export interface Account { id: string; name: string; created_at: string; user_id?: string; avatar?: string }
const accountID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const avatarPattern = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
export const MaxAvatarChars = 200_000;
export function newAccountID(): string { return randomUUID(); }
export function cleanName(value: string): string {
  const name = [...value.replace(/[\x00-\x1f\x7f]/g, ' ').trim()].slice(0, 40).join('');
  if (!name) throw Error('读不到小红书昵称');
  return name;
}
export class AccountStore {
  readonly root: string;
  constructor(readonly dataDir: string) {
    fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
    this.root = childDirectory(dataDir, 'accounts');
  }
  list(): Account[] {
    return fs.readdirSync(this.root).filter(name => accountID.test(name)).flatMap(id => { try { return [this.get(id)]; } catch { return []; } })
      .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  }
  get(id: string): Account {
    if (!accountID.test(id)) throw Error('账号编号无效');
    const dir = path.join(this.root, id);
    if (!fs.existsSync(dir) || fs.lstatSync(dir).isSymbolicLink()) throw Error('找不到这个账号，请刷新账号列表');
    const value = readSmallJSON(path.join(dir, 'account.json')) as Account;
    if (value?.id !== id || typeof value.name !== 'string' || typeof value.created_at !== 'string') throw Error('账号资料无效');
    const account: Account = { id, name: cleanName(value.name), created_at: value.created_at };
    if (typeof value.user_id === 'string' && value.user_id) account.user_id = value.user_id;
    if (typeof value.avatar === 'string' && avatarPattern.test(value.avatar)) account.avatar = value.avatar;
    return account;
  }
  /**
   * 记下刚登录好的账号。同一个小红书账号（user_id 相同）以前登录过的，旧的那条换成这一条（返回 replaced，调用方去清旧的登录状态）。
   */
  saveLoggedIn(input: { id: string; name: string; user_id?: string; avatar?: string }): { account: Account; replaced?: Account } {
    const release = acquireLock(this.root);
    try {
      if (!accountID.test(input.id)) throw Error('账号编号无效');
      const account: Account = { id: input.id, name: cleanName(input.name), created_at: new Date().toISOString() };
      if (input.user_id) account.user_id = String(input.user_id).slice(0, 80);
      if (input.avatar && avatarPattern.test(input.avatar) && input.avatar.length <= MaxAvatarChars) account.avatar = input.avatar;
      const replaced = account.user_id ? this.list().find(a => a.user_id === account.user_id && a.id !== account.id) : undefined;
      if (replaced) account.created_at = replaced.created_at;
      const dir = childDirectory(this.root, account.id);
      atomicJSON(path.join(dir, 'account.json'), account);
      if (replaced) this.removeFiles(replaced.id);
      return { account, ...(replaced ? { replaced } : {}) };
    } finally { release(); }
  }
  remove(id: string): Account {
    const release = acquireLock(this.root);
    try {
      const account = this.get(id);
      this.removeFiles(id);
      return account;
    } finally { release(); }
  }
  /** 删掉账号资料与它的登录状态（片场开的网页存储）。 */
  removeFiles(id: string): void {
    if (!accountID.test(id)) throw Error('账号编号无效');
    fs.rmSync(path.join(this.root, id), { recursive: true, force: true });
    fs.rmSync(path.join(fs.realpathSync(this.dataDir), 'web-sessions', id), { recursive: true, force: true });
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
