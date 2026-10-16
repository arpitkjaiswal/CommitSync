# CommitFlow QA and security audit — v0.3.1

Audit performed 2026-10-17 IST against the delivered v0.3.0 archive. Runtime: Node v24.19.0. This report describes tests actually executed; it is not a claim of live-browser or production certification.

## Outcome

**69 automated tests passed, 0 failed, 0 skipped** after fixes. **14 mocked end-to-end integration tests passed** when run separately. **19 JavaScript syntax checks**, **2 JSON parses**, and manifest/popup packaged-resource checks passed. Individual final test results are in `TEST-RESULTS.txt`; syntax/resource output is in `CHECK-RESULTS.txt`.

The baseline suite was executed before changes: 51 passed. New regression tests then reproduced three failures. All three were fixed and their regression tests rerun successfully. The final suite includes all original tests.

## Reproduced defects and fixes

| Finding | Reproduction observed before fix | Fix and regression coverage |
| --- | --- | --- |
| Storage initialization could fail outside its security gate | The new end-to-end synchronous `setAccessLevel` exception test failed: worker evaluation threw before `storageReady` was assigned, despite a registered listener | Initialize the gate through a Promise before calling storage APIs. Both synchronous exceptions and asynchronous rejection block queued operations. Also test delayed initialization: no GitHub calls before both restrictions complete. |
| Partial configuration writes could pair the wrong token/target | A simulated replacement session write plus failed cleanup left the newly saved repository paired with the previous token; the regression expected the old repository but observed the new one | Store a session credential object bound to its verified repository/branch before updating persistent target settings. Reject target/credential mismatches. Tests cover first-write failure, second-write failure and worker restart. |
| Unsaved popup edits could sync to the previous repository | Editing the displayed repository and clicking Sync sent `GH_SYNC` for the old persisted destination; the regression failed | Require verification of edited fields. Include the displayed saved destination in sync messages, and reject stale popup destinations in the worker service. Tests prove no sync call after unsaved edits and no adapter call for a stale target. |

The first integration run had 11 passes / 1 failure. The separate popup/service regression run had 6 passes / 2 failures. After fixes, the combined focused run had 20 passes / 0 failures. Subsequent complete runs passed 67 tests, then the final 69 after adding protected-branch and LeetCode-403 integration cases.

## End-to-end test boundary

`tests/helpers/integration-harness.js` executes the actual `content.js` and `leetcode.js` in an isolated Node VM. Messages cross into the actual worker listener body, its real configuration/capture/sync services and the real GitHub adapter. Static worker imports are supplied as the real imported dependencies; only the adapter's HTTP/sleep dependencies and Chrome surfaces are mocked.

The GitHub mock models blobs, nested trees, commits, a branch head and fast-forward enforcement. It retains a pre-existing README and records ref-update payloads. It can return errors before mutation or lose a response after applying a ref update. The LeetCode mock returns list/detail GraphQL responses. Tests drive the real content scheduler without real waiting.

This exercises the complete application flow with mocks. It does **not** execute Chrome's actual ESM service-worker loader, extension installation, browser permissions, rendering, cookie policies, CORS/CSP enforcement, or OS lifecycle.

## Coverage actually executed

| Scenario | Result and evidence |
| --- | --- |
| Delayed judging | Multiple pending polls store nothing; Accepted details subsequently create one local record and upload exact source. |
| Duplicate events / multiple tabs | Duplicate capture messages leave one record. |
| Concurrent sync attempts | Two worker messages are serialized and produce one branch commit. |
| Rejected verdicts | No capture message, local record or GitHub commit. Unit tests cover known rejected status codes. |
| Expired LeetCode session | HTTP 401 and 403 stop the content scheduler without capture/upload. |
| GitHub 401 | Sanitized authentication error, no branch update; retry succeeds after mocked correction. |
| GitHub 403 | Read/access denial and protected-branch PATCH denial stop safely; no force-push. |
| GitHub 409 / 422 | Ref conflict responses are reconciled without force; later explicit retry succeeds. |
| GitHub 429 | Retry time is persisted. A reconstructed worker blocks premature calls; retry succeeds after simulated elapsed cooldown. |
| Network failures | Content polling backs off; GitHub safe operations retry with bounded backoff. Exhaustion and timeout are covered by adapter tests. |
| Initialization race | Requests wait for both storage-access promises; synchronous and asynchronous failure block credential operations. |
| Worker reconstruction | Same storage survives a fresh worker listener; completed submissions remain deduplicated and cooldown remains enforced. |
| Lost response / partial failure | A successfully applied PATCH with a lost response is reconciled. A lost completion ledger is replayed without another branch commit. Unit tests additionally cover local write failure and failed tree creation. |
| Existing files | The mocked pre-existing README remains; unrelated tree entries are preserved through `base_tree`. Conflicting solution files/symlinks and truncated trees are rejected. |
| No force-push | All inspected ref writes use literal `force: false`; the mock rejects unsafe writes. |
| No duplicate reachable commits | Duplicate/concurrent/restart/reconciliation scenarios keep exactly one applied branch commit for the submission. Unreachable objects can still be created during failed attempts. |
| Credential isolation | The fake PAT is absent from local persistent storage, worker replies, content messages, LeetCode request headers and captured logs. Content senders are denied all GitHub/configuration routes. Reflected token text in mock transport/server errors does not appear in returned errors. Session memory and GitHub Authorization headers intentionally contain the PAT. |
| Existing scaffold | All prior configuration, popup, manifest, API validation, retry and persistence tests remain in the full run. |

These are assertions over the tested scenarios, not proof that arbitrary future code or a compromised browser cannot expose secrets.

## Exact verification commands

From the extracted project directory:

```sh
node --version
npm run check
npm test
npm run test:integration
```

The final recorded complete test run was executed as:

```sh
node --test --test-reporter=tap CommitFlow/tests/*.test.js
```

from its parent directory. The standalone integration run used `node --test CommitFlow/tests/integration.test.js` there. `npm test` was also executed during the audit, including the 67-test complete run. The equivalent npm commands above are provided for reproduction.

No ESLint, HTML validator, CSS validator or third-party test framework is configured in this dependency-free project. Optional `tinycss2`/`html5lib` imports were attempted in both Python environments; the parser dependencies were unavailable. Consequently, no HTML/CSS grammar or visual-rendering pass is claimed. The implemented check verifies JS syntax, JSON parsing, absence of inline HTML handlers and existence of local manifest/HTML resource references. npm emitted an environment `http-proxy` configuration warning; it did not fail the runs.

## Every changed file relative to v0.3.0

| File | Change |
| --- | --- |
| `background.js` | Promise-wrapped storage isolation initialization; forward displayed destination to sync service. |
| `github-service.js` | Destination-bound session credentials; safe write ordering; mismatch/stale-destination rejection. |
| `github-popup.js` | Remember displayed saved destination and block syncing with unverified edits. |
| `manifest.json` | Version 0.3.1; permissions unchanged. |
| `package.json` | Version 0.3.1; add `check` and `test:integration` scripts. |
| `README.md` | Version, audit commands/results pointers and updated credential/destination behavior. |
| `tests/github-service.test.js` | Update session credential shape and add partial-write/stale-target regressions. |
| `tests/github-popup.test.js` | New unsaved-destination regression against the actual popup script. |
| `tests/integration.test.js` | New 14-case mocked end-to-end suite. |
| `tests/helpers/integration-harness.js` | New Chrome/storage bridge, content VM and stateful LeetCode/GitHub mocks. |
| `scripts/check.mjs` | New dependency-free syntax, JSON and packaged-resource check. |
| `CHECK-RESULTS.txt` | Captured executed check output. |
| `TEST-RESULTS.txt` | Captured TAP output for all 69 final tests. |
| `AUDIT.md` | This audit report. |

All other project files are unchanged from the delivered v0.3.0 archive.

## Exact Chrome installation / upgrade steps

1. Extract `CommitFlow-audited-v0.3.1.zip` to a stable directory. Keep the full `CommitFlow` folder together; do not select or load the ZIP itself.
2. In desktop Chrome 102 or newer, type `chrome://extensions` into the address bar.
3. Enable **Developer mode** at the top right.
4. For a new installation, click **Load unpacked** and select the extracted `CommitFlow` folder containing `manifest.json`.
5. For an existing unpacked installation, replace its files with this folder's contents and click **Reload** on its existing extension card. Avoid loading two copies; using the same directory preserves extension identity/local captures.
6. Confirm the extension card shows version **0.3.1** and no errors. Allow the LeetCode and GitHub API access requested by Chrome. Pin CommitFlow using the Extensions puzzle-piece menu if desired.
7. Reload every already-open LeetCode tab so it runs the new content scripts. Sign in, open a problem page and leave it visible while making a new submission.
8. Open CommitFlow's popup. Enter a fine-grained PAT scoped to the selected repository with **Contents: read and write**, plus owner/repository/existing branch. Click **Verify & save repository**. Re-enter your token after extension reloads or browser restarts because session storage is cleared.
9. Use an initialized disposable repository for the first live test. Click **Sync next submission** after an Accepted capture, then inspect the file, commit and preserved existing files on GitHub.
10. Use the extension card's service-worker inspector for worker errors and the LeetCode tab's console for capture errors. Never print the token/session storage or share Authorization headers. Follow README.md's manual release checklist.

No npm install or build is required to load Chrome. Node.js 22+ is needed only to reproduce automated checks.

## Remaining limitations

- Live authenticated LeetCode/GitHub requests, actual Chrome installation, popup layout/accessibility, browser CSP/CORS/cookie enforcement and real worker termination/resume have not been verified. Restart tests reconstruct the application with shared storage; they do not kill a live Chrome worker halfway through execution.
- LeetCode GraphQL is undocumented. Tests use the explicitly documented contract in `LEETCODE-API.md`, not a verified current signed-in schema. Field/verdict changes stop capture; contest paths and leetcode.cn are unsupported.
- Capture is polling-based, visible-problem-page only, with a latest-20 list window and a non-durable pending tracker. Clock skew, closed tabs, reloads and throttling can miss captures. It is not historical import.
- Local capture storage is bounded (50 records / roughly 3.5 MB); unsynced records can be evicted. Completion/deduplication histories are also bounded. No archival guarantee.
- GitHub sync is manual and one record per click. Long API operations serialize other worker operations. There is no durable automatic retry scheduler; interrupted work is replayed manually. A failed oldest record blocks later records until resolved.
- Empty repositories require a user-created initial commit; missing branches must be created separately. Branch protections are respected but cannot be fully proven by a blob-write permission probe. No PR fallback or bypass.
- Non-fast-forward protection is not exact compare-and-swap against an external actor who force-resets a branch. Failed attempts can create unreachable Git objects. Distinct submission IDs intentionally use distinct files, even if their code is identical.
- Session tokens are not stored on disk by this implementation, but session memory is not a secure OS vault. Browser/OS compromise or privileged extension debugging can expose them. Use a narrowly scoped expiring token.
- Content records are schema-validated but are not cryptographically authenticated against a compromised renderer. Unknown programming languages fail closed and require a mapping update.
