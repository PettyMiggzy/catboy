// Reward blocklist — wallets barred from ALL $CATBOY rewards: the staking pool,
// merch/holder discounts, the whale group, and any future airdrop or rebate.
//
// These are wash-trade / chart-farm wallets identified on-chain: they churn buys
// to fake volume and paint the chart, then net-sell into real buyers. Being on
// this list does NOT stop them trading (the mint has no freeze authority — nobody
// can) — it only makes the farming earn them nothing from us.
//
// Public wallet addresses only (never secrets). Add more without a code change via
// the REWARD_BLOCKLIST env var (comma/space separated). Reversible: remove an
// address here or from the env and redeploy/restart.
const HARDCODED = [
  // --- Group A: chart dumpers (churn buys, then net-SELL into real buyers) ---
  "9w2fmUrr2QbSP8URbDHyLNNPBXvqv1guMx9XSmSWgmK3", // net -16.7 SOL (20b/40s)
  "rkwYDiuEB5Fiym1LDh99HFmNxzMJiHhUDkcuSsceHjN",  // net -13.5 SOL (20b/40s)
  "6yBst5Jdx7kYi6Xpi7ogvCie3kHDAzsUpDEoT68toRx",  // net -11.2 SOL (80b/220s)
  "FxVumvMfcHMR35SoRWm28RRpUebHGKUiKh7uSndQ5aKd",  // operator/funder of 6yBst5 + another wash wallet
  // --- Group B: volume bots (net ~0, fixed 20-cycle churn to fake trending) ---
  "2zYR5pbjGTH28vfB7W9GGmTWKgTzAmfoQcZ3RkvF6iog",
  "79Rfx3vugVaL51FkvLR8aMZNc27VbKfjvtLn4hR1C7qN",
  "BC3WCXZi6eXKLKt72Yx4tZ9n7wHxaEG1dN16djvvjAGU",
  "3nd4ENrPvT3BqcBSZDYTSn1GiAY81Z69qrfCke2RYgVn",
  "7TC394JXWTs1Z6kvSyJM1kntUfyLnM25GsbW51YwJFbg",
  "k2aFHBQELBy3hdf1rBR2JNYKeWUgUWRnr4uwz3rEP4W",
  "4JA4GqHsPTUwpjoR7rKC1V9f5HHMqMeViWwug5peuzKv",
  "EXSYevtEHL8G2NvQcahi2CHmujN3DUvid91fJnZQUBzC",
  "JBjHV3RQosa5uzibeQadiAjsx4EnBLoC8zTdeuXrF6vA",
  // Note: kEdTbk…dKRiZ (160b/20s, net +0.01) left OFF — net-accumulator, could be a
  // real DCA buyer. Watching it; add here if it starts dumping.
];

const _env = (process.env.REWARD_BLOCKLIST || "").split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);

export const BLOCKLIST = new Set([...HARDCODED, ..._env]);

// True if this wallet is barred from rewards. Safe on null/undefined.
export function isBlocked(addr) {
  return !!addr && BLOCKLIST.has(String(addr).trim());
}
