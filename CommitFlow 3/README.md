# CommitFlow v0.3.1

A dependency-free Chrome Manifest V3 extension using vanilla JavaScript, HTML and CSS. Captures newly Accepted LeetCode submissions and offers explicit **Sync next submission** to GitHub using its official REST Git Data API. No automatic/background GitHub uploads. Complete source is included; no build step.

## Install / upgrade

1. Extract the archive. Open `chrome://extensions` in Chrome 102+ and turn on **Developer mode**.
2. Click **Load unpacked**, selecting the `CommitFlow` directory containing `manifest.json`. To upgrade, replace files in your existing unpacked directory and click its **Reload** button.
3. Approve access to `https://api.github.com` if requested. Reload already-open LeetCode tabs for the updated content scripts.
4. Open the popup through Chrome's Extensions menu. Preferences still support display name, system/light/dark theme and reset.

## Configure GitHub

1. Create a repository on GitHub **with a README**, or use an existing initialized repository. Ensure the branch you want already exists.
2. In GitHub: **Settings → Developer settings → Personal access tokens → Fine-grained tokens → Generate new token**.
3. Select the correct resource owner and **Only select repositories**, selecting this repository. Choose a short expiration.
4. Under **Repository permissions**, choose **Contents: Read and write**. Metadata read access is automatically included by GitHub. Do not add Workflows, Administration, Issues or other permissions for CommitFlow. Organization approval may be necessary.
5. Enter the owner, repository name, exact branch and token in the extension popup. Use a `github_pat_…` fine-grained PAT; classic PATs are rejected.
6. Click **Verify & save repository**. Verification reads the repository/branch and creates a constant, unattached Git blob to prove Contents write access. It creates no commit, file or branch update. A repository's `permissions.push` flag alone does not prove a PAT can write.
7. With a visible signed-in LeetCode problem page open, complete a new Accepted submission. Then click **Sync next submission** in the popup to upload one locally captured, unsynced submission. Repeat for additional submissions.

Blank token input retains the current session token during re-verification. Verification failure preserves the previous configuration. A partial persistence failure cannot pair a token with a different repository: session credentials are bound to their verified target, and mismatches block syncing. Unsaved edits must be verified before syncing; stale popup destinations are rejected by the worker. **Disconnect** removes token and target settings; it does not delete remote files, local captures or completion history. Preference Reset affects only appearance/name.

### Empty repositories and branch rules

GitHub documents that the Git Data API cannot create references in an empty repository. CommitFlow detects an empty branch list and stops **before any writes**, asking you to initialize with a README. It does not silently switch to the Contents API. A missing configured branch also stops; create it on GitHub and verify again. Protected branches/rulesets are respected: verification cannot guarantee that a later ref update meets all branch rules. No bypass, force-push or automatic PR creation is attempted.

## Tests

Install Node.js 22+, then run:

```sh
cd CommitFlow
npm run check
npm test
npm run test:integration
# Same full suite:
node --test
# GitHub adapter and durable-state tests only:
node --test tests/github.test.js tests/github-service.test.js
```

No npm install or dependencies. Tests mock HTTP, Chrome APIs, storage and popup behavior; they never use a real token or repository. See AUDIT.md for the executed QA results and TEST-RESULTS.txt for individual test outcomes. Live authenticated Chrome/LeetCode/GitHub behavior has not been tested in this environment.

## Solution paths and deduplication

Files use `solutions/<problem-slug>/<canonical-language>/<submission-id>.<extension>`:

```text
solutions/two-sum/javascript/123.js
solutions/two-sum/python3/124.py
solutions/two-sum/cpp/125.cpp
```

Source bytes are preserved, including Unicode and line endings. Language mapping is explicit in `github.js`; unknown languages stop with an error. Each distinct submission ID has its own immutable file. Different submissions of identical code may intentionally create separate files; retries of the same submission do not create duplicate commits.

Before creating a commit, CommitFlow reads the branch commit and walks only the required Git tree directories. If the exact target contains the expected Git blob SHA, the operation is a duplicate and skips commit/ref creation. Different content, symlinks or occupied directory paths produce a conflict instead of overwriting. Truncated tree responses fail closed.

## Commit transaction and recovery

1. Re-verify repository and write access on every sync.
2. Read the branch head, commit and tree. Check for the existing solution.
3. Create a source blob, then a tree using **base_tree** plus one new entry, preserving unrelated repository files.
4. Create a commit with the observed branch head as its single parent.
5. Re-read the head. If it changed, stop with a conflict; a later user retry rebuilds against the current head.
6. PATCH the branch reference with **force: false**. GitHub's fast-forward guard protects the remaining race window.
7. Persist completion locally only after success or reconciliation.

If the final update response is lost, read the current branch/file to determine whether the expected blob is already present. Never blindly retry a branch PATCH. If a local completion write fails after a remote update, replay recognizes the remote file. Earlier failures may leave unreachable blobs, trees or commits, but do not change repository files; GitHub manages those objects. This is not a multi-request transaction or an exact compare-and-swap against arbitrary external force-pushes. CommitFlow itself never force-pushes.

All popup operations run through the worker's serialized queue, preventing two local syncs from racing. Worker suspension, popup closure or browser restart can interrupt work; use Sync next again after reconnecting. Remote-file checks make this replay safe. There are no alarms, automatic background retry loops or all-record batch uploads.

## Errors and retries

| Failure | Behavior |
| --- | --- |
| Network/timeouts, GitHub 5xx | Up to 3 attempts per safe request, 500 ms then 1 s backoff; 15 s request timeout |
| 401 | Stop; replace expired/invalid token and verify |
| 403 access denied | Stop; check Contents permission, organization approval and branch rules |
| 403 rate limit / 429 | Honor Retry-After/reset headers with at least 60 s cooldown; persist retry time across worker restarts |
| 404 | Stop; repository/branch absent or inaccessible |
| 409/422 | Conflict/validation failure; no forced update; retry explicitly after resolving |
| Lost PATCH response | Reconcile current remote content before reporting failure |
| Local write failure | Keep submission retryable; next attempt checks remote content |

Rate-limit cooldown is enforced for subsequent verify/sync requests. After the displayed time, click Sync next again. For non-rate-limit transient failures, click again once bounded retries are exhausted. A failed oldest submission remains first in the queue until resolved. HTTP/API error bodies and transport exception text are not displayed or logged, preventing reflected credentials from leaking.

## Token storage and trust boundary

The PAT is stored **only in `chrome.storage.session`**, bound to the verified repository/branch and restricted to `TRUSTED_CONTEXTS`. It survives service-worker restarts but is cleared by a browser restart or extension reload/disable/update. Re-enter the token afterward. Repository settings and sync metadata persist in `chrome.storage.local`; the PAT never does. Both storage areas must successfully restrict access before any message handler can read/write secrets; failure blocks operations.

Session memory is **not an encrypted credential vault**. Malicious extension code, privileged debugging, a compromised browser/OS or someone controlling your active browser session may obtain the token. The popup briefly holds it during entry and sending; its password input is cleared after submission. JavaScript cannot guarantee immediate memory erasure. Use a short-lived token limited to one repository, revoke it on suspected exposure, and never include it in screenshots or support logs.

No token, authorization header or GitHub API error body is logged. `GH_STATUS` returns only `tokenConfigured`, never token bytes. Content scripts may only send validated Accepted records; every `GH_*` and configuration route requires the extension's exact popup URL and ID, excluding tab senders. Tokens travel only from popup to worker and from worker to `https://api.github.com` over HTTPS. Redirects are rejected; no arbitrary-URL fetch proxy exists. Page scripts receive no GitHub credentials. This does not cryptographically authenticate source code against a compromised renderer; captured source must still be treated as untrusted data.

Only `storage` plus the GitHub API host permission are requested. LeetCode uses declarative isolated content scripts on the exact `https://leetcode.com/*` origin. No cookies, webRequest, scripting, activeTab, tabs or alarms permissions. Code is packaged locally; no CDN or remotely hosted code.

## LeetCode capture scope and local state

The isolated adapter polls a visible problem page every five seconds, using the signed-in user's same-origin GraphQL session. It checks detail verdict code 10 before emitting any record and retrieves submission ID, slug, title, language, Unix timestamp and submitted source. Pending/null details wait within 30 checks / 15 minutes. Rejected verdicts never sync. Authentication/schema failures stop polling until the page is reloaded after correction. Network/rate-limit failures back off. See **LEETCODE-API.md** for all undocumented GraphQL dependencies and sources inspected.

This is not historical import: completed submissions predating the capture session are ignored; older pending submissions observed while judging can complete now. Polling examines the latest 20 submissions for the current problem. Closing/reloading tabs loses the pending tracker, and browser throttling can delay detection. Contest paths, leetcode.cn and offline capture are unsupported.

Local captures retain up to 50 records / approximately 3.5 MB, with 1,000 Accepted IDs. Sync completion history retains 1,000 target-plus-submission keys. Old unsynced captures can be evicted; this is a bounded cache, not archival storage. Completion is scoped by owner/repository/branch. Previously completed entries are not automatically restored after deliberate remote deletion; clearing completion history allows explicit replay.

Inspect non-secret state from the extension service-worker inspector:

```js
await chrome.storage.local.get([
  'commitflow.accepted.v1',
  'commitflow.github.v1',
  'commitflow.github.state.v1'
]);
```

For an intentional full rescan of retained captures, remove `commitflow.github.state.v1`. Existing identical remote files remain duplicates. Do not inspect or print session token storage in logs.

## Complete changes

- **New:** `github.js` (REST adapter, validation, paths, blob hashing, Git transaction/recovery).
- **New:** `github-service.js` (session credential management, verified configuration, durable sync status).
- **New:** `github-popup.js` (verification/sync/disconnect UI).
- **Updated:** `background.js`, `manifest.json`, `popup.html`, `popup.css`, `package.json`, `README.md`.
- **New:** `LEETCODE-API.md`, `tests/github.test.js`, `tests/github-service.test.js`.
- **Updated:** `tests/scaffold.test.js` (GitHub sender isolation, storage isolation failure and manifest changes).
- **Retained:** `config.js`, `leetcode.js`, `submissions.js`, `content.js`, `popup.js`, and existing LeetCode/content/popup tests.

## Manual release verification

Use an initialized disposable repository. Verify the token, capture an Accepted solution, sync and compare exact source/path. Confirm unrelated files remain. Replay the same record after clearing local completion history and confirm no extra commit. Test a read-only/expired token, empty repository, missing/protected branch and an external branch advance. Test interrupted connectivity around the final PATCH; replay should reconcile or safely retry. Restart Chrome to verify the token is gone. Confirm LeetCode content-script requests to `GH_STATUS`/`GH_SYNC` are denied. The automated suite covers these adapter/state failure modes with mocks; real browser UI and API testing remains manual.

## Official GitHub references inspected

The adapter pins REST API version `2026-03-10`, as shown in the current official documentation inspected during implementation.

- Git database overview and empty-repository limitation: https://docs.github.com/en/rest/guides/using-the-rest-api-to-interact-with-your-git-database
- References / fast-forward updates: https://docs.github.com/en/rest/git/refs
- Trees / base_tree: https://docs.github.com/en/rest/git/trees
- Blobs: https://docs.github.com/en/rest/git/blobs
- Commits: https://docs.github.com/en/rest/git/commits
- Permission matrix: https://docs.github.com/en/rest/authentication/permissions-required-for-fine-grained-personal-access-tokens
- Retry/rate-limit guidance: https://docs.github.com/en/rest/using-the-rest-api/best-practices-for-using-the-rest-api
