import fs from 'node:fs';
import { Page, delay } from './cdp';
import type { Draft } from './draft';
import * as scripts from './page-scripts';

export type Progress = (fraction: number, message: string) => void;
export async function preparePage(page: Page, draft: Draft, progress: Progress, options: { timeout?: number } = {}): Promise<string[]> {
  const timeout = options.timeout ?? 10 * 60_000;
  progress(0.1, '请在打开的小红书窗口完成登录');
  await page.waitFor(scripts.uploadInputPresent, Math.min(timeout, 180_000), '尚未进入上传页面。请在小红书窗口完成登录，再点一次「上传并填写」');
  await page.click('.creator-tab, [role="tab"]', '上传视频');
  if (!await resumeDraft(page, draft, progress, timeout)) {
    progress(0.2, '正在上传视频，请保留小红书窗口');
    await page.upload('input.upload-input, input[type="file"][accept*="video"]', draft.video);
  }
  await page.waitFor(scripts.videoUploaded, timeout, '视频上传或处理超时，请在小红书窗口检查');
  progress(0.55, '正在填写标题、正文和话题');
  await page.fillTitle(draft.title);
  await page.fillContent(draft.content);
  const warnings: string[] = [];
  if (draft.tags.length) {
    // 话题另起一段，免得粘在正文最后一句上。
    await page.press('Enter');
    for (const tag of draft.tags) {
      const outcome = await insertTopic(page, tag, timeout);
      if (outcome === 'picked') continue;
      if (outcome === 'missing') warnings.push(`小红书没有找到话题「${tag}」，已填为文字，请在小红书页面确认。`);
      else warnings.push(`话题「${tag}」被识别成了「${outcome.other}」，请在小红书页面检查。`);
    }
  }
  if (!draft.cover) {
    warnings.push('发布信息里没有登记封面，小红书会用视频首帧；需要的话请在小红书页面手动设置封面。');
  } else {
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
  }
  // Readiness only: do not click. Upload progress can coexist with an editable form.
  await page.waitFor(scripts.publishReady, Math.min(timeout, 180_000), '内容已填写，但小红书尚未允许发布，请在窗口检查上传进度或校验提示');
  progress(1, '内容已填好，请在小红书页面检查并手动发布');
  return warnings;
}

/**
 * 逐字输入「#话题」，等候选出现、点中同名的那一项，再核对正文里确实多了这个话题（`a[data-topic]`）。
 * 候选会随输入重画，所以每次都重新找；最多点 3 次、等 5 秒。找不到同名话题时留下文字、补一个空格收尾。
 */
async function insertTopic(page: Page, tag: string, timeout: number): Promise<'picked' | 'missing' | { other: string }> {
  const before = (await page.evaluate(scripts.insertedTopics)).count;
  await page.type('#');
  await delay(Math.min(timeout, 200));
  await page.type(tag);
  const deadline = Date.now() + Math.min(timeout, 5000);
  for (let attempts = 0; attempts < 3 && Date.now() < deadline;) {
    const at = await page.evaluate(scripts.topicTarget, tag);
    if (!at) { await delay(Math.min(timeout, 200)); continue; }
    attempts++;
    await page.clickAt(at.x, at.y);
    const settle = Date.now() + Math.min(timeout, 1000);
    do {
      const now = await page.evaluate(scripts.insertedTopics);
      if (now.count > before) return now.last.toLowerCase() === tag.toLowerCase() ? 'picked' : { other: now.last };
      await delay(50);
    } while (Date.now() < settle);
  }
  await page.press('Escape');
  await page.type(' ', 0);
  return 'missing';
}

/**
 * 同一个成片上次已经传过、没发布：小红书离开页面时会把它存成本机草稿，视频已经在小红书那边。
 * 按视频文件大小认出那条草稿，从草稿箱点「编辑」接着填，不再重新上传。认不出、点不开就返回 false，照常上传。
 */
async function resumeDraft(page: Page, draft: Draft, progress: Progress, timeout: number): Promise<boolean> {
  const found = await page.evaluate(scripts.findVideoDraft, fs.statSync(draft.video).size);
  if (!found) return false;
  progress(0.2, '找到这个成片上次留下的草稿，正在打开');
  if (!await page.click('.draft-title, .draft-title-box')) return false;
  try { await page.waitFor(scripts.draftDrawerOpen, Math.min(timeout, 10_000)); } catch { return false; }
  if (await page.evaluate(scripts.editDraft, found)) return true;
  await page.press('Escape');
  return false;
}
