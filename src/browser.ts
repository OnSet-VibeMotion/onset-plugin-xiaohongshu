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

/** Only controls the page owned by the desktop host. Never launches a separate browser. */
export async function openBrowser(_profile: string, options: { bridge?: BrowserBridge; account: string; label: string }): Promise<BrowserConnection> {
  const bridge = validateBridge(options.bridge);
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
  const opened = await request({ action: 'open', account: options.account, label: options.label, url: CreatorOrigin + '/' });
  return {
    attached: true, reused: opened.reused === true,
    send: (method, params = {}) => request({ action: 'command', method, params }),
    disconnect() { connected = false; },
  };
}
