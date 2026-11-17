/** These functions are serialized and executed inside Chromium. Keep them closure-free.
 * Their behavior is verified by prepare.browser.test.ts; Node V8 cannot measure them. */
export function query(selector: string): Element | null { return document.querySelector(selector); }
export function uploadInputPresent(): boolean { return !!document.querySelector('input.upload-input, input[type="file"][accept*="video"]'); }
export function videoUploaded(): boolean {
  const title = document.querySelector<HTMLInputElement>('input[placeholder*="标题"], div.d-input input');
  const text = document.body.innerText;
  return !!title && !title.disabled && /上传成功|重新上传|设置封面|编辑封面/.test(text) && !/正在上传|上传中|正在转码|处理中/.test(text);
}
export function publishReady(): boolean {
  return [...document.querySelectorAll<HTMLElement>('button, xhs-publish-btn')].some(element => {
    const label = element.textContent?.trim() ?? '';
    return /^(发布|立即发布)$/.test(label) && element.getClientRects().length > 0
      && !element.hasAttribute('disabled') && element.getAttribute('aria-disabled') !== 'true'
      && !/disabled|loading/.test(element.className);
  });
}
export function coverDialogOpen(): boolean { return [...document.querySelectorAll<HTMLElement>('.d-modal, [role="dialog"]')].some(e => e.getClientRects().length > 0); }
export function coverConfirmReady(): boolean { return [...document.querySelectorAll<HTMLButtonElement>('.d-modal:has(input[accept*="image"]) .d-modal-footer button, [role="dialog"]:has(input[accept*="image"]) button')].some(e => e.textContent?.trim() === '确定' && !e.disabled && e.getClientRects().length > 0); }
export function coverDialogClosed(): boolean { return [...document.querySelectorAll<HTMLElement>('.d-modal, [role="dialog"]')].every(e => !e.getClientRects().length); }
export function clickControl({ selector, exactText }: { selector: string; exactText?: string }): boolean {
  const matches = [...document.querySelectorAll<HTMLElement>(selector)].filter(e => e.getClientRects().length && (!exactText || e.textContent?.trim() === exactText));
  const element = matches.find(e => !matches.some(other => other !== e && e.contains(other)));
  if (!element) return false;
  if (/^(发布|立即发布|定时发布|确认发布)$/.test(element.textContent?.trim() ?? '') || element.closest('.publish-page-publish-btn, xhs-publish-btn')) throw Error('插件不允许点击发布按钮');
  element.click(); return true;
}
/**
 * 话题候选里与 tag 同名的那一项的中心点（页面坐标），没有就返回 null。小红书的候选是
 * `#creator-editor-topic-container .item`，话题名在 `.name` 里，同一项里还有浏览量，所以不能按整项文字比。
 * 比较时忽略开头的 # 和大小写。
 */
export function topicTarget(tag: string): { x: number; y: number } | null {
  const norm = (s: string) => s.trim().replace(/^#/, '').replace(/\[话题\]#?$/, '').trim().toLowerCase();
  const items = [...document.querySelectorAll<HTMLElement>('#creator-editor-topic-container .item, .topic-container .item, .topic-list .item, [role="option"]')]
    .filter(e => e.getClientRects().length);
  const item = items.find(e => norm((e.querySelector('.name') ?? e).textContent ?? '') === norm(tag));
  if (!item) return null;
  item.scrollIntoView({ block: 'nearest' });
  const r = item.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}
/** 正文里已经插进去的话题（`a[data-topic]`）：个数与最后一个的名字（data-topic 是带 name 的 JSON）。 */
export function insertedTopics(): { count: number; last: string } {
  const nodes = [...document.querySelectorAll<HTMLElement>('a[data-topic]')];
  const node = nodes[nodes.length - 1];
  let last = '';
  if (node) {
    try { last = String(JSON.parse(node.getAttribute('data-topic') ?? '{}').name ?? ''); } catch { last = ''; }
    if (!last) last = (node.textContent ?? '').trim().replace(/^#/, '').replace(/\[话题\]#?$/, '');
  }
  return { count: nodes.length, last: last.replace(/^#/, '').trim() };
}
export function fillTitle(value: string): void {
  const input = [...document.querySelectorAll<HTMLInputElement>('input[placeholder*="标题"], div.d-input input')].find(e => e.getClientRects().length);
  if (!input) throw Error('找不到标题输入框');
  input.focus(); Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
  input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true }));
  if (input.value !== value) throw Error('标题没有填写完整');
}
export function selectContent(): void {
  const editor = [...document.querySelectorAll<HTMLElement>('.tiptap.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"]')].find(e => e.getClientRects().length);
  if (!editor) throw Error('找不到正文编辑器');
  editor.focus(); const range = document.createRange(); range.selectNodeContents(editor);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
}
/**
 * 登录了没有、登录的是谁：还在登录页时返回 null。先问创作者中心自己的接口（字段名没有文档，按名字认），
 * 读不到再从页面上的头像与昵称认。返回的头像是小红书 CDN 的地址，由插件进程去取。
 */
export async function loginInfo(): Promise<{ name: string; avatar: string; user_id: string } | null> {
  if (/login/i.test(location.pathname)) return null;
  const find = (value: unknown, key: RegExp, ok: (v: string) => boolean, depth = 0): string => {
    if (!value || typeof value !== 'object' || depth > 5) return '';
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) if (typeof v === 'string' && key.test(k) && ok(v.trim())) return v.trim();
    for (const v of Object.values(value as Record<string, unknown>)) { const found = find(v, key, ok, depth + 1); if (found) return found; }
    return '';
  };
  const url = (v: string) => /^https:\/\//.test(v);
  try {
    const response = await fetch('/api/galaxy/creator/home/personal_info', { credentials: 'include' });
    if (response.ok) {
      const json = await response.json();
      const name = find(json, /^(name|nick_?name|user_?name|nickName|userName)$/i, v => v.length > 0 && v.length <= 60);
      if (name) return { name, avatar: find(json, /avatar|image/i, url), user_id: find(json, /^(user_?id|userId|red_?id|redId)$/i, v => v.length > 0 && v.length <= 80) };
    }
  } catch { /* 接口不在或改了：退回读页面 */ }
  const visible = (e: Element) => e.getClientRects().length > 0;
  const avatar = [...document.querySelectorAll('img')].find(i => visible(i) && /avatar/i.test(`${i.className} ${i.src} ${i.parentElement?.className ?? ''}`));
  const nameEl = [...document.querySelectorAll('[class*="name" i], [class*="nick" i]')].find(e => visible(e) && !e.querySelector('*') && (e.textContent ?? '').trim().length > 0 && (e.textContent ?? '').trim().length <= 40);
  const name = nameEl?.textContent?.trim() ?? '';
  if (!name || !avatar) return null;
  return { name, avatar: url(avatar.src) ? avatar.src : '', user_id: '' };
}
