// Deploy StagLocker to Robinhood Chain.
//   DEPLOYER_KEY=0x... npx hardhat run scripts/deploy.js --network robinhood
// Keep DEPLOYER_KEY in your shell env ONLY - never commit it.
const { ethers } = require("hardhat");

// Robinhood Chain Uniswap V3 NonfungiblePositionManager (address(0) to disable V3 locks).
const POSITION_MANAGER = process.env.LOCKER_PM || "0x73991a25c818bf1f1128deaab1492d45638de0d3";
const FLAT_FEE_WEI = process.env.LOCKER_FEE_WEI || "0"; // launch free, raise later via setFee
const FEE_RECIPIENT = process.env.LOCKER_TREASURY;      // required: where fees go
const ADMIN = process.env.LOCKER_ADMIN;                 // required: fee control only

async function main() {
  if (!FEE_RECIPIENT || !ADMIN) throw new Error("set LOCKER_TREASURY and LOCKER_ADMIN env vars");
  const Locker = await ethers.getContractFactory("StagLocker");
  const locker = await Locker.deploy(POSITION_MANAGER, FLAT_FEE_WEI, FEE_RECIPIENT, ADMIN);
  await locker.waitForDeployment();
  const addr = await locker.getAddress();
  console.log("StagLocker deployed:", addr);
  console.log("Verify: npx hardhat verify --network robinhood", addr, POSITION_MANAGER, FLAT_FEE_WEI, FEE_RECIPIENT, ADMIN);
}
main().catch((e) => { console.error(e); process.exit(1); });
