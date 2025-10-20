import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-toolbox/network-helpers";
import { deployProtocol, registerAgent, E, MIN_PROVIDER_STAKE } from "./helpers";

const BID_WINDOW = 60;
const EXEC_WINDOW = 300;

async function postStandardTask(f: any, reward = E(100)) {
  await f.tasks.connect(f.poster).postTask("PRIME_SUM:100", "math", reward, BID_WINDOW, EXEC_WINDOW);
  return f.tasks.taskCount();
}

describe("TaskMarketplace", () => {
  it("escrows the reward on post and validates parameters", async () => {
    const f = await loadFixture(deployProtocol);
    const before = await f.cycle.balanceOf(f.poster.address);
    const id = await postStandardTask(f);
    expect(await f.cycle.balanceOf(f.poster.address)).to.equal(before - E(100));
    expect(await f.cycle.balanceOf(await f.tasks.getAddress())).to.equal(E(100));

    const t = await f.tasks.getTask(id);
    expect(t.status).to.equal(0n); // Open
    expect(t.agentBond).to.equal(E(10)); // 10% of reward
    expect((await f.tasks.getOpenTaskIds()).length).to.equal(1);

    await expect(
      f.tasks.connect(f.poster).postTask("x", "", E(0.5), BID_WINDOW, EXEC_WINDOW)
    ).to.be.revertedWith("market: reward too low");
    await expect(
      f.tasks.connect(f.poster).postTask("x", "", E(10), 1, EXEC_WINDOW)
    ).to.be.revertedWith("market: bad bid window");
    await expect(
      f.tasks.connect(f.poster).postTask("", "", E(10), BID_WINDOW, EXEC_WINDOW)
    ).to.be.revertedWith("market: empty spec");
  });

  it("only active registered agents can bid, within limits", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await expect(f.tasks.connect(f.poster).bid(id, E(50))).to.be.revertedWith("market: not an agent");

    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await expect(f.tasks.connect(f.agentWallet1).bid(id, E(101))).to.be.revertedWith("market: bad bid");
    await expect(f.tasks.connect(f.agentWallet1).bid(id, 0)).to.be.revertedWith("market: bad bid");
    await f.tasks.connect(f.agentWallet1).bid(id, E(70));
    expect((await f.tasks.getBids(id)).length).to.equal(1);

    await time.increase(BID_WINDOW + 1);
    await expect(f.tasks.connect(f.agentWallet1).bid(id, E(60))).to.be.revertedWith("market: bidding over");
  });

  it("assigns to the lowest bid (earliest wins ties) and pulls the bond", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1, "A1");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet2, "A2");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet3, "A3");

    await f.tasks.connect(f.agentWallet1).bid(id, E(80));
    await f.tasks.connect(f.agentWallet2).bid(id, E(60)); // lowest, first
    await f.tasks.connect(f.agentWallet3).bid(id, E(60)); // tie, later -> loses

    await expect(f.tasks.finalizeBidding(id)).to.be.revertedWith("market: bidding live");
    await time.increase(BID_WINDOW + 1);

    const balBefore = await f.cycle.balanceOf(f.agentWallet2.address);
    await f.tasks.finalizeBidding(id);
    const t = await f.tasks.getTask(id);
    expect(t.status).to.equal(1n); // Assigned
    expect(t.assignedAgentId).to.equal(2n);
    expect(t.winningBid).to.equal(E(60));
    expect(await f.cycle.balanceOf(f.agentWallet2.address)).to.equal(balBefore - E(10)); // bond posted
    expect((await f.tasks.getOpenTaskIds()).length).to.equal(0);
  });

  it("falls back to the next-best bid when the winner cannot post bond", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1, "Funded");
    await registerAgent(f.registry, f.agentOwner, f.agentWallet2, "Broke");

    // the "cheaper" agent revokes its allowance so the bond pull fails
    await f.cycle.connect(f.agentWallet2).approve(await f.tasks.getAddress(), 0);
    await f.tasks.connect(f.agentWallet2).bid(id, E(40));
    await f.tasks.connect(f.agentWallet1).bid(id, E(70));

    await time.increase(BID_WINDOW + 1);
    await f.tasks.finalizeBidding(id);
    const t = await f.tasks.getTask(id);
    expect(t.assignedAgentId).to.equal(1n); // fell through to the funded agent
    expect(t.winningBid).to.equal(E(70));
    expect((await f.tasks.getBids(id))[0].voided).to.equal(true);
  });

  it("cancels and refunds when nobody bids; poster can cancel while open", async () => {
    const f = await loadFixture(deployProtocol);
    const id1 = await postStandardTask(f);
    await time.increase(BID_WINDOW + 1);
    const before = await f.cycle.balanceOf(f.poster.address);
    await f.tasks.finalizeBidding(id1);
    expect((await f.tasks.getTask(id1)).status).to.equal(6n); // Cancelled
    expect(await f.cycle.balanceOf(f.poster.address)).to.equal(before + E(100));

    const id2 = await postStandardTask(f);
    await f.tasks.connect(f.poster).cancelTask(id2);
    expect((await f.tasks.getTask(id2)).status).to.equal(6n);
  });

  it("pays out a full approve: fee -> vault, dividend -> shareholders, rest -> agent, refund -> poster", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f); // reward 100, bond 10
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.tasks.connect(f.agentWallet1).bid(id, E(60));
    await time.increase(BID_WINDOW + 1);
    await f.tasks.finalizeBidding(id);

    await f.tasks.connect(f.agentWallet1).submitResult(id, "ipfs://result", ethers.id("42"));
    const t = await f.tasks.getTask(id);
    expect(t.status).to.equal(2n); // Submitted

    const agentBefore = await f.cycle.balanceOf(f.agentWallet1.address);
    const posterBefore = await f.cycle.balanceOf(f.poster.address);
    const vaultBefore = await f.vault.totalFeesReceived();

    await expect(f.tasks.connect(f.agentWallet1).approveResult(id)).to.be.revertedWith("market: not poster");
    await f.tasks.connect(f.poster).approveResult(id);

    // winning bid 60: fee 5% = 3, dividend 10% = 6, agent nets 51 + bond 10 back
    expect(await f.cycle.balanceOf(f.agentWallet1.address)).to.equal(agentBefore + E(51) + E(10));
    expect(await f.cycle.balanceOf(f.poster.address)).to.equal(posterBefore + E(40)); // unspent reward
    expect((await f.vault.totalFeesReceived()) - vaultBefore).to.equal(E(3));
    // dividend sits with the genesis shareholder (agentOwner)
    expect(await f.shares.pendingDividends(1, f.agentOwner.address)).to.equal(E(6));

    const a = await f.registry.getAgent(1);
    expect(a.lifetimeEarnings).to.equal(E(60)); // gross bid on the leaderboard
    expect(a.reputation).to.equal(110n);
    expect(await f.cycle.balanceOf(await f.tasks.getAddress())).to.equal(0n); // escrow fully unwound
  });

  it("rejection refunds the poster plus half the bond and dings reputation", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.tasks.connect(f.agentWallet1).bid(id, E(60));
    await time.increase(BID_WINDOW + 1);
    await f.tasks.finalizeBidding(id);
    await f.tasks.connect(f.agentWallet1).submitResult(id, "ipfs://bad", ethers.id("wrong"));

    const posterBefore = await f.cycle.balanceOf(f.poster.address);
    const vaultBefore = await f.vault.totalFeesReceived();
    await f.tasks.connect(f.poster).rejectResult(id, "wrong answer");

    expect(await f.cycle.balanceOf(f.poster.address)).to.equal(posterBefore + E(100) + E(5));
    expect((await f.vault.totalFeesReceived()) - vaultBefore).to.equal(E(5));
    const a = await f.registry.getAgent(1);
    expect(a.reputation).to.equal(50n); // 100 - 50
    expect(a.tasksFailed).to.equal(1n);
    expect((await f.tasks.getTask(id)).status).to.equal(4n); // Rejected
  });

  it("expires blown deadlines with the same bond burn", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.tasks.connect(f.agentWallet1).bid(id, E(60));
    await time.increase(BID_WINDOW + 1);
    await f.tasks.finalizeBidding(id);

    await expect(f.tasks.expireTask(id)).to.be.revertedWith("market: deadline live");
    await time.increase(EXEC_WINDOW + 1);
    await expect(
      f.tasks.connect(f.agentWallet1).submitResult(id, "ipfs://late", ethers.id("late"))
    ).to.be.revertedWith("market: past deadline");

    const posterBefore = await f.cycle.balanceOf(f.poster.address);
    await f.tasks.expireTask(id); // anyone may call
    expect(await f.cycle.balanceOf(f.poster.address)).to.equal(posterBefore + E(105));
    expect((await f.tasks.getTask(id)).status).to.equal(5n); // Expired
  });

  it("auto-approves via timeout when the poster goes silent", async () => {
    const f = await loadFixture(deployProtocol);
    const id = await postStandardTask(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    await f.tasks.connect(f.agentWallet1).bid(id, E(60));
    await time.increase(BID_WINDOW + 1);
    await f.tasks.finalizeBidding(id);
    await f.tasks.connect(f.agentWallet1).submitResult(id, "ipfs://done", ethers.id("done"));

    await expect(f.tasks.claimReviewTimeout(id)).to.be.revertedWith("market: review live");
    await time.increase(121);
    const agentBefore = await f.cycle.balanceOf(f.agentWallet1.address);
    await f.tasks.connect(f.speculator1).claimReviewTimeout(id); // anyone
    expect(await f.cycle.balanceOf(f.agentWallet1.address)).to.equal(agentBefore + E(61)); // 51 + bond 10
    expect((await f.tasks.getTask(id)).status).to.equal(3n); // Completed
  });
});

describe("ComputeMarket", () => {
  async function setupProvider(f: any) {
    await f.compute.connect(f.providerAcct).registerProvider("RigOne", "us-east", "H100", 8, E(2)); // 2 CYCLE per unit-hour
    return 1n;
  }

  it("registers providers with stake and lists capacity", async () => {
    const f = await loadFixture(deployProtocol);
    const before = await f.cycle.balanceOf(f.providerAcct.address);
    await setupProvider(f);
    expect(await f.cycle.balanceOf(f.providerAcct.address)).to.equal(before - MIN_PROVIDER_STAKE);
    const p = await f.compute.getProvider(1);
    expect(p.availableUnits).to.equal(8);
    await expect(
      f.compute.connect(f.providerAcct).registerProvider("Again", "", "A100", 4, E(1))
    ).to.be.revertedWith("compute: already provider");
  });

  it("rents a slice: escrow, capacity, confirm, complete, fee split, spend ledger", async () => {
    const f = await loadFixture(deployProtocol);
    await setupProvider(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);

    await expect(f.compute.connect(f.poster).rent(1, 4, 1800)).to.be.revertedWith("compute: not an agent");
    // 4 units * 1800s at 2/unit-hour = 4 CYCLE
    await f.compute.connect(f.agentWallet1).rent(1, 4, 1800);
    let p = await f.compute.getProvider(1);
    expect(p.availableUnits).to.equal(4);
    const r = await f.compute.getRental(1);
    expect(r.cost).to.equal(E(4));

    await expect(f.compute.connect(f.poster).confirmRental(1)).to.be.revertedWith("compute: not provider");
    await f.compute.connect(f.providerAcct).confirmRental(1);

    const provBefore = await f.cycle.balanceOf(f.providerAcct.address);
    const vaultBefore = await f.vault.totalFeesReceived();
    await f.compute.connect(f.agentWallet1).completeRental(1); // renter settles early
    // fee 2.5% of 4 = 0.1; provider gets 3.9
    expect(await f.cycle.balanceOf(f.providerAcct.address)).to.equal(provBefore + E(3.9));
    expect((await f.vault.totalFeesReceived()) - vaultBefore).to.equal(E(0.1));
    p = await f.compute.getProvider(1);
    expect(p.availableUnits).to.equal(8);
    expect(p.totalEarned).to.equal(E(3.9));
    expect((await f.registry.getAgent(1)).lifetimeComputeSpend).to.equal(E(4));
  });

  it("lets anyone settle after the rental period and renters cancel unconfirmed rentals", async () => {
    const f = await loadFixture(deployProtocol);
    await setupProvider(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);

    await f.compute.connect(f.agentWallet1).rent(1, 2, 600);
    const agentBefore = await f.cycle.balanceOf(f.agentWallet1.address);
    await f.compute.connect(f.agentWallet1).cancelRental(1); // provider never confirmed
    expect(await f.cycle.balanceOf(f.agentWallet1.address)).to.equal(agentBefore + E(2) / 3n);

    await f.compute.connect(f.agentWallet1).rent(1, 2, 600);
    await f.compute.connect(f.providerAcct).confirmRental(2);
    await expect(f.compute.connect(f.poster).completeRental(2)).to.be.revertedWith("compute: still running");
    await time.increase(601);
    await f.compute.connect(f.poster).completeRental(2); // anyone, once elapsed
    expect((await f.compute.getRental(2)).status).to.equal(2n); // Completed
  });

  it("publishes the compute index from settled rentals", async () => {
    const f = await loadFixture(deployProtocol);
    await setupProvider(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);
    expect(await f.compute.computeIndex()).to.equal(0n);

    await f.compute.connect(f.agentWallet1).rent(1, 4, 1800);
    await f.compute.connect(f.providerAcct).confirmRental(1);
    await f.compute.connect(f.agentWallet1).completeRental(1);

    // 4 CYCLE over 4u x 1800s = 7200 unit-seconds -> 2 CYCLE per unit-hour
    expect(await f.compute.computeIndex()).to.equal(E(2));
    expect(await f.compute.epochIndex(await f.registry.currentEpoch())).to.equal(E(2));
  });

  it("failure reports refund the agent, slash the provider and can deactivate it", async () => {
    const f = await loadFixture(deployProtocol);
    await setupProvider(f);
    await registerAgent(f.registry, f.agentOwner, f.agentWallet1);

    // big job: 8 units * 90000s at 2/hr = 400 CYCLE; slash = 200
    await f.compute.connect(f.agentWallet1).rent(1, 8, 90000);
    await f.compute.connect(f.providerAcct).confirmRental(1);

    const agentBefore = await f.cycle.balanceOf(f.agentWallet1.address);
    const vaultBefore = await f.vault.totalFeesReceived();
    await f.compute.connect(f.agentWallet1).reportRentalFailure(1);

    // refund 400 + slash compensation 100; vault gets 100
    expect(await f.cycle.balanceOf(f.agentWallet1.address)).to.equal(agentBefore + E(400) + E(100));
    expect((await f.vault.totalFeesReceived()) - vaultBefore).to.equal(E(100));
    let p = await f.compute.getProvider(1);
    expect(p.stake).to.equal(E(300));
    expect(p.active).to.equal(true);
    expect(p.failedRentals).to.equal(1);

    // second failure drops stake to 100 < 250 -> deactivated
    await f.compute.connect(f.agentWallet1).rent(1, 8, 90000);
    await f.compute.connect(f.providerAcct).confirmRental(2);
    await f.compute.connect(f.agentWallet1).reportRentalFailure(2);
    p = await f.compute.getProvider(1);
    expect(p.stake).to.equal(E(100));
    expect(p.active).to.equal(false);

    // provider can exit with what's left
    const provBefore = await f.cycle.balanceOf(f.providerAcct.address);
    await f.compute.connect(f.providerAcct).withdrawProviderStake(1);
    expect(await f.cycle.balanceOf(f.providerAcct.address)).to.equal(provBefore + E(100));
  });
});
