const form = document.querySelector('#settings');
const fields = document.querySelector('#fields');
const nameInput = document.querySelector('#display-name');
const themeInput = document.querySelector('#theme');
const reset = document.querySelector('#reset');
const check = document.querySelector('#check');
const status = document.querySelector('#status');
let loaded = false;

function announce(text, error = false) {
  status.textContent = text;
  status.dataset.error = String(error);
}
async function request(type, config) {
  const response = await chrome.runtime.sendMessage({ namespace: 'commitflow', type, config });
  if (!response?.ok) throw new Error(response?.error || 'No response from the service worker.');
  return response.data;
}
function render(config) {
  nameInput.value = config.displayName;
  themeInput.value = config.theme;
  document.documentElement.dataset.theme = config.theme;
  loaded = true;
}
async function run(action) {
  fields.disabled = true;
  reset.disabled = true;
  check.disabled = true;
  form.setAttribute('aria-busy', 'true');
  try { await action(); }
  catch (error) { announce(`${error.message} Try again or reset preferences.`, true); }
  finally {
    fields.disabled = !loaded;
    reset.disabled = false;
    check.disabled = false;
    form.setAttribute('aria-busy', 'false');
  }
}
form.addEventListener('submit', event => {
  event.preventDefault();
  void run(async () => {
    render(await request('CONFIG_SET', { displayName: nameInput.value, theme: themeInput.value }));
    announce('Preferences saved on this device.');
  });
});
reset.addEventListener('click', () => void run(async () => {
  render(await request('CONFIG_RESET'));
  announce('Default preferences restored.');
}));
check.addEventListener('click', () => void run(async () => {
  const result = await request('PING');
  if (!loaded) render(await request('CONFIG_GET'));
  announce(`Service worker connected · v${result.version}`);
}));
void run(async () => {
  render(await request('CONFIG_GET'));
  announce('Ready. Preferences stay on this device.');
});
