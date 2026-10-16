CommitFlow
CommitFlow is a Chrome extension that captures accepted LeetCode
submissions and syncs them to a GitHub repository, helping keep coding
solutions backed up and organized.
Tech Stack
- JavaScript --- extension logic and UI behavior.
- HTML & CSS --- extension popup and settings interface.
- Chrome Extensions Manifest V3 --- extension platform and
  permissions.
- Chrome content scripts --- detect accepted submissions while a
  LeetCode problem page is open.
- Chrome extension service worker --- coordinate background work
  and GitHub synchronization.
- LeetCode GraphQL --- retrieve submission/problem information
  using the signed-in LeetCode session.
- GitHub REST API / Git Data API --- write solution files and
  create commits in the configured repository.
- chrome.storage.local --- store extension preferences locally
  on the user's device.
- Node.js node:test --- run automated tests.
The MVP does not require a separate backend server.
How It Works
1. The extension runs while a LeetCode problem page is open.
2. It detects an accepted submission and gathers the relevant problem
   and solution details.
3. It checks for duplicates to avoid repeatedly syncing the same
   submission.
4. It uses the configured GitHub repository, branch, and token to
   upload the solution and create a commit.
5. The solution files and any generated problem metadata are organized
   in the repository.
Exact behavior depends on the features enabled in the installed version.
Requirements
- Google Chrome or another Chromium-based browser that supports
  Manifest V3.
- A GitHub account and a repository where solutions will be stored.
- A LeetCode account; sign in to LeetCode in the same browser.
- Node.js, only if you want to run the automated tests.
Installation: Load the Extension Locally
1. Download or clone the CommitFlow source code.
2. Make sure the project folder contains manifest.json.
3. Open chrome://extensions in Chrome.
4. Enable Developer mode.
5. Click Load unpacked.
6. Select the CommitFlow project folder (the folder containing
   manifest.json).
7. Pin CommitFlow from Chrome's Extensions menu for convenient access.
8. Sign in to LeetCode in the same Chrome profile.
After changing the extension's source files, return to
chrome://extensions and click the extension's Reload button.
Configure GitHub Sync
1. Create a GitHub repository for your solutions, or choose an existing
   repository.
2. Create a fine-grained personal access token in GitHub settings.
3. Limit the token to only the repository that CommitFlow should
   update.
4. Grant the repository permission Contents: Read and write. Avoid
   granting unrelated permissions.
5. Open CommitFlow's actual configuration/settings interface and enter:
   - Owner: your GitHub username or organization
   - Repository: the destination repository name
   - Branch: the target branch, commonly main
   - Token: the fine-grained GitHub token
6. Save the configuration and use the extension's connection check, if
   available.
Important: Never commit a GitHub token to the repository, include
it in screenshots, or share it in chat. Keep it stored locally in the
extension. If a token is exposed, revoke it in GitHub and create a
replacement.

If your installed version does not show the GitHub configuration fields,
check the version's settings UI and source code before assuming the
token has been configured.
Using CommitFlow
1. Open LeetCode and make sure you are signed in.
2. Open a problem and submit your solution.
3. Once LeetCode marks the submission Accepted, leave the problem
   page open long enough for CommitFlow to detect it.
4. Check the extension's status or connection check if provided.
5. Open your GitHub repository and verify that the solution file and
   commit appear.
If a submission does not sync, check that: - You are signed in to
LeetCode in the same Chrome profile. - The extension is enabled and has
been reloaded after recent code changes. - The owner, repository, and
branch are correct. - The token is valid, has not expired, and has
Contents: Read and write access to the destination repository. - The
browser's extension service worker console has no relevant errors.
Run Tests
From the project root, run:
node --test
This uses Node.js's built-in test runner. If the project has a different
test command or test layout, follow the scripts and instructions in its
current source.
Project Structure
The extension's core files are typically organized like this:
commitflow/
├── manifest.json       # Manifest V3 metadata and permissions
├── background.js       # Service worker / background coordination
├── content.js          # LeetCode page and submission detection
├── popup.html          # Extension popup markup
├── popup.css           # Popup styling
├── popup.js            # Popup behavior and settings
└── tests/              # Automated tests
File names can vary by version; use the actual names in your checkout as
the source of truth.
Security and Privacy Notes
- Use a token scoped to the single destination repository whenever
  possible.
- Do not hard-code secrets in JavaScript or commit them to Git.
- Keep the token in extension-local storage and avoid logging it.
- LeetCode access relies on the signed-in browser session; do not
  share session cookies.
- Review the permissions in manifest.json and keep them limited to
  what the extension needs.
License
Add the license that applies to this project before distributing it
publicly.
