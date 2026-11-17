const $ = id => document.getElementById(id);
// 正在跑的操作与它开始的时间：latest.json 更新到这之后才算有了结果。
let running = '', since = '', accounts = [], timer, deadline = 0;
// 上一次读完账号列表的时间：读列表本身是一次任务，跑完宿主会发 refresh，紧跟着的那一下不再读，免得没完没了。
let listedAt = 0;
/** 账号在插件自己的数据目录里（设置里没打开项目也能登录），经 onset.list 现读，不靠项目里的文件。 */
async function loadAccounts() {
  const selected = $('accounts').value;
  let listed = null;
  try { listed = await onset.list('accounts'); } catch (err) { if (!running) status(err.message, true); }
  listedAt = Date.now();
  if (!Array.isArray(listed?.accounts)) return;
  accounts = listed.accounts;
  $('accounts').replaceChildren();
  for (const account of accounts) $('accounts').add(new Option(account.name, account.id));
  if (!accounts.length) $('accounts').add(new Option('还没有账号，先登录一个', ''));
  if (accounts.some(account => account.id === selected)) $('accounts').value = selected;
  buttons();
}
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function buttons() {
  for (const id of ['prepare', 'open']) $(id).disabled = !!running || !$('accounts').value;
  for (const id of ['login', 'refresh']) $(id).disabled = !!running;
  $('accounts').disabled = !!running;
  const account = accounts.find(a => a.id === $('accounts').value);
  $('avatar').hidden = !account?.avatar;
  if (account?.avatar) $('avatar').src = account.avatar;
}
async function read(file) {
  try { return JSON.parse((await onset.read(`production/xiaohongshu/${file}.json`)).text); } catch { return null; }
}
async function refresh() {
  if (running && Date.now() > deadline) {
    running = ''; clearInterval(timer); buttons();
    status('任务长时间没有完成，请查看片场任务列表和小红书窗口。重新上传前先检查已有内容。', true);
    return;
  }
  const latest = await read('latest');
  if (latest && (!running || (latest.updated_at ?? '') >= since)) {
    status(latest.message, ['error', 'interrupted'].includes(latest.status));
    $('warnings').replaceChildren();
    for (const warning of latest.warnings ?? []) { const item = document.createElement('li'); item.textContent = warning; $('warnings').append(item); }
    if (running && latest.status !== 'running') {
      running = ''; clearInterval(timer);
      await loadAccounts();
      if (latest.account && accounts.some(a => a.id === latest.account.id)) $('accounts').value = latest.account.id;
    }
  } else if (!running) status(accounts.length ? '选择账号后，打开小红书或上传并填写。' : '先点「登录新账号」，在弹出的小红书页面登录。');
  buttons();
}
async function run(operation, params = {}) {
  if (running) return;
  running = operation; since = new Date().toISOString(); deadline = Infinity; buttons(); status('正在开始…（如果片场上方弹出确认，请点「执行」）');
  try {
    await onset.run(operation, params);
    deadline = Date.now() + 20 * 60 * 1000;
    status(operation === 'login' ? '请在弹出的小红书页面登录，登录好后会自动回来…' : '正在准备，请在片场内的小红书页面查看进度…');
    timer = setInterval(refresh, 800);
    await refresh();
  } catch (err) { running = ''; status(err.message, true); buttons(); }
}
$('accounts').addEventListener('change', buttons);
$('refresh').onclick = () => { if (!running) void loadAccounts().then(refresh); };
$('login').onclick = () => run('login');
$('open').onclick = () => run('open_account', { account: $('accounts').value });
$('prepare').onclick = () => run('prepare', { account: $('accounts').value });
// 项目或任务有变化（例如在设置里登录了新账号）：重读；自己读列表引起的那一下跳过。
onset.onRefresh(() => { if (!running && Date.now() - listedAt > 3000) void loadAccounts().then(refresh); else void refresh(); });
onset.ready.then(loadAccounts).then(refresh).catch(err => status(err.message, true));
