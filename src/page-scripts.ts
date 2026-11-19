/** These functions are serialized and executed inside Chromium. Keep them closure-free.
 * Their behavior is verified by prepare.browser.test.ts; Node V8 cannot measure them. */
export function query(selector: string): Element | null { return document.querySelector(selector); }
export function uploadInputPresent(): boolean { return !!document.querySelector('input.upload-input, input[type="file"][accept*="video"]'); }
/**
 * 视频笔记的上传状态。小红书选好视频后就进编辑页，视频在页面上一边传一边显示「上传中」与百分比，
 * 传完显示「上传成功」「重新上传」/「替换视频」，「设置封面」一节也出来了。
 * percent 先取上传状态那几块（进度、stage、上传卡片）文字里的百分比，再看整页「上传/处理…xx%」，最后看进度条的 aria-valuenow；
 * 读不到为 null。none 表示页面上看不出有视频在传（还在上传入口页，或者编辑页上没有视频的痕迹）。
 * 2026-11-19 核对过上传入口页（input.upload-input、「拖拽视频到此或点击上传」，这时是 none）；上传中、失败时的文字与进度条
 * 没有在真实页面上看到（核对时不上传），按常见写法认，未核实。
 */
export interface VideoStatus { state: 'none' | 'uploading' | 'ready' | 'failed'; text: string; percent: number | null }
export function videoStatus(): VideoStatus {
  const skip = '.main-cover-editor-modal, .d-modal, .draft-drawer, #creator-editor-topic-container';
  const nodes = [...document.querySelectorAll<HTMLElement>('[class*="progress"], [class*="stage"], [class*="upload-content"], [class*="uploading"], [role="progressbar"], [role="alert"]')]
    .filter(node => node.getClientRects().length && !node.closest(skip));
  const text = nodes.map(node => node.innerText.trim()).filter(Boolean).join('\n').slice(0, 500);
  const body = document.body.innerText;
  const bars = nodes.flatMap(node => [node, ...node.querySelectorAll<HTMLElement>('[role="progressbar"]')]);
  const bar = bars.find(node => node.hasAttribute('aria-valuenow'));
  const value = Number(bar?.getAttribute('aria-valuenow')), max = Number(bar?.getAttribute('aria-valuemax') || 100);
  const match = text.match(/(\d{1,3}(?:\.\d+)?)\s*%/) ?? body.match(/(?:上传|处理|转码)[^\n%]{0,10}?(\d{1,3}(?:\.\d+)?)\s*%/);
  const percent = match ? Math.min(100, Number(match[1]))
    : bar && Number.isFinite(value) && max > 0 ? Math.min(100, Math.max(0, value / max * 100)) : null;
  if (/(上传|转码|处理|解析)失败/.test(`${text}\n${body}`)) return { state: 'failed', text, percent };
  const busy = /正在上传|上传中|正在转码|转码中|处理中|解析中/.test(body);
  const title = [...document.querySelectorAll<HTMLInputElement>('input[placeholder*="标题"], div.d-input input')]
    .some(input => input.getClientRects().length && !input.disabled && !input.closest(skip));
  if (title && !busy && /上传成功|重新上传|替换视频|设置封面|编辑封面/.test(body)) return { state: 'ready', text, percent };
  return { state: busy || percent !== null ? 'uploading' : 'none', text, percent };
}

/** 页面停在视频笔记的编辑页（选好视频后才有标题框）。 */
export function editorOpen(): boolean {
  return [...document.querySelectorAll<HTMLInputElement>('input[placeholder*="标题"], div.d-input input')]
    .some(input => input.getClientRects().length && !input.disabled && !input.closest('.main-cover-editor-modal, .d-modal'));
}

/**
 * 小红书弹出了要用户自己做的验证：滑块、点选验证码、短信或身份确认。验证组件挂在 captcha / verify 容器或 iframe 里
 * （小红书的是 red-captcha，登录与风控页在 website-login 下）；身份确认是普通弹窗，按文字认。只认看得见的，封面编辑器不算。
 * 2026-11-19 核对过创作者中心会载入 edith.xiaohongshu.com/api/redcaptcha 的配置；验证弹出来时的 DOM 没见到，选择器未核实。
 */
export function verificationOpen(): boolean {
  const visible = (node: Element) => node.getClientRects().length > 0 && (node as HTMLElement).offsetWidth > 20 && (node as HTMLElement).offsetHeight > 20;
  const cover = '.main-cover-editor-modal, .cover-modal';
  const widgets = '[class*="red-captcha"], [class*="redcaptcha"], [class*="captcha"], [id*="captcha"], [class*="verify-container"], [class*="verify-modal"], [class*="verifyContainer"], iframe[src*="captcha"], iframe[src*="verify"], iframe[src*="website-login"]';
  if ([...document.querySelectorAll(widgets)].some(node => visible(node) && !node.closest(cover))) return true;
  return [...document.querySelectorAll<HTMLElement>('[role="dialog"], .d-modal, [class*="modal"]')]
    .some(dialog => visible(dialog) && !dialog.closest(cover) && !dialog.querySelector(cover)
      && /安全验证|身份验证|身份校验|人机验证|请完成.{0,6}验证|验证码|滑块|拖动.{0,4}完成|向右拖动/.test(dialog.innerText.slice(0, 300)));
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
/*
 * 新版的封面（2026-11-18 在真实页面上核对过）：
 * - 入口：「设置封面」一节（.cover-plugin-preview）里的 div.cover-edit-entry「编辑封面」；
 * - 编辑器：.d-modal-mask 里的 .d-modal.main-cover-editor-modal，标题 h6「设置封面」；
 * - 上传：编辑器里 label.upload-btn > input.upload-input[accept*="image"]（aria-label「上传封面图片」）。
 *   传上去之后这个文件框就没了，换成 button.uploaded-thumbnail，清除按钮是 [aria-label="清除已上传封面"]；
 * - 完成：button.mojito-button「完成」。点右上角的 img.close-icon 会问「关闭后操作将不会保留」。
 */
export function coverEntryPresent(): boolean {
  return !!document.querySelector('.cover-edit-entry, div.upload-cover, button.upload-cover');
}
export function coverEditorOpen(): boolean {
  const m = document.querySelector<HTMLElement>('.main-cover-editor-modal');
  return !!m && m.getClientRects().length > 0;
}
/** 编辑器里已经有一张传上去的封面（接着草稿做时常见）：先清掉，文件框才会回来。 */
export function clearUploadedCover(): boolean {
  const clear = document.querySelector<HTMLElement>('.main-cover-editor-modal [aria-label="清除已上传封面"]');
  if (!clear) return false;
  clear.click(); return true;
}
export function coverInputReady(): boolean { return !!document.querySelector('.main-cover-editor-modal input[type="file"][accept*="image"]'); }
export function coverUploaded(): boolean { return !!document.querySelector('.main-cover-editor-modal .uploaded-thumbnail'); }
export function clickCoverDone(): boolean {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.main-cover-editor-modal button')].find(b => b.textContent?.trim() === '完成' && !b.disabled && b.getClientRects().length);
  if (!button) return false;
  button.click(); return true;
}
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
/** 正文编辑器里已经插进去的话题（`a[data-topic]`）：个数与最后一个的名字（data-topic 是带 name 的 JSON）。 */
export function insertedTopics(): { count: number; last: string; names: string[] } {
  // 只看正文编辑器：右边的笔记预览里也有一份话题。
  const editor = [...document.querySelectorAll<HTMLElement>('.tiptap.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]')].find(e => e.getClientRects().length);
  const nodes = editor ? [...editor.querySelectorAll<HTMLElement>('a[data-topic]')] : [];
  const node = nodes[nodes.length - 1];
  const nameOf = (a: HTMLElement) => {
    try { const n = String(JSON.parse(a.getAttribute('data-topic') ?? '{}').name ?? ''); if (n) return n.replace(/^#/, '').trim(); } catch { /* 按文字认 */ }
    return (a.textContent ?? '').trim().replace(/^#/, '').replace(/\[话题\]#?$/, '');
  };
  let last = '';
  if (node) {
    try { last = String(JSON.parse(node.getAttribute('data-topic') ?? '{}').name ?? ''); } catch { last = ''; }
    if (!last) last = (node.textContent ?? '').trim().replace(/^#/, '').replace(/\[话题\]#?$/, '');
  }
  return { count: nodes.length, last: last.replace(/^#/, '').trim(), names: nodes.map(nameOf) };
}
/**
 * 小红书把视频笔记的草稿存在这个浏览器本地：IndexedDB `draft-database-v1` 的 `video-draft`（2026-11-19 在真实页面上核对过库与
 * 表名，以及 `content.draftStore.video` 的字段：width、height、fileid、fsize 字节数、duration）。新版页面另有 `xhs-creator-draft`
 * 库里的 `video-Draft-<用户编号>` 表（核对时是空的，记录形状未核实，按同样的字段读）。
 * 找视频大小与这次成片相同、时长也对得上（草稿记了时长、成片读得出时长时；单位未核实，秒或毫秒都认，差 1.5 秒以内）、最新的那条，
 * 返回它在草稿箱里显示的标题与保存时间（草稿箱只按这两样列出）；没有就返回 null。读不了也当没有。只读，不改也不删草稿。
 */
export async function findVideoDraft(film: { size: number; duration: number | null }): Promise<{ title: string; time: string } | null> {
  const readAll = (name: string, stores: (names: string[]) => string[]) => new Promise<any[]>((resolve) => {
    let open: IDBOpenDBRequest;
    try { open = indexedDB.open(name); } catch { resolve([]); return; }
    open.onerror = () => resolve([]);
    open.onupgradeneeded = () => { open.transaction?.abort(); resolve([]); };
    open.onsuccess = () => {
      const db = open.result;
      const wanted = stores([...db.objectStoreNames]);
      if (!wanted.length) { db.close(); resolve([]); return; }
      const records: any[] = [];
      let left = wanted.length;
      for (const store of wanted) {
        const all = db.transaction(store, 'readonly').objectStore(store).getAll();
        all.onsuccess = () => { records.push(...all.result); if (!--left) { db.close(); resolve(records); } };
        all.onerror = () => { if (!--left) { db.close(); resolve(records); } };
      }
    };
  });
  try {
    const records = [
      ...await readAll('draft-database-v1', names => names.filter(n => n === 'video-draft')),
      ...await readAll('xhs-creator-draft', names => names.filter(n => /^video-draft/i.test(n))),
    ];
    const videoOf = (r: any) => r?.content?.draftStore?.video ?? r?.draftStore?.video;
    const durationMatches = (value: unknown) => {
      const d = Number(value);
      if (film.duration == null || !Number.isFinite(d) || d <= 0) return true;
      return Math.abs(d * 1000 - film.duration) <= 1500 || Math.abs(d - film.duration) <= 1500;
    };
    const hit = records
      .filter(r => videoOf(r)?.fsize === film.size && videoOf(r)?.fileid && durationMatches(videoOf(r)?.duration))
      .sort((a, b) => (b.timeStamp ?? 0) - (a.timeStamp ?? 0))[0];
    if (!hit) return null;
    const t = new Date(hit.timeStamp), two = (n: number) => String(n).padStart(2, '0');
    const time = `${t.getFullYear()}-${two(t.getMonth() + 1)}-${two(t.getDate())} ${two(t.getHours())}:${two(t.getMinutes())}:${two(t.getSeconds())}`;
    return { title: String((hit.content ?? hit).draftStore?.title ?? ''), time };
  } catch { return null; }
}
export function draftDrawerOpen(): boolean { return !![...document.querySelectorAll<HTMLElement>('.draft-drawer .draft-item, .draft-list .draft-item')].find(e => e.getClientRects().length); }
/** 在打开的草稿箱里点那条草稿的「编辑」：先按标题找，同名的再按「保存于」的时间分。 */
export function editDraft({ title, time }: { title: string; time: string }): boolean {
  const items = [...document.querySelectorAll<HTMLElement>('.draft-drawer .draft-item, .draft-list .draft-item')].filter(e => e.getClientRects().length);
  const named = items.filter(e => (e.querySelector('.draft-title-text')?.textContent ?? '').trim() === title);
  const item = named.length === 1 ? named[0] : named.find(e => (e.querySelector('.draft-time')?.textContent ?? '').includes(time));
  const edit = item && [...item.querySelectorAll<HTMLElement>('.draft-actions .btn, .draft-actions *')].find(e => (e.textContent ?? '').trim() === '编辑');
  if (!edit) return false;
  edit.click(); return true;
}
/** 没有可信鼠标事件时的退路：在 (x, y) 处的元素上派发 pointerdown / mousedown / pointerup / mouseup / click。不点发布。 */
export function pointerClick({ x, y }: { x: number; y: number }): boolean {
  const target = document.elementFromPoint(x, y) as HTMLElement | null;
  if (!target) return false;
  if (target.closest('.publish-page-publish-btn, xhs-publish-btn') || /^(发布|立即发布|定时发布|确认发布)$/.test(target.textContent?.trim() ?? '')) throw Error('插件不允许点击发布按钮');
  const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0 };
  target.dispatchEvent(new PointerEvent('pointerdown', init)); target.dispatchEvent(new MouseEvent('mousedown', init));
  target.dispatchEvent(new PointerEvent('pointerup', init)); target.dispatchEvent(new MouseEvent('mouseup', init));
  target.dispatchEvent(new MouseEvent('click', init));
  return true;
}
/**
 * 正文里第一个不在清单里的话题（小红书「关联活动」、旧草稿会自己带进来），把光标放在它后面，
 * 好让一次退格把它整个删掉。返回它的名字；没有了返回 ''。
 */
export function selectExtraTopic(keep: string[]): string {
  const editor = [...document.querySelectorAll<HTMLElement>('.tiptap.ProseMirror[contenteditable="true"], .ProseMirror[contenteditable="true"], [contenteditable="true"][role="textbox"], [contenteditable="true"]')].find(e => e.getClientRects().length);
  if (!editor) return '';
  const wanted = new Set(keep.map(k => k.replace(/^#/, '').trim().toLowerCase()));
  const nameOf = (a: Element) => {
    try { const n = String(JSON.parse(a.getAttribute('data-topic') ?? '{}').name ?? ''); if (n) return n; } catch { /* 按文字认 */ }
    return (a.textContent ?? '').trim().replace(/^#/, '').replace(/\[话题\]#?$/, '');
  };
  const extra = [...editor.querySelectorAll('a[data-topic]')].find(a => !wanted.has(nameOf(a).trim().toLowerCase()));
  if (!extra) return '';
  editor.focus();
  const range = document.createRange(); range.setStartAfter(extra); range.collapse(true);
  const selection = window.getSelection()!; selection.removeAllRanges(); selection.addRange(range);
  return nameOf(extra);
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

export interface PublishedNote { title: string; type: string; duration: number | null; time: string; reviewing: boolean }
/**
 * 这个账号最近发的笔记（创作者中心「笔记管理」用的接口，2026-11-19 在真实页面上核对过）：
 * GET /api/galaxy/v2/creator/note/user/posted?tab=0&page=<n>，要带页面自己的签名（window._webmsxyw 算出 X-s / X-t，
 * 不带回 406）；回 { code: 0, success: true, data: { notes, page } }，page 是下一页、没有了为 -1。每条笔记：display_title、
 * type（video / normal）、video_info.duration（秒）、time（「2026-11-18 15:44」）、tab_status（已发布为 1；审核中的取值未核实，按 2 认）。
 * tab=0 是全部笔记，含审核中与未通过的。读不到返回 null（读到几页算几页）。
 */
export async function recentNotes(pages: number): Promise<PublishedNote[] | null> {
  const notes: PublishedNote[] = [];
  let next = 0;
  for (let page = 0; page < pages && next >= 0; page++) {
    let data: any;
    try {
      const url = `/api/galaxy/v2/creator/note/user/posted?tab=0&page=${next}`;
      const headers: Record<string, string> = {};
      const sign = (window as any)._webmsxyw;
      if (typeof sign === 'function') {
        const signed = sign(url, undefined);
        if (signed?.['X-s']) { headers['x-s'] = String(signed['X-s']); headers['x-t'] = String(signed['X-t']); }
      }
      const response = await fetch(url, { credentials: 'same-origin', cache: 'no-store', headers, signal: AbortSignal.timeout(8000) });
      if (!response.ok) return page ? notes : null;
      data = await response.json();
    } catch { return page ? notes : null; }
    if (data?.code !== 0 || !Array.isArray(data?.data?.notes)) return page ? notes : null;
    for (const note of data.data.notes) {
      const seconds = Number(note?.video_info?.duration);
      notes.push({
        title: String(note?.display_title ?? note?.title ?? ''), type: String(note?.type ?? ''),
        duration: Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null,
        time: String(note?.time ?? ''), reviewing: note?.tab_status === 2,
      });
    }
    next = Number(data.data.page ?? -1);
    if (!Number.isFinite(next)) break;
  }
  return notes;
}

/** 编辑页里预览视频的时长（秒）：小红书在编辑页放着已经选好的视频（元素未在真实页面上核实）。没有为 null。 */
export function editorVideoDuration(): number | null {
  const durations = [...document.querySelectorAll('video')].map(video => video.duration).filter(value => Number.isFinite(value) && value > 0);
  return durations.length ? Math.max(...durations) : null;
}
