const form = document.querySelector('#github-settings');
const fields = document.querySelector('#github-fields');
const owner = document.querySelector('#github-owner');
const repo = document.querySelector('#github-repo');
const branch = document.querySelector('#github-branch');
const token = document.querySelector('#github-token');
const status = document.querySelector('#github-status');
let busy = false;
let savedTarget = null;
async function call(type, config) {
  const response = await chrome.runtime.sendMessage({ namespace: 'commitflow', type, config });
  if (!response?.ok) {
    const retry = response?.retryAt ? ` Retry after ${new Date(response.retryAt).toLocaleString()}.` : '';
    throw new Error((response?.error || 'Extension unavailable.') + retry);
  }
  return response.data;
}
async function run(task) {
  if (busy) return;
  busy = true; fields.disabled = true; status.dataset.error = 'false';
  status.textContent = 'Working…';
  try { await task(); }
  catch (error) { status.textContent = error.message; status.dataset.error = 'true'; }
  finally { token.value = ''; fields.disabled = false; busy = false; }
}
function render(data) {
  savedTarget = { owner: data.owner, repo: data.repo, branch: data.branch };
  owner.value = data.owner; repo.value = data.repo; branch.value = data.branch;
  token.placeholder = data.tokenConfigured ? 'Session token saved; leave blank to keep it' : 'github_pat_…';
  status.textContent = data.tokenConfigured
    ? (data.last?.message || 'Ready to verify and sync.')
    : 'Enter a fine-grained token and verify access. No background syncing.';
  if (data.last?.retryAt) status.textContent += ` Retry after ${new Date(data.last.retryAt).toLocaleString()}.`;
}
form.addEventListener('submit', event => {
  event.preventDefault();
  const config = { owner: owner.value.trim(), repo: repo.value.trim(), branch: branch.value.trim(), token: token.value.trim() };
  token.value = '';
  void run(async () => render(await call('GH_CONFIGURE', config)));
});
document.querySelector('#github-sync').addEventListener('click', () => void run(async () => {
  if (!savedTarget || owner.value.trim() !== savedTarget.owner || repo.value.trim() !== savedTarget.repo || branch.value.trim() !== savedTarget.branch || token.value.trim()) {
    throw new Error('Verify and save your edited GitHub settings before syncing.');
  }
  const result = await call('GH_SYNC', savedTarget);
  status.textContent = result.message || `${result.state}: ${result.path}`;
}));
document.querySelector('#github-disconnect').addEventListener('click', () => void run(async () => {
  await call('GH_DISCONNECT'); render(await call('GH_STATUS'));
}));
void run(async () => render(await call('GH_STATUS')));
