# Connect GitHub

GitHub is used in two ways: to **clone repositories** for agents to work on, and to **open pull requests**. Open **Connections → GitHub** and pick a method.

## Terminal (GitHub CLI)

```bash
# install gh: https://cli.github.com
gh auth login
```

Choose GitHub.com, HTTPS, and sign in through the browser. Apiary then reuses that login.

## Web (personal access token)

Create a token at *GitHub → Settings → Developer settings → Personal access tokens*:

* **Fine-grained token:** give it access to the repositories you want, with **Contents: read and write** and **Pull requests: read and write**.
* **Classic token:** tick **repo**.

Paste it under **Connections → GitHub → Web · token** and press **Save**. The token is stored only in your private Apiary file and is passed to git per command, never written into a repository's configuration.

Or from a terminal: `echo "$GITHUB_TOKEN" | apiary connect github --method token`.

## Test

Press **Test connection**. It shows the account you are signed in as.
