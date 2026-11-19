import * as scripts from './page-scripts';
export interface BrowserConnection {
  attached?: boolean;
  reused?: boolean;
  send(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<any>;
  /** 片场里的页面还开着、还在前面吗（用户点了「返回片场」就不在前面了）。 */
  state?(): Promise<{ open: boolean; visible: boolean }>;
  /** 关掉片场里的这个页面（登录完自动回到片场）。 */
  close?(): Promise<void>;
  /** 自动操作期间在页面上盖遮罩显示进度（用户点不到页面）；idle 揭开。操作结束时片场也会自动揭开。 */
  busy?(message: string, progress: number | null): Promise<void>;
  idle?(): Promise<void>;
  disconnect(): void;
}

type Pending = { resolve: (value: any) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> };
export class CDP {
  private next = 0;
  private pending = new Map<number, Pending>();
  private constructor(private socket: WebSocket) {
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data));
      const request = this.pending.get(message.id);
      if (!request) return;
      clearTimeout(request.timer); this.pending.delete(message.id);
      if (message.error) request.reject(Error(message.error.message)); else request.resolve(message.result ?? {});
    });
    socket.addEventListener('close', () => this.rejectPending());
  }
  static async connect(endpoint: string): Promise<CDP> {
    const url = new URL(endpoint);
    if (url.protocol !== 'ws:' || !['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname)) throw Error('浏览器调试连接必须在本机');
    const socket = new WebSocket(endpoint);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => { socket.close(); reject(Error('连接浏览器超时')); }, 5000);
      socket.addEventListener('open', () => { clearTimeout(timer); resolve(); }, { once: true });
      socket.addEventListener('error', () => { clearTimeout(timer); reject(Error('无法连接浏览器')); }, { once: true });
    });
    return new CDP(socket);
  }
  send(method: string, params: Record<string, unknown> = {}, sessionId?: string): Promise<any> {
    if (this.socket.readyState !== WebSocket.OPEN) return Promise.reject(Error('浏览器窗口已关闭'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(id); reject(Error(`浏览器操作超时：${method}`)); }, 15_000);
      this.pending.set(id, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });
  }
  private rejectPending(): void {
    for (const request of this.pending.values()) { clearTimeout(request.timer); request.reject(Error('浏览器连接已断开')); }
    this.pending.clear();
  }
  /** Disconnect automation only. Never close the user's browser. */
  disconnect(): void { this.rejectPending(); this.socket.close(); }
}

export const CreatorOrigin = 'https://creator.xiaohongshu.com';
export const delay = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));
export class Page {
  private constructor(private cdp: BrowserConnection, private sessionId: string, readonly origin: string) {}
  static async create(cdp: BrowserConnection, origin = CreatorOrigin): Promise<Page> {
    if (cdp.attached) {
      const page = new Page(cdp, '', origin);
      await page.raw('Page.enable'); await page.raw('Page.bringToFront');
      return page;
    }
    const { targetId } = await cdp.send('Target.createTarget', { url: 'about:blank', newWindow: true });
    const { sessionId } = await cdp.send('Target.attachToTarget', { targetId, flatten: true });
    const page = new Page(cdp, sessionId, origin);
    await page.raw('Page.enable'); await page.raw('Page.bringToFront');
    return page;
  }
  raw(method: string, params: Record<string, unknown> = {}): Promise<any> { return this.cdp.send(method, params, this.sessionId); }
  async navigate(url: string): Promise<void> {
    if (new URL(url).origin !== this.origin) throw Error('只能打开小红书创作者页面');
    const result = await this.raw('Page.navigate', { url });
    if (result.errorText) throw Error(`打开小红书失败：${result.errorText}`);
  }
  private expression<T, A>(fn: (arg: A) => T, arg: A): string {
    return `(() => { if (location.origin !== ${JSON.stringify(this.origin)}) throw new Error('页面已离开创作者中心，请重新打开'); return (${fn.toString()})(${JSON.stringify(arg) ?? 'undefined'}); })()`;
  }
  async evaluate<T, A = undefined>(fn: (arg: A) => T, arg?: A): Promise<T> {
    const result = await this.raw('Runtime.evaluate', { expression: this.expression(fn, arg as A), returnByValue: true, awaitPromise: true });
    if (result.exceptionDetails) throw Error(result.exceptionDetails.exception?.description ?? '页面操作失败');
    return result.result.value as T;
  }
  /** 每一步自动操作前的检查点（小红书弹出验证时停下交给用户），返回停了多少毫秒；没设就是 0。不能在里面调 waitFor。 */
  guard?: () => Promise<number>;
  async checkpoint(): Promise<number> { return this.guard ? this.guard() : 0; }
  async waitFor(fn: () => boolean, timeout: number, message = '等待页面超时，请在小红书窗口检查登录或页面状态'): Promise<void> {
    let deadline = Date.now() + timeout;
    do {
      // 停下等用户验证的时间不算进这一步的时限。
      deadline += await this.checkpoint();
      try { if (await this.evaluate(fn)) return; }
      catch (err) { if (!/context|页面已离开/i.test(String(err))) throw err; }
      await delay(Math.min(250, timeout));
    } while (Date.now() < deadline);
    throw Error(message);
  }
  async upload(selector: string, file: string): Promise<void> {
    const result = await this.raw('Runtime.evaluate', { expression: this.expression(scripts.query, selector) });
    if (result.exceptionDetails || !result.result.objectId || result.result.subtype === 'null') throw Error('找不到上传控件，页面可能已更新');
    await this.raw('DOM.setFileInputFiles', { objectId: result.result.objectId, files: [file] });
    await this.raw('Runtime.releaseObject', { objectId: result.result.objectId });
  }
  async click(selector: string, exactText?: string): Promise<boolean> {
    return this.evaluate(scripts.clickControl, { selector, exactText });
  }
  /** 片场客户端放不放行键盘与鼠标事件（旧版只放行插入文字与页面脚本）；第一次被拒后记下，之后直接走退路。 */
  private input = true;
  private async trusted(method: string, params: Record<string, unknown>): Promise<boolean> {
    if (!this.input) return false;
    try { await this.raw(method, params); return true; }
    catch (err) { if (/不支持这个网页控制命令/.test(String(err))) { this.input = false; return false; } throw err; }
  }
  /** 像人一样逐字打（按下、松开，带字符）：小红书的话题候选靠逐字输入「#」触发。客户端不让发键盘事件时退回插入文字。 */
  async type(text: string, gap = 50): Promise<void> {
    for (const ch of text) {
      if (await this.trusted('Input.dispatchKeyEvent', { type: 'keyDown', key: ch, text: ch, unmodifiedText: ch })) await this.raw('Input.dispatchKeyEvent', { type: 'keyUp', key: ch });
      else await this.raw('Input.insertText', { text: ch });
      if (gap) await delay(gap);
    }
  }
  /** 按一个键；客户端不让发键盘事件时返回 false。 */
  async press(key: 'Enter' | 'Escape' | 'Backspace'): Promise<boolean> {
    const code = key === 'Enter' ? 13 : key === 'Escape' ? 27 : 8;
    if (!await this.trusted('Input.dispatchKeyEvent', { type: 'keyDown', key, code: key, windowsVirtualKeyCode: code, ...(key === 'Enter' ? { text: '\r' } : {}) })) return false;
    await this.raw('Input.dispatchKeyEvent', { type: 'keyUp', key, code: key, windowsVirtualKeyCode: code });
    return true;
  }
  /** 真的点一下鼠标（候选项可能只认鼠标事件）；客户端不让发鼠标事件时，在那个位置的元素上依次派发按下、松开、点击。 */
  async clickAt(x: number, y: number): Promise<void> {
    if (await this.trusted('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })) {
      await this.raw('Input.dispatchMouseEvent', { type: 'mousePressed', x, y, button: 'left', clickCount: 1 });
      await this.raw('Input.dispatchMouseEvent', { type: 'mouseReleased', x, y, button: 'left', clickCount: 1 });
      return;
    }
    await this.evaluate(scripts.pointerClick, { x, y });
  }
  async fillTitle(title: string): Promise<void> {
    await this.evaluate(scripts.fillTitle, title);
  }
  async fillContent(content: string): Promise<void> {
    await this.evaluate(scripts.selectContent);
    await this.raw('Input.insertText', { text: content });
  }
}
