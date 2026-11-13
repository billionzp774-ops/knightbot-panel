# Knight Bot Panel

A web control panel for **Knightbot-MD** (a WhatsApp Multi-Device bot built on Baileys). Single-page HTML UI + an Express server that spawns and manages the bot as a child process, streams logs over WebSocket, and pulls updates from GitHub.

Built to deploy on **Railway** (free trial / hobby) — one click, no build step needed.

## What it does

1. **Paste your `creds.json`** (the session you already got from the pair-code generator) → press **Start Bot**. The panel writes it to `./session/creds.json` and boots the bot.
2. **Get your session** — the "Open Pair-Code Generator" button links to `https://knight-bot-paircode.onrender.com` (the official generator from Knightbot-MD's README). Enter your number there, link WhatsApp, copy the `creds.json`, paste it back here.
3. **Live logs** — stdout/stderr stream to the browser in real time over WebSocket.
4. **Update from GitHub** — runs `git fetch && git reset --hard origin/main` on the running deploy and reinstalls deps, then restarts the bot if it was running. Your session and runtime data are preserved.
5. **Auto-restart** — if the bot process crashes, the panel restarts it (back-off up to 15s, max retries tracked).
6. **Auto-resume on redeploy** — if `creds.json` is already present at boot, the panel starts the bot automatically.

## File layout

```
panel/
├── server.js          Express + ws: serves UI, spawns/manages bot, git Update
├── public/index.html  the panel UI (single page, inline CSS/JS)
├── index.js           bot entry (Knightbot-MD)
├── main.js            bot message handler (Knightbot-MD)
├── config.js, settings.js
├── commands/, lib/, assets/, data/
├── Dockerfile         Railway/any container host
├── railway.json       Railway config
└── package.json
```

## Deploy on Railway

1. Push this repo to your GitHub.
2. Go to https://railway.app → **New Project → Deploy from GitHub repo**.
3. Pick this repo. Railway detects `railway.json` automatically.
4. Set env var (optional): `OWNER_NUMBER=your-number-without-plus`.
5. Wait for the build (~5 min, ffmpeg+git installed).
6. Open the Railway public URL → paste your `creds.json` → **Start Bot**.

## Endpoints

| Method | Path          | What it does |
|--------|---------------|--------------|
| GET    | `/`           | the panel UI |
| GET    | `/api/meta`   | repo url + current HEAD |
| GET    | `/api/status` | bot state, uptime, restarts, pid |
| POST   | `/api/start`  | body `{session:"<creds.json string>"}` → writes session + starts bot |
| POST   | `/api/stop`   | stop the bot |
| POST   | `/api/restart`| stop + start |
| POST   | `/api/clear`  | delete `./session` |
| POST   | `/api/update` | `git reset --hard origin/main` + `npm install` |
| WS     | `/ws`         | live log stream + state updates |

## Credits

Bot © Professor — [Knightbot-MD](https://github.com/mruniquehacker/Knightbot-MD) (MIT). Panel built around it.
