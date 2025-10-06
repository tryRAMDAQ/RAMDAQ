import { config as loadEnv } from "dotenv";
import path from "node:path";
import { Contract, JsonRpcProvider, Wallet, formatEther, formatUnits, parseEther, parseUnits } from "ethers";

loadEnv({ path: path.resolve(__dirname, "../../arena/.env") });

const RPC = "https://rpc.mainnet.chain.robinhood.com";
const EXECUTOR = "0x97e00bB5C8991Ebe4750058ac62bd86fF521DEf5";
const USDG = "0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168";
const QUOTER = "0x8dc178efb8111bb0973dd9d722ebeff267c98f94";
const ZERO = "0x0000000000000000000000000000000000000000";
const AMOUNT = parseUnits("0.25", 6);
const MAX_GAS_PER_WALLET = parseEther("0.0001");
const TESTS = [
  ["NVDA", "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC"],
  ["AAPL", "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9"],
  ["MSFT", "0xe93237C50D904957Cf27E7B1133b510C669c2e74"],
  ["TSLA", "0x322F0929c4625eD5bAd873c95208D54E1c003b2d"],
  ["META", "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35"],
] as const;
const ERC20_ABI = [
  "function balanceOf(address) view returns (uint256)",
  "function transfer(address,uint256) returns (bool)",
  "function approve(address,uint256) returns (bool)",
];
const STOCK_ABI = ["function balanceOf(address) view returns (uint256)"];
const POOL_KEY = "tuple(address currency0,address currency1,uint24 fee,int24 tickSpacing,address hooks)";
const QUOTER_ABI = [`function quoteExactInputSingle(tuple(${POOL_KEY} poolKey,bool zeroForOne,uint128 exactAmount,bytes hookData) params) returns (uint256 amountOut,uint256 gasEstimate)`];
const EXECUTOR_ABI = ["function buyStock(address,uint256,uint256,uint256) returns (uint256)"];

async function main() {
  const live = process.argv.includes("--live");
  const provider = new JsonRpcProvider(RPC);
  if ((await provider.getNetwork()).chainId !== 4663n) throw new Error("wrong chain");
  if ((await provider.getCode(EXECUTOR)) === "0x") throw new Error("executor is not deployed");
  const wallets = TESTS.map((_, i) => {
    const key = process.env[`AGENT_SECRET_${i + 1}`];
    if (!key) throw new Error(`AGENT_SECRET_${i + 1} is required`);
    return new Wallet(key, provider);
  });
  const fees = await provider.getFeeData();
  const gasPrice = fees.maxFeePerGas ?? fees.gasPrice;
  if (!gasPrice) throw new Error("RPC returned no gas price");
  const projectedPerWallet = 500_000n * gasPrice;
  if (projectedPerWallet > MAX_GAS_PER_WALLET) {
    throw new Error(`gas safety stop: ${formatEther(projectedPerWallet)} ETH per wallet > ${formatEther(MAX_GAS_PER_WALLET)} ETH`);
  }

  const funderUsdg = new Contract(USDG, ERC20_ABI, wallets[0]);
  const balances: bigint[] = await Promise.all(wallets.map((w) => funderUsdg.balanceOf(w.address)));
  const deficits = balances.map((b) => b >= AMOUNT ? 0n : AMOUNT - b);
  const totalDeficit = deficits.reduce((a, b) => a + b, 0n);
  if (balances[0] < AMOUNT + totalDeficit) throw new Error("wallet 1 lacks USDG for five capped tests");

  console.log(JSON.stringify({
    mode: live ? "LIVE" : "DRY_RUN",
    executor: EXECUTOR,
    perWalletUsdg: "0.25",
    maxTotalUsdg: "1.25",
    projectedMaxGasEthPerWallet: formatEther(projectedPerWallet),
    tests: wallets.map((w, i) => ({ wallet: w.address, symbol: TESTS[i][0], fundingNeeded: formatUnits(deficits[i], 6) })),
  }, null, 2));
  if (!live) return;

  const fundingTxs: string[] = [];
  for (let i = 1; i < wallets.length; i++) {
    if (deficits[i] === 0n) continue;
    const tx = await funderUsdg.transfer(wallets[i].address, deficits[i]);
    const receipt = await tx.wait(1);
    if (!receipt || receipt.status !== 1) throw new Error(`funding wallet ${i + 1} reverted`);
    fundingTxs.push(tx.hash);
  }