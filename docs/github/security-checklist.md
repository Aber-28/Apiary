# GitHub security checklist (for the repository owner)

Run `./scripts/lock-down-github.sh` once from a computer where `gh auth login` is done. It protects `main` and release tags so only the owner can change them, turns off the wiki and projects, and turns on private vulnerability reporting, dependency alerts, automatic security fixes, code scanning and approval for workflows from outside contributors.

Then, by hand:

- **Two-factor authentication** on your GitHub account, ideally with a passkey or security key. This is the most important item.
- **Use GitHub's private email** for commits (Settings → Emails → keep my email private, and block command-line pushes that expose it) so your own address is not published in new commits.
- **Tokens:** give Apiary a fine-grained token limited to the repositories it needs, with an expiry date. Do not use a classic token with full access.
- **Review open Dependabot pull requests** and merge or close them. They only update the actions used by the tests.
- Check Settings → Actions → General: fork pull request workflows should need approval, and the default workflow token should be read-only (the workflow already asks for read-only).
