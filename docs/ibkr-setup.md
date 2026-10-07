# Interactive Brokers bridge — step-by-step setup

The Node server can connect to **Trader Workstation (TWS) or IB Gateway on this PC** and
replace the three MotiveWave studies (TickRelay, LiveBarRelay, AutoTrader). The bridge lives
in `server/ibkr-bridge.ts`, is **OFF by default**, and turns on only with `IB_ENABLED=true` in
`.env`. Nothing downstream changes: IB ticks and 1-minute bars enter through the same code path
as the MotiveWave relays (`ingestStudyMessage`), and IB bracket orders are driven by the same
`order_command` messages AutoTrader received, replying with the same events (`order_ack`,
`order_filled`, `bracket_flattened`, `orders_cancelled`, `order_error`).

**The bridge never sees your IB credentials.** It only talks to the local API socket of the
TWS / Gateway window you are logged into. The login lives in that window (or in IBC's
`config.ini` on this PC) — never in this repo, never in `.env`.

### TWS or IB Gateway — which port?

Both programs expose the same API; use whichever you have installed (you do not need both).

| Program | Live | Paper | API switch |
| --- | --- | --- | --- |
| **TWS** (`C:\Jts\tws.exe`, the full trading screen) | **7496** | 7497 | OFF until you tick *Enable ActiveX and Socket Clients* (B1) |
| **IB Gateway** (API-only, no charts) | **4001** | 4002 | always on — there is no such checkbox in the Gateway |

`IB_PORT` in `.env` must be the port of the program + mode you are logged into. The bridge's
status page reports ports 7496 / 4001 as `mode: "LIVE"`.

Order of operations: **A (account + data subscription) → B (TWS or Gateway settings) →
C (turn the bridge on) → D (verify) → soak with Read-Only ON → E (unattended running) →
F (allow orders)**.

---

## A. In Client Portal (the IBKR website) — one-time account setup

1. **Futures trading permission**: Settings → Account Settings → Trading Permissions →
   **Futures → United States** → request. (Approval can take a business day. Until it is
   approved every MES order is rejected — IB error 201/10268.)
2. **Market data subscription** (real-time CME futures are NOT free):
   Settings → User Settings → **Market Data Subscriptions** → Configure → North America →
   **CME Real-Time (NP, L1)** — the *Non-Professional*, Level 1 one. Do not pick the "US
   Securities Snapshot and Futures Value Bundle" — that one is delayed for order routing.
   Without this subscription IB sends error **10167 "Displaying delayed market data"**; the
   bridge flags it in `/api/ibkr/status` (`marketData: "delayed"`), pushes a notification,
   and **refuses every order** until a reconnect sees real-time ticks.
3. *Optional* — a paper account (Settings → Account Settings → Paper Trading Account). **You
   do not need one**: see "No paper account? Soak on LIVE with Read-Only API ON" below. If you
   do make one, also set "Share real-time market data subscriptions with paper trading
   account" → Yes, and log in with the paper username (port 7497 TWS / 4002 Gateway).

## B. API settings (do these by hand, once, in whichever program you use)

### B1. TWS (what is installed on this PC: `C:\Jts\tws.exe`)

1. Log in (live username). Open **Edit → Global Configuration** (newer TWS: **File → Global
   Configuration**, or the gear icon top-right).
2. **API → Settings**:
   - ☑ **Enable ActiveX and Socket Clients** — without this TWS refuses every API connection
   - ☑ **Read-Only API** — leave it **CHECKED for now** (the soak below); uncheck it only in F
   - **Socket port**: `7496` (live). (Paper TWS uses `7497`.)
   - **Master API client ID**: `17` (matches `IB_CLIENT_ID`; makes TWS forward every order
     status to the bridge)
   - ☑ **Allow connections from localhost only**; **Trusted IPs**: add `127.0.0.1`
   - ☑ **Download open orders on connection** (default on — the bridge reconciles with it)
3. **API → Precautions**: ☑ **Bypass Order Precautions for API Orders**. Without this TWS
   pops a modal confirmation for the first bracket and the order sits unanswered.
4. **Lock and Exit**: choose **Auto restart** (not Auto logoff) and set the time to
   **05:05 PM** (this PC's clock = ET). That is inside the CME daily halt (5:00–6:00 PM ET),
   so the daily restart loses no bars, and with Auto restart the daily restart does **not**
   ask for your password (see E).
5. Apply → OK. Leave TWS running (minimised is fine).

### B2. IB Gateway (alternative to TWS)

1. Download **IB Gateway (stable)** from interactivebrokers.com → Trading → API → IB Gateway
   and install to `C:\Jts`. On the login window choose **IB API** (not FIX CTCI).
2. Gear icon (Configure) → **Settings → API → Settings**: the API is **always enabled** in
   the Gateway (there is no "Enable ActiveX and Socket Clients" box). Set ☑ **Read-Only API**
   (for the soak), **Socket port** `4001` live / `4002` paper, **Master API client ID** `17`,
   **Trusted IPs** `127.0.0.1` with localhost-only, ☑ Download open orders on connection.
3. **Settings → API → Precautions**: ☑ Bypass Order Precautions for API Orders.
4. **Settings → Lock and Exit**: **Auto restart**, **05:05 PM**.

IB's own server reset (00:15–01:45 ET on weeknights, longer on Saturday) also drops the
session briefly either way; the bridge treats codes 1100 / 1101 / 1102 and re-subscribes.

## C. Turn the bridge on

`.env` is a plain-text settings file in the project folder — the full path is
`C:\Users\Jackson\OneDrive\day trading iphone\.env` (the file name is literally `.env`,
nothing before the dot). The server reads it once, when it starts.

1. Open it in Notepad: File Explorer → the project folder → right-click `.env` → *Open with*
   → Notepad. (Can't see it? File Explorer → View → Show → ☑ Hidden items and ☑ File name
   extensions.)
2. Look for lines that start with `IB_`. If they are there, **change** them; if not, paste
   this block at the bottom (copy from `.env.example` if you prefer). For **TWS live**:

   ```
   IB_ENABLED=true
   IB_HOST=127.0.0.1
   IB_PORT=7496
   IB_CLIENT_ID=17
   IB_ACCOUNT=            # optional: your U… account id; default = the first account TWS reports
   IB_CONTRACT=           # leave empty: the bridge resolves the front month itself
   IB_ROLL_DAYS_BEFORE_EXPIRY=4
   IB_BACKFILL_DAYS=2
   IB_SERVE_BACKFILL=true
   IB_BACKFILL_MAX_DAYS=30
   IB_STOP_TYPE=STP       # STP_LMT mirrors AutoTrader's stop-limit (+IB_STOP_SLIP_PTS cap) if you prefer
   ```

   `IB_PORT`: **7496** TWS live · 7497 TWS paper · 4001 Gateway live · 4002 Gateway paper.
   Each name must appear only once in the file. Save (Ctrl+S) and close Notepad.
3. **Restart the server** so it reads the new values: close the black server console window
   (the one the Desktop **"Start Trading Server"** shortcut opened — click its X, or press
   Ctrl+C in it and answer `Y`), then double-click **Start Trading Server** again. (From a
   terminal in the project folder, `npm run dev` does the same.) The server log should show
   `[ibkr] connecting to IB Gateway 127.0.0.1:7496 …` within a few seconds.

**Do not run MotiveWave's studies at the same time**: while the bridge is connected it is the
order executor and AutoTrader's socket is bypassed, but ticks from a still-running TickRelay
would be a second feed on the same key. Close the MW charts (or remove the three studies) once
IB is up.

## D. Verify

1. `GET http://localhost:3000/api/ibkr/status` → `connected: true`, `ready: true`,
   `gateway.mode: "LIVE"` (port 7496), `contract.rawSymbol` like `MESZ6`, `rollDate`,
   `account` = your U… account, `subscriptions.ticks/bars: true`, `marketData: "realtime"`
   (NOT `"delayed"`), `lastTickAgeSec` a few seconds during session hours.
2. `GET /api/trade/status` → `{connected:true}`; `GET /api/mw/sync-status` →
   `feed_status: "mw-live"` (the bridge is treated as a study), `contractGuard.offContract: false`.
3. Server log: `[ibkr] front month: MESZ6 …`, `[ibkr] 1m stream live: N history bars
   delivered as bulk_bars, hello sent for MESZ6:1`, then `[mw-feed] hello MES:1 ver=2 …`.
4. The 8:30 AM digest now carries an `IBKR:` line.

### No paper account? Soak on LIVE with Read-Only API ON first

With **Read-Only API** checked, TWS / the Gateway **refuses every order at the source** — no
order can reach the exchange whatever the server does. Everything else works: ticks, 1-minute
bars, the connect-time history dump, gap backfills, contract resolution and the status page.
So run one full session (ideally RTH plus an evening) this way and check D.1–D.3 and the chart
staying live, with zero order risk. Keep the AutoTrader **disarmed** during the soak too (if
the engine fires anyway, TWS rejects the bracket and the app shows an `order_error`; three in
10 minutes auto-disarm). Only when you are ready to trade: uncheck Read-Only API (B1.2 /
B2.2), then **restart the server** so the bridge reconnects on the writable socket — section F.

## E. Unattended running (logins, restarts, IBC)

- **What needs your password**: a manual login after any **cold start / reboot** (TWS or the
  Gateway was not running), and IB's **weekly re-authentication every Sunday**. With **Auto
  restart** set (B1.4 / B2.4) the **daily** restart needs **no** password — TWS/Gateway
  restarts itself and the bridge reconnects on its own (2 s → 60 s backoff), then re-backfills
  the last `IB_BACKFILL_DAYS`.
- **IBC** (https://github.com/IbcAlpha/IBC) automates the cold-start and Sunday logins (it
  drives both TWS — `StartTWS.bat` — and the Gateway — `StartGateway.bat`). With a live
  account protected by IB Key two-factor, IBC still cannot do the **phone tap** — approve the
  IBKR Mobile notification when it arrives (put a Sunday-afternoon reminder next to the
  Fractal Exchange study session).
  1. Download the latest `IBC-<version>-Win.zip`, unzip to `C:\IBC`.
  2. Edit `%USERPROFILE%\Documents\IBC\config.ini` (the important keys):
     ```
     IbLoginId=<username>
     IbPassword=<password>              ; stays on this PC only — never copy it anywhere else
     TradingMode=live                   ; "paper" only if you use a paper login
     IbDir=C:\Jts
     AcceptIncomingConnectionAction=accept
     ReadOnlyLogin=no
     ReadOnlyApi=yes                    ; the soak; "no" in section F
     OverrideTwsApiPort=7496            ; TWS live (7497 TWS paper, 4001/4002 Gateway)
     OverrideTwsMasterClientID=17
     TrustedTwsApiClientIPs=127.0.0.1
     ExistingSessionDetectedAction=primary
     AcceptNonBrokerageAccountWarning=yes
     AllowBlindTrading=yes              ; no "you have no market data" modal on API orders
     AutoRestartTime=05:05 PM
     ClosedownAt=                       ; leave empty (never close)
     ```
  3. Edit `C:\IBC\StartTWS.bat` (or `StartGateway.bat`): set `TWS_MAJOR_VRSN` to the installed
     version, `TRADING_MODE`, and `IBC_INI` to the config path above. Double-click it once and
     confirm it logs in by itself (tap the phone prompt if asked).
  4. **Task Scheduler** (survives reboots): Create Task → "Run only when user is logged on"
     (TWS is a GUI app) → Trigger **At log on** → Action: start `C:\IBC\StartTWS.bat` →
     Conditions: untick "Start only if on AC power" → Settings: "do not start a new instance".
     Keep the PC from sleeping (the server already needs that).
- **Restart memory**: open brackets are saved to `<BAXTER_ARTIFACTS_DIR>\ibkr-brackets.json`
  and the contract eras (when the bridge switched to each month) to `ibkr-state.json` next to
  it. Delete `ibkr-brackets.json` only if you flattened the account by hand while the server
  was down.

## F. Allow orders

1. Section A.1 approved and the account funded; the Read-Only soak (above) looked clean.
2. TWS/Gateway: **uncheck Read-Only API** (IBC: `ReadOnlyApi=no`). `.env`: set
   `IB_ACCOUNT=U…` to pin the account explicitly. **Restart the server.**
3. `/api/ibkr/status` → `gateway.mode: "LIVE"`, `ready: true`, `marketData: "realtime"`.
   Keep the AutoTrader **disarmed** for the first session and watch one small manual bracket
   end-to-end before arming: `POST /api/trade/execute` with `{direction:"Long",
   price:<last>, tp1:<last+10>, sl:<last-10>, contracts:1, interval:"5m", riskLevel:"safe"}` —
   TWS shows three linked orders (MKT parent + LMT + STP, GTC); the log shows `order_queued →
   order_ack → order_filled`; it ends in `bracket_flattened {reason:"tp_filled"|"sl_filled"}`.

---

## How the bridge behaves (what to expect)

- **Front month**: `reqContractDetails(MES, FUT, CME, USD)` → the nearest expiry, but the bridge
  switches to the next contract `IB_ROLL_DAYS_BEFORE_EXPIRY` (4) days before the last trade date
  — at **00:00 ET** of that day (the Monday of expiry week), never the evening before. It
  re-checks every 6 h and on every connect; a switch cancels/re-subscribes, records the switch
  instant in `ibkr-state.json`, and pushes a "🔄 IBKR contract roll" notification.
  `IB_CONTRACT=MESZ6` pins a contract instead.
- **Contract guard interplay** (`server/contract-guard.ts`): the guard pairs the feed's raw
  1-minute closes with Yahoo's continuous `ES=F`, which has been observed rolling ~4 days
  before expiry (2026-09-14 for the 09-18 expiry) — hence the 4-day default, so IB and Yahoo
  are on the same month. If the two switch a few hours apart the guard may trip briefly and
  fast-recovers once both agree. Setting 8 (the CME volume roll) puts IB on the new month ~4
  days before Yahoo → the guard quarantines the feed and blocks orders for those days.
- **Order gates**: an order is refused (the engine logs "not placed", nothing is tracked) while
  market data is **delayed** (10167), while IB reports **connectivity lost** (1100 / 2110,
  until 1101/1102), and when the **last tick is older than 90 s** (or there has been none yet
  on this connection) — a MKT bracket must never fill blind.
- **Data**: tick-by-tick `AllLast` → `tick` messages; `reqHistoricalData(1 min, TRADES, 2 D,
  keepUpToDate)` → the opening batch becomes a LiveBarRelay-style `bulk_bars` dump and a
  `hello`, then each COMPLETED minute is a `bar` (`resolution:"1", complete:true`). If IB's
  final values for a minute arrive after the bridge already closed it (up to 2 minutes later)
  the bar is re-sent as a correction (an upsert — harmless). A historical request with no
  answer in 60 s is cancelled and retried once (the live stream is re-requested).
- **Backfill**: gap-audit's `backfill` requests are answered from IB history with IB's pacing
  rules (≤ 60 requests / 10 min, no identical request within 15 s, 1-day chunks), but only
  inside the **current contract's era** — from 00:00 ET one day after Yahoo's roll for the
  previous expiry (or the bridge's own switch instant, whichever is later) — and within
  `IB_BACKFILL_MAX_DAYS`. Anything older is **declined** (`backfill_done {declined:true,
  reason:"era"|"max_days"|"disabled"}`): gap-audit then neither marks it unfillable nor
  re-asks for 6 h, and gap-heal hands it to the Yahoo path — an old-month hole is never filled
  with new-month prices (the 2026-09-17 lesson).
- **Orders**: one bracket per `order_command` = MKT parent + LMT take-profit (full quantity at
  `tp1`) + STP stop at `sl`, all GTC (positions carry overnight), `outsideRth`, children linked
  by `parentId`, `transmit` false/false/true so IB releases the chain atomically. A `tp2` is
  never placed (TP1-only policy). When one child fills, IB's OCA cancels the other; the bridge
  double-checks 2 s later. If IB **rejects a child leg**: before the entry fills the whole
  bracket is cancelled; after the fill a replacement stop (or take-profit) is placed at once
  and a loud `order_error` says so ("UNPROTECTED" if even that fails). Order ids come from
  `nextValidId`; request ids live far above them (2,000,000,001+).
- **Events → the app**: Submitted/PreSubmitted → `order_ack`; parent Filled → `order_filled`
  (`entry` = the command price so trade-state's ±2-pt match works, `fillPrice` alongside);
  TP/SL child Filled → `bracket_flattened {reason:"tp_filled"|"sl_filled"}`; parent cancelled
  before fill → `orders_cancelled`; IB error 201/110/200/… on a tracked order → `order_error`
  (three in 10 min still auto-disarms); `reset_flag` → `flag_reset`.
- **Resilience**: reconnect with 2 s → 60 s backoff; heartbeat via `reqCurrentTime` every 30 s
  (three misses force a reconnect); 1100/1101/1102 handled (1101 re-subscribes); 10167 and
  502/504 surfaced in `lastError`. The contract guard's order gate still applies.
- **Status**: `GET /api/ibkr/status`; a line in the 08:30 daily digest; `[ibkr]` lines in the
  server log (`C:\BaxterData\logs\server-YYYYMMDD.log`).

## Troubleshooting

| Symptom | Cause / fix |
| --- | --- |
| `lastError: IB 502 Couldn't connect` | TWS/Gateway not running, `IB_PORT` does not match (7496 TWS live / 4001 Gateway live), or TWS's *Enable ActiveX and Socket Clients* is unticked (B1.2). |
| `/api/ibkr/status` says `enabled:false` | `.env` not saved, `IB_ENABLED` misspelled / duplicated, or the server was not restarted (C). |
| `connected:true` but `ready:false`, `contract:null` | No contract details — futures permission missing (A.1), or `IB_CONTRACT` names a contract IB does not list. |
| `marketData: "delayed"`, error 10167 | No CME Real-Time (NP, L1) subscription (A.2). Orders are refused until fixed. |
| Every order → `order_error` / never `order_ack` | Read-Only API still checked (expected during the soak — F.2), or a precaution modal is waiting (B1.3). |
| `order_error IB 201 … margin` | Account underfunded / futures permission not yet approved. |
| Bars stop but ticks continue | `subscriptions.bars:false` with a 162 error — the bridge retries with `1 D`; check `lastError`. |
| Guard says OFF-CONTRACT right after a roll | Expected for a few days with the 8-day rule (see interplay above). |

## Known live-account gotchas (learned on the first real connection, 2026-09-24)

- **"Insufficient equity" when buying CME Real-Time (NP, L1)**: IBKR only sells market-data
  subscriptions to accounts holding roughly USD 500 of equity; a deposit still in transit does not
  count. Without the subscription TWS answers IB 10189 (`No market data permissions for CME FUT`)
  to the tick request — history, gap fills and the order channel still work, but the bridge
  refuses orders because there are no live ticks (by design).
- **Margin, not the $5 multiplier, is the real cost**: holding one MES through the close needs
  exchange margin on the order of USD 1.5k at IBKR. The strategy carries trades overnight, so
  intraday-margin brokers (~USD 50/MES, forced flat before the close) do not fit either.
- **IB 10372 on every request** (fixed 2026-09-24): newer TWS builds return
  `lastTradeDateOrContractMonth` as `20261218 08:30:00 US/Central`; the bridge now sends only the
  `yyyymmdd` prefix in requests.
- **TWS logs itself out daily**; the bridge reconnects on its own (2 → 60 s backoff) and re-requests
  everything once TWS is back. Set Lock and Exit → Auto restart to avoid the daily manual login.
