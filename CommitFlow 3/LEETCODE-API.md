# LeetCode adapter contract

## Undocumented LeetCode contract (reviewed 2026-10-16 IST)

Official Chrome documentation was inspected for isolated worlds, declarative content scripts, request origin behavior and asynchronous messaging. LeetCode's official FAQ explains viewing submission details/code, but it does **not** document a supported API. Searches of official LeetCode material did not locate a public supported GraphQL contract. Do not interpret the following as official documentation or guaranteed compatibility.

Every LeetCode operation below is an **undocumented website dependency** centralized in `leetcode.js`:

| Dependency | Assumption / failure behavior |
| --- | --- |
| `POST https://leetcode.com/graphql/` | JSON GraphQL with signed-in same-origin cookies, readable `csrftoken` forwarded as `x-csrftoken`; auth/challenge failures stop |
| `userStatus { isSignedIn username }` | Boolean sign-in state and nonempty account name; missing fields stop |
| `submissionList(offset: 0, limit: 20, questionSlug: $slug)` | Current user's problem-filtered latest submissions; `submissions` is an array |
| List `id`, `timestamp`, `statusDisplay` | Numeric submission ID, Unix seconds, nonempty status string; Pending/Judging/Started indicate pending observations |
| `submissionDetails(submissionId: $id)` | `$id: Int!`; IDs above 2,147,483,647 explicitly fail pending a schema update |
| Detail `statusCode`, `timestamp`, `code`, `lang.name`, `question.titleSlug` | 10 means Accepted; 0 means pending; 11–16 and 20 are terminal non-Accepted; all other codes stop |
| `question(titleSlug: $slug) { title titleSlug }` | Problem metadata used for title; slug must agree with submission detail |
| Null detail/metadata | Treated as eventual consistency within retry bounds, not proof of acceptance |

A firsthand community report of a changed detail query was also inspected. It is **not official LeetCode documentation**; it motivated avoiding a presumed `submissionDetails.id` field. The implementation and fixtures represent explicit compatibility assumptions, not a live authenticated schema verification.

Sources inspected:
- Official Chrome content scripts: https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts
- Official Chrome messaging: https://developer.chrome.com/docs/extensions/develop/concepts/messaging
- Official Chrome request behavior: https://developer.chrome.com/docs/extensions/develop/concepts/network-requests
- Official LeetCode FAQ: https://leetcode.com/faq/
- Non-official firsthand schema-change report: https://github.com/akarsh1995/leetcode-graphql-queries/issues/7


The GitHub phase does not change this undocumented capture adapter. See README.md for current setup, credential handling and synchronization.
