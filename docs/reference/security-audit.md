# Security audit report

**Version tested:** 0.60.1 (fixes shipped in 0.60.2)
**Type:** self-audit, black-box and white-box, on a throw-away instance
**Result:** 3 issues found and fixed, 7 known limits documented, no critical findings

## Read this first: what this report is and is not

This audit was done by the same AI assistant that helped write Apiary. It is a careful, repeatable self-check, **not an independent penetration test**. It finds the mistakes an attentive reviewer would find. It cannot replace a human specialist who has never seen the code. Treat it as evidence of good hygiene, not as a certificate.

All addresses below are examples (`192.0.2.x`, `example.com`). No real hosts, names or secrets appear here.

## Scope and method

- A fresh Apiary instance was started on a private test machine with a throw-away data folder and the built-in mock agents. No real accounts, keys or devices were involved.
- Two attack scripts ran against it, once with token-only access and once with an owner account:
  - **Phase 1** (27 checks): sign-in required everywhere, wrong Host and Origin headers, cross-site requests, wrong content types, path traversal, upload tricks, security headers.
  - **Phase 2** (14 checks): password guessing (sequential and parallel), account endpoints, malformed URLs, oversized and malformed bodies, cookie handling.
- The code was read for the same classes of problem: secrets handling, command and path construction, outbound requests, and trust in files or updates.
- The project's own `scripts/security-check.sh` (11 checks) was run against the test instance.

Not covered: denial of service under heavy load, the host operating system, your reverse proxy and TLS set-up, third-party services, and the agents' own behaviour on real tasks.

## Results at a glance

| Phase | Checks | Passed | Notes |
|---|---|---|---|
| Phase 1 | 27 | 27 | One apparent failure was a mistake in the test script, not in Apiary |
| Phase 2, before fixes | 14 | 11 | Three real findings (below) |
| Phase 2, after fixes | 14 | 14 | Re-tested on 0.60.2 |
| `security-check.sh` | 11 | 11 | |
| Automated test suite | all | all | Re-run after every fix, including four runs in parallel |

## Findings

### Fixed

| # | Severity | Finding | Fix |
|---|---|---|---|
| 1 | Medium | **Parallel password guesses skipped the sign-in lock.** 40 guesses sent at the same instant were all evaluated, because the lock was checked before any of them was counted. | Every try is now counted before it is checked. After the fix the same attack gave 4 normal rejections and 36 lock-outs. |
| 2 | Low to Medium | **Changing the password did not limit guesses of the current password.** A signed-in session could try the current password without limit. | The same throttle now applies, with a 429 when locked. |
| 3 | Low | **A malformed web address caused an internal error (500).** No data leaked, but it was sloppy. | Now answers 400 "Bad address". |

### Known limits (accepted or planned)

| # | Severity | Limit | Why it stands / what to do |
|---|---|---|---|
| A | Low | A `?token=` in the address is accepted for convenience. | It can end up in browser history or proxy logs. Prefer the header or the sign-in. Planned: remove it for the browser. |
| B | Low | Sessions are signed cookies with no server-side list, so one cannot be revoked individually. | Changing the password or the server secret ends all sessions. |
| C | Low | Behind a reverse proxy that hides the real address, all visitors share one throttle bucket. | Configure the proxy to pass the client address, or keep Apiary off the public internet. |
| D | Low | Someone who can reach the sign-in page can lock the owner out for a while by guessing. | Trade-off of having a lock at all. Use a private network or VPN. |
| E | Info | Some internal error messages are shown to the signed-in user. | No secrets are included; useful for troubleshooting. |
| F | Medium (by design) | The updater trusts the `main` branch of the project's repository and does not verify a signature. | Anyone who can push to that branch can ship code to your machine. Protect the branch, turn on two-factor sign-in, and keep updates manual if you prefer. Signed releases are a candidate improvement. |
| G | By design | "Full access" mode lets an agent do whatever your Linux user can do. | Use Safe mode by default, run Apiary as a dedicated low-privilege user, and read the approvals you are shown. |

## What held up

- Every sensitive endpoint refuses requests without a valid token or session.
- Requests with a foreign Host or Origin header, cross-site form posts and wrong content types are rejected.
- Path traversal attempts (`../`, encoded variants) cannot leave the allowed folders; the file viewer resolves real paths first.
- Uploads are checked by file signature, not just by name.
- Security headers are present, and the content policy only allows the app's own scripts and styles.
- Stored secrets (vault, tokens) are not returned by any endpoint, and are not written to logs or reports. Passwords use scrypt.

## Recommendations

1. Keep Apiary on a private network or behind a VPN. Do not expose the sign-in page to the open internet.
2. If you use a reverse proxy, pass the client address through and use HTTPS.
3. Leave agents in Safe mode unless you need more, and use a dedicated Linux user.
4. Protect the repository's `main` branch and use two-factor sign-in on the GitHub account, because the updater follows it.
5. Re-run `scripts/security-check.sh` after changes to your set-up.
6. For anything beyond a home lab, ask a human security professional for an independent test.

## How to repeat this

```
APIARY_NO_UPDATE_CHECK=1 npm test
bash scripts/security-check.sh
```

The first runs the full automated suite, which now includes the sign-in lock, parallel guessing and malformed address cases from this audit.
