import React, { useEffect, useState } from "react";
import { RACES_API, fmtEth } from "./components/computeArena";
import { EthMark } from "./components/ethMark";
import { Logo } from "./components/logo";
import { fetchHoldings, Holdings } from "./lib/holdings";

/**
 * /agent/<id> — one desk, fully auditable. The complete trade log with every
 * fill's on-chain anchor tx, open positions marked at live prices, the equity
 * curve, W/L — and for house desks the real wallet, one click from Blockscout.
 */
const STRAT_COLOR: Record<string, string> = { balanced: "#2a78d6", undercut: "#1baf7a", premium: "#4a3aa7", memes: "#e87ba4", sniper: "#d97706" };

const fmtUsd = (v: number, dp = 2) => `$${Math.abs(v).toLocaleString(undefined, { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
const pnlFmt = (v: number) => `${v >= 0 ? "+" : "−"}${fmtUsd(v)}`;
const timeFmt = (t: number) => new Date(t).toLocaleTimeString([], { hour12: false });

function EquityChart({ pts, bankroll }: { pts: Array<{ t: number; equityUsd: number }>; bankroll: number }) {
  if (!pts || pts.length < 2) return <div className="mut" style={{ padding: "18px 0" }}>the curve draws as the desk trades…</div>;
  const W = 860, H = 190, PAD = 10;
  const t0 = pts[0].t, t1 = pts[pts.length - 1].t;
  const vs = pts.map((p) => p.equityUsd);
  const v0 = Math.min(...vs, bankroll), v1 = Math.max(...vs, bankroll);
  const x = (t: number) => PAD + ((t - t0) / Math.max(1, t1 - t0)) * (W - 2 * PAD);
  const y = (v: number) => v1 === v0 ? H / 2 : H - PAD - ((v - v0) / (v1 - v0)) * (H - 2 * PAD);
  const up = vs[vs.length - 1] >= bankroll;
  const c = up ? "#00c805" : "#ff5000";
  const line = pts.map((p) => `${x(p.t).toFixed(1)},${y(p.equityUsd).toFixed(1)}`).join(" ");
  return (
    <div style={{ overflowX: "auto" }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", minWidth: 560, display: "block" }}>
        <line x1={PAD} x2={W - PAD} y1={y(bankroll)} y2={y(bankroll)} stroke="var(--border-strong)" strokeDasharray="4 4" strokeWidth="1" />
        <text x={W - PAD - 2} y={y(bankroll) - 5} textAnchor="end" fontSize="10" fill="var(--muted)" fontFamily="var(--font-mono)">${bankroll.toLocaleString()} start</text>
        <polygon points={`${PAD},${H - PAD} ${line} ${x(t1)},${H - PAD}`} fill={c} opacity="0.07" />
        <polyline points={line} fill="none" stroke={c} strokeWidth="2.2" strokeLinejoin="round" strokeLinecap="round" />
        <circle cx={x(t1)} cy={y(vs[vs.length - 1])} r="3.5" fill={c} />
      </svg>
    </div>
  );
}

export default function AgentPage() {
  const id = window.location.pathname.replace(/^\/agent\/?/, "").replace(/\/$/, "");
  const [data, setData] = useState<any>(null);
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    const poll = async () => {
      try {
        const r = await fetch(`${RACES_API}/agent?id=${encodeURIComponent(id)}`);
        const j = await r.json();
        if (!alive) return;
        if (j.error) setErr(j.error); else { setData(j); setErr(null); }
      } catch { if (alive) setErr("arena unreachable"); }
    };
    poll();
    const t = setInterval(poll, 4000);
    return () => { alive = false; clearInterval(t); };
  }, [id]);

  const a = data?.agent;
  const tint = a ? (STRAT_COLOR[a.strategy] ?? "#2a78d6") : "#2a78d6";

  // REAL on-chain holdings — the wallet's actual ETH, USDG and stock tokens.
  const [holdings, setHoldings] = useState<Holdings | null>(null);
  const wallet = a?.wallet;