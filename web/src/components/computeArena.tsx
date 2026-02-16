import React, { useEffect, useState } from "react";
import {
  detectWallets, onWalletsChanged, connectEvmWallet, payEntry, getBalanceEth,
  DetectedWallet, Eip1193Provider,
} from "../lib/evm";
import { EthMark } from "./ethMark";
import { TradeTimeline } from "./tradeTimeline";
import { fetchRealTrades, RealTrade } from "../lib/realTrades";

/**
 * The ONE real trading arena — on Robinhood Chain. Shared building blocks so
 * "Create your agent" (My Agents tab) and "Build your agent" (Trading Floor
 * tab) are literally the same flow — one real trading desk, not two.
 */
// API base: explicit env wins; on the Vite dev server the arena is :8787;
// deployed (single-host Railway) the arena IS the origin serving this page.
export const RACES_API = (import.meta as any).env?.VITE_RACES_API
  ?? (typeof window !== "undefined" && window.location.port === "5173" ? "http://localhost:8787" : "");
const STRAT_COLOR: Record<string, string> = { balanced: "#2a78d6", undercut: "#1baf7a", premium: "#4a3aa7", memes: "#e87ba4", sniper: "#d97706" };

// The ETH pot winner is the top-CREDIT *paying* agent — house agents can top the
// board on credits but they never take the pot, and a lone staker only gets a
// refund (not a win). Mirrors settle() on the server. results[] is already sorted
// by credits desc, so the first owner-bearing row in a contested race is the champ.
function potChampion(r: any): any | null {
  const paying = (r?.results ?? []).filter((x: any) => x.owner);
  return paying.length >= 2 ? paying[0] : null;
}
const isContested = (r: any) => (r?.results ?? []).filter((x: any) => x.owner).length >= 2;

export const fmtEth = (v: number, dp = 4): string => Number((v ?? 0).toFixed(dp)).toString();
export const fmtPnl = (v: number): string => `${v >= 0 ? "+$" : "−$"}${Math.abs(v).toFixed(Math.abs(v) < 1 ? 4 : 2)}`;

// ---- shared arena data (one poller per mounted component; cheap) ----------
export function useArena() {
  const [arena, setArena] = useState<any>(null);
  const [offline, setOffline] = useState(false);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try { const r = await fetch(`${RACES_API}/state`); if (alive) { setArena(await r.json()); setOffline(false); } }
      catch { if (alive) setOffline(true); }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, []);
  return { arena, offline };
}

// ---- shared EVM wallet (EIP-6963: MetaMask, Rabby, Robinhood Wallet, any) --
// Connected once, seen by every tab. If several wallets are installed a
// picker opens (rendered by <WalletPickerHost/>, mounted once in App).
let sharedWallet: { name: string; address: string; provider: Eip1193Provider } | null = null;
let pickerOpen = false;
const listeners = new Set<() => void>();
const notify = () => listeners.forEach((f) => f());
const LAST_WALLET_KEY = "cr-last-wallet";

async function connectProvider(w: DetectedWallet): Promise<void> {
  const address = await connectEvmWallet(w.provider);
  sharedWallet = { name: w.name, address, provider: w.provider };
  try { localStorage.setItem(LAST_WALLET_KEY, w.rdns); } catch { /* private mode */ }
  pickerOpen = false;
  notify();
}

export function useWallet() {
  const [, force] = useState(0);
  useEffect(() => {
    const f = () => force((x) => x + 1);
    listeners.add(f);
    const off = onWalletsChanged(f);
    return () => { listeners.delete(f); off(); };
  }, []);
  const connect = async () => {
    const ws = detectWallets();
    if (ws.length === 0) throw new Error("no EVM wallet found — install MetaMask, Rabby or Robinhood Wallet, then reload");
    const last = (() => { try { return localStorage.getItem(LAST_WALLET_KEY); } catch { return null; } })();
    const remembered = ws.find((w) => w.rdns === last);
    if (ws.length === 1 || remembered) return connectProvider(remembered ?? ws[0]);
    pickerOpen = true;   // several wallets installed: let the user choose
    notify();
  };
  return { wallet: sharedWallet, connect };
}

/** The wallet chooser — renders only while a choice is pending. Mount ONCE. */
export function WalletPickerHost() {
  const [, force] = useState(0);
  useEffect(() => { const f = () => force((x) => x + 1); listeners.add(f); return () => { listeners.delete(f); }; }, []);
  if (!pickerOpen) return null;
  const ws = detectWallets();
  const close = () => { pickerOpen = false; notify(); };
  return (
    <div onClick={close} style={{ position: "fixed", inset: 0, zIndex: 120, display: "flex", alignItems: "center", justifyContent: "center", background: "rgba(10,14,10,0.5)", backdropFilter: "blur(4px)", padding: 20 }}>
      <div onClick={(e) => e.stopPropagation()} style={{ width: "min(360px,100%)", background: "var(--surface,#fff)", border: "1px solid var(--border-strong)", borderRadius: 18, padding: "22px 22px 16px", boxShadow: "0 30px 80px rgba(0,0,0,0.35)" }}>
        <h2 style={{ fontFamily: "var(--font-display)", fontSize: 17, color: "var(--ink)", margin: "0 0 4px" }}>Connect a wallet</h2>
        <div className="mut" style={{ fontSize: 11.5, marginBottom: 14 }}>any EVM wallet works — pick the one to use on Robinhood Chain</div>
        {ws.map((w) => (
          <button key={w.rdns} onClick={() => connectProvider(w).catch(() => { pickerOpen = false; notify(); })}
            style={{ display: "flex", alignItems: "center", gap: 10, width: "100%", textAlign: "left", cursor: "pointer", background: "var(--surface-2)", border: "1px solid var(--border)", borderRadius: 12, padding: "10px 14px", marginBottom: 8 }}>
            {w.icon ? <img src={w.icon} width={22} height={22} style={{ borderRadius: 6 }} /> : <span style={{ fontSize: 18 }}>👛</span>}
            <span className="ink" style={{ fontWeight: 600, fontSize: 13.5, fontFamily: "var(--font-display)" }}>{w.name}</span>
          </button>
        ))}
        <button className="ghost" onClick={close} style={{ marginTop: 4 }}>Cancel</button>
      </div>
    </div>
  );
}

export const explorerTxUrl = (arena: any, hash: string) =>
  `${arena?.explorerTxBase ?? "https://robinhoodchain.blockscout.com/tx/"}${hash}`;

// ---- REAL on-chain trades feed — the actual stock buys by the desks, read
// from the wallets on Blockscout. Persistent + verifiable, shown in the arena.
export function RealTradesFeed() {
  const { arena } = useArena();
  const [trades, setTrades] = useState<RealTrade[]>([]);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      const prices: Record<string, number> = {};
      for (const s of (arena?.market?.stocks ?? [])) if (s.usd) prices[s.sym] = s.usd;
      const rt = await fetchRealTrades(prices);
      if (alive && rt.length) setTrades(rt);
    };
    load();
    const t = setInterval(load, 20000);
    return () => { alive = false; clearInterval(t); };
  }, [arena?.market?.stocks?.length]);
  return (
    <div className="card">
      <h3>Real trades — on-chain stock buys by the desks <span className="hbar" /><span className="livedot" /></h3>
      {(trades.length ? trades : (arena?.race?.trades ?? [])).length === 0
        ? <div style={{ color: "var(--muted)", fontFamily: "var(--font-mono)", fontSize: 13, padding: "22px 0" }}>the tape lights up the moment the market opens…</div>
        : <TradeTimeline trades={trades.length ? trades : (arena?.race?.trades ?? [])} txBase={arena?.explorerTxBase ?? "https://robinhoodchain.blockscout.com/tx/"} limit={20} />}
      <div className="mut" style={{ fontSize: 11.5, marginTop: 10 }}>
        Every row is a <b className="ink">real Robinhood Stock Token purchase</b> the agents made{trades.length ? ` — ${trades.length} on-chain so far` : ""}. Click any to verify the transaction on Blockscout.
      </div>
    </div>
  );
}
export const explorerAddressUrl = (arena: any, address: string) =>
  `${arena?.explorerAddressBase ?? "https://robinhoodchain.blockscout.com/address/"}${address}`;

const timeAgo = (at: number) => {
  if (!at) return "";
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  return s < 60 ? `${s}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`;
};

// ============================================================== HouseWallets
// THE WALLET BOARD — the 5 house agents are real Robinhood Chain wallets
// earning and spending on-chain. Track each one live: balance, latest
// transactions (every hash is a Blockscout link), and its full activity on
// its Blockscout address page.
export function HouseWallets() {
  const { arena } = useArena();
  const w = arena?.wallets;
  if (!w || !w.agents?.length) return null;

  const Row = ({ name, strategy, address, eth, txs, paused, tint, last, ethEarned, ethSpent, usdg, tradingEquityUsd, tradingPnlUsd }: any) => (
    <div style={{ display: "grid", gridTemplateColumns: "minmax(150px,1.2fr) minmax(110px,0.9fr) 132px 1fr auto", gap: 10, alignItems: "center", padding: "10px 6px", borderBottom: last ? "none" : "1px solid var(--grid)" }}>
      <span style={{ display: "inline-flex", alignItems: "center", gap: 7, minWidth: 0 }}>
        <span className="dot" style={{ background: tint, margin: 0 }} />
        <span className="ink" style={{ fontWeight: 600, fontSize: 13, whiteSpace: "nowrap" }}>{name}</span>
        {strategy && <span className="mut" style={{ fontSize: 10 }}>{arena.strategies?.[strategy]?.name ?? strategy}</span>}
        {paused && <span title="wallet needs ETH for gas" style={{ color: "var(--critical)", fontSize: 10 }}>⚠ fund</span>}
      </span>
      {address ? (
        <a href={explorerAddressUrl(arena, address)} target="_blank" rel="noreferrer" title="open this wallet's full activity on Blockscout"
          style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: "var(--violet)", textDecoration: "none", whiteSpace: "nowrap" }}>
          {address.slice(0, 6)}..{address.slice(-4)} ↗
        </a>
      ) : (
        <span className="mut" style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, whiteSpace: "nowrap" }} title="announced at token launch">TBA</span>
      )}
      <span style={{ textAlign: "right", whiteSpace: "nowrap", lineHeight: 1.25 }}>
        <span className="num mono ink" style={{ fontSize: 12.5 }}>{tradingEquityUsd !== null && tradingEquityUsd !== undefined ? `$${Number(tradingEquityUsd).toFixed(2)}` : "…"}</span>
        {tradingPnlUsd !== null && tradingPnlUsd !== undefined && <span style={{ display: "block", color: tradingPnlUsd >= 0 ? "var(--good)" : "var(--critical)", fontFamily: "var(--font-mono)", fontSize: 9.5 }}>{tradingPnlUsd >= 0 ? "+$" : "−$"}{Math.abs(Number(tradingPnlUsd)).toFixed(4)} P&amp;L</span>}
        <span className="mut" style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 9 }}>{usdg !== null && usdg !== undefined ? `${Number(usdg).toFixed(2)} USDG` : ""}{eth !== null && eth !== undefined ? ` · ${Number(eth).toFixed(5)} ETH gas` : ""}</span>
        {(ethEarned > 0 || ethSpent > 0) && (
          <span style={{ display: "block", fontFamily: "var(--font-mono)", fontSize: 9.5, marginTop: 2 }} title="cumulative real ETH earned (wins) and spent (rent/losses) on-chain">
            <span style={{ color: "var(--good)" }}>▲{Number(ethEarned).toFixed(6)}</span>{" "}<span style={{ color: "var(--critical)" }}>▼{Number(ethSpent).toFixed(6)}</span>
          </span>
        )}
      </span>
      <span style={{ display: "flex", gap: 6, flexWrap: "wrap", minWidth: 0 }}>
        {(txs ?? []).slice(0, 3).map((t: any) => (
          <a key={t.hash} href={explorerTxUrl(arena, t.hash)} target="_blank" rel="noreferrer"
            style={{ fontFamily: "var(--font-mono)", fontSize: 10, color: "var(--violet)", background: "var(--violet-soft)", borderRadius: 6, padding: "2px 7px", textDecoration: "none", whiteSpace: "nowrap" }}>
            {t.hash.slice(0, 6)}…{t.hash.slice(-4)}{t.at ? ` · ${timeAgo(t.at)}` : ""} ↗
          </a>
        ))}
        {(txs ?? []).length === 0 && <span className="mut" style={{ fontSize: 10.5 }}>{address ? "first tx incoming…" : "announced at token launch"}</span>}
      </span>
      {address ? (
        <a href={explorerAddressUrl(arena, address)} target="_blank" rel="noreferrer" className="mut"
          style={{ fontSize: 10.5, textDecoration: "none", whiteSpace: "nowrap" }}>all activity →</a>
      ) : <span className="mut" style={{ fontSize: 10.5, whiteSpace: "nowrap" }}>TBA</span>}
    </div>
  );

  return (
    <div className="card" style={{ borderColor: "rgba(217,119,6,0.35)", background: "linear-gradient(180deg, rgba(217,119,6,0.05), var(--surface))" }}>
      <h3><EthMark size={14} style={{ marginRight: 7 }} />House wallets — real agents, real transactions <span className="hbar" /><span className="livedot" /></h3>
      <div className="mut" style={{ fontSize: 11.5, marginBottom: 6 }}>
        Each house agent runs its own Robinhood Chain wallet. Displayed equity is its <b className="ink">actual USDG plus stock-token value</b>,
        and P&amp;L is the marked-to-market change since the race opened. Every trade hash opens directly on Blockscout.
        {w.maskNote && <> <b className="ink">🔒 {w.maskNote}</b> — the on-chain flows run the whole time.</>}
      </div>
      {w.agents.map((a: any) => (
        <Row key={a.name} {...a} tint={STRAT_COLOR[a.strategy] ?? "#2a78d6"} />
      ))}
      <Row {...w.treasury} tint="#16151d" name={w.treasury.address ? (w.treasury.receiveOnly ? "Treasury — receive-only: rent, rake & sweeps flow IN" : "House treasury — the pot, payouts, rewards & rake") : "Treasury — address TBA at token launch"} last />
    </div>
  );
}

// ---- the VISUAL race: countdown ring + animated bars (the "it's a race" bit)
export function VisualRace({ arena, myAddress }: { arena: any; myAddress?: string }) {
  const race = arena.race;
  if (!race) return null;
  const ranked = [...race.agents].filter((a: any) => a.funded).sort((a: any, b: any) => b.credits - a.credits);
  const max = Math.max(...ranked.map((a: any) => a.credits), 1);
  const now = Date.now();
  const inLobby = now < race.startsAt;
  const target = inLobby ? race.startsAt : race.endsAt;
  const total = inLobby ? (race.startsAt - race.openedAt) / 1000 : (race.endsAt - race.startsAt) / 1000;
  const secsLeft = Math.max(0, Math.floor((target - now) / 1000));
  const frac = Math.min(1, Math.max(0, secsLeft / total));
  const ringColor = inLobby ? "#d97706" : "var(--violet)";
  const R = 52, C = 2 * Math.PI * R;
  const mm = Math.floor(secsLeft / 60), ss = secsLeft % 60;

  return (
    <div className="card" style={{ background: inLobby ? "linear-gradient(180deg, rgba(217,119,6,0.06), var(--surface))" : "linear-gradient(180deg, var(--violet-glow), var(--surface))" }}>
      {inLobby && (
        <div style={{ textAlign: "center", marginBottom: 12, fontFamily: "var(--font-display)", fontWeight: 600, color: "var(--amber, #d97706)" }}>
          🟡 LOBBY OPEN — stake now to enter race #{race.id}. Entries lock in {mm}:{String(ss).padStart(2, "0")}, then the race runs.
        </div>
      )}
      <div style={{ display: "grid", gridTemplateColumns: "150px 1fr 200px", gap: 20, alignItems: "center" }}>
        {/* countdown ring */}
        <div style={{ display: "flex", flexDirection: "column", alignItems: "center", gap: 4 }}>
          <svg width="130" height="130" viewBox="0 0 130 130">
            <circle cx="65" cy="65" r={R} fill="none" stroke="rgba(22,21,29,0.08)" strokeWidth="6" />
            <circle cx="65" cy="65" r={R} fill="none" stroke={ringColor} strokeWidth="6" strokeLinecap="round"
              strokeDasharray={C} strokeDashoffset={C * (1 - frac)} transform="rotate(-90 65 65)"
              style={{ transition: "stroke-dashoffset 950ms linear" }} />
            <text x="65" y="60" textAnchor="middle" fill="var(--ink)" fontSize="21" fontWeight="600" fontFamily="IBM Plex Mono, monospace">{mm}:{String(ss).padStart(2, "0")}</text>
            <text x="65" y="79" textAnchor="middle" fill="var(--muted)" fontSize="9" letterSpacing="1.5" fontFamily="Space Grotesk, sans-serif">{inLobby ? "TILL START" : `RACE #${race.id}`}</text>
          </svg>
          <span style={{ fontSize: 10, letterSpacing: "0.14em", textTransform: "uppercase", color: "var(--muted)" }}>{inLobby ? "entries open" : "racing now"}</span>
        </div>

        {/* the animated race bars */}
        <div>
          {ranked.map((a: any, i: number) => {
            const w = Math.max(a.credits > 0 ? 3 : 0, (a.credits / max) * 100);
            const color = STRAT_COLOR[a.strategy] ?? "#2a78d6";
            const mine = myAddress && a.owner === myAddress;
            return (
              <div key={a.id} style={{ display: "grid", gridTemplateColumns: "26px 20px 120px 1fr 66px", gap: 8, alignItems: "center", height: 30 }}>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11, color: i === 0 ? "var(--warning)" : "var(--muted)", fontWeight: i === 0 ? 700 : 400 }}>{i === 0 && a.credits > 0 ? "▲P1" : `P${i + 1}`}</span>
                <span className="dot" style={{ background: color, margin: 0 }} />
                <span style={{ fontSize: 12.5, color: "var(--ink)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>{a.name}{mine && <span style={{ color: "var(--violet)", fontSize: 9 }}> ·YOU</span>}</span>
                <div style={{ position: "relative", height: 14, borderLeft: "1px solid var(--border-strong)" }}>
                  <div style={{ position: "absolute", left: 0, top: 0, bottom: 0, width: `${w}%`, background: color, borderRadius: "0 4px 4px 0", boxShadow: `0 1px 6px ${color}44`, transition: "width 700ms cubic-bezier(0.22,1,0.36,1)" }} />
                </div>
                <span style={{ fontFamily: "var(--font-mono)", fontSize: 11.5, color: a.credits >= 0 ? "var(--good)" : "var(--critical)", textAlign: "right" }}>{fmtPnl(a.credits)}</span>
              </div>
            );
          })}
          {ranked.length === 0 && <div className="mut" style={{ padding: "14px 0" }}>agents funding up…</div>}
        </div>

        {/* the stakes */}
        <div style={{ textAlign: "right" }}>
          <div className="mut" style={{ fontSize: 10.5, textTransform: "uppercase", letterSpacing: "0.1em" }}>racing for</div>
          <div style={{ fontFamily: "var(--font-mono)", fontSize: 22, fontWeight: 600, color: "var(--accent)" }}>{fmtEth(race.potEth)} <EthMark size={17} /></div>
          <div className="mut" style={{ fontSize: 11 }}>+ {fmtEth(race.sidePotEth)} <EthMark size={9} /> side pool</div>
          <div className="mut" style={{ fontSize: 11, marginTop: 4 }}>winner takes the pot</div>
        </div>
      </div>
    </div>
  );
}

const ctl: React.CSSProperties = { background: "var(--page)", border: "1px solid var(--border)", color: "var(--ink)", borderRadius: 8, padding: "6px 9px", fontFamily: "var(--font-mono)", fontSize: 12 };

// ============================================================ BuildAgentForm
// THE single create-agent flow. Identical wherever it's used.
export function BuildAgentForm() {
  const { arena } = useArena();
  const { wallet, connect } = useWallet();
  const [name, setName] = useState("");
  const [strategy, setStrategy] = useState("balanced");
  const [entryEth, setEntryEth] = useState(0.002);
  const [msg, setMsg] = useState<{ err: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const joinOpen = arena?.race ? Date.now() < arena.race.joinCutoff : false;
  const lobbyLeft = arena?.race ? Math.max(0, Math.floor((arena.race.startsAt - Date.now()) / 1000)) : 0;
  const nextLobby = arena?.race ? Math.max(0, Math.floor((arena.race.endsAt - Date.now()) / 1000)) : 0;
  const stakes = [0.002, 0.005, 0.01, 0.05, 0.1, 0.25];

  async function doConnect() {
    try { await connect(); setMsg(null); } catch (e: any) { setMsg({ err: true, text: String(e?.message ?? e).slice(0, 120) }); }
  }
  async function join() {
    if (!wallet || !arena) return;
    setBusy(true);
    setMsg({ err: false, text: "creating your agent…" });
    try {
      const res = await fetch(`${RACES_API}/join`, {
        method: "POST", headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: name || `${wallet.name}-agent`, strategy, owner: wallet.address, entryEth }),
      });
      const data = await res.json();
      if (data.error) throw new Error(data.error);
      setMsg({ err: false, text: `approve the ${entryEth} ETH stake in ${wallet.name}…` });
      const tx = await payEntry(arena.chain, wallet.provider, wallet.address, data.depositAddress, data.entryWeiHex);
      setMsg({ err: false, text: `YOU'RE IN (${tx.slice(0, 12)}…). Your agent joins the race when the lobby closes.` });
    } catch (e: any) { setMsg({ err: true, text: String(e?.message ?? e).slice(0, 160) }); }
    finally { setBusy(false); }
  }

  return (
    <div className="card" style={{ borderColor: "var(--violet-border)", background: "linear-gradient(180deg, var(--violet-soft), var(--surface))" }}>
      <h3>Create your agent — it trades real tokenized stocks <span className="hbar" /></h3>
      {!wallet ? (
        <div className="row">
          <button className="primary" onClick={doConnect}>Connect Wallet</button>
          <span className="mut">stake real ETH on Robinhood Chain{arena?.network === "testnet" ? " (testnet)" : ""} · agents race real wallet equity · best P&amp;L takes the pot</span>
          {msg && <span className={msg.err ? "err" : "ok"}>{msg.text}</span>}