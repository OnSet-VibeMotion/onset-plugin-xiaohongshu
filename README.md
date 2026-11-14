# 片场 · 小红书上传助手

片场的独立插件。选一个小红书账号，打开浏览器，上传成片和封面、填写文案，最后由你在小红书页面手动发布。

支持多个账号。每个账号使用独立的浏览器资料目录，登录状态保存在本机；账号在不同片场项目之间共用。

## 在片场中安装

需要支持第三方插件和 `{node}` 运行时的片场客户端，以及已经安装的 Google Chrome 或 Microsoft Edge。插件使用客户端自带的 Node 运行时，用户不需要安装 Node、Python 或 npm。

打开片场「设置 → 我的插件」，添加来源：

```text
github:OnSet-VibeMotion/onset-plugin-xiaohongshu#main
```

检查插件说明后点「装上」。如果仓库是私有的，本机 Git 需要已有该仓库的读取权限。

本地开发可添加 `link:/本机绝对路径/onset-plugin-xiaohongshu`。仓库包含已构建的 `dist/plugin.cjs`，客户端克隆后可以直接运行，不会在上传时下载依赖。

## 使用

1. 在片场完成视频和小红书发布信息，`publish.md` 中的 `platform` 应是 `xiaohongshu`。
2. 打开发布页中的「小红书上传助手」，展开「管理账号」，填写备注名并点「添加并登录」。在新开的浏览器窗口中登录。
3. 可以继续添加工作号、个人号等。改备注名会保留该账号的登录状态。「刷新账号」可同步其他项目中新增的账号。
4. 选择账号，点「上传并填写」，在片场的操作确认条中执行。插件打开这个账号的新窗口，上传视频和封面，填入标题、正文、话题及必要的素材署名。
5. 页面提示「内容已填好」后，在小红书窗口核对实际账号、封面、文案和平台要求，再手动点击发布。

「打开小红书」只打开所选账号的创作者后台，不上传素材。首次添加的账号备注是你自己起的名字，不代表已经完成登录，也不代表平台认证的账号名称。

## 内容与状态

- 本版处理**视频笔记**，从 `publish.md` 读取 `video.path`、`copy.primary_title`、`copy.introduction`、`copy.hashtags`、`credits` 和 `cover.images`。封面优先使用小红书的 3:4 版本；没有明确的候选时停止并说明原因。
- 有成片 SHA-256 时会校验，视频变化后需要先刷新发布信息。路径只接受项目内的文件，不允许通过符号链接上传项目外的文件。
- 话题匹配不到联想项时保留 `#话题` 文字并提醒人工检查。封面设置失败会报告失败，保留浏览器供你处理。
- `ready_to_publish` 只表示内容已经填好，**不表示发布成功**。插件没有点击发布、定时提交、后台批量发布或自动重试提交的功能。
- 每次上传会打开新的编辑页面。重新上传前先检查已有窗口，避免在已经手动发布后重复准备。
- 登录失效时需要在打开的窗口重新登录。如果登录后停留在首页，回片场重新点「上传并填写」。

## 数据存放

账号列表与 Chrome/Edge Profile 保存在片场传入的插件私有数据目录：

```text
<片场数据目录>/onset/stations/xiaohongshu-upload/data/accounts/<账号编号>/
  account.json
  browser/
```

登录凭据不写进视频项目和 Git 仓库。项目内 `production/xiaohongshu/` 仅记录账号备注列表、操作进度和准备状态。自动化断开时保留浏览器，关闭窗口由用户决定。

账号隔离与浏览器连接使用原生 Chrome DevTools Protocol；不会读取用户日常浏览器的资料目录，不依赖额外的 MCP 服务。

## 开发与验证

```bash
npm ci
npm run check
npm run test:coverage
```

测试需要本机已安装 Chrome。浏览器测试在临时账号目录和本机模拟页面中运行，覆盖文件上传、表单填写、账号 Cookie 隔离、窗口保留、发布按钮不被点击及插件页面的账号选择。不会连接真实账号或上传真实素材。

Node 侧覆盖率检查包含账号、文件校验、浏览器连接和流程编排，门槛为 80%。`src/page-scripts.ts` 在 Chromium 中执行，由浏览器测试验证，不计入 Node 的覆盖率统计。

修改源码后运行 `npm run build`，将 `dist/plugin.cjs` 一起提交。CI 会重新构建并检查产物一致。

可额外校验与本地片场源码的契约：

```bash
node scripts/check-host.mjs /本机路径/auto-motion
```

已经验证 macOS + Chrome 的模拟页面流程。真实小红书登录和上传仍需要有账号的人验收；网站 DOM 更新可能要求调整 `src/prepare.ts` 的选择器。Windows/Linux 的浏览器路径已列出，尚未进行真机验收。

## 流程参考

实现独立编写，发布页流程参考以下项目；未将它们的服务或脚本作为运行依赖：

- [social-auto-upload 小红书浏览器实现](https://github.com/dreammis/social-auto-upload/blob/main/uploader/xiaohongshu_uploader/main.py)：视频及封面上传流程。
- [XiaohongshuSkills](https://github.com/white0dew/XiaohongshuSkills)：使用 CDP 设置上传文件、分离填表与提交。
- [xiaohongshu-mcp](https://github.com/xpzouying/xiaohongshu-mcp)：创作者页面等待和控件定位参考。
- [Chrome 关于独立调试资料目录的说明](https://developer.chrome.com/blog/remote-debugging-port)。

打包依赖 `yaml` 的 MIT 许可随仓库保留在 `licenses/` 中。
