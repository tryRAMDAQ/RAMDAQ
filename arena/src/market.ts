/**
 * THE STOCK MARKET — real tokenized equities (Robinhood Stock Tokens) on
 * Robinhood Chain, priced live.
 *
 * Every symbol below is a REAL ERC-20 on Robinhood Chain mainnet, issued by
 * Robinhood and backed 1:1 by custodied shares, trading 24/7 against the
 * chain's Uniswap v4 PoolManager (0x8366a39C…). Prices come from the chain's
 * Blockscout indexer (derived from actual on-chain market activity) and
 * refresh continuously — the agents trade paper positions AT these real
 * prices, and every fill is anchored on-chain with the token's address so
 * anyone can audit the quote against the real market.
 */

export interface Stock {
  sym: string;
  name: string;
  token: string;         // the Robinhood Stock Token contract on mainnet (4663)
  kind: "megacap" | "chip" | "crypto" | "etf" | "private";
}

// The racing basket — a lane for every persona. All addresses verified on
// robinhoodchain.blockscout.com (the "• Robinhood Token" issues, not the fakes).
export const BASKET: Stock[] = [
  { sym: "NVDA", name: "NVIDIA", token: "0xd0601CE157Db5bdC3162BbaC2a2C8aF5320D9EEC", kind: "chip" },
  { sym: "AMD", name: "AMD", token: "0x86923f96303D656E4aa86D9d42D1e57ad2023fdC", kind: "chip" },
  { sym: "MU", name: "Micron", token: "0xfF080c8ce2E5feadaCa0Da81314Ae59D232d4afD", kind: "chip" },
  { sym: "TSLA", name: "Tesla", token: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", kind: "megacap" },
  { sym: "AAPL", name: "Apple", token: "0xaF3D76f1834A1d425780943C99Ea8A608f8a93f9", kind: "megacap" },
  { sym: "MSFT", name: "Microsoft", token: "0xe93237C50D904957Cf27E7B1133b510C669c2e74", kind: "megacap" },
  { sym: "META", name: "Meta", token: "0xc0D6457C16Cc70d6790Dd43521C899C87ce02f35", kind: "megacap" },
  { sym: "GOOGL", name: "Alphabet", token: "0x2e0847E8910a9732eB3fb1bb4b70a580ADAD4FE3", kind: "megacap" },
  { sym: "AMZN", name: "Amazon", token: "0x12f190a9F9d7D37a250758b26824B97CE941bF54", kind: "megacap" },
  { sym: "COIN", name: "Coinbase", token: "0x6330D8C3178a418788dF01a47479c0ce7CCF450b", kind: "crypto" },
  { sym: "SPCX", name: "SpaceX", token: "0x4a0E65A3EcceC6dBe60AE065F2e7bb85Fae35eEa", kind: "private" },
  { sym: "SPY", name: "S&P 500 ETF", token: "0x117cc2133c37B721F49dE2A7a74833232B3B4C0C", kind: "etf" },
];

export interface Quote {
  sym: string;
  usd: number;           // live price
  prevUsd: number;       // previous poll (tick direction)
  vol24hUsd: number;     // real 24h on-chain volume
  at: number;            // when we read it
  history: Array<{ t: number; usd: number }>; // ring, ~30 min
}

// Stock prices live on MAINNET regardless of which network the money runs on
// (same pattern as vast.ai market pricing) — the explorer is env-overridable.
const STOCK_EXPLORER = (process.env.STOCK_EXPLORER ?? "https://robinhoodchain.blockscout.com").replace(/\/$/, "");