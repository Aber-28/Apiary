# Installing Claude Code or Codex from Apiary

You do not need to install an AI tool by hand. If Apiary finds no AI on the computer, the first screen offers three buttons: **Install Claude Code for me**, **Install Codex for me** and **Install both**. The same button appears on the Connections page and in the setup wizard whenever a tool is missing.

## What happens
1. Apiary checks the computer (and whether it already has the tool).
2. It downloads and installs the tool **for your user only**. It never uses `sudo`.
   - **Claude Code** uses Anthropic's own installer (`curl -fsSL https://claude.ai/install.sh | bash`), which puts `claude` in `~/.local/bin`.
   - **Codex** is installed with `npm` into `~/.local`, so `codex` also ends up in `~/.local/bin`.
3. It checks that the tool starts.

A progress screen shows a bar, the steps, a live log like a terminal, and a timer, so you can always see that it is working. It usually takes one to three minutes.

## After the install: sign in once
Installing is not signing in. The screen then shows the one command to run in a terminal on the computer (`claude` or `codex login`). It prints a link: open it in a browser on any device, sign in, and come back. Then press **I have signed in. Check now**. Prefer not to sign in? Use a web API key under Connections instead.

## If it fails
The screen says why in plain words and offers **Try again**. Common causes:

| Message | What to do |
| --- | --- |
| Could not reach the download server | Check that the computer is online. |
| Not allowed to write to your home folder | Check the permissions of `~/.local`. |
| `curl` or `npm` is needed | `sudo apt-get install -y curl` or `sudo apt-get install -y nodejs npm` |
| The disk is full | Free some space. |

You can always install by hand instead; the commands are on the Connections page.
