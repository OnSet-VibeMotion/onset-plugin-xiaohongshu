import { CreatorOrigin, type BrowserConnection } from './cdp';

export interface BrowserBridge { endpoint: string; token: string }
export function validateBridge(value: unknown): BrowserBridge {
  if (!value || typeof value !== 'object') throw Error('请更新片场客户端，当前版本尚不支持客户端内小红书页面');
  const { endpoint, token } = value as Partial<BrowserBridge>;
  if (typeof endpoint !== 'string' || typeof token !== 'string' || !/^[0-9a-f]{64}$/.test(token)) throw Error('客户端网页连接无效');
  const url = new URL(endpoint);
  if (url.protocol !== 'http:' || url.hostname !== '127.0.0.1' || !url.port || url.pathname !== '/' || url.search || url.hash || url.username || url.password) throw Error('客户端网页连接必须是本机的临时连接');
  return { endpoint, token };
}

/** 片场给本次操作的网页连接：打开、查看、关掉片场里的小红书页面。 */
export function connectBridge(value: unknown) {
  const bridge = validateBridge(value);
  let connected = true;
  const request = async (body: Record<string, unknown>) => {
    if (!connected) throw Error('网页自动填写已结束');
    const response = await fetch(bridge.endpoint, {
      method: 'POST', headers: { authorization: `Bearer ${bridge.token}`, 'content-type': 'application/json' },
      body: JSON.stringify(body), signal: AbortSignal.timeout(45_000), redirect: 'error',
    });
    const result = await response.json() as Record<string, any>;
    if (!response.ok) throw Error(result.error || '客户端网页操作失败');
    return result;
  };
  return {
    request,
    /** 移除账号前关掉它开着的页面（别的操作正在用时片场会拒绝）。 */
    forget: (account: string) => request({ action: 'forget', account }),
    disconnect() { connected = false; },
  };
}

export interface OpenOptions { bridge?: BrowserBridge; account: string; label: string; hint?: string }
/** Only controls the page owned by the desktop host. Never launches a separate browser. */
export async function openBrowser(_profile: string, options: OpenOptions): Promise<BrowserConnection> {
  const bridge = connectBridge(options.bridge);
  const opened = await bridge.request({ action: 'open', account: options.account, label: options.label, url: CreatorOrigin + '/', ...(options.hint ? { hint: options.hint } : {}) });
  return {
    attached: true, reused: opened.reused === true,
    send: (method, params = {}) => bridge.request({ action: 'command', method, params }),
    state: async () => { const s = await bridge.request({ action: 'state' }); return { open: s.open === true, visible: s.visible === true }; },
    close: async () => { await bridge.request({ action: 'close' }); },
    disconnect() { bridge.disconnect(); },
  };
}
