import { ethers } from "ethers";

/**
 * The actual work. Tasks are machine-verifiable toy workloads: the poster
 * publishes a deterministic spec, the agent computes the answer (on rented
 * compute), and the poster re-derives the answer to verify the submitted
 * hash. Rejections in the demo are REAL failed verification, not theater -
 * an agent with skill < 1.0 sometimes computes garbage and gets slashed
 * for it.
 *
 * Spec grammar: "KIND:arg1,arg2"
 *   PRIME_SUM:n          sum of the first n primes
 *   SHA_CHAIN:seed,k     keccak256 applied k times to the seed
 *   MONTE_PI:samples,seed  deterministic Monte-Carlo estimate of pi (4dp)
 *   MATMUL_TRACE:seed,n  trace of A^2 for a seeded n x n integer matrix
 *   MEME:seed            deterministic meme caption (creative "work")
 */

function lcg(seed: number) {
  let s = seed >>> 0;
  return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32);
}

function primeSum(n: number): bigint {
  const limit = Math.max(1000, Math.floor(n * (Math.log(n + 1) + Math.log(Math.log(n + 3))) * 1.3) + 100);
  const sieve = new Uint8Array(limit + 1);
  let count = 0;
  let sum = 0n;
  for (let i = 2; i <= limit && count < n; i++) {
    if (!sieve[i]) {
      count++;
      sum += BigInt(i);
      for (let j = i * i; j <= limit; j += i) sieve[j] = 1;
    }
  }
  return sum;
}

function shaChain(seed: string, k: number): string {
  let h = ethers.keccak256(ethers.toUtf8Bytes(seed));
  for (let i = 1; i < k; i++) h = ethers.keccak256(h);
  return h;
}

function montePi(samples: number, seed: number): string {
  const rnd = lcg(seed);
  let inside = 0;
  for (let i = 0; i < samples; i++) {
    const x = rnd() * 2 - 1;
    const y = rnd() * 2 - 1;
    if (x * x + y * y <= 1) inside++;
  }
  return ((4 * inside) / samples).toFixed(4);
}

function matmulTrace(seed: number, n: number): bigint {
  const rnd = lcg(seed);
  const a: number[][] = [];
  for (let i = 0; i < n; i++) {
    a.push([]);
    for (let j = 0; j < n; j++) a[i].push(Math.floor(rnd() * 1000));
  }
  // trace(A^2) = sum_i sum_k a[i][k] * a[k][i]
  let tr = 0n;
  for (let i = 0; i < n; i++)
    for (let k = 0; k < n; k++) tr += BigInt(a[i][k] * a[k][i]);
  return tr;
}

const MEME_SUBJECTS = ["gpu-poor devs", "the compute cartel", "agent #4", "liquidity", "my sub-agent", "the mempool", "validators", "a lone H100"];
const MEME_VERBS = ["outbidding", "rugging", "compounding into", "yield farming", "shitposting about", "frontrunning", "staking against", "diamond-handing"];
const MEME_PUNCH = ["and it's beautiful", "wagmi (machine edition)", "sers, we are the exit liquidity", "raw compute never sleeps", "the flippening is compute", "gm = gpu morning", "this epoch we eat", "slashed but not shaken"];

function meme(seed: number): string {
  const rnd = lcg(seed);
  const pick = (arr: string[]) => arr[Math.floor(rnd() * arr.length)];
  return `${pick(MEME_SUBJECTS)} ${pick(MEME_VERBS)} ${pick(MEME_SUBJECTS)} - ${pick(MEME_PUNCH)}`;
}

export function solve(spec: string): string {
  const [kind, argstr] = spec.split(":");
  const args = (argstr ?? "").split(",");
  switch (kind) {
    case "PRIME_SUM": return primeSum(parseInt(args[0])).toString();
    case "SHA_CHAIN": return shaChain(args[0], parseInt(args[1]));
    case "MONTE_PI": return montePi(parseInt(args[0]), parseInt(args[1]));
    case "MATMUL_TRACE": return matmulTrace(parseInt(args[0]), parseInt(args[1])).toString();
    case "MEME": return meme(parseInt(args[0]));
    default: throw new Error(`unknown task kind: ${kind}`);
  }
}

/** Canonical result hash committed on-chain and checked by the poster. */
export function resultHashOf(spec: string, answer: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(`${spec}|${answer}`));
}

/** How much raw compute a task needs (drives real rental demand). */
export function computeNeed(spec: string): { units: number; rentSecs: number; workMs: number } {
  const kind = spec.split(":")[0];
  switch (kind) {
    case "PRIME_SUM": return { units: 2, rentSecs: 120, workMs: 4000 };
    case "SHA_CHAIN": return { units: 1, rentSecs: 90, workMs: 3000 };
    case "MONTE_PI": return { units: 4, rentSecs: 150, workMs: 6000 };
    case "MATMUL_TRACE": return { units: 8, rentSecs: 200, workMs: 8000 };
    case "MEME": return { units: 1, rentSecs: 60, workMs: 2500 };
    default: return { units: 1, rentSecs: 60, workMs: 3000 };
  }
}

/** Random task generator for the faucet. */
export function randomSpec(): { spec: string; tags: string; rewardRange: [number, number] } {
  const roll = Math.random();
  const seed = Math.floor(Math.random() * 1_000_000);
  if (roll < 0.25) return { spec: `PRIME_SUM:${2000 + Math.floor(Math.random() * 8000)}`, tags: "math", rewardRange: [40, 150] };
  if (roll < 0.45) return { spec: `SHA_CHAIN:agora-${seed},${50 + Math.floor(Math.random() * 300)}`, tags: "crypto", rewardRange: [40, 120] };
  if (roll < 0.65) return { spec: `MONTE_PI:${50_000 + Math.floor(Math.random() * 150_000)},${seed}`, tags: "math,sim", rewardRange: [60, 200] };
  if (roll < 0.82) return { spec: `MATMUL_TRACE:${seed},${24 + Math.floor(Math.random() * 24)}`, tags: "math,heavy", rewardRange: [150, 400] };
  return { spec: `MEME:${seed}`, tags: "creative", rewardRange: [30, 100] };
}
