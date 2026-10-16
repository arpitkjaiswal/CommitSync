import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createConfigStore } from '../../config.js';
import { createGitHubService } from '../../github-service.js';
import { createGitHubAdapter, GitHubError, gitBlobSHA } from '../../github.js';
import { saveAccepted, isLeetCodeSender } from '../../submissions.js';
const load = name => readFile(new URL(`../../${name}`, import.meta.url), 'utf8');
const workerSource = await load('background.js');
const lcSource = await load('leetcode.js');
const contentSource = await load('content.js');
export const TOKEN = 'github_pat_' + 'audit_secret_'.repeat(3);
export const CONFIG = { owner: 'tester', repo: 'solutions', branch: 'main', token: TOKEN };
export const flush = async () => { for (let i = 0; i < 15; i++) await new Promise(r => setImmediate(r)); };
const hash = x => createHash('sha1').update(JSON.stringify(x)).digest('hex');
const response = (status, data, headers = {}) => ({ status, ok: status >= 200 && status < 300, headers: new Headers(headers), json: async () => structuredClone(data) });
export function storage() {
  const data = {};
  return { data, async setAccessLevel() {}, async get(key) { return { [key]: structuredClone(data[key]) }; },
    async set(value) { Object.assign(data, structuredClone(value)); }, async remove(key) { delete data[key]; } };
}
export function githubServer() {
  const calls = [], faults = [], blobs = new Map(), trees = new Map(), commits = new Map();
  let sequence = 0; let committed = 0;
  function buildTree(files) {
    const entries = new Map();
    const groups = new Map();
    for (const [path, blob] of Object.entries(files)) {
      const [name, ...rest] = path.split('/');
      if (!rest.length) entries.set(name, { path: name, type: 'blob', mode: '100644', sha: blob });
      else { const group = groups.get(name) || {}; group[rest.join('/')] = blob; groups.set(name, group); }
    }
    for (const [name, group] of groups) entries.set(name, { path: name, type: 'tree', mode: '040000', sha: buildTree(group) });
    const tree = [...entries.values()].sort((a,b) => a.path.localeCompare(b.path));
    const id = hash(tree); trees.set(id, { tree, files: { ...files } }); return id;
  }
  const readme = hash('existing readme');
  let head = hash('initial'); commits.set(head, { tree: buildTree({ 'README.md': readme }) });
  const fetchFn = async (url, options) => {
    const path = url.replace('https://api.github.com/repos/tester/solutions', '');
    const body = options.body ? JSON.parse(options.body) : undefined;
    calls.push({ path, method: options.method, body, authorization: options.headers.Authorization });
    const index = faults.findIndex(f => f.path === path && (!f.method || f.method === options.method));
    const fault = index < 0 ? null : faults.splice(index, 1)[0];
    if (fault && !fault.afterApply) {
      if (fault.network) throw new Error('mock transport: ' + TOKEN);
      return response(fault.status, { message: 'mock server body: ' + TOKEN }, fault.headers);
    }
    let result;
    if (path === '') result = response(200, { permissions: { push: true } });
    else if (path === '/branches?per_page=1') result = response(200, [{ name: 'main' }]);
    else if (path === '/git/ref/heads/main') result = response(200, { ref: 'refs/heads/main', object: { type: 'commit', sha: head } });
    else if (path === '/git/blobs') { const id = await gitBlobSHA(body.content); blobs.set(id, body.content); result = response(201, { sha: id }); }
    else if (path.startsWith('/git/commits/')) result = response(200, { tree: { sha: commits.get(path.split('/').at(-1)).tree } });
    else if (path.startsWith('/git/trees/')) result = response(200, { tree: trees.get(path.split('/').at(-1)).tree, truncated: false });
    else if (path === '/git/trees') {
      const files = { ...trees.get(body.base_tree).files };
      for (const entry of body.tree) files[entry.path] = entry.sha;
      result = response(201, { sha: buildTree(files) });
    } else if (path === '/git/commits') { const id = hash([body, sequence++]); commits.set(id, { tree: body.tree, parent: body.parents[0] }); result = response(201, { sha: id }); }
    else if (path === '/git/refs/heads/main') {
      if (body.force !== false || commits.get(body.sha).parent !== head) return response(409, {});
      head = body.sha; committed++; result = response(200, { object: { sha: head } });
    } else throw new Error(`Unexpected mocked GitHub route: ${path}`);
    if (fault?.afterApply) throw new Error('lost response: ' + TOKEN);
    return result;
  };
  return { calls, faults, fetchFn, get committed() { return committed; }, get files() { return trees.get(commits.get(head).tree).files; },
    get source() { return Object.fromEntries(Object.entries(this.files).map(([p, id]) => [p, blobs.get(id)])); },
    advance() { const next = hash(['external', sequence++]); commits.set(next, { tree: commits.get(head).tree, parent: head }); head = next; } };
}
export function environment() {
  const local = storage(), session = storage(), github = githubServer();
  const logs = [], replies = [], contentMessages = [], lcRequests = [], waits = [];
  let listener;
  const lc = { status: 0, http: 200, failures: 0, timestamp: Math.floor(Date.now()/1000), code: 'return [0, 1];\n' };
  const log = (...args) => logs.push(args);
  function restart() {
    const runtime = { id: 'audit', getURL: path => `chrome-extension://audit/${path}`, getManifest: () => ({ version: 'audit' }), onMessage: { addListener(fn) { listener = fn; } } };
    vm.runInNewContext(workerSource.replace(/^import .*;\n/gm, ''), {
      chrome: { runtime, storage: { local, session } }, console: { error: log, warn: log, log },
      createConfigStore, saveAccepted, isLeetCodeSender, GitHubError,
      createGitHubService: args => createGitHubService({ ...args, adapterFactory: config => createGitHubAdapter(config, { fetchFn: github.fetchFn, sleep: async ms => waits.push(ms) }) })
    });
  }
  const popup = { id: 'audit', url: 'chrome-extension://audit/popup.html' };
  const content = { id: 'audit', url: 'https://leetcode.com/problems/two-sum/', tab: { id: 1 }, frameId: 0 };
  function send(type, payload = {}, sender = popup) {
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('No worker reply')), 2000);
      listener({ namespace: 'commitflow', type, ...payload }, sender, reply => { clearTimeout(timeout); replies.push(reply); resolve(reply); });
    });
  }
  function startContent() {
    const timers = new Map(); let next = 0;
    const fetchFn = async (url, options) => {
      lcRequests.push({ url, headers: options.headers });
      if (lc.failures-- > 0) throw new Error('offline');
      if (lc.http !== 200) return response(lc.http, {});
      const request = JSON.parse(options.body);
      return response(200, { data: request.query.includes('CommitFlowSubmissions')
        ? { userStatus: { isSignedIn: true, username: 'tester' }, submissionList: { submissions: [{ id: '123', timestamp: lc.timestamp, statusDisplay: lc.status === 0 ? 'Judging' : 'Finished' }] } }
        : { submissionDetails: { statusCode: lc.status, timestamp: lc.timestamp, code: lc.code, lang: { name: 'JavaScript' }, question: { titleSlug: 'two-sum' } }, question: { title: 'Two Sum', titleSlug: 'two-sum' } } });
    };
    const context = vm.createContext({ URL, AbortController, Date, fetch: fetchFn,
      setTimeout: (fn, ms) => { timers.set(++next, { fn, ms }); return next; }, clearTimeout: id => timers.delete(id),
      document: { hidden: false, cookie: 'csrftoken=leetcode-only' }, location: { href: content.url },
      console: { warn: log }, chrome: { runtime: { sendMessage: message => { contentMessages.push(message); return send(message.type, { record: message.record }, content); } } }
    });
    vm.runInContext(lcSource, context); vm.runInContext(contentSource, context);
    return { timers, async tick() { await flush(); const item = [...timers].find(([,v]) => v.ms !== 15000); if (item) { timers.delete(item[0]); await item[1].fn(); } await flush(); } };
  }
  restart();
  return { local, session, github, lc, logs, replies, contentMessages, lcRequests, waits, restart, send, startContent, content };
}
