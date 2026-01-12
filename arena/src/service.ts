import "dotenv/config";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { Contract, formatUnits } from "ethers";
import {
  Wallet, chain, detectChain, decodeSecret, randomWallet, depositWallet, validAddress,
  sendEth, anchorMemo, drainTo, getBalanceWei, getBalanceEth, weiToEth, ethToWei, addressActivity,
  RPC_URL, provider,
} from "./chain";
import {
  RaceAgent, StrategyId, STRATEGIES, Backend, newAgent, logEvent,
  snapshotCredits, decideTrade, markToMarket, Fill, BANKROLL_USD, mulberry,
} from "./engine";
import { ComputeJob, solve, resultHashOf, isSpecSafe } from "./work";
import { detectHardware, HostCompute } from "./hw";
import { BASKET, refreshMarket, quoteOf, allQuotes, momentum, marketStatus, STOCK_TOKEN_BASE } from "./market";
import { LIQUID_STOCKS, LIQUID_SYMBOLS, LiquidStockSymbol, buyStockToken, sellStockToken } from "./stock-trader";

/**
 * HEDGE BOTS ARENA - the tweet, fused. Now on ROBINHOOD CHAIN (ETH).
 *
 * COORDINATION: agents bid for real compute jobs, rent silicon (the vast.ai
 * pool for the house, the arena host, or the player's OWN rig via the plugin
 * connector), execute, and get verified by hash. Revenue is earned.
 *
 * SPECULATION: every instrument is a bet on compute flow -
 *   - stake ETH to ENTER your agent: top compute earner takes the whole pot;
 *   - SIDE-BET ETH on any agent (house included): backers of the round's
 *     winner split the side pool pro-rata, 5% rake to treasury.
 *
 * Money rails are real ETH transfers on Robinhood Chain (Arbitrum-Orbit L2,
 * ETH gas, ~100ms blocks). Proofs ride tx calldata — open any settlement on
 * Blockscout and the compute receipt is right there in the raw input.
 */

// ------------------------------------------------------------------ config
const PORT = Number(process.env.PORT ?? process.env.RACES_PORT ?? 8787);
const RACES_PAUSED = process.env.RACES_PAUSED === "1";
const LOBBY_MS = 120_000;         // entry window BEFORE the race — stake here, then it locks
const RACE_MS = 5 * 60 * 1000;    // the race itself, entries closed
const SIDEBET_CUTOFF_MS = 45_000;      // side bets close 45s before the bell
// Entry economics — env-overridable so mainnet can tune stakes without a code change.
const MIN_ENTRY_ETH = Number(process.env.MIN_ENTRY_ETH) > 0 ? Number(process.env.MIN_ENTRY_ETH) : 0.002;
const MAX_ENTRY_ETH = Number(process.env.MAX_ENTRY_ETH) > 0 ? Number(process.env.MAX_ENTRY_ETH) : 0.5;
const MIN_SIDEBET_ETH = Number(process.env.MIN_SIDEBET_ETH) > 0 ? Number(process.env.MIN_SIDEBET_ETH) : 0.0005;
const RAKE_BPS = 500;
// The credit→wei peg for HOUSE agent wallet settlements: every verified house
// job settles as a REAL transfer (reward − rent) between the agent's wallet and
// the treasury. 1 cr = 30 gwei by default → a 150 cr job moves ~0.0000045 ETH.
const CREDIT_GWEI = Number(process.env.CREDIT_GWEI) > 0 ? Number(process.env.CREDIT_GWEI) : 30;
const weiForCredits = (credits: number): bigint => BigInt(Math.round(Math.abs(credits) * CREDIT_GWEI)) * 1_000_000_000n;
// Safety cap: within a single race, a house agent can spend at most this share of
// its wallet balance (measured at race start). Protects an agent from bleeding
// its wallet on a bad race — once it hits the cap, further settlements defer
// (the compute proof is still anchored, the ETH transfer just doesn't fire).
const AGENT_SPEND_CAP_BPS = Number(process.env.AGENT_SPEND_CAP_BPS) > 0 ? Number(process.env.AGENT_SPEND_CAP_BPS) : 500; // 5%
// Pre-launch privacy — PUBLIC_WALLETS modes:
//   "1"/"all" = everything public (launch mode)
//   "agents"  = agent wallets + tx links public, ONLY the treasury shows N/A.
//               (Heads-up: any settlement tx on Blockscout still shows the
//               treasury as counterparty — this hides it from the SITE, the
//               chain itself can't hide it.)
//   "0"/unset = everything masked (deep stealth)
// Balances always show; the on-chain flows run exactly the same in every mode.
const WALLET_MODE = String(process.env.PUBLIC_WALLETS ?? "0").toLowerCase();
const SHOW_AGENTS = WALLET_MODE === "1" || WALLET_MODE === "all" || WALLET_MODE === "agents";
const SHOW_TREASURY = WALLET_MODE === "1" || WALLET_MODE === "all";
const PUBLIC_WALLETS = SHOW_TREASURY && SHOW_AGENTS; // fully public

// YOUR treasury — a PUBLIC ADDRESS only. The key NEVER touches this server, so
// the arena can only SEND to it, never spend from it: rake + agent profits
// sweep here one-way. Nobody who compromises the box can rinse it.
const TREASURY_ADDRESS: string | null = (() => {
  const v = process.env.TREASURY_ADDRESS?.trim();
  if (!v) return null;
  const a = validAddress(v);
  if (!a) console.error(`\n  ⚠ TREASURY_ADDRESS is not a valid EVM address — IGNORING it (house money stays in the ops wallet until it's fixed).\n`);
  return a;
})();
// Working float each agent keeps; anything above it sweeps to TREASURY_ADDRESS.
const AGENT_FLOAT_WEI = ethToWei(Math.max(0, Number(process.env.AGENT_FLOAT_ETH) || 0.001));
const TICK_MS = 2_500;
const TRADE_MS = 6_000;                // each agent considers a trade this often
const MARKET_REFRESH_MS = 12_000;      // live stock quotes poll
const ANCHOR_EVERY_MS = 30_000;        // fills batch-anchor on-chain this often
const WORKER_ALIVE_MS = 60_000;        // legacy own-rig heartbeat window (retired)

// The $10k competition book remains paper. When explicitly enabled, selected
// BUY fills also mirror one small, independently capped on-chain token clip.
const REAL_STOCK_TRADES = process.env.REAL_STOCK_TRADES === "1";
const STOCK_EXECUTOR_ADDRESS = process.env.STOCK_EXECUTOR_ADDRESS?.trim() ?? "";
const REAL_STOCK_BUY_USDG = Math.min(5, Math.max(0.01, Number(process.env.REAL_STOCK_BUY_USDG) || 3));
const REAL_STOCK_MAX_BUYS_PER_RACE = Math.min(25, Math.max(0, Math.floor(Number(process.env.REAL_STOCK_MAX_BUYS_PER_RACE) || 5)));
const REAL_STOCK_MAX_BUYS_PER_WALLET = Math.min(5, Math.max(1, Math.floor(Number(process.env.REAL_STOCK_MAX_BUYS_PER_WALLET) || 1)));
const REAL_STOCK_SELLS = process.env.REAL_STOCK_SELLS === "1";
const STOCK_SELL_EXECUTOR_ADDRESS = process.env.STOCK_SELL_EXECUTOR_ADDRESS?.trim() ?? "";
const REAL_STOCK_MAX_SELLS_PER_RACE = Math.min(25, Math.max(0, Math.floor(Number(process.env.REAL_STOCK_MAX_SELLS_PER_RACE) || 5)));
const REAL_STOCK_MAX_SELLS_PER_WALLET = Math.min(5, Math.max(1, Math.floor(Number(process.env.REAL_STOCK_MAX_SELLS_PER_WALLET) || 1)));
const REAL_STOCK_SLIPPAGE_BPS = Math.min(300, Math.max(1, Math.floor(Number(process.env.REAL_STOCK_SLIPPAGE_BPS) || 100)));
const REAL_STOCK_MAX_GAS_ETH = Math.min(0.001, Math.max(0.000001, Number(process.env.REAL_STOCK_MAX_GAS_ETH) || 0.00005));

// Where the ops-wallet key + past-race history live. On Railway (ephemeral
// filesystem) point STATE_DIR at a mounted volume (e.g. /data) so the key and
// race files SURVIVE redeploys. Locally it defaults to ./state.
const STATE_DIR = process.env.STATE_DIR?.trim() || path.join(__dirname, "..", "state");
fs.mkdirSync(STATE_DIR, { recursive: true });

const rng = mulberry(0xa60aa);
const hw = detectHardware();
const hostCompute = new HostCompute(Math.max(2, hw.cores - 2));
const log = (m: string) => console.log(`${new Date().toISOString().slice(11, 19)} [arena] ${m}`);
const fmtEth = (e: number) => Number(e.toFixed(6)).toString();

// ------------------------------------------------------------- key custody
// ONE house treasury + the 5 HOUSE AGENT WALLETS. The treasury does it all:
// holds player stakes (the pot), pays winners, pays agent job rewards,
// receives their rent, and keeps the 5% rake — direct wallet-to-wallet ETH.
// Env secrets accept a 0x-prefixed 32-byte hex private key (what MetaMask /
// Rabby "export private key" gives you) or a JSON byte array — mainnet
// go-live is paste-and-restart. Missing keys are generated and persisted to
// state/evm-keys.json (gitignored) so testnet runs out of the box.
interface KeyFile { treasury: string; agents: string[]; }
const KEYS_PATH = path.join(STATE_DIR, "evm-keys.json");

function walletFromEnv(name: string): Wallet | null {
  const v = process.env[name]?.trim();
  if (!v) return null;
  const w = decodeSecret(v);
  // A malformed OPTIONAL secret must never crash the arena — warn loudly and
  // fall back (auto-generated / file key). Fund/replace it when it's valid.
  if (!w) { console.error(`\n  ⚠ ${name} is set but is NOT a valid key — expected a 0x-prefixed 32-byte hex private key (MetaMask/Rabby → Export Private Key) or a JSON byte array. IGNORING it and falling back.\n`); return null; }
  return w;
}
function localKeys(): KeyFile {
  let k: Partial<KeyFile> = {};
  if (fs.existsSync(KEYS_PATH)) {
    try { k = JSON.parse(fs.readFileSync(KEYS_PATH, "utf8")); } catch { k = {}; }
  }
  const out: KeyFile = {
    treasury: typeof k.treasury === "string" && decodeSecret(k.treasury) ? k.treasury : randomWallet().privateKey,
    agents: Array.isArray(k.agents) ? k.agents.filter((a) => typeof a === "string" && decodeSecret(a)) : [],
  };
  while (out.agents.length < 5) out.agents.push(randomWallet().privateKey);
  fs.writeFileSync(KEYS_PATH, JSON.stringify(out));
  return out;
}
const AGENT_ENV_NAMES = ["AGENT_SECRET_1", "AGENT_SECRET_2", "AGENT_SECRET_3", "AGENT_SECRET_4", "AGENT_SECRET_5"];
// ALWAYS keep a local key file as the fallback. If an env secret is missing OR
// invalid, walletFromEnv returns null and we degrade to an auto-generated key
// here — never a crash. When every env key is valid, these are simply unused.
// (Persisted to STATE_DIR — mount the Railway volume so they survive redeploys.)
const fileKeys = localKeys();
// The house treasury. TREASURY_SECRET (ESCROW_SECRET accepted as a legacy
// alias); locally it falls back to the key file so existing testnet funds and
// derived deposit addresses carry over unchanged.
const treasury = walletFromEnv("TREASURY_SECRET") ?? walletFromEnv("ESCROW_SECRET") ?? decodeSecret(fileKeys.treasury)!;
// The 5 house agent wallets — REAL on-chain actors. Each house agent settles its
// verified work as an actual transfer against the treasury, so its Blockscout
// address page IS its work history.
const agentWallets: Wallet[] = AGENT_ENV_NAMES.map((n, i) =>
  walletFromEnv(n) ?? decodeSecret(fileKeys.agents[i])!
);

const depositFor = (label: string): Wallet => depositWallet(treasury, label);

async function payOut(to: string, eth: number): Promise<string> {
  const { hash } = await sendEth(treasury, to, ethToWei(eth));
  return hash;
}

// ---- on-chain PROOF: write compute receipts to Robinhood Chain -----------
// Each verified job + each race result becomes a real transaction with the
// proof JSON in its calldata. Anyone opens it on Blockscout, reads the job +
// answer hash from the raw input, re-runs the deterministic job themselves,
// and confirms it matches - verification without trusting this server.
// Pauses if the treasury lacks gas ETH.
let receiptsPaused = false;
export async function writeReceipt(memo: object): Promise<string | null> {
  if (receiptsPaused) return null;
  try {
    const { hash } = await anchorMemo(treasury, memo);
    return hash;
  } catch (e: any) {
    receiptsPaused = true;
    setTimeout(() => { receiptsPaused = false; }, 90_000); // retry after funding
    log(`on-chain proofs PAUSED - treasury needs ETH for gas (fund ${treasury.address}): ${String(e?.message ?? e).slice(0, 60)}`);
    return null;
  }
}

// ---- HOUSE WALLET SETTLEMENT: agents that really earn & spend ------------
// Every settled house job becomes ONE real transaction: an ETH transfer between
// the agent's wallet and the treasury (reward − rent at the credit peg), with
// the compute proof in the same tx's calldata. Win a job → treasury pays your
// wallet. Ship a bad answer / rent exceeds reward → your wallet pays treasury.
// Anyone can watch each agent work on its Blockscout address page.
const walletFlowPaused = new Map<string, number>();      // payer address -> pausedUntil
const walletTxs = new Map<string, Array<{ hash: string; at: number }>>(); // our own txs, newest first
const walletEth = new Map<string, number>();             // cached balances (refresher)
const chainTxs = new Map<string, Array<{ hash: string; at: number }>>();  // from the explorer index

function pushWalletTx(addr: string, hash: string): void {
  const l = walletTxs.get(addr) ?? [];
  l.unshift({ hash, at: Date.now() });
  walletTxs.set(addr, l.slice(0, 8));
}

async function agentJobTx(w: Wallet, agent: RaceAgent, job: { receiptTx?: string }, memoObj: object, netCredits: number): Promise<void> {
  // THE LIVE MODEL (TREASURY_ADDRESS set): money moves ONE WAY, agents -> your
  // treasury. The agent signs its own settlements: losses/rent transfer to the
  // treasury; wins anchor the proof in calldata (agents never receive — the
  // score is credits, and value reaches the treasury via rent + profit sweeps).
  // Without TREASURY_ADDRESS (test mode): two-way vs the local ops wallet.
  const oneWay = TREASURY_ADDRESS !== null;
  const wei = weiForCredits(netCredits);
  const payer = oneWay ? w : netCredits >= 0 ? treasury : w;
  const payee: string | null = oneWay
    ? (netCredits < 0 && wei > 0n ? TREASURY_ADDRESS : null)
    : (netCredits >= 0 ? w.address : treasury.address);
  if ((walletFlowPaused.get(payer.address) ?? 0) > Date.now()) return;

  // PER-RACE 5% SPEND CAP: only when the AGENT itself is the one spending. If this
  // settlement would push its total spend this race over the cap, don't fire the
  // transfer — still anchor the proof so the compute record is on-chain.
  const agentIsPayer = payer.address === w.address;
  let doTransfer = !!payee && wei > 0n;
  const ethAmt = weiToEth(wei);
  if (doTransfer && agentIsPayer) {
    const cap = raceSpend.get(agent.id);
    if (cap && cap.spent + ethAmt > cap.budget) {
      doTransfer = false;
      logEvent(agent, `per-race spend cap (${AGENT_SPEND_CAP_BPS / 100}%) reached — settlement deferred, proof still anchored`);
    }
  }
  try {
    // transfer + proof in ONE tx: EVM calldata rides along natively.
    const { hash } = doTransfer && payee
      ? await sendEth(payer, payee, wei, memoObj)
      : await anchorMemo(payer, memoObj);
    if (doTransfer && agentIsPayer) { const cap = raceSpend.get(agent.id); if (cap) cap.spent += ethAmt; }
    // cumulative on-chain ETH P&L for this agent (shown on the site)
    if (doTransfer && wei > 0n) {
      if (agentIsPayer) recordFlow(agent.name, ethAmt, false);                 // agent PAID (rent/loss)
      else if (payee === w.address) recordFlow(agent.name, ethAmt, true);      // agent EARNED (win)
    }
    job.receiptTx = hash;
    pushWalletTx(w.address, hash);
    pushWalletTx(oneWay ? TREASURY_ADDRESS! : treasury.address, hash);
    logEvent(agent, oneWay
      ? (doTransfer ? `paid ${fmtEth(ethAmt)} ETH rent -> treasury (tx ${hash.slice(0, 10)}…)` : `proof anchored on-chain, +${netCredits} cr (tx ${hash.slice(0, 10)}…)`)
      : (doTransfer ? `settled ON-CHAIN: ${netCredits >= 0 ? "earned" : "paid"} ${fmtEth(ethAmt)} ETH (tx ${hash.slice(0, 10)}…)` : `proof anchored on-chain (spend cap) (tx ${hash.slice(0, 10)}…)`));
  } catch (e: any) {
    walletFlowPaused.set(payer.address, Date.now() + 90_000);
    log(`wallet flow PAUSED for ${payer.address.slice(0, 10)}… (fund it to resume): ${String(e?.message ?? e).slice(0, 70)}`);
  }
}

// ---- per-race spend cap: no agent spends >AGENT_SPEND_CAP_BPS of its wallet ---
// budget[agentId] = share of the wallet balance snapshotted at race start (ETH).
const raceSpend = new Map<string, { budget: number; spent: number }>();
async function initRaceSpendCaps(): Promise<void> {
  raceSpend.clear();
  if (!race) return;
  for (const a of race.agents) {
    if (!a.house) continue;
    const w = houseWalletByName.get(a.name);
    if (!w) continue;
    try {
      const bal = await getBalanceEth(w.address);
      raceSpend.set(a.id, { budget: (bal * AGENT_SPEND_CAP_BPS) / 10_000, spent: 0 });
    } catch { raceSpend.set(a.id, { budget: 0, spent: 0 }); }
  }
}

// Keep the wallet board fresh: real balances + real on-chain activity for every
// house wallet and the treasury — served in /state for the site.
async function refreshWalletBoard(): Promise<void> {
  const all = [...agentWallets.map((k) => k.address), treasury.address, ...(TREASURY_ADDRESS ? [TREASURY_ADDRESS] : [])];
  for (const addr of all) {
    try { walletEth.set(addr, await getBalanceEth(addr)); } catch { /* keep last */ }
    try {
      chainTxs.set(addr, await addressActivity(addr, 6));
    } catch { /* explorer index unreachable — our own tx ring still shows */ }
  }
}
/** Merged view: explorer-indexed activity + our just-sent txs the index hasn't caught yet. */
function walletActivity(addr: string): Array<{ hash: string; at: number }> {
  const seen = new Set<string>();
  const out: Array<{ hash: string; at: number }> = [];
  for (const e of [...(walletTxs.get(addr) ?? []), ...(chainTxs.get(addr) ?? [])]) {
    if (seen.has(e.hash)) continue;
    seen.add(e.hash);
    out.push(e);
    if (out.length >= 6) break;
  }
  return out;
}

// ------------------------------------------------------------------ state
interface SideBet { owner: string; agentId: string; eth: number; depositAddress: string; }

interface Trade extends Fill {
  agentId: string;
  name: string;
  strategy: StrategyId;
}

interface Race {
  id: number;
  openedAt: number;  // lobby opens (entries open)
  startsAt: number;  // race begins (entries LOCK)
  endsAt: number;    // race ends
  potEth: number;        // entry stakes (players)
  sidePotEth: number;    // spectator side bets
  agents: RaceAgent[];
  jobs: ComputeJob[];    // legacy, always [] in trading mode
  trades: Trade[];       // the tape — every fill, newest last
  sideBets: SideBet[];
  settled: boolean;
  results: Array<{ name: string; owner: string | null; credits: number; paidEth: number; tx?: string }>;
  sideNote?: string;
  anchorTx?: string;        // on-chain calldata anchor of the final standings
}

// walletStats = cumulative REAL ETH each house agent has earned (paid to it for
// verified wins) and spent (rent/losses), keyed by agent name.
// Persisted so the on-chain P&L survives redeploys.
interface Persisted { raceCounter: number; pastRaces: Race[]; walletStats?: Record<string, { earned: number; spent: number }>; }
const DB_PATH = path.join(STATE_DIR, "races-evm.json");
const db: Persisted = fs.existsSync(DB_PATH)
  ? JSON.parse(fs.readFileSync(DB_PATH, "utf8"))
  : { raceCounter: 0, pastRaces: [] };
db.walletStats = db.walletStats ?? {};
const saveDb = () => fs.writeFileSync(DB_PATH, JSON.stringify(db));
function recordFlow(name: string, eth: number, earned: boolean): void {
  const w = (db.walletStats![name] = db.walletStats![name] ?? { earned: 0, spent: 0 });
  if (earned) w.earned += eth; else w.spent += eth;
}

let race: Race | null = null;
let lastTradeAt = 0;
const pendingAnchor: Trade[] = []; // fills awaiting their on-chain batch anchor
let realStockBuysThisRace = 0;
const realStockBuysByWallet = new Map<string, number>();
let realStockSellsThisRace = 0;
const realStockSellsByWallet = new Map<string, number>();
const realStockLots = new Map<string, { sym: LiquidStockSymbol; amount: string }>();
const recentBuySymbols = new Map<string, string[]>();
const stockBuyPaused = new Map<string, number>();

// 5 house desks ↔ 5 wallets (AGENT_SECRET_1..5, by position).
// The cast is Robin Hood lore — fitting, since they trade on Robinhood Chain.
const HOUSE: Array<{ name: string; strategy: StrategyId }> = [
  { name: "Friar Tuck", strategy: "balanced" },   // steady hands, blue chips
  { name: "Will Scarlet", strategy: "undercut" }, // the quick blade — scalps
  { name: "Little John", strategy: "premium" },   // the big man — whale positions
  { name: "Sheriff Notts", strategy: "memes" },   // the villain — degen chaos
  { name: "Robyn Arrow", strategy: "sniper" },    // never misses the mover
];
const houseWalletByName = new Map<string, Wallet>(HOUSE.map((h, i) => [h.name, agentWallets[i]]));

interface RealPortfolio {
  usdg: number;
  stockUsd: number;
  equityUsd: number;
  startEquityUsd: number;
  pnlUsd: number;
  positions: Array<{ sym: string; qty: number; px: number; valueUsd: number; token: string }>;
  history: Array<{ t: number; v: number }>;
  updatedAt: number;
}

const USDG_TOKEN = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const BALANCE_ABI = ["function balanceOf(address) view returns(uint256)"];
const realPortfolios = new Map<string, RealPortfolio>();
const realPortfolioBaselines = new Map<string, number>();
const realPortfolioHistory = new Map<string, Array<{ t: number; v: number }>>();

async function refreshRealPortfolios(resetBaseline = false): Promise<void> {
  if (chain.chainId !== 4663) return;
  await Promise.all(agentWallets.map(async (wallet) => {
    try {
      const stockEntries = LIQUID_SYMBOLS.map((sym) => [sym, LIQUID_STOCKS[sym]] as const);
      const [usdgRaw, ...stockRaws] = await Promise.all([
        new Contract(USDG_TOKEN, BALANCE_ABI, provider).balanceOf(wallet.address),
        ...stockEntries.map(([, token]) => new Contract(token, BALANCE_ABI, provider).balanceOf(wallet.address)),
      ]);
      const usdg = Number(formatUnits(usdgRaw, 6));
      const positions: RealPortfolio["positions"] = [];
      stockEntries.forEach(([sym, token], i) => {
        const qty = Number(formatUnits(stockRaws[i], 18));
        const px = pxOf(sym) ?? 0;
        if (qty > 1e-12) positions.push({ sym, qty, px, valueUsd: qty * px, token });
      });
      const stockUsd = positions.reduce((sum, p) => sum + p.valueUsd, 0);
      const equityUsd = usdg + stockUsd;
      if (resetBaseline || !realPortfolioBaselines.has(wallet.address)) realPortfolioBaselines.set(wallet.address, equityUsd);
      const startEquityUsd = realPortfolioBaselines.get(wallet.address)!;
      const pnlUsd = equityUsd - startEquityUsd;
      const history = resetBaseline ? [] : (realPortfolioHistory.get(wallet.address) ?? []);
      history.push({ t: Date.now(), v: pnlUsd });
      if (history.length > 240) history.shift();
      realPortfolioHistory.set(wallet.address, history);
      realPortfolios.set(wallet.address, {
        usdg, stockUsd, equityUsd, startEquityUsd, pnlUsd,
        positions: positions.sort((a, b) => b.valueUsd - a.valueUsd),
        history: [...history], updatedAt: Date.now(),
      });
    } catch { /* keep the last confirmed portfolio snapshot */ }
  }));
}

function realPortfolioOf(a: RaceAgent): RealPortfolio | undefined {
  const wallet = a.house ? houseWalletByName.get(a.name) : undefined;
  return wallet ? realPortfolios.get(wallet.address) : undefined;
}

const scoreOf = (a: RaceAgent): number => realPortfolioOf(a)?.pnlUsd ?? a.credits;
const equityOf = (a: RaceAgent): number => realPortfolioOf(a)?.equityUsd ?? a.equity;

function newRace(): Race {
  db.raceCounter += 1;
  const agents = HOUSE.map((h, i) =>
    newAgent({
      id: `r${db.raceCounter}-house${i}`, name: h.name, strategy: h.strategy,
      house: true, owner: null, depositAddress: null, funded: true,
      entryEth: 0, backend: "vast", // legacy field, unused in trading mode
    })
  );
  pendingAnchor.length = 0;
  realStockBuysThisRace = 0;
  realStockBuysByWallet.clear();
  realStockSellsThisRace = 0;
  realStockSellsByWallet.clear();
  realStockLots.clear();
  realPortfolioBaselines.clear();
  realPortfolioHistory.clear();
  recentBuySymbols.clear();
  const openedAt = Date.now();
  const startsAt = openedAt + LOBBY_MS;   // lobby first, then the race begins
  const r: Race = {
    id: db.raceCounter,
    openedAt, startsAt, endsAt: startsAt + RACE_MS,
    potEth: 0, sidePotEth: 0,
    agents, jobs: [], trades: [], sideBets: [],
    settled: false, results: [],
  };
  log(`race #${r.id} LOBBY open - stake for ${LOBBY_MS / 1000}s, then the agents trade RWA stocks for ${RACE_MS / 60000} min`);
  const qs = allQuotes();
  if (qs.length) log(`  market: ${qs.slice(0, 6).map((q) => `${q.sym} $${q.usd.toFixed(2)}`).join(" · ")} …`);
  return r;
}

// ------------------------------------------------------------ trading floor
function agentById(id: string): RaceAgent | undefined {
  return race?.agents.find((a) => a.id === id);
}

const SYMS: string[] = [...LIQUID_SYMBOLS];
const pxOf = (sym: string) => quoteOf(sym)?.usd;
const momOf = (sym: string) => momentum(sym, 3 * 60_000);
function publicOnchainTrade(f: Fill & Partial<Pick<Trade, "agentId" | "name" | "strategy">>) {
  if (!f.stockTx || !f.stockAmount || !f.usdgAmount) return null;
  const qty = Number(f.stockAmount);
  const usd = Number(f.usdgAmount);
  const side = f.stockAction ?? f.side;
  return {
    t: f.t, agentId: f.agentId, name: f.name, strategy: f.strategy,
    sym: f.sym, side, qty, px: qty > 0 ? usd / qty : f.px, usd,
    receiptTx: SHOW_AGENTS ? f.stockTx : null,
    proven: true,
    onchainPurchase: side === "buy",
    onchainSale: side === "sell",
    stockAmount: f.stockAmount,
    usdgAmount: f.usdgAmount,
    stockToken: f.stockToken ?? null,
  };
}
const fmtUsd = (v: number) => (v >= 0 ? "+" : "−") + "$" + Math.abs(v).toFixed(2);

/** One pass of the floor: every funded agent may act on its persona's signal.
 *  Fills execute at the LIVE market price ± a small realistic slippage. */
function diversifyBuy(a: RaceAgent, intent: { sym: string; side: "buy" | "sell"; qty: number }): typeof intent {
  if (intent.side !== "buy") return intent;
  const prefs = STRATEGIES[a.strategy].prefs.filter((s) => SYMS.includes(s));
  const universe = prefs.length >= 2 ? prefs : SYMS;
  const recent = recentBuySymbols.get(a.id) ?? [];
  const choices = universe.filter((s) => !recent.includes(s));
  const sym = choices.length ? choices[Math.floor(rng() * choices.length)] : intent.sym;
  const oldPx = pxOf(intent.sym);
  const newPx = pxOf(sym);
  if (!oldPx || !newPx) return intent;
  const notional = intent.qty * oldPx;
  return { ...intent, sym, qty: Math.round((notional / newPx) * 10_000) / 10_000 };
}

async function mirrorRealStockBuy(a: RaceAgent, fill: Trade): Promise<boolean> {
  if (!REAL_STOCK_TRADES || fill.side !== "buy" || !a.house) return false;
  if (realStockBuysThisRace >= REAL_STOCK_MAX_BUYS_PER_RACE) return false;
  const wallet = houseWalletByName.get(a.name);
  if (!wallet || (stockBuyPaused.get(wallet.address) ?? 0) > Date.now()) return false;
  if ((realStockBuysByWallet.get(wallet.address) ?? 0) >= REAL_STOCK_MAX_BUYS_PER_WALLET) return false;
  if (!LIQUID_SYMBOLS.includes(fill.sym as LiquidStockSymbol)) return false;

  // Reserve before awaiting so overlapping rounds cannot breach the race cap.
  realStockBuysThisRace += 1;
  realStockBuysByWallet.set(wallet.address, (realStockBuysByWallet.get(wallet.address) ?? 0) + 1);
  try {
    const purchase = await buyStockToken(wallet, fill.sym as LiquidStockSymbol, {
      executor: STOCK_EXECUTOR_ADDRESS,
      amountUsdg: REAL_STOCK_BUY_USDG,
      slippageBps: REAL_STOCK_SLIPPAGE_BPS,
      maxGasEth: REAL_STOCK_MAX_GAS_ETH,
    });
    fill.stockTx = purchase.purchaseTx;
    fill.approvalTx = purchase.approvalTx;
    fill.stockToken = purchase.token;
    fill.stockAmount = purchase.stockReceived;
    fill.stockAction = "buy";
    fill.usdgAmount = purchase.usdgSpent;
    realStockLots.set(wallet.address, { sym: purchase.symbol, amount: purchase.stockReceived });
    if (purchase.approvalTx) pushWalletTx(wallet.address, purchase.approvalTx);
    pushWalletTx(wallet.address, purchase.purchaseTx);