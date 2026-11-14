import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn } from 'node:child_process';
import { CDP, delay } from '../../src/cdp';

export function findBrowser(configured = ''): string {
  const candidates = configured ? [configured] : process.platform === 'darwin' ? [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    path.join(os.homedir(), 'Applications/Google Chrome.app/Contents/MacOS/Google Chrome'),
    '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
  ] : process.platform === 'win32' ? [
    path.join(process.env.PROGRAMFILES ?? 'C:\\Program Files', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env.LOCALAPPDATA ?? '', 'Google/Chrome/Application/chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)', 'Microsoft/Edge/Application/msedge.exe'),
  ] : ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser'];
  for (const file of candidates) {
    if (!path.isAbsolute(file)) continue;
    try { fs.accessSync(file, fs.constants.X_OK); if (fs.statSync(file).isFile()) return file; } catch {}
  }
  throw Error('未找到 Chrome 或 Edge，请先安装浏览器，或在插件设置中填写浏览器程序路径');
}

async function existingEndpoint(profile: string): Promise<string | null> {
  try {
    const file = path.join(profile, 'DevToolsActivePort');
    const stat = fs.lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024) return null;
    const [port, browserPath] = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/);
    if (!/^\d{1,5}$/.test(port) || Number(port) < 1 || Number(port) > 65535 || !/^\/devtools\/browser\/[\w-]+$/.test(browserPath)) return null;
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(700), redirect: 'error' });
    const info = await response.json() as { webSocketDebuggerUrl?: string };
    const expected = `ws://127.0.0.1:${port}${browserPath}`;
    return info.webSocketDebuggerUrl === expected ? expected : null;
  } catch { return null; }
}

/** Own profile only; no browser install, default-profile access, or credential export. */
export async function openBrowser(profile: string, options: { executable?: string; headless?: boolean } = {}): Promise<CDP> {
  const existing = await existingEndpoint(profile);
  if (existing) return CDP.connect(existing);
  const executable = findBrowser(options.executable);
  const args = [`--user-data-dir=${profile}`, '--remote-debugging-port=0', '--remote-debugging-address=127.0.0.1',
    '--no-first-run', '--no-default-browser-check', '--disable-session-crashed-bubble',
    ...(options.headless ? ['--headless=new'] : []), 'about:blank'];
  const child = spawn(executable, args, { detached: true, stdio: 'ignore' });
  let failure: Error | undefined;
  child.on('error', err => { failure = err; }); child.unref();
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (failure) throw Error(`无法启动浏览器：${failure.message}`);
    const endpoint = await existingEndpoint(profile);
    if (endpoint) return CDP.connect(endpoint);
    await delay(200);
  }
  throw Error('浏览器启动超时，请关闭这个插件账号的浏览器窗口后重试');
}
