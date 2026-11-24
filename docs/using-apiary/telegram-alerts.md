# Telegram alerts

Apiary can message you on Telegram when something needs you, so you do not have to keep the page open. Open **Settings > Telegram alerts**.

This first version is **alerts only**. You cannot approve or command anything from Telegram yet.

## Set it up

1. In Telegram, message **@BotFather**, send `/newbot` and follow the steps. Copy the token it gives you (it looks like `123456789:ABC...`).
2. Paste the token on the Telegram alerts page and press **Save token**. It is stored encrypted in your [Secrets vault](secrets-vault.md) as "Telegram bot token", so the vault must exist and be unlocked (turn on auto-unlock so alerts keep working after a restart).
3. Press **Link my chat**. Apiary shows a 6-digit code. Open your bot in Telegram and send it that code. The chat is linked and the bot confirms.
4. Tick **Send alerts**, choose what to send, and press **Save**. **Send a test alert** checks it works.

## What is sent

- An approval is waiting for you.
- A health warning appears (see [Health](health.md)). Only the title is sent.
- A long task finishes (you choose how many minutes counts as long, default 10).

Messages are short titles such as "Approval waiting (Website): Review the deployment plan". **Command output, file contents and secrets are never sent**, and anything matching a known secret value is masked. The same alert is not repeated within 10 minutes, and at most 30 are sent an hour.

## Who the bot answers

Only the chat you linked. Anyone else who finds your bot is ignored: no reply, nothing happens. A chat can only be linked by sending the one-time code, which expires after 10 minutes. In the linked chat, `/status` replies with one line: how many agents are working, how many approvals are waiting and how many health warnings there are. Press **Unlink** to remove the chat.

## API

`GET/PUT /api/telegram`, `POST /api/telegram/test`, `/link` and `/unlink` (see the API reference). The token is never returned.
