import { Page, delay } from './cdp';
import type { Draft } from './draft';
import * as scripts from './page-scripts';

export type Progress = (fraction: number, message: string) => void;
export async function preparePage(page: Page, draft: Draft, progress: Progress, options: { timeout?: number } = {}): Promise<string[]> {
  const timeout = options.timeout ?? 10 * 60_000;
  progress(0.1, '请在打开的小红书窗口完成登录');
  await page.waitFor(scripts.uploadInputPresent, Math.min(timeout, 180_000), '尚未进入上传页面。请在小红书窗口完成登录，再点一次「上传并填写」');
  await page.click('.creator-tab, [role="tab"]', '上传视频');
  progress(0.2, '正在上传视频，请保留小红书窗口');
  await page.upload('input.upload-input, input[type="file"][accept*="video"]', draft.video);
  await page.waitFor(scripts.videoUploaded, timeout, '视频上传或处理超时，请在小红书窗口检查');
  progress(0.55, '正在填写标题、正文和话题');
  await page.fillTitle(draft.title);
  await page.fillContent(draft.content);
  const warnings: string[] = [];
  for (const tag of draft.tags) {
    await page.raw('Input.insertText', { text: `\n#${tag}` });
    let matched = false;
    const deadline = Date.now() + Math.min(timeout, 3000);
    do {
      matched = await page.click('.topic-container .item, .topic-list .item, [role="option"]', `#${tag}`)
        || await page.click('.topic-container .item, .topic-list .item, [role="option"]', tag);
      if (matched) break;
      await delay(200);
    } while (Date.now() < deadline);
    if (!matched) {
      warnings.push(`话题「${tag}」已填为文字，请在小红书页面确认话题识别。`);
      await page.raw('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
      await page.raw('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 });
    }
  }
  progress(0.75, '正在设置封面');
  if (!await page.click('div.upload-cover, button.upload-cover, .cover-plugin-preview .default.pointer')
    && !await page.click('button', '设置封面')) throw Error('找不到设置封面的入口，请在小红书页面手动设置封面');
  await page.waitFor(scripts.coverDialogOpen, Math.min(timeout, 15_000), '封面窗口没有打开');
  if (!await page.click('.d-modal *, [role="dialog"] *', '上传封面')) throw Error('找不到「上传封面」，请在小红书页面手动设置封面');
  await page.upload('.d-modal input[type="file"][accept*="image"], [role="dialog"] input[type="file"][accept*="image"]', draft.cover);
  await delay(Math.min(timeout, 1000));
  await page.waitFor(scripts.coverConfirmReady, Math.min(timeout, 15_000), '封面尚未处理完成');
  if (!await page.click('.d-modal:has(input[accept*="image"]) .d-modal-footer button, [role="dialog"]:has(input[accept*="image"]) button', '确定')) throw Error('封面没有确认成功');
  await page.waitFor(scripts.coverDialogClosed, Math.min(timeout, 15_000), '封面尚未保存，请在小红书窗口检查');
  // Readiness only: do not click. Upload progress can coexist with an editable form.
  await page.waitFor(scripts.publishReady, Math.min(timeout, 180_000), '内容已填写，但小红书尚未允许发布，请在窗口检查上传进度或校验提示');
  progress(1, '内容已填好，请在小红书页面检查并手动发布');
  return warnings;
}
