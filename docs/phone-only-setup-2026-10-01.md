# Running the trading system from the iPhone only (2026-10-01)

Your question: can the MotiveWave studies, the AutoTrader and the terminal/server all run on the iPhone, so you
don't need the computer?

## Short answer

**No, not on the iPhone itself. But you can run everything from the iPhone if the programs run on a computer you
never have to touch.**

- The three studies (TickRelay, LiveBarRelay, AutoTrader) are custom Java add-ons. Custom add-ons only load in
  **desktop** MotiveWave (Windows, Mac or Linux). The MotiveWave iPhone app is a separate, simpler app. It has
  170+ built-in studies, but you can't install your own studies in it, and it has no strategy or auto-trading mode.
- The server (engine, signals, terminal, push alerts) is a Node program that needs a Windows/Mac/Linux machine
  that stays on. iPhones can't run it.
- So "phone only" really means: **a computer that is always on (your laptop, a small home PC, or a rented
  Windows server in Chicago) runs MotiveWave, the studies and the server, and the phone is your remote control.**
  You already have most of that remote control working.
- **Apex note:** the AutoTrader isn't allowed on an Apex account wherever it runs (laptop, rented server or
  phone). On Apex the phone setup that follows the rules is: the server sends an alert, you read it, and you
  enter the trade yourself on the phone. Details are in the Apex section below.

---

## What already works from the phone today (through the Cloudflare tunnel)

The DayTrading iPhone app connects to the server over `trading.jacksonlems.com` (Cloudflare tunnel; writes need
the API key). With the laptop running, you can already:

| From the iPhone | How |
|---|---|
| See live charts, signals, journal, ledger, backtest | DayTrading app tabs (Signals, Trade, Journal, Backtest, Portfolio) |
| Arm / disarm the AutoTrader and change its settings | DayTrading app **AutoTrader** tab (hold-to-arm; `POST /api/trade/settings`). Allowed only on a SIM account, never on Apex (see Apex section) |
| Get notified about trade events | Server push + Discord on AutoTrader fills, stops, errors, contract-guard flips (`server/trade-notify.ts`) |
| Get signal alerts | Discord signal alerts. Note: part of the signal-alert path is driven by the desktop browser tab (market.tsx). Before relying on it with the laptop unattended, check that alerts still arrive with that tab closed. Signals don't send an iPhone push of their own yet; adding one is a small server change |
| Place and manage trades by hand on the Apex account | **R\|Trader Pro mobile** (free, Rithmic's own app; Apex documents it for Rithmic accounts) or **MotiveWave Mobile** (included with your paid Order Flow desktop licence) |

So the **phone is already a working remote control**. What's missing is a computer that stays on and keeps
working when you aren't sitting at it.

---

## What can't work on the iPhone, and why

1. **Custom studies can't load in MotiveWave Mobile.**
   - MotiveWave's SDK is Java for desktop MotiveWave "version 7 and above". It loads add-ons by scanning the
     `MotiveWave Extensions` folder on a Windows/Mac disk (SDK deployment guide). Desktop system requirements
     list Windows 10+, macOS 13+ and Ubuntu 18.04+, with no iOS or Android.
   - On the forum (2024-06-25, a community member, not MotiveWave staff): "It is currently not possible to use an
     SDK to develop custom indicators specifically for the MotiveWave mobile apps on iOS and Android."
   - No mobile docs page, mobile marketing page or App Store listing mentions the SDK, custom studies, strategies
     or automation. MotiveWave hasn't said "no" in writing, but nothing on record says "yes" either.
2. **There is no strategy or auto-trading mode on mobile.** Automatic strategies (the mode AutoTrader uses) are a
   desktop-chart feature, run from a control box on the desktop Trade Panel. No mobile page mentions strategies,
   Trade Manager, backtesting or replay.
3. **The phone app and the desktop don't sync.** Workspaces, alerts and drawings don't carry over from desktop to
   mobile (users have asked since 2023 with no staff answer). The phone app can't "connect to" your desktop
   MotiveWave and drive its studies. You set it up separately, with its own broker login.
4. **The Node server can't run on iOS.** It needs a desktop-class machine, Node, the SQLite database and the
   Cloudflare tunnel connector.
5. **Even if MotiveWave added mobile strategies later, it wouldn't help.** Your studies are custom SDK code, not
   built-in strategies.

### Notes on the phone apps themselves

- MotiveWave Mobile supports Rithmic, CQG, CTS and dxFeed (docs). It has no Tradovate and no Interactive Brokers.
  The App Store text still names OANDA and TD Ameritrade, which were removed in Dec 2025. Current iOS version is
  1.1.0 and needs iOS 15+.
- **MotiveWave Mobile with an Apex login is not guaranteed to work. Test it once.** In 2024 a forum user reported
  that the mobile app didn't work with a Rithmic paper/demo login. Rithmic also says its own web/mobile access "is
  not available to demo users". Apex logins use System = **Apex** (not "Rithmic Paper Trading"), and Apex itself
  links R|Trader Pro mobile for its traders, so R|Trader Pro mobile is the safer bet. Sign the exchange
  agreements on desktop first; the mobile app doesn't show the agreement pop-up.
- **Rithmic may allow only one session per login.** If you log in on the phone while desktop MotiveWave is
  connected with the same Apex credentials, one of them may get kicked off. If it's the desktop, the studies go
  blind. This isn't confirmed in Rithmic's own docs. Test it once while watching the feed badge in the app.
- App Store reviews (Dec 2025, Apr 2026) say MotiveWave Mobile chart trading can't attach a bracket on entry.
  You'd have to add the OCO stop/target by hand right after the fill. R|Trader Pro mobile has server-side
  brackets with set stop and target ticks.

---

## The realistic options

All three keep the phone as your only screen. They differ in where the "always-on computer" lives.

### Option A: keep the laptop at home, always on, and control it from the phone

**Cost: $0/month** (about $2–4/month of electricity). Optional: $99 one-time for Windows 11 Pro if you want Microsoft
Remote Desktop instead of the free Chrome Remote Desktop.

Things about your laptop that matter (checked on this machine 2026-10-01):

- It's **Windows 11 Home**. Home can't be a Remote Desktop *host*, so use **Chrome Remote Desktop** (free) or pay
  $99 for Pro.
- It's a **Modern Standby** laptop (Lenovo 83JX). If the lid closes or the machine drops into standby, Windows
  **freezes MotiveWave, the studies and the server**. The network staying up during standby doesn't help. This
  can't be switched off; you have to stop the laptop from entering standby.
- Sleep on AC is already set to Never. The lid-close action wasn't visible in the current power plan, so set it
  explicitly.
- Tailscale is already installed and running.

Setup steps:

1. Keep it plugged in. Go to **Settings > System > Power & battery > Lid & power button controls** and set
   "When I close the lid (plugged in)" to **Do nothing**. Also set "Turn off screen" and "Sleep" (plugged in) to
   **Never**, then dim the screen. Test: close the lid, wait 15 minutes, and check that the app's chart is still
   ticking.
2. Install the **Chrome Remote Desktop** host from remotedesktop.google.com/access, set a PIN, and install the free
   Chrome Remote Desktop iOS app. You can now see and click MotiveWave from the phone. That covers reconnecting to
   Rithmic, re-activating studies and restarting the server.
3. Make it recover by itself after a crash or Windows Update reboot:
   - Put shortcuts to `C:\BaxterData\start-trading-server.bat` and MotiveWave in the Startup folder (`shell:startup`).
     The Cloudflare tunnel already has its own logon task.
   - Turn on automatic sign-in with Microsoft's **Sysinternals Autologon** so those startup items run without
     you. Microsoft's warning: the password is stored where any local admin can read it.
   - Set Windows Update **active hours** to cover the trading day.
4. In MotiveWave, check that the workspace reopens and reconnects to Rithmic without a click. If it needs a
   click, you can do that through Chrome Remote Desktop.
5. On the phone, install **R|Trader Pro** (free) and log in with System = Apex. Do this once while watching the
   feed badge in the app (the one-login-at-a-time test above).

Trade-offs: free, and nothing has to be moved. But the laptop has to stay home and on, and a home power or internet
outage takes the system down. While the laptop is busy being a server, you can't carry it around.

### Option B: a small dedicated PC at home (the cheapest real "phone-only" setup)

**Cost: about $189–239 one-time + about $1–3/month electricity.**

Example: Beelink Mini S12 Pro (N100, 16 GB, 500 GB SSD), $189 on sale / $239 list, 7–10 W idle. Check at purchase
whether it ships with Windows 11 Pro or Home. Pro lets you use built-in Remote Desktop; with Home, use Chrome
Remote Desktop. The 16 GB matters: the server is capped at about 2 GB plus a 768 MB worker, and MotiveWave wants
about 4 GB of Java heap.

Setup steps (about half a day; I can do the software side with you):

1. In the BIOS, set **"Restore on AC power loss = Power On"** so it comes back after a power cut. Plug it into the
   router with Ethernet.
2. Install Node (the same major version as the laptop), the project and the database:
   - Put the project in a normal folder like `C:\Trading`, **not OneDrive**. The live database living inside
     OneDrive is already an open risk.
   - Copy the database, `.env` (API key) and `C:\BaxterData`.
   - Update the server's boot guard to the new folder path (an engineering change on our side; otherwise the
     server refuses to start).
3. Install desktop MotiveWave and copy the three study jars into `MotiveWave Extensions`. **Close MotiveWave on the
   laptop for good.** The licence lets you install on several computers but run only one at a time.
4. Move the Cloudflare tunnel connector to the new PC: same token, logon task. Stop it on the laptop first so the
   API never answers from two places.
5. Set up Tailscale + Chrome Remote Desktop (or Windows App if it has Pro), plus autologon, startup items and
   active hours, the same as Option A steps 2–4.
6. Do the phone checks from Option A step 5.

Trade-offs: costs about the same as 3–4 months of a VPS, then nothing more. It frees the laptop. It still depends
on your home power and internet.

### Option C: a rented Windows server in Chicago (VPS)

**Cost: about $50–80/month** (prices checked 2026-10-01):

| Provider | Plan | Price | Notes |
|---|---|---|---|
| FinTechVPS | Core 4 vCPU / 8 GB | $50/mo | Chicago; lists Rithmic + MotiveWave |
| QuantVPS | VPS Lite 4 cores / 8 GB | $59.99/mo | Chicago, Windows Server 2022, lists Rithmic + MotiveWave |
| TradingVPS | Standard 4 vCPU / **16 GB** | $59/mo | Chicago/NY, WS2022; no Rithmic/MotiveWave mention |
| ChartVPS | Mark-2 3 cores / 8 GB | $80/mo | Chicago |

Pick **16 GB** if you can. On 8 GB, the server (about 2.8 GB) plus MotiveWave (about 4 GB) plus Windows would be
tight. Chicago is about 30 miles from CME's data center (Aurora, IL), which is why these advertise under 1 ms to
the exchange.

Setup steps: the same migration as Option B steps 2–4, but onto the VPS. Connect from the iPhone with Microsoft's
free **Windows App** (needs iOS 26+); Windows Server includes Remote Desktop. Shut down MotiveWave on the laptop
(one copy running at a time).

Trade-offs:

- Best uptime: no home power or internet dependency, and lowest latency.
- But it's $600–960/year.
- Windows Server isn't officially listed by MotiveWave, though VPS vendors sell it for exactly this.
- Your Rithmic/Apex logins would come from a data-center IP instead of your home. Apex's IP and VPS stance is only
  documented by third parties (their concern is account sharing, not hosting). Ask Apex support before moving
  your Apex login to a VPS.

### Not an option (for completeness)

- **Trading from the phone with no computer anywhere:** you can place trades by hand in R|Trader Pro mobile or
  MotiveWave Mobile, but you'd have no engine, no signals, no studies and no terminal.
- **Swapping MotiveWave for a direct Rithmic API bridge in the server** (like the parked IBKR bridge): this removes
  MotiveWave from the setup, but the server still needs a host. It's a bigger engineering project and it changes
  nothing about the Apex rules.

### Cost summary

| | Upfront | Monthly | Frees the laptop | Survives a home outage |
|---|---|---|---|---|
| A. Laptop always on | $0 (or $99 Pro) | ~$2–4 power | No | No |
| B. Home mini PC | ~$189–239 | ~$1–3 power | Yes | No |
| C. Chicago VPS | $0 | ~$50–80 | Yes | Yes |
| Phone apps (R\|Trader Pro, MotiveWave Mobile) | $0 | $0 | – | – |

MotiveWave Mobile is included with your paid desktop licence (the log shows Order Flow edition). Sign in with
the email you used to buy desktop MotiveWave. R|Trader Pro mobile is free.

---

## Apex note (read this before turning anything on)

- **Apex bans automated order placement on every account type.** The Apex User Agreement requires every order to be
  "initiated manually by the User through a discrete and intentional action for each individual order". It
  explicitly prohibits "pre-configured bots, scripts, or strategies that place, modify, or cancel orders based on
  preset conditions, signals, or market events". The help center adds that "hands-off, set-and-forget, or
  set-and-walk-away" trading leads to account closure and forfeiture of funds. **That is exactly what the
  AutoTrader does.** Moving it to a VPS, a mini PC or your phone doesn't change that.
- **What Apex does allow** (same agreement): tools that **generate trade alerts or signals** but don't place orders;
  platform-native stop and target orders you **set yourself when you enter**; charting and analysis software that
  doesn't touch order entry.
- **So the phone workflow that follows the rules is:** the server spots a setup, you get an alert on the phone, you
  read it, and you enter the trade yourself in R|Trader Pro (or MotiveWave Mobile) with a stop and target you set
  by hand.
  - Don't build a one-tap "take this signal" button that fills in or sends the order for you. Apex's wording bans
    tools that "pre-load" or "auto-execute" orders.
  - Be flat before **4:59 PM ET**.
- **Keep the AutoTrader DISARMED whenever MotiveWave is connected to an Apex account** (eval or PA). That's the
  09-24 decision. Using it on MotiveWave's own **SIM** account is fine. Watch out: the phone's AutoTrader tab can
  arm it remotely, so check which account the AutoTrader strategy points at before arming. If you want, I can add
  the arm-lock for Apex mode offered on 09-24, so the server refuses to arm while connected to Apex.
- Apex "strongly encourages" sending third-party software to them for approval before using it. If you want to
  be extra safe, you could send them a short description of the alert-only setup.
- If you want the AutoTrader actually trading for you while you're on your phone, you'd need a firm that allows
  automation. The 2026-09-24 prop-firm research found DayTraders.com (Rithmic plan) as the only conditional fit;
  confirm it with them in writing.

---

## Recommendation

1. **Now: Option A ($0).** On Apex, the phone's job is alerts plus entering trades by hand, so the laptop staying
   home as the server is enough:
   - Set the lid to "Do nothing" and the screen/sleep to Never.
   - Install Chrome Remote Desktop.
   - Set up autostart, autologon and Windows Update active hours.
   - Install R|Trader Pro on the phone and do the one-time login test.
   - Leave the AutoTrader disarmed on Apex.
2. **When you want the laptop back: Option B (about $200 once).** A 16 GB mini PC on Ethernet costs less than four
   months of a VPS, and I can handle the move (project out of OneDrive, boot-guard path, tunnel move).
3. **Option C (about $60/month, 16 GB, Chicago)** only if home power or internet is unreliable or you'll be away for
   weeks. Ask Apex about logging in from a VPS first.
4. **Small upgrade worth doing in any option:** send an iPhone push for each new signal straight from the server.
   Today signal alerts go through Discord, partly driven by the desktop browser tab. Then the alert reaches you
   even when nobody has a browser open.

## Things to test once (they couldn't be settled from documentation)

- [ ] R|Trader Pro mobile logs in with the Apex credentials (System = Apex).
- [ ] Logging in on the phone does / does not disconnect desktop MotiveWave's Rithmic session (watch the app's feed badge).
- [ ] MotiveWave Mobile accepts the Apex Rithmic login (optional; 2024 reports said demo/paper logins failed).
- [ ] Laptop: lid closed for 15 min, plugged in, and the chart in the app is still ticking.
- [ ] Discord/phone signal alerts still arrive with the laptop's browser tab closed.

## Sources (all fetched 2026-10-01 unless noted)

- MotiveWave Mobile: https://motivewave.com/mobile-app.htm ; https://docs.motivewave.com/mobile-app/supported-connections ;
  https://docs.motivewave.com/mobile-app/how-do-the-editions-work-for-the-mobile ;
  https://apps.apple.com/us/app/motivewave-mobile-trading/id1666369733
- SDK / desktop only: https://docs.motivewave.com/user-guide/sdk-programming-guide/deployment.md ; https://www.motivewave.com/sdk.htm ;
  https://docs.motivewave.com/knowledge-base/support/minimum-system-requirements ;
  https://forum.motivewave.com/threads/is-it-possible-to-use-sdk-to-develop-indicators-for-mobile-apps-ios-and-android.2415 (2024-06-25)
- Strategies are desktop: https://docs.motivewave.com/user-guide/strategy-back-testing/strategies.md ; https://motivewave.com/products.htm
- No desktop-mobile sync: https://forum.motivewave.com/threads/alerts-synchronize-mobile-app.1882 ; https://forum.motivewave.com/threads/motivewave-mobile-ipad-app.2999
- One running copy per licence: https://docs.motivewave.com/knowledge-base/faq/can-i-use-motivewave-on-multiple-computers
- Rithmic mobile: https://www.rithmic.com/products/web-mobile ; https://apps.apple.com/app/id1600330588 ;
  Apex: https://apextraderfunding.com/help-center/rithmic/rtrader-mobile-app/
- Apex rules: https://dashboard.apextraderfunding.com/agreement/user-agreement ;
  https://apextraderfunding.com/help-center/getting-started/prohibited-activities/ ;
  https://apextraderfunding.com/help-center/performance-accounts-pa/legacy-performance-account-pa-compliance/
- VPS pricing: https://fintechvps.com/ ; https://www.quantvps.com/pricing ; https://chartvps.com/pricing/ ; https://tradingvps.io/
- Mini PC: https://www.bee-link.com/products/beelink-mini-s12-pro-n100 ; https://www.starryhope.com/minipcs/models/beelink-mini-s12-pro/
- Remote access: https://tailscale.com/kb/1095/secure-rdp-windows ; https://support.google.com/chrome/answer/1649523 ;
  https://learn.microsoft.com/en-us/windows-server/remote/remote-desktop-services/remotepc/remote-desktop-allow-access
- Modern Standby freezes desktop apps: https://learn.microsoft.com/en-us/windows-hardware/design/device-experiences/prepare-software-for-modern-standby
- Local readings (this laptop): Windows 11 Home 25H2, Modern Standby only, AC sleep = Never, Tailscale running; the
  project's own code for the app's AutoTrader tab, trade-notify push path, Cloudflare tunnel + API-key gate.
