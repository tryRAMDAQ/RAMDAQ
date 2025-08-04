# Going live — Hedge Bots (Robinhood Chain)

Everything works locally today. This is the checklist so **nothing breaks when you move it** to the internet. The arena is the piece that goes live (real wallets, real ETH on Robinhood Chain).

## The pieces — ONE host (Railway serves everything)

| Piece | What it is | Where it hosts |
|---|---|---|
| `arena/` | the arena service — **also serves the built site** (`web/dist`) | **Railway** (one process, one URL) |
| `web/` | the site, built to static files at deploy time | served by the arena service |
| Robinhood Chain RPC | reads + broadcasts txns | public endpoints (`rpc.mainnet.chain.robinhood.com` / testnet), or a keyed Alchemy URL |

The service serves the site itself: `/`, `/app` and `/docs` are the pages, `/state`, `/join`, `/bet`, `/verify`, `/worker/*` are the API — same origin, so the frontend needs zero API config.

## 1. Everything → Railway (single service)

1. Push this repo to GitHub (already done — keys stay out via `.gitignore`).
2. New Railway project → **Deploy from GitHub repo** → pick this repo. **Root directory = the repo root** (leave blank / `/`). Build + start are read automatically from `railway.json` — no manual command entry:
   - build: installs `web/` deps, `npm run build` (produces `web/dist`), installs `arena/` deps