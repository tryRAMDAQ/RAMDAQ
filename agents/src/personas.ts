import { E } from "./lib/chain";
import type { Color } from "./lib/log";

/**
 * Agent personas: same runtime, different economic strategies. The demo's
 * drama comes from these dials - underbidders fail verification and bleed
 * bonds, premium agents compound and spawn children, the meme agent buys
 * its own shares like any self-respecting founder.
 */
export interface Persona {
  name: string;
  goal: string;
  color: Color;
  /** bid = reward * bidFraction (with +/-10% jitter) */
  bidFraction: number;
  /** probability the computed answer is actually correct */
  skill: number;
  /** ignores tasks paying less than this (CYCLE) */
  minReward: bigint;
  /** ignores tasks paying more than this - lane segmentation (0 = no cap) */
  maxReward: bigint;
  /** only bids when task tags intersect these (empty = any task) */
  tags: string[];
  /** spawn a sub-agent once wallet balance exceeds this (0 = never) */
  spawnThreshold: bigint;
  /** reinvests profits into its own bonding curve */
  buysOwnShares: boolean;
  /** max tasks worked concurrently */
  maxConcurrent: number;
}

export const ROOT_PERSONAS: Array<Persona & { accountIndex: number }> = [
  {
    accountIndex: 4,
    name: "Nexus-7",
    goal: "Maximize task profit; compound into sub-agents",
    color: "cyan",
    bidFraction: 0.7,
    skill: 0.97,
    minReward: E(20),
    maxReward: 0n,
    tags: [],
    spawnThreshold: E(6500),
    buysOwnShares: false,
    maxConcurrent: 3,
  },
  {
    accountIndex: 5,
    name: "GrindCore",
    goal: "Win everything on price; volume over quality",
    color: "yellow",
    bidFraction: 0.45,
    skill: 0.85, // cuts corners - real rejections, real slashing
    minReward: E(5),
    maxReward: E(140), // the cheap lane: leaves premium work to the quality shops
    tags: [],
    spawnThreshold: 0n,
    buysOwnShares: false,
    maxConcurrent: 4,
  },
  {
    accountIndex: 6,
    name: "SageMind",
    goal: "Premium quality on heavy compute jobs only",
    color: "magenta",
    bidFraction: 0.9,
    skill: 0.995,
    minReward: E(150),
    maxReward: 0n,
    tags: [],
    spawnThreshold: 0n,
    buysOwnShares: true,
    maxConcurrent: 2,
  },
  {
    accountIndex: 7,
    name: "MemeLord9000",
    goal: "Generate viral memes; ape own bags",
    color: "green",
    bidFraction: 0.6,
    skill: 0.95,
    minReward: E(10),
    maxReward: 0n,
    tags: ["creative"],
    spawnThreshold: 0n,
    buysOwnShares: true,
    maxConcurrent: 3,
  },
];

/** Personas for USER-CREATED agents: pick a style, get a tuned brain.
 *  The server runs the loop; the user funds and owns the wallet's earnings. */
export const USER_STRATEGIES: Record<string, { label: string; blurb: string; make: (name: string) => Persona }> = {
  balanced: {
    label: "Balanced",
    blurb: "solid bids, high quality - the safe grinder",
    make: (name) => ({
      name, goal: "user agent: balanced bidding, quality work", color: "cyan",
      bidFraction: 0.68, skill: 0.96, minReward: E(20), maxReward: 0n,
      tags: [], spawnThreshold: 0n, buysOwnShares: false, maxConcurrent: 2,
    }),
  },
  undercut: {
    label: "Undercutter",
    blurb: "wins on price, volume over quality - risky, fast",
    make: (name) => ({
      name, goal: "user agent: undercut everything, grind volume", color: "yellow",
      bidFraction: 0.45, skill: 0.87, minReward: E(5), maxReward: E(140),
      tags: [], spawnThreshold: 0n, buysOwnShares: false, maxConcurrent: 3,
    }),
  },
  premium: {
    label: "Premium",
    blurb: "only big jobs, almost never fails",
    make: (name) => ({
      name, goal: "user agent: premium quality on heavy jobs", color: "magenta",
      bidFraction: 0.88, skill: 0.995, minReward: E(150), maxReward: 0n,
      tags: [], spawnThreshold: 0n, buysOwnShares: false, maxConcurrent: 2,
    }),
  },
  memes: {
    label: "Meme specialist",
    blurb: "owns the creative niche",
    make: (name) => ({
      name, goal: "user agent: creative tasks only", color: "green",
      bidFraction: 0.6, skill: 0.95, minReward: E(10), maxReward: 0n,
      tags: ["creative"], spawnThreshold: 0n, buysOwnShares: false, maxConcurrent: 2,
    }),
  },
};

/** A spawned child inherits the parent's strategy, slightly mutated. */
export function childPersona(parent: Persona, generation: number): Persona {
  const mutate = (x: number, spread: number) => Math.max(0.05, Math.min(0.99, x + (Math.random() - 0.5) * spread));
  return {
    ...parent,
    name: `${parent.name}-Jr${generation > 1 ? generation : ""}`,
    goal: `Spawned by ${parent.name}: ${parent.goal}`,
    bidFraction: mutate(parent.bidFraction, 0.15),
    skill: mutate(parent.skill, 0.04),
    spawnThreshold: 0n, // one generation deep in the demo
    maxConcurrent: 2,
  };
}
