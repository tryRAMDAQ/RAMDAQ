import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { chain, detectChain, decodeSecret, drainTo, getBalanceEth, ethToWei, validAddress, Wallet } from "./chain";

/**
 * HARVEST — move the house money to ANY wallet you choose, when you choose.
 * The operations wallet named in day-to-day txs is disposable; your real
 * treasury stays unnamed on-chain until the moment you run this.
 *
 *   npm run sweep -- --to <ADDRESS>              drain ops treasury (keeps 0.0005 ETH for gas)
 *   npm run sweep -- --to <ADDRESS> --eth 0.05   send a fixed amount instead
 *   npm run sweep -- --to <ADDRESS> --agents     ALSO drain the 5 agent wallets
 *   npm run sweep -- --to <ADDRESS> --keep 0.001 keep a different gas reserve
 */

function arg(name: string): string | null {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] ?? "" : null;
}
const has = (name: string) => process.argv.includes(`--${name}`);

async function drain(from: Wallet, to: string, label: string, keepEth: number, fixedEth?: number): Promise<void> {
  const bal = await getBalanceEth(from.address);
  const r = await drainTo(from, to, {
    keepWei: ethToWei(keepEth),
    fixedWei: fixedEth !== undefined ? ethToWei(fixedEth) : undefined,
  });
  if (!r) { console.log(`  ${label.padEnd(14)} ${bal.toFixed(6)} ETH — nothing to sweep`); return; }
  console.log(`  ${label.padEnd(14)} sent ${r.ethMoved.toFixed(6)} ETH -> ${to.slice(0, 10)}…  tx ${r.hash.slice(0, 18)}…`);
}

async function main() {
  const toStr = arg("to");
  if (!toStr) { console.error("usage: npm run sweep -- --to <ADDRESS> [--eth 0.05] [--agents] [--keep 0.001]"); process.exit(1); }
  const to = validAddress(toStr);
  if (!to) { console.error(`invalid destination address: ${toStr}`); process.exit(1); }

  await detectChain();

  const KEYS_PATH = path.join(process.env.STATE_DIR?.trim() || path.join(__dirname, "..", "state"), "evm-keys.json");
  const file = fs.existsSync(KEYS_PATH) ? JSON.parse(fs.readFileSync(KEYS_PATH, "utf8")) : null;
  const treasury = decodeSecret(process.env.TREASURY_SECRET) ?? decodeSecret(process.env.ESCROW_SECRET)
    ?? (file?.treasury ? decodeSecret(file.treasury) : null);
  if (!treasury) { console.error("no treasury key found (.env TREASURY_SECRET or state/evm-keys.json)"); process.exit(1); }

  const keep = Number(arg("keep")) > 0 ? Number(arg("keep")) : 0.0005;
  const fixed = arg("eth") !== null ? Number(arg("eth")) : arg("sol") !== null ? Number(arg("sol")) : undefined;

  console.log(`\nHARVEST on ${chain.name} (${chain.network}) -> ${to}\n`);
  await drain(treasury, to, "ops treasury", keep, fixed);

  if (has("agents")) {
    for (let i = 1; i <= 5; i++) {
      const w = decodeSecret(process.env[`AGENT_SECRET_${i}`])
        ?? (file?.agents?.[i - 1] ? decodeSecret(file.agents[i - 1]) : null);
      if (w) await drain(w, to, `agent #${i}`, 0);
    }
  }
  console.log("\ndone — funds are wherever YOU pointed them.\n");
}

main().catch((e) => { console.error(String(e?.message ?? e)); process.exit(1); });
