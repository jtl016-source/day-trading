# PORTFOLIO — Long-Term Research Module

A fully **isolated** add-on to the trading dashboard. It does **not** touch the MES
futures engine, signal tiers, auto-trader state, relay, candle, or websocket code.
New server services live in `server/portfolio/`, new UI in
`client/src/components/portfolio/` + `client/src/pages/portfolio.tsx`, reachable at the
**`/portfolio`** route (PORTFOLIO tab in the terminal header).

All data is fetched **server-side** in Node and exposed under `/api/portfolio/*`. The
React client only consumes those same-origin endpoints.

---

## 1. Environment

| Var | Required | Notes |
|-----|----------|-------|
| `FMP_API_KEY` | yes | [Financial Modeling Prep](https://site.financialmodelingprep.com/developer/docs) key. Read from `process.env`, never hardcoded. Add to `.env` (gitignored). A placeholder is in `.env.example`. |
| `PORT` | — | Existing app port. Portfolio routes mount on the same server. |

> ⚠️ **Rotate your key** if it was ever shared in plaintext. Then put the new value in
> `.env` and restart the server.

Without a key the module loads, the UI shows an "FMP_API_KEY not set" hint, and every
endpoint degrades gracefully (empty + `dataStale: true`) instead of crashing.

---

## 2. Endpoints (`/api/portfolio/*`)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/health` | key present?, daily FMP budget, active weights |
| GET | `/congress/recent` | normalized senate+house trades (rolling 90d) + your followed list |
| GET | `/congress/leaders` | per-politician aggregation (buys/sells, top tickers, conviction) |
| POST | `/congress/follow` | `{ politician }` — star/unstar |
| GET | `/smartmoney/funds` | tracked funds + summaries (top tickers, portfolio value) |
| GET | `/smartmoney/fund/:cik` | one fund's full holdings + QoQ change |
| GET | `/smartmoney/consensus` | cross-fund ownership counts (holders / adders) |
| GET | `/insider/recent` | open-market insider BUYS ≥ $100k by officers/directors |
| GET | `/score/:ticker` | full confluence breakdown (0–100 + pillars + flags) |
| GET | `/screener?universe=all\|watchlist\|holdings&minTotal=&minQuality=…` | scored, filtered, sorted |
| GET / POST / DELETE | `/watchlist` | tracked tickers (`POST {ticker}`, `DELETE ?ticker=`) |
| GET / POST | `/holdings` | manual positions (live-valued). `POST {ticker,shares,costBasis,isCore}`; `POST {action:"delete",ticker}`; `POST {action:"coreTarget",pct,etf}` |

---

## 3. Caching & free-tier safety

In-memory **stale-while-revalidate** cache (`cache.ts`) with per-source TTLs:

| Source | TTL |
|--------|-----|
| fundamentals, 13F, SPY benchmark | 24h |
| congress, insider | 1h |
| quotes | 1min |

Every FMP request goes through `fmpClient.ts`, which has **retry-with-backoff** and a
**daily budget guard**: it logs a warning at **200** calls and hard-stops at **245**
(serving cache only) so the ~250/day free-tier ceiling is never breached. Budget is
visible at `GET /api/portfolio/health` and in the UI's top-right corner.

Cost is dominated by the number of **distinct tickers scored** and **tracked CIKs**, not
by how often the dashboard is open (stale reads refresh in the background, capped by the
guard).

---

## 4. Confluence scoring (`scoring.ts`)

`scoreStock(ticker)` → `{ ticker, total (0–100), grade A–F, pillars, flags, dataStale }`.
All weights live in one tunable `PORTFOLIO_WEIGHTS` object:

| Pillar | Weight | What it measures |
|--------|--------|------------------|
| **Quality** | 30 | ROE>15, ROIC>12, D/E<1, interest coverage>5, 5y positive FCF, gross-margin stability (each sub-check proportional) |
| **Value** | 20 | P/FCF, EV/EBITDA, P/E (cheaper = higher). **Value-trap guard**: capped at half weight until Quality ≥ 50% of its max |
| **Momentum** | 20 | 12-1 month return vs SPY. **Zero if below the 200-day MA** (regime filter) |
| **Smart Money** | 20 | +per tracked superinvestor holding it, bonus per fund that ADDED, bonus for a top-10 weight anywhere. Diminishing past 8 holders |
| **Congress + Insider** | 10 | recent congressional buys (weighted by amount + recency, ×2 if multiple politicians bought independently) + insider buys ≥ $100k |

**Flags:** `BELOW_200DMA`, `VALUE_TRAP_GUARD`, `CROWDED` (>15 holders),
`DISCLOSURE_LAG` (congress data >30 days old).

To **tune weights**, edit `PORTFOLIO_WEIGHTS` in `server/portfolio/scoring.ts` — every
sub-weight and threshold is named there in one place.

> Note: Value scores against fixed "cheap/expensive" ramps rather than live sector
> medians (a sector-median fetch over the whole universe would blow the free-tier
> budget). Adjust the ramps in `scoring.ts` if you want them tighter.

---

## 5. Adding / removing superinvestors

Edit `server/portfolio/superinvestors.ts` — a plain array of
`{ cik, manager, fund }`. To **add**: find the fund on
[SEC EDGAR 13F search](https://www.sec.gov/cgi-bin/browse-edgar?action=getcompany&type=13F),
copy the 10-digit CIK, append a row. To **remove**: delete the row. A wrong/most-recent
CIK simply yields empty holdings (the fund card shows "no data — verify CIK") and never
breaks the build. CIKs occasionally drift when a fund re-registers.

---

## 6. Persistence

Watchlist, holdings, followed politicians, and core/satellite target are stored in
`data/portfolio.json` (`store.ts`) — a single JSON file, **separate from the futures
sqlite DB**, so the trading data is never touched.

---

## 7. Shared files touched (minimal diffs)

- `server/index.ts` — 2 lines: import + `registerPortfolioRoutes(app)`.
- `client/src/App.tsx` — 2 lines: import + `<Route path="/portfolio" …/>`.
- `client/src/pages/terminal.tsx` — 3 lines: `useLocation` import, hook, one `Portfolio` nav button.
- `.env` / `.env.example` — `FMP_API_KEY`.

Everything else is new, isolated files.

---

## 8. Disclaimer

Research tool — **not investment advice**. 13F filings lag up to 135 days; congressional
disclosures up to 45 days. Insider and congressional data are informational only.
