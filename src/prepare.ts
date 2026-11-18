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
    if (!await page.press('Enter')) await page.type(' ', 0);
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
    await setCover(page, draft.cover, timeout);
  }
  warnings.push(...await removeExtraTopics(page, draft.tags));
  // Readiness only: do not click. Upload progress can coexist with an editable form.
  await page.waitFor(scripts.publishReady, Math.min(timeout, 180_000), '内容已填写，但小红书尚未允许发布，请在窗口检查上传进度或校验提示');
  progress(1, '内容已填好，请在小红书页面检查并手动发布');
  return warnings;
}

/**
 * 设置封面。新版页面（2026-11-18 在真实页面上核对过）：「编辑封面」→ 编辑器里把图片放进上传框
 * （已经有一张传上去的就先清掉）→ 等缩略图出来 →「完成」。图片直接放进页面里的文件框，不弹选文件窗口。
 * 旧版页面（.upload-cover →「上传封面」→「确定」）照旧支持。
 */
async function setCover(page: Page, cover: string, timeout: number): Promise<void> {
  const step = Math.min(timeout, 15_000);
  await page.waitFor(scripts.coverEntryPresent, step, '找不到设置封面的入口（「编辑封面」），请在小红书页面手动设置封面');
  if (!await page.click('.cover-edit-entry')) return legacyCover(page, cover, timeout);
  await page.waitFor(scripts.coverEditorOpen, step, '封面编辑器没有打开，请在小红书页面手动设置封面');
  if (await page.evaluate(scripts.clearUploadedCover)) await page.waitFor(scripts.coverInputReady, step, '清不掉编辑器里原来那张封面，请在小红书页面手动设置封面');
  await page.waitFor(scripts.coverInputReady, step, '封面编辑器里找不到「上传」，请在小红书页面手动设置封面');
  await page.upload('.main-cover-editor-modal input[type="file"][accept*="image"]', cover);
  await page.waitFor(scripts.coverUploaded, step, '封面图片没有传上去，请在小红书页面检查');
  if (!await page.evaluate(scripts.clickCoverDone)) throw Error('封面编辑器里找不到「完成」，请在小红书页面检查封面');
  await page.waitFor(() => !document.querySelector('.main-cover-editor-modal')?.getClientRects().length, step, '封面还没保存（编辑器没有关上），请在小红书窗口检查');
}

/** 旧版页面：弹窗里点「上传封面」，放进图片，点「确定」。 */
async function legacyCover(page: Page, cover: string, timeout: number): Promise<void> {
  const step = Math.min(timeout, 15_000);
  if (!await page.click('div.upload-cover, button.upload-cover') && !await page.click('button', '设置封面')) throw Error('找不到设置封面的入口（「编辑封面」），请在小红书页面手动设置封面');
  await page.waitFor(scripts.coverDialogOpen, step, '封面窗口没有打开');
  if (!await page.click('.d-modal *, [role="dialog"] *', '上传封面')) throw Error('找不到「上传封面」，请在小红书页面手动设置封面');
  await page.upload('.d-modal input[type="file"][accept*="image"], [role="dialog"] input[type="file"][accept*="image"]', cover);
  await delay(Math.min(timeout, 1000));
  await page.waitFor(scripts.coverConfirmReady, step, '封面尚未处理完成');
  if (!await page.click('.d-modal:has(input[accept*="image"]) .d-modal-footer button, [role="dialog"]:has(input[accept*="image"]) button', '确定')) throw Error('封面没有确认成功');
  await page.waitFor(scripts.coverDialogClosed, step, '封面尚未保存，请在小红书窗口检查');
}

/**
 * 逐字输入「#话题」，等候选出现、点中同名的那一项，再核对正文里确实多了这个话题（`a[data-topic]`）。
 * 候选会随输入重画，所以每次都重新找；最多点 3 次、等 5 秒。找不到同名话题时留下文字、补一个空格收尾。
 */
async function insertTopic(page: Page, tag: string, timeout: number): Promise<'picked' | 'missing' | { other: string }> {
  const same = (names: string[]) => names.filter(n => n.toLowerCase() === tag.toLowerCase()).length;
  let start = await page.evaluate(scripts.insertedTopics);
  await page.type('#');
  await delay(Math.min(timeout, 200));
  await page.type(tag);
  const deadline = Date.now() + Math.min(timeout, 5000);
  let wrong = '';
  let last: { x: number; y: number } | null = null;
  for (let attempts = 0; attempts < 3 && Date.now() < deadline;) {
    const at = await page.evaluate(scripts.topicTarget, tag);
    // 候选列表随输入还在重画：同一项连续两次停在同一个位置才点，免得点到换上来的别的话题。
    const settled = at && last && Math.abs(at.x - last.x) < 1 && Math.abs(at.y - last.y) < 1;
    last = at;
    if (!at || !settled) { await delay(Math.min(timeout, 150)); continue; }
    attempts++;
    await page.clickAt(at.x, at.y);
    // 按名字核对：这次多出了同名话题就算选中。页面自己也会往正文里加话题（关联活动），不能只看最后一个。
    const settle = Date.now() + Math.min(timeout, 1000);
    let now = await page.evaluate(scripts.insertedTopics);
    while (now.count === start.count && Date.now() < settle) { await delay(50); now = await page.evaluate(scripts.insertedTopics); }
    if (now.count === start.count) continue;
    if (same(now.names) > same(start.names)) return 'picked';
    // 插错了：光标就在刚插进的话题后面，退格删掉它，重新输入再选。删不掉（客户端不让发按键）就照实提醒。
    wrong = now.last;
    if (!await page.press('Backspace')) return { other: wrong };
    await delay(100);
    if ((await page.evaluate(scripts.insertedTopics)).count >= now.count) return { other: wrong };
    start = await page.evaluate(scripts.insertedTopics);
    await page.type('#' + tag);
    last = null;
  }
  await page.press('Escape');
  await page.type(' ', 0);
  return wrong ? { other: wrong } : 'missing';
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

/**
 * 清掉正文里不在话题清单里的话题（小红书「关联活动」、旧草稿会自己带进来）：光标放到它后面按一次退格，
 * 核对确实少了一个再删下一个。客户端不让发按键时只提醒，不去改编辑器的 DOM（会和编辑器的内部状态对不上）。
 */
async function removeExtraTopics(page: Page, tags: string[]): Promise<string[]> {
  const removed: string[] = [];
  for (let round = 0; round < 20; round++) {
    const name = await page.evaluate(scripts.selectExtraTopic, tags);
    if (!name) break;
    const before = (await page.evaluate(scripts.insertedTopics)).count;
    if (!await page.press('Backspace')) return [`正文里多了不在话题清单里的话题「${name}」，请在小红书页面手动删掉。`];
    await delay(100);
    if ((await page.evaluate(scripts.insertedTopics)).count >= before) return [`正文里多出的话题「${name}」没删掉，请在小红书页面手动删掉。`];
    removed.push(name);
  }
  return removed.length ? [`已删掉正文里不在话题清单里的话题：${removed.join('、')}。`] : [];
}
