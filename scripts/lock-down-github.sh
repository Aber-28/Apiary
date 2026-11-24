#!/bin/sh
# Run once by the repository owner, on a computer where `gh auth login` is done.
# Protects main and release tags so only the owner can change them, and turns off what Apiary does not use.
set -e
REPO="${1:-Aber-28/Apiary}"
for f in .github/rulesets/protect-main.json .github/rulesets/protect-tags.json; do
  gh api -X POST "repos/$REPO/rulesets" --input "$f" --jq '"created: " + .name'
done
gh api -X PATCH "repos/$REPO" -F has_wiki=false -F has_projects=false -F allow_auto_merge=false -F delete_branch_on_merge=true --jq '"settings updated"'
gh api -X PUT "repos/$REPO/private-vulnerability-reporting" >/dev/null && echo "private vulnerability reporting on"
gh api -X PUT "repos/$REPO/vulnerability-alerts" >/dev/null && echo "dependency alerts on"
gh api -X PUT "repos/$REPO/automated-security-fixes" >/dev/null && echo "automatic security fix pull requests on" || echo "skipped: automatic security fixes"
gh api -X PATCH "repos/$REPO/code-scanning/default-setup" -f state=configured -f query_suite=default >/dev/null && echo "code scanning (CodeQL) on" || echo "skipped: code scanning (turn on under Security > Code scanning)"
gh api -X PUT "repos/$REPO/actions/permissions/fork-pr-contributor-approval" -f approval_policy=all_external_contributors >/dev/null && echo "workflows from outside contributors need your approval" || echo "skipped: set Settings > Actions > General > Fork pull request workflows to require approval"
echo "Done. Also turn on two-factor authentication for your GitHub account."
