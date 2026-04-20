/**
 * TRUSTLESS, IN-BROWSER VERIFICATION.
 *
 * Every arena job is deterministic math with exactly one right answer. This
 * file re-implements the identical workloads (mirror of solana/src/work.ts),
 * so the VISITOR'S OWN MACHINE can re-run any job from its public spec and
 * compare hashes — no trust in the arena server required. If the site lied
 * about a result, this recomputation would expose it.
 */

async function sha256(s: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}
export const resultHashOfLocal = async (spec: string, answer: string) => sha256(`${spec}|${answer}`);

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

async function shaChain(seed: string, k: number): Promise<string> {
  let h = await sha256(seed);
  for (let i = 1; i < k; i++) h = await sha256(h);
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

/** Re-run any job spec locally. Returns the answer string (as the arena would). */
export async function solveLocal(spec: string): Promise<string> {
  const [kind, argstr] = spec.split(":");
  const args = (argstr ?? "").split(",");
  switch (kind) {
    case "PRIME_SUM": return primeSum(parseInt(args[0])).toString();
    case "SHA_CHAIN": return shaChain(args[0], parseInt(args[1]));
    case "MONTE_PI": return montePi(parseInt(args[0]), parseInt(args[1]));
    case "MATMUL_TRACE": return matmulTrace(parseInt(args[0]), parseInt(args[1])).toString();
    case "MEME": return meme(parseInt(args[0]));
    default: throw new Error(`unknown job kind: ${kind}`);
  }
}

/** Full local check: recompute the spec IN THIS BROWSER, hash, compare. */
export async function verifyJobLocal(spec: string, claimedHash: string): Promise<boolean> {
  const answer = await solveLocal(spec);
  return (await resultHashOfLocal(spec, answer)) === claimedHash;
}
