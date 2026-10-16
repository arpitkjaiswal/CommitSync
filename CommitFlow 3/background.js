import { GitHubError } from './github.js';
import { createGitHubService } from './github-service.js';
import { createConfigStore } from './config.js';
import { isLeetCodeSender, saveAccepted } from './submissions.js';

const github = createGitHubService({ local: chrome.storage.local, session: chrome.storage.session });
let storageReady;
const store = createConfigStore(chrome.storage.local);
// Serialize reads and writes in arrival order. Durable state stays in storage.
let queue = Promise.resolve();
function enqueue(task) {
  const result = queue.then(async () => {
    await storageReady;
    return task();
  });
  queue = result.catch(() => {});
  return result;
}

// Register synchronously at module evaluation, before any asynchronous work.
// No onInstalled write is needed: missing configuration uses lazy defaults.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.namespace !== 'commitflow') return false;
  if (typeof message.type !== 'string') {
    sendResponse({ ok: false, error: 'Invalid message type.' });
    return false;
  }
  if (message.type === 'LEETCODE_ACCEPTED') {
    if (!isLeetCodeSender(sender, chrome.runtime.id)) {
      sendResponse({ ok: false, error: 'Unauthorized sender.' });
      return false;
    }
    enqueue(() => saveAccepted(chrome.storage.local, message.record)).then(
      data => sendResponse({ ok: true, data }),
      () => sendResponse({ ok: false, error: 'Could not validate or store submission.' })
    );
    return true;
  }
  if (sender.id !== chrome.runtime.id || sender.tab ||
      sender.url !== chrome.runtime.getURL('popup.html')) {
    sendResponse({ ok: false, error: 'Unauthorized sender.' });
    return false;
  }

  enqueue(async () => {
    switch (message.type) {
      case 'GH_STATUS': return github.status();
      case 'GH_CONFIGURE': return github.configure(message.config);
      case 'GH_DISCONNECT': return github.disconnect();
      case 'GH_SYNC': return github.syncNext(message.config);
      case 'PING': return { status: 'ready', version: chrome.runtime.getManifest().version };
      case 'CONFIG_GET': return store.read();
      case 'CONFIG_SET': return store.save(message.config);
      case 'CONFIG_RESET': return store.reset();
      default: throw new Error('Unknown CommitFlow message.');
    }
  }).then(
    data => sendResponse({ ok: true, data }),
    error => sendResponse({ ok: false, error: message.type.startsWith('GH_')
      ? (error instanceof GitHubError ? error.message : 'GitHub operation could not complete.')
      : error.message || 'Operation failed.', code: error.code, retryAt: error.retryAt || 0 })
  );
  return true; // Keep the response channel open for asynchronous storage calls.
});

// Both areas must be restricted before ANY message may read/write credentials.
// Listener registration above remains synchronous. Never swallow isolation failures.
storageReady = Promise.resolve().then(() => Promise.all([
  chrome.storage.local.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' }),
  chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' })
])).then(() => true, () => { throw new Error('Secure storage unavailable. Reload the extension.'); });
// Mark the promise handled even before the first message; enqueue still awaits rejection.
void storageReady.catch(() => {});
