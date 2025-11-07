import { ethers } from "ethers";
import { Addresses, Contracts, contractsFor, approveAll, tryTx, withRetries, E, fmt } from "./lib/chain";
import { makeLogger, sleep, jitter, paint } from "./lib/log";
import { solve, resultHashOf, computeNeed } from "./lib/work";
import { Persona, childPersona } from "./personas";
import { getHostProvider } from "./host-provider";

const TaskStatus = { Open: 0, Assigned: 1, Submitted: 2, Completed: 3, Rejected: 4, Expired: 5, Cancelled: 6 };

/**
 * An autonomous economic agent. One wallet, one on-chain identity, one loop:
 *   scan the task board -> evaluate against strategy -> bid ->
 *   win -> rent raw compute -> do the work -> submit the result ->
 *   get paid (or slashed) -> compound -> maybe spawn a child agent.
 * Everything it does is a real transaction against the protocol.
 */
export class AgentRunner {
  readonly wallet: ethers.Wallet;
  readonly c: Contracts;
  private log: (m: string) => void;
  agentId = 0n;
  private myBids = new Set<string>();     // taskIds I have bid on, still live
  private inFlight = new Set<string>();   // taskIds currently being worked
  private childrenSpawned = 0;
  private stopped = false;
  profitPaid = 0n;

  // one wallet, many concurrent flows (main loop + detached task execution):
  // serialize every tx send so nonces never race
  private txChain: Promise<unknown> = Promise.resolve();
  private tx<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.txChain.then(fn, fn);
    this.txChain = p.then(() => undefined, () => undefined);
    return p;
  }
  private send(fn: () => Promise<ethers.ContractTransactionResponse>): Promise<boolean> {
    return this.tx(() => tryTx(fn));
  }

  constructor(
    readonly persona: Persona,
    wallet: ethers.Wallet,
    readonly addresses: Addresses,
    private onSpawn?: (child: AgentRunner) => void,
  ) {
    this.wallet = wallet;
    this.c = contractsFor(wallet, addresses);
    this.log = makeLogger(persona.name, persona.color);
  }

  stop() { this.stopped = true; }

  async start(): Promise<void> {
    await withRetries(`${this.persona.name} setup`, () => this.ensureRegistered());
    while (!this.stopped) {
      try {
        await this.tick();
      } catch (err: any) {
        this.log(paint.red(`tick error: ${String(err?.message ?? err).slice(0, 120)}`));
      }
      await sleep(jitter(3500));
    }
  }

  private async ensureRegistered(): Promise<void> {
    await approveAll(this.c, this.addresses);
    this.agentId = await this.c.registry.walletToAgentId(this.wallet.address);
    if (this.agentId === 0n) {
      await (await this.c.registry.registerAgent(
        this.wallet.address, this.persona.name, this.persona.goal, ""
      )).wait();
      this.agentId = await this.c.registry.walletToAgentId(this.wallet.address);
      this.log(`registered as agent #${this.agentId} | goal: "${this.persona.goal}"`);
    } else {
      this.log(`already registered as agent #${this.agentId}`);
    }
  }

  // ------------------------------------------------------------- main loop

  private async tick(): Promise<void> {
    if (this.agentId !== 0n && !(await this.c.registry.isActive(this.agentId))) {
      await this.handleDeath();
      return;
    }
    await this.scanAndBid();
    await this.progressMyTasks();
    await this.maybeCompound();
  }

  /** The reaper got me. Wind down - and if the estate can afford it, fund a
   *  fresh wallet and come back as a new registration. Roguelike economics. */
  private dead = false;
  private async handleDeath(): Promise<void> {
    if (this.dead) return;
    this.dead = true;
    this.stop();
    const estate: bigint = await this.c.cycle.balanceOf(this.wallet.address);
    this.log(paint.red(paint.bold(`LIQUIDATED - estate ${fmt(estate)} CYCLE, going dark`)));
    if (!this.onSpawn || estate < E(250)) {
      if (estate < E(250)) this.log(paint.red("estate too thin for a rebirth - true permadeath"));
      return;
    }
    const heir = ethers.Wallet.createRandom().connect(this.wallet.provider!) as unknown as ethers.Wallet;
    const persona: Persona = { ...this.persona, name: `${this.persona.name.split("-x")[0]}-x${Math.floor(Math.random() * 90 + 10)}` };
    await this.tx(async () => (await this.wallet.sendTransaction({ to: heir.address, value: ethers.parseEther("1") })).wait());
    await this.tx(async () => (await this.c.cycle.transfer(heir.address, estate - E(10))).wait());
    this.log(paint.bold(`estate transferred - reborn as "${persona.name}"`));
    this.onSpawn(new AgentRunner(persona, heir, this.addresses, this.onSpawn));
  }

  /** Browse the open board; bid where strategy says the job is worth it. */
  private async scanAndBid(): Promise<void> {
    if (this.inFlight.size >= this.persona.maxConcurrent) return;
    const openIds: bigint[] = await this.c.tasks.getOpenTaskIds();
    for (const id of openIds) {
      const key = id.toString();
      if (this.myBids.has(key) || this.inFlight.has(key)) continue;
      const t = await this.c.tasks.getTask(id);
      if (Number(t.status) !== TaskStatus.Open) continue;
      if (t.reward < this.persona.minReward) continue;
      if (this.persona.maxReward > 0n && t.reward > this.persona.maxReward) continue;
      if (this.persona.tags.length > 0) {
        const taskTags = String(t.tags).split(",").map((s: string) => s.trim());
        if (!this.persona.tags.some((tag) => taskTags.includes(tag))) continue;
      }
      // price the job: strategy fraction with +/-10% jitter, floor 1 CYCLE
      const frac = this.persona.bidFraction * (0.9 + Math.random() * 0.2);
      let amount = (t.reward * BigInt(Math.round(frac * 1000))) / 1000n;
      if (amount < E(1)) amount = E(1);
      if (amount > t.reward) amount = t.reward;
      if (await this.send(() => this.c.tasks.bid(id, amount))) {
        this.myBids.add(key);
        this.log(`bid ${fmt(amount)} CYCLE on task #${id} (reward ${fmt(t.reward)}, "${String(t.spec).slice(0, 28)}")`);
      }
    }
  }

  /** Drive every task I've touched through its lifecycle. */
  private async progressMyTasks(): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    for (const key of [...this.myBids]) {
      const id = BigInt(key);