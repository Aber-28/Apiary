# Terminal vs web

| | Terminal | Web (API key) |
| --- | --- | --- |
| Setup | Log in once with the CLI | Paste a key |
| Edits files, runs commands | Yes | No (chat only) |
| Works with git worktrees and PRs | Yes | No |
| Take over in your terminal | Yes | No |
| Billing | Your CLI plan or account | Your API account |

You can mix: for example Claude through the terminal and Codex through the web. If your chosen method is not usable (for example the CLI is missing but a key is saved), Apiary falls back to the other one automatically.

Keys are stored in `~/.apiary/state.json`, which is readable only by your user, and are never sent back to the browser.
