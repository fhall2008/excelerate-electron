# Excelerate HSC — Desktop App

Offline-first Electron wrapper for the Excelerate HSC study platform.  
Works on **Windows** and **macOS**.

## Quick Start

```bash
# 1. Clone this repo
git clone https://github.com/YOUR_USERNAME/excelerate-electron.git
cd excelerate-electron

# 2. Clone the web app into this repo
git clone https://github.com/fhall2008/HSCSTUDY-Cloudflare-pages webfiles

# 3. Install dependencies
npm install

# 4. Run
npm start
```

That's it. The app loads `webfiles/project/WebFiles/` as the frontend.

## How It Works

```
┌──────────────────────────────────────────────┐
│  Electron App                                │
│                                              │
│  ┌─────────────────┐   ┌──────────────────┐  │
│  │  Renderer       │   │  Main Process    │  │
│  │  (WebFiles/)    │◄──►  Local Express   │  │
│  │  Same frontend  │   │  + SQLite DB     │  │
│  │  as web version │   │  + Sync Engine   │  │
│  └─────────────────┘   └────────┬─────────┘  │
└──────────────────────────────── │ ────────────┘
                                  │ when online
                             ┌────▼────────────┐
                             │  School Server  │
                             │  (Cloudflare    │
                             │   Worker+Turso) │
                             └─────────────────┘
```

- Frontend is the same `WebFiles/` used by the web version — no changes needed
- Local Express server runs inside the main process, replacing the Cloudflare Worker
- SQLite database stores everything locally via `better-sqlite3`
- Sync engine runs every 60 seconds when online
- JWT cached for 30-day offline login
- AI tutor proxies to the school Worker when online; shows helpful error offline

## Project Structure

```
excelerate-electron/
├── src/
│   ├── main.js              # Electron main process + window
│   ├── preload.js           # Secure IPC bridge to renderer
│   ├── server.js            # Local Express API (mirrors Cloudflare Worker)
│   ├── sync.js              # Background sync engine
│   └── electron-bridge.js   # Injected into WebFiles at runtime
├── resources/
│   ├── icon.ico             # Windows icon — replace with your own
│   └── icon.icns            # macOS icon — replace with your own
├── webfiles/                # ← git clone the main repo here (gitignored)
├── .gitignore
├── package.json
└── README.md
```

## Building Installers

```bash
# Windows (.exe)
npm run build:win

# macOS (.dmg) — must run on a Mac
npm run build:mac

# Both
npm run build:all
```

Output goes to `dist/`.

## Offline Capabilities

| Feature | Offline |
|---|---|
| Past papers (cached) | ✅ |
| Study notes | ✅ |
| Planner | ✅ |
| Forum (read + post) | ✅ queued |
| Login (return user) | ✅ 30 days |
| AI Tutor | ❌ needs internet |
| File uploads | ❌ needs internet |
| First-time login | ❌ needs internet |

## App Icons

Replace `resources/icon.ico` (Windows) and `resources/icon.icns` (macOS) with your school's branding before building.

## Sync Status

A small indicator in the bottom-right corner shows:
- 🟢 **Synced** — up to date with school server
- 🔵 **Syncing** — sync in progress
- 🔴 **Offline** — no internet, using cached data

Click the indicator to see last sync time and force a manual sync.

## Troubleshooting

**`better-sqlite3` install fails on Windows**  
```bash
npm install --global windows-build-tools
npm install
```

**App won't find WebFiles**  
Make sure you ran `git clone https://github.com/fhall2008/HSCSTUDY-Cloudflare-pages webfiles` inside this repo.  
Or set `WEBFILES_PATH=/path/to/project/WebFiles` as an environment variable.

**Student logged out after offline period**  
They need internet once to refresh their Kinde session (30-day cache).
