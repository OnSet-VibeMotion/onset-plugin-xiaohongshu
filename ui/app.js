const $ = id => document.getElementById(id);
let activeRequest = '', accounts = [], timer, deadline = 0;
function status(message, error = false) { $('status').textContent = message; $('status').dataset.error = String(error); }
function buttons() {
  for (const id of ['prepare', 'open', 'rename']) $(id).disabled = !!activeRequest || !$('accounts').value;
  for (const id of ['add', 'refresh']) $(id).disabled = !!activeRequest;
  $('accounts').disabled = !!activeRequest;
}
async function read(file) {
  try { return JSON.parse((await onset.read(`production/xiaohongshu/${file}.json`)).text); } catch { return null; }
}
async function refresh() {
  if (activeRequest && Date.now() > deadline) {
    activeRequest = ''; clearInterval(timer); buttons();
    status('任务长时间没有完成，请查看片场任务列表和小红书窗口。重新上传前先检查已有内容。', true);
    return;
  }
  const snapshot = await read('accounts');
  const selected = $('accounts').value;
  if (snapshot?.accounts) {
    accounts = snapshot.accounts;
    $('accounts').replaceChildren();
    for (const account of accounts) { const option = document.createElement('option'); option.value = account.id; option.textContent = account.name; $('accounts').append(option); }
    if (!accounts.length) $('accounts').add(new Option('先添加一个小红书账号', ''));
    if (accounts.some(account => account.id === selected)) $('accounts').value = selected;
  }
  const latest = await read('latest');
  if (latest && (!activeRequest || latest.request_id === activeRequest)) {
    status(latest.message, ['error', 'interrupted'].includes(latest.status));
    $('warnings').replaceChildren();
    for (const warning of latest.warnings ?? []) { const item = document.createElement('li'); item.textContent = warning; $('warnings').append(item); }
    if (activeRequest && latest.status !== 'running') {
      activeRequest = ''; clearInterval(timer);
      if (latest.account && accounts.some(a => a.id === latest.account.id)) $('accounts').value = latest.account.id;
    }
  } else if (!activeRequest) status(snapshot ? '选择账号后，打开小红书或上传并填写。' : '首次使用请添加账号；已有账号请点「刷新账号」。');
  buttons();
}
async function run(operation, params = {}) {
  if (activeRequest) return;
  const requestID = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  activeRequest = requestID; deadline = Infinity; buttons(); status('请在片场上方确认这次操作');
  try {
    await onset.run(operation, { ...params, request_id: requestID });
    deadline = Date.now() + 20 * 60 * 1000;
    status('正在准备，请在片场内的小红书页面查看进度…');
    timer = setInterval(refresh, 800);
    await refresh();
  } catch (err) { activeRequest = ''; status(err.message, true); buttons(); }
}
$('accounts').addEventListener('change', buttons);
$('refresh').onclick = () => run('accounts');
$('open').onclick = () => run('open_account', { account: $('accounts').value });
$('prepare').onclick = () => run('prepare', { account: $('accounts').value });
$('add').onclick = () => {
  const name = $('name').value.trim(); if (!name) return status('先填写一个账号备注名', true);
  run('add_account', { name });
};
$('rename').onclick = () => {
  const name = $('name').value.trim(); if (!name) return status('先填写新的备注名', true);
  run('rename_account', { account: $('accounts').value, name });
};
onset.onRefresh(refresh);
onset.ready.then(refresh).catch(err => status(err.message, true));
