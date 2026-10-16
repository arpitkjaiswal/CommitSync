import './leetcode.js';
const { validateAccepted } = globalThis.CommitFlowLeetCode;
export const SUBMISSIONS_KEY = 'commitflow.accepted.v1';
export function isLeetCodeSender(sender, extensionId) {
  try {
    const url = new URL(sender.url);
    return sender.id === extensionId && Number.isInteger(sender.tab?.id) && sender.frameId === 0 &&
      url.origin === 'https://leetcode.com';
  } catch { return false; }
}
// Caller must serialize this read/modify/write operation (background queue does).
export async function saveAccepted(storage, value) {
  const record = validateAccepted(value);
  const stored = (await storage.get(SUBMISSIONS_KEY))[SUBMISSIONS_KEY] ?? { ids: [], records: [] };
  if (!Array.isArray(stored.ids) || !Array.isArray(stored.records)) throw new Error('Submission storage is corrupt.');
  if (stored.ids.includes(record.submissionId)) return { duplicate: true, submissionId: record.submissionId };
  const records = [...stored.records, record].slice(-50);
  // Leave headroom under Chrome's older 5 MiB local-storage quota.
  while (new TextEncoder().encode(JSON.stringify(records)).length > 3500000) records.shift();
  await storage.set({ [SUBMISSIONS_KEY]: { ids: [...stored.ids, record.submissionId].slice(-1000), records } });
  return { duplicate: false, submissionId: record.submissionId };
}
