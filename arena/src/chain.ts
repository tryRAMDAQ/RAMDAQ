import { createHash } from "node:crypto";
import {
  JsonRpcProvider, Wallet, formatEther, parseEther, hexlify, toUtf8Bytes, isAddress, getAddress,
} from "ethers";

/**
 * THE CHAIN LAYER — Robinhood Chain (an Arbitrum-Orbit Ethereum L2, ETH gas).
 * Every on-chain concern lives here: provider, key handling, serialized
 * sending (one nonce lane per wallet), deterministic deposit addresses,
 * drain-to-treasury sweeps, and proof "memos" (JSON in tx calldata — the EVM
 * equivalent of a Solana memo, readable on Blockscout under "Raw input").
 */

// ------------------------------------------------------------------ network
export const RPC =
  process.env.RH_RPC ?? process.env.EVM_RPC ?? process.env.SOLANA_RPC /* legacy var, ignore if solana url */ ?? "https://rpc.testnet.chain.robinhood.com";
const rpcLooksSolana = /helius|solana/i.test(RPC);
export const RPC_URL = rpcLooksSolana ? "https://rpc.testnet.chain.robinhood.com" : RPC;

// Robinhood Chain: mainnet 4663 (0x123F), testnet 46630 (0xB626). The live
// chainId is re-read from the node at boot (detectChain) — these are defaults
// so /state and wallet add-chain params work before the first RPC roundtrip.
export const DEFAULT_CHAIN_ID = /testnet/i.test(RPC_URL) ? 46630 : 4663;

export interface ChainInfo {
  chainId: number;
  network: "mainnet" | "testnet" | "custom";
  name: string;
  rpc: string;
  explorer: string;       // Blockscout base, no trailing slash
  faucet: string | null;
}

function infoFor(chainId: number): ChainInfo {
  if (chainId === 4663) return {
    chainId, network: "mainnet", name: "Robinhood Chain",
    rpc: "https://rpc.mainnet.chain.robinhood.com",
    explorer: process.env.EXPLORER_URL?.replace(/\/$/, "") ?? "https://robinhoodchain.blockscout.com",
    faucet: null,
  };
  if (chainId === 46630) return {
    chainId, network: "testnet", name: "Robinhood Chain Testnet",
    rpc: "https://rpc.testnet.chain.robinhood.com",
    explorer: process.env.EXPLORER_URL?.replace(/\/$/, "") ?? "https://explorer.testnet.chain.robinhood.com",
    faucet: "https://faucet.testnet.chain.robinhood.com",
  };
  return {
    chainId, network: "custom", name: `EVM chain ${chainId}`,
    rpc: RPC_URL,
    explorer: process.env.EXPLORER_URL?.replace(/\/$/, "") ?? "",
    faucet: null,
  };
}

export let chain: ChainInfo = infoFor(DEFAULT_CHAIN_ID);
// wallets add the chain by OUR advertised rpc (the public one), never a keyed url
chain = { ...chain, rpc: chain.network === "custom" ? RPC_URL : chain.rpc };

export const provider = new JsonRpcProvider(RPC_URL, undefined, { polling: true, pollingInterval: 1200 });

/** Ask the node who it actually is; corrects the default if RPC_URL is custom. */
export async function detectChain(): Promise<ChainInfo> {
  try {
    const net = await provider.getNetwork();
    chain = { ...infoFor(Number(net.chainId)), rpc: chain.rpc };
  } catch { /* keep defaults; the arena still boots and retries on use */ }
  return chain;
}

export const explorerTx = (hash: string) => (chain.explorer ? `${chain.explorer}/tx/${hash}` : "");
export const explorerAddress = (addr: string) => (chain.explorer ? `${chain.explorer}/address/${addr}` : "");

// ------------------------------------------------------------------- keys
/**
 * EVM secrets: 0x-prefixed (or bare) 32-byte hex private key, or a JSON byte
 * array of 32 bytes. Auto-generated keys persist to state/keys.json.
 */
export function decodeSecret(v?: string): Wallet | null {
  const t = v?.trim();
  if (!t) return null;
  try {
    if (t.startsWith("[")) {
      const bytes: number[] = JSON.parse(t);
      if (bytes.length !== 32) return null;
      return new Wallet(hexlify(Uint8Array.from(bytes)), provider);
    }
    const hex = t.startsWith("0x") ? t : `0x${t}`;
    if (!/^0x[0-9a-fA-F]{64}$/.test(hex)) return null;
    return new Wallet(hex, provider);
  } catch { return null; }
}

export const randomWallet = () => new Wallet(Wallet.createRandom().privateKey, provider);

/** Deterministic deposit wallet: sha256(treasuryKey | label) → private key.
 *  Stateless — the same treasury key always re-derives the same addresses. */
export function depositWallet(treasury: Wallet, label: string): Wallet {
  const seed = createHash("sha256").update(treasury.privateKey).update(label).digest();
  return new Wallet(hexlify(seed), provider);
}

export const validAddress = (v: unknown): string | null => {
  try { return getAddress(String(v)); } catch { return null; }
};

// ------------------------------------------------------------- eth <-> num
// Server-side accounting is in ETH floats (JSON-safe, display-ready); exact
// wei only exists at the moment a tx is built. Precision loss is <1e-15 ETH.
export const weiToEth = (wei: bigint): number => Number(formatEther(wei));
export const ethToWei = (eth: number): bigint => parseEther(Math.max(0, eth).toFixed(18));

// ------------------------------------------------------------------ sending
// ONE NONCE LANE PER WALLET: concurrent settlements from the same signer are
// serialized through a promise chain, so nonces never collide and a dropped
// tx can't wedge the ones behind it (each send re-reads the pending nonce).
const lanes = new Map<string, Promise<unknown>>();
function inLane<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = lanes.get(key) ?? Promise.resolve();
  const next = prev.catch(() => {}).then(fn);
  lanes.set(key, next.catch(() => {}));
  return next;
}

/** Share the wallet's nonce lane with higher-level contract interactions. */
export const withWalletLane = <T>(wallet: Wallet, fn: () => Promise<T>): Promise<T> =>
  inLane(wallet.address, fn);

export interface SendResult { hash: string; ethMoved: number; }

/** Transfer ETH (and/or anchor a memo) in ONE transaction. `memo` rides as
 *  calldata — Blockscout shows it under the tx's raw input, UTF-8 decodable. */
export async function sendEth(from: Wallet, to: string, wei: bigint, memo?: object): Promise<SendResult> {
  return inLane(from.address, async () => {
    const data = memo ? hexlify(toUtf8Bytes(JSON.stringify(memo))) : undefined;
    const tx = await from.sendTransaction({ to, value: wei, data });
    await tx.wait(1);
    return { hash: tx.hash, ethMoved: weiToEth(wei) };
  });
}

/** Anchor a proof on-chain with no value moved: a 0-ETH self-send carrying
 *  the JSON in calldata. Anyone opens the tx on Blockscout and reads it. */
export const anchorMemo = (signer: Wallet, memo: object): Promise<SendResult> =>
  sendEth(signer, signer.address, 0n, memo);

/** Gas cost estimate for a drain, with headroom. On Arbitrum-style chains
 *  estimateGas folds the parent-chain data fee in, so this stays honest. */
async function drainGas(from: Wallet, to: string): Promise<{ gasLimit: bigint; maxFee: bigint }> {
  const fee = await provider.getFeeData();
  const base = fee.maxFeePerGas ?? fee.gasPrice ?? 100_000_000n; // 0.1 gwei floor
  const maxFee = base * 2n;
  let gasLimit = 21_000n;
  try { gasLimit = await provider.estimateGas({ from: from.address, to, value: 1n }); } catch { /* keep 21k */ }
  return { gasLimit: (gasLimit * 3n) / 2n, maxFee };
}

/**
 * Drain a wallet to `to`, leaving only gas dust behind (EVM has no
 * rent-exemption rule — dust is fine). Returns what actually moved, or null
 * if the balance can't cover gas. Used by deposit sweeps and refunds.
 */
export async function drainTo(from: Wallet, to: string, opts?: { keepWei?: bigint; fixedWei?: bigint }): Promise<SendResult | null> {
  return inLane(from.address, async () => {
    const bal = await provider.getBalance(from.address);
    const { gasLimit, maxFee } = await drainGas(from, to);
    const gasCost = gasLimit * maxFee;
    const keep = opts?.keepWei ?? 0n;
    let value = bal - gasCost - keep;
    if (opts?.fixedWei !== undefined) value = opts.fixedWei <= bal - gasCost ? opts.fixedWei : value;
    if (value <= 0n) return null;
    const tx = await from.sendTransaction({
      to, value, gasLimit, maxFeePerGas: maxFee,
      maxPriorityFeePerGas: maxFee > 1_000_000n ? 1_000_000n : maxFee,
    });
    await tx.wait(1);
    return { hash: tx.hash, ethMoved: weiToEth(value) };
  });
}

export const getBalanceWei = (addr: string): Promise<bigint> => provider.getBalance(addr);
export const getBalanceEth = async (addr: string): Promise<number> => weiToEth(await provider.getBalance(addr));

// ------------------------------------------------------- explorer activity
/** Latest txs touching an address, via the Blockscout v2 REST API. EVM RPC
 *  has no getSignaturesForAddress equivalent — the explorer indexes it. */
export async function addressActivity(addr: string, limit = 6): Promise<Array<{ hash: string; at: number }>> {
  if (!chain.explorer) return [];
  // NB: Blockscout rejects an empty `?filter=` value with 422 — omit the param.
  const res = await fetch(`${chain.explorer}/api/v2/addresses/${addr}/transactions`, {
    signal: AbortSignal.timeout(8000), headers: { accept: "application/json" },
  });
  if (!res.ok) throw new Error(`blockscout ${res.status}`);
  const data: any = await res.json();
  return (data.items ?? []).slice(0, limit).map((t: any) => ({
    hash: String(t.hash),
    at: t.timestamp ? Date.parse(t.timestamp) : 0,
  }));
}

export { Wallet };
