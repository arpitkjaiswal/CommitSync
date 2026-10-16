import { createGitHubAdapter, validateGitHubConfig, GitHubError } from './github.js';
import { SUBMISSIONS_KEY } from './submissions.js';
export const GH_CONFIG = 'commitflow.github.v1';
export const GH_TOKEN = 'commitflow.github.token.v1';
export const GH_STATE = 'commitflow.github.state.v1';
const targetKey = c => `${c.owner.toLowerCase()}/${c.repo.toLowerCase()}@${c.branch}`;
export function createGitHubService({ local, session, adapterFactory = createGitHubAdapter, now = Date.now }) {
  const read = async (area, key) => (await area.get(key))[key];
  const matches = (credential, config) => !!config && credential?.target === targetKey(config) && typeof credential.token === 'string';
  async function status() {
    const config = await read(local, GH_CONFIG);
    const state = await read(local, GH_STATE);
    return { owner: config?.owner || '', repo: config?.repo || '', branch: config?.branch || 'main',
      tokenConfigured: matches(await read(session, GH_TOKEN), config), last: state?.last || null };
  }
  async function configure(input) {
    const previous = await read(local, GH_STATE) || { completed: [] };
    if (previous.last?.retryAt > now()) throw new GitHubError('RATE_LIMIT', 'Wait until the saved retry time before verifying.', previous.last.retryAt);
    const token = input?.token || (await read(session, GH_TOKEN))?.token;
    const config = validateGitHubConfig({ ...input, token });
    try { await adapterFactory(config).verify(); }
    catch (error) {
      if (error instanceof GitHubError && error.code === 'RATE_LIMIT') {
        await local.set({ [GH_STATE]: { ...previous, last: { code: error.code, message: error.message, retryAt: error.retryAt } } });
      }
      throw error;
    }
    // Only trust this target once access verification succeeds. Never return the token.
    // Bind the session credential to its verified destination before persisting it.
    // A failed second write leaves a mismatch that status/sync reject.
    await session.set({ [GH_TOKEN]: { token: config.token, target: targetKey(config) } });
    await local.set({ [GH_CONFIG]: { owner: config.owner, repo: config.repo, branch: config.branch } });
    const state = await read(local, GH_STATE) || { completed: [] };
    await local.set({ [GH_STATE]: { ...state, last: { code: 'VERIFIED', message: 'Access verified. Ready to sync.', retryAt: 0 } } });
    return status();
  }
  async function disconnect() {
    await session.remove(GH_TOKEN);
    await local.remove(GH_CONFIG);
    return { disconnected: true };
  }
  async function syncNext(expectedTarget) {
    const config = await read(local, GH_CONFIG);
    const credential = await read(session, GH_TOKEN);
    if (!matches(credential, config)) throw new GitHubError('CONFIG', 'Enter a token and verify the repository first.');
    const token = credential.token;
    if (expectedTarget && (expectedTarget.owner !== config.owner || expectedTarget.repo !== config.repo || expectedTarget.branch !== config.branch)) {
      throw new GitHubError('CONFIG', 'Repository settings changed. Reopen the popup and verify the destination.');
    }
    const state = await read(local, GH_STATE) || { completed: [] };
    if (!Array.isArray(state.completed)) throw new GitHubError('STORAGE', 'GitHub sync state is corrupt.');
    if (state.last?.retryAt > now()) throw new GitHubError('RATE_LIMIT', 'Wait until the saved retry time before syncing.', state.last.retryAt);
    const records = (await read(local, SUBMISSIONS_KEY))?.records || [];
    const target = targetKey(config);
    const record = records.find(r => !state.completed.includes(`${target}:${r.submissionId}`));
    if (!record) return { state: 'idle', message: 'No unsynced submissions in the local capture cache.' };
    try {
      const result = await adapterFactory({ ...config, token }).sync(record);
      // If this write fails after the GitHub ref succeeds, replay checks the remote file.
      await local.set({ [GH_STATE]: { completed: [...state.completed, `${target}:${record.submissionId}`].slice(-1000),
        last: { code: 'SUCCESS', message: `${result.state}: ${result.path}`, commit: result.commit, retryAt: 0 } } });
      return result;
    } catch (error) {
      const safe = error instanceof GitHubError ? error : new GitHubError('STORAGE', 'Local sync state could not be saved. Retry safely.');
      try { await local.set({ [GH_STATE]: { ...state, last: { code: safe.code, message: safe.message, retryAt: safe.retryAt } } }); } catch { /* Retry reconciles against GitHub. */ }
      throw safe;
    }
  }
  return { status, configure, disconnect, syncNext };
}
