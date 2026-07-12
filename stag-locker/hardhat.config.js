require("@nomicfoundation/hardhat-toolbox");

// Matches the $STAG contracts repo: Solidity 0.8.24, optimizer 200, viaIR, paris, OZ 5.0.2.
// Standalone: `npm i && npx hardhat test`. Or drop contracts/ + test/ into the main repo.
const PK = process.env.DEPLOYER_KEY; // env only - never commit a key

module.exports = {
  solidity: {
    version: "0.8.24",
    settings: { optimizer: { enabled: true, runs: 200 }, viaIR: true, evmVersion: "paris" },
  },
  networks: {
    robinhood: {
      url: process.env.RHC_RPC || "https://rpc.mainnet.chain.robinhood.com",
      chainId: 4663,
      accounts: PK ? [PK] : [],
    },
  },
};
