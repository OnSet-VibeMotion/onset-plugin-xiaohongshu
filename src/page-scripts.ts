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
