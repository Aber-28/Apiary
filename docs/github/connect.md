# Connect GitHub

GitHub is used in two ways: to **clone repositories** for agents to work on, and to **open pull requests**. Open **Connections → GitHub** and pick a method.

## Sign in (easiest)

Open **Connections → GitHub** and press **Sign in with GitHub**.

1. Apiary shows a short code, for example `ABCD-1234`.
2. Press **Open github.com**, type the code, and approve.
3. The page updates by itself and shows *Signed in as …*.

You never type a password into Apiary, and Apiary never sees one. The login is kept by GitHub's own tool and Apiary reuses it.

If the GitHub tool is not on the computer yet, the card shows **Install GitHub tool for me**. It downloads GitHub's official release into your own home folder (`~/.local/bin`). It does not use sudo and does not change anything else.

If the sign-in fails, the card says why in plain words (no internet, code expired, cancelled on GitHub) and offers **Try again**. You can also use a token instead (below).

### From a terminal instead

```bash
gh auth login
```

Choose GitHub.com, HTTPS, and sign in through the browser. Apiary reuses that login.

## Web (personal access token)

Press **Create one on GitHub** on the token card (the form opens with the name and the *repo* access already filled in), or create it yourself at *GitHub → Settings → Developer settings → Personal access tokens*:

* **Fine-grained token:** give it access to the repositories you want, with **Contents: read and write** and **Pull requests: read and write**.
* **Classic token:** tick **repo**.

Paste it under **Connections → GitHub → Web · token** and press **Save**. The token is stored only in your private Apiary file and is passed to git per command, never written into a repository's configuration.

Or from a terminal: `echo "$GITHUB_TOKEN" | apiary connect github --method token`.

## Test

Press **Test connection**. It shows the account you are signed in as.
