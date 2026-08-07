# Mobile App — Working From Anywhere + Standalone Install

## ✅ Implemented: the web app is now an installable app (PWA)

No computer or Expo Go needed. Once this branch is deployed:

1. Open the deployed site on your phone (Railway/Replit URL).
2. **iPhone (Safari)**: Share button → "Add to Home Screen".
   **Android (Chrome)**: menu (⋮) → "Add to Home screen" / "Install app".
3. A **Milk Yellow Box** icon appears on your home screen. It launches
   full-screen (no browser bars), works from any network, and never touches
   Expo Go or your computer.

What was added: `client/public/manifest.webmanifest`, app icons
(`icon-192/512`, maskable, `apple-touch-icon`), a minimal `sw.js` service
worker (never caches `/api` or `/ws` — live data always fresh), PWA meta
tags in `client/index.html`, and service-worker registration in `main.tsx`
(production only).

The sections below remain for the separate Expo project on your computer,
if you still want a native binary later.

---

## Free hosting options (Railway replacement)

The server needs: long-running Node process, WebSockets, and (ideally) a
persistent disk for the SQLite candle cache (`data/app.db`).

### Option A — Render.com free tier (recommended, phone-friendly)

`render.yaml` in the repo root makes this one-click:

1. Sign up at render.com with your GitHub account (works from a phone).
2. New → **Blueprint** → pick the `day-trading` repo → Apply.
3. Render builds and deploys from `main` automatically (and re-deploys on
   every merge). Your URL: `https://day-trading-XXXX.onrender.com`.

Free-tier caveats:
- **Spins down after ~15 min idle** — first open after a quiet period takes
  ~30–60s to wake. (While MotiveWave's TickRelay is connected it stays awake.)
- **No persistent disk** — the SQLite candle cache resets on each deploy or
  restart. Re-download from Polygon via the `/data` page, or use
  `POST /api/data/import-full` with a JSON export to restore.

### Option B — Host on the home PC (best fit, $0, no cloud at all)

MotiveWave already requires the home PC to be on for live ticks — so run the
server there too, and expose it with a free tunnel:

1. On the PC: `npm run build && npm start` (serves on port 5000).
2. Install **Tailscale** (free personal plan) on the PC and your phone →
   the phone can reach the PC from anywhere, privately, at a stable address.
   `tailscale serve --bg 5000` gives it HTTPS.
   Or `tailscale funnel 5000` for a public HTTPS URL (no phone app needed).
3. Add to Home Screen from that URL.

Pros: candle cache persists, no cold starts, ticks never leave the LAN.
Con: needs one-time setup at the computer.

### Option C — Oracle Cloud "Always Free" VM

A genuinely free forever Linux VM (generous ARM shape). Most robust: real
disk, always on, no sleep. But it's a full server you SSH into and maintain —
only worth it if A and B both disappoint.

Avoid: Fly.io (requires a card now), Glitch (hosting shut down), Replit
deployments (paid), free serverless platforms like Cloud Run/Vercel/Netlify
(no persistent WebSocket server + SQLite wiped constantly).

---

The Expo mobile app is NOT in this repository — it lives on your computer.
This guide covers (1) why it only loads on your home WiFi and how to fix it,
and (2) how to turn it into a real installed app so you never open Expo Go.

---

## Part 1 — Why it only works at your house

When you run `npx expo start`, Expo defaults to **LAN mode**: the QR code
points Expo Go at your computer's local address (something like
`exp://192.168.1.x:8081`). Your phone downloads the app's JavaScript from
your computer over your home WiFi. Away from home, that address doesn't
exist — so nothing loads.

There are usually **two** home-network dependencies, and both must be fixed:

1. **The app bundle** — served by `expo start` on your computer (LAN only by default).
2. **The data** — if the app's fetch/WebSocket URLs point at a LAN IP
   (e.g. `http://192.168.1.x:5000/api/...`), the app can open but shows no
   data away from home.

### Quick fix (still uses Expo Go, works on any network)

```bash
npx expo start --tunnel
```

Tunnel mode routes the bundle through Expo's servers (ngrok), so your phone
can load it from cellular or any WiFi. First run will prompt to install
`@expo/ngrok` — accept it. Caveats: it's slower than LAN, and **your
computer must still be on and running the dev server**.

### Data fix (required for both Expo Go and a standalone build)

The app must talk to a **publicly reachable** server, not your PC's LAN IP:

- Deploy this Express server (the `railway/fix-deploy-3668ac` branch targets
  Railway) or use your Replit deployment URL.
- In the mobile app, replace any `http://192.168.x.x:PORT` base URL with the
  public HTTPS URL, e.g.:
  - REST: `https://<your-app>.up.railway.app/api/...`
  - WebSocket: `wss://<your-app>.up.railway.app/ws/live-bars`
- Best practice: put it in one config file or an Expo env var
  (`EXPO_PUBLIC_API_URL`) and reference it everywhere:

```ts
// config.ts in the mobile app
export const API_URL = process.env.EXPO_PUBLIC_API_URL ?? "https://<your-app>.up.railway.app";
export const WS_URL  = API_URL.replace(/^http/, "ws") + "/ws/live-bars";
```

Note: the live tick feed originates from MotiveWave on your home PC pushing
to `/ws/mw-feed`. Point the MotiveWave TickRelay study at the deployed
server's URL too, otherwise live prices only flow while the server you're
using is the one MotiveWave feeds.

---

## Part 2 — A real installed app (no Expo Go)

Use **EAS Build** (Expo Application Services). It compiles a native binary in
the cloud — your own icon and name on the home screen, launches like any app.

### One-time setup (in the mobile app's folder on your computer)

```bash
npm install -g eas-cli
eas login                # free Expo account
eas build:configure      # creates eas.json
```

Give the app its identity in `app.json`: `"name"`, `"icon"` (1024×1024 png),
`"splash"`, and `"android.package"` / `"ios.bundleIdentifier"` (e.g.
`com.jackson.milkyellowbox`).

### Android — easiest, free

In `eas.json`, make the preview profile produce an installable APK:

```json
{
  "build": {
    "preview": { "android": { "buildType": "apk" }, "distribution": "internal" }
  }
}
```

Then:

```bash
eas build --platform android --profile preview
```

When the cloud build finishes (~10–20 min) you get a link/QR — open it on
your phone, download the `.apk`, and install (allow "install from unknown
sources" when prompted). Done: real app icon, no Expo Go, no computer needed.

### iPhone — requires an Apple Developer account ($99/yr)

Apple doesn't allow installing apps outside their system without it. Easiest
path once enrolled:

```bash
eas build --platform ios --profile production
eas submit --platform ios
```

Then install via **TestFlight** (Apple's free beta app). Alternative:
ad-hoc internal distribution (`eas device:create` to register your iPhone's
UDID, then a preview build installs straight from a link).

### Updating the app without rebuilding

Set up **EAS Update** so JavaScript changes push over-the-air to the
installed app:

```bash
eas update:configure
# after making changes:
eas update --branch production --message "describe the change"
```

The installed app picks up the new JS on next launch. You only need a new
`eas build` when adding native dependencies or changing app.json identity.

### Checklist for the standalone build

- [ ] API/WS URLs point at the deployed server (no LAN IPs anywhere)
- [ ] Backend deployed and reachable over HTTPS (Railway/Replit)
- [ ] `app.json` has name, icon, splash, package/bundle identifier
- [ ] Android: preview profile with `"buildType": "apk"` → install APK
- [ ] iOS: Apple Developer account → TestFlight
- [ ] EAS Update configured for over-the-air JS updates
