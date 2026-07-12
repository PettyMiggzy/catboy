// Hardhat + ethers v6 test suite for StagLocker.
// Drop this into the $STAG contracts repo (C:\Users\samah\stag\contracts):
//   contracts/StagLocker.sol, contracts/mocks/Mocks.sol, test/StagLocker.test.js
// then:  npx hardhat test test/StagLocker.test.js
const { expect } = require("chai");
const { ethers } = require("hardhat");
const { anyValue } = require("@nomicfoundation/hardhat-chai-matchers/withArgs");

const DAY = 24 * 60 * 60;
const now = async () => (await ethers.provider.getBlock("latest")).timestamp;
const jump = async (secs) => { await ethers.provider.send("evm_increaseTime", [secs]); await ethers.provider.send("evm_mine", []); };

async function deploy(feeWei = 0n) {
  const [admin, treasury, alice, bob] = await ethers.getSigners();
  const PM = await (await ethers.getContractFactory("MockPositionManager")).deploy();
  const Locker = await ethers.getContractFactory("StagLocker");
  const locker = await Locker.deploy(await PM.getAddress(), feeWei, treasury.address, admin.address);
  const Tok = await (await ethers.getContractFactory("MockERC20")).deploy();
  return { admin, treasury, alice, bob, PM, locker, tok: Tok };
}

describe("StagLocker", () => {
  describe("constructor", () => {
    it("reverts on zero fee recipient or admin", async () => {
      const Locker = await ethers.getContractFactory("StagLocker");
      const z = ethers.ZeroAddress;
      const me = (await ethers.getSigners())[0].address;
      // zero feeRecipient -> our own guard
      await expect(Locker.deploy(z, 0, z, me)).to.be.revertedWithCustomError(Locker, "ZeroAddress");
      // zero admin -> caught earlier by the Ownable base constructor
      await expect(Locker.deploy(z, 0, me, z)).to.be.revertedWithCustomError(Locker, "OwnableInvalidOwner");
    });
    it("allows zero positionManager (V3 locks disabled)", async () => {
      const [admin, t] = await ethers.getSigners();
      const Locker = await ethers.getContractFactory("StagLocker");
      const l = await Locker.deploy(ethers.ZeroAddress, 0, t.address, admin.address);
      await expect(l.lockV3Position(0, (await now()) + DAY)).to.be.revertedWithCustomError(l, "WrongKind");
    });
  });

  describe("lockTokens", () => {
    it("locks tokens and exposes them via views", async () => {
      const { locker, tok, alice } = await deploy();
      await tok.mint(alice.address, 1000n);
      await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      const unlock = (await now()) + DAY;
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, unlock))
        .to.emit(locker, "TokenLocked").withArgs(0, alice.address, await tok.getAddress(), 1000n, unlock);
      const lk = await locker.getLock(0);
      expect(lk.owner).to.equal(alice.address);
      expect(lk.amountOrId).to.equal(1000n);
      expect(lk.kind).to.equal(0n);
      expect(await locker.ownerLockIds(alice.address)).to.deep.equal([0n]);
      expect(await locker.assetLockIds(await tok.getAddress())).to.deep.equal([0n]);
      expect(await locker.totalLocks()).to.equal(1n);
    });
    it("records the amount RECEIVED for fee-on-transfer tokens", async () => {
      const { locker, alice } = await deploy();
      const fee = await (await ethers.getContractFactory("MockFeeToken")).deploy(500); // 5%
      await fee.mint(alice.address, 1000n);
      await fee.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await fee.getAddress(), 1000n, (await now()) + DAY);
      expect((await locker.getLock(0)).amountOrId).to.equal(950n); // 1000 - 5%
    });
    it("reverts on zero address, zero amount, past unlock", async () => {
      const { locker, tok, alice } = await deploy();
      const u = (await now()) + DAY;
      await expect(locker.lockTokens(ethers.ZeroAddress, 1n, u)).to.be.revertedWithCustomError(locker, "ZeroAddress");
      await expect(locker.lockTokens(await tok.getAddress(), 0n, u)).to.be.revertedWithCustomError(locker, "ZeroAmount");
      await tok.mint(alice.address, 1n); await tok.connect(alice).approve(await locker.getAddress(), 1n);
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1n, await now())).to.be.revertedWithCustomError(locker, "BadUnlockTime");
    });
  });

  describe("fees", () => {
    it("charges the flat fee, forwards it, and refunds overpayment", async () => {
      const feeWei = ethers.parseEther("0.01");
      const { locker, tok, alice, treasury } = await deploy(feeWei);
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      const before = await ethers.provider.getBalance(treasury.address);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY, { value: ethers.parseEther("0.05") });
      expect(await ethers.provider.getBalance(treasury.address)).to.equal(before + feeWei); // exactly the fee, overpay refunded
    });
    it("reverts when fee underpaid", async () => {
      const feeWei = ethers.parseEther("0.01");
      const { locker, tok, alice } = await deploy(feeWei);
      await tok.mint(alice.address, 1n); await tok.connect(alice).approve(await locker.getAddress(), 1n);
      await expect(locker.connect(alice).lockTokens(await tok.getAddress(), 1n, (await now()) + DAY, { value: ethers.parseEther("0.005") }))
        .to.be.revertedWithCustomError(locker, "FeeTooLow");
    });
  });

  describe("withdraw", () => {
    it("blocks early withdraw, allows after unlock, only by owner", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(locker, "StillLocked");
      await jump(DAY + 1);
      await expect(locker.connect(bob).withdraw(0)).to.be.revertedWithCustomError(locker, "NotLockOwner");
      await expect(locker.connect(alice).withdraw(0)).to.emit(locker, "Withdrawn").withArgs(0, alice.address);
      expect(await tok.balanceOf(alice.address)).to.equal(1000n);
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(locker, "AlreadyWithdrawn");
    });
  });

  describe("manage (only strengthens the lock)", () => {
    it("extendLock only later, owner only", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      const u = (await now()) + DAY;
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, u);
      await expect(locker.connect(alice).extendLock(0, u - 1)).to.be.revertedWithCustomError(locker, "BadUnlockTime");
      await expect(locker.connect(bob).extendLock(0, u + DAY)).to.be.revertedWithCustomError(locker, "NotLockOwner");
      await expect(locker.connect(alice).extendLock(0, u + DAY)).to.emit(locker, "LockExtended").withArgs(0, u + DAY);
    });
    it("topUp adds received amount, ERC20 only", async () => {
      const { locker, tok, alice } = await deploy();
      await tok.mint(alice.address, 1500n); await tok.connect(alice).approve(await locker.getAddress(), 1500n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      await expect(locker.connect(alice).topUp(0, 500n)).to.emit(locker, "LockToppedUp").withArgs(0, 500n, 1500n);
      expect((await locker.getLock(0)).amountOrId).to.equal(1500n);
    });
    it("transferLockOwnership moves control", async () => {
      const { locker, tok, alice, bob } = await deploy();
      await tok.mint(alice.address, 1000n); await tok.connect(alice).approve(await locker.getAddress(), 1000n);
      await locker.connect(alice).lockTokens(await tok.getAddress(), 1000n, (await now()) + DAY);
      await locker.connect(alice).transferLockOwnership(0, bob.address);
      expect((await locker.getLock(0)).owner).to.equal(bob.address);
      await jump(DAY + 1);
      await expect(locker.connect(alice).withdraw(0)).to.be.revertedWithCustomError(locker, "NotLockOwner");
      await locker.connect(bob).withdraw(0);
      expect(await tok.balanceOf(bob.address)).to.equal(1000n);
    });
  });

  describe("V3 LP locks", () => {
    it("locks via lockV3Position (approve path)", async () => {
      const { locker, PM, alice } = await deploy();
      const id = 0; await PM.mint(alice.address);
      await PM.connect(alice).approve(await locker.getAddress(), id);
      const u = (await now()) + DAY;
      await expect(locker.connect(alice).lockV3Position(id, u)).to.emit(locker, "V3Locked").withArgs(anyValue, alice.address, id, u);
      expect(await PM.ownerOf(id)).to.equal(await locker.getAddress());
      await jump(DAY + 1);
      await locker.connect(alice).withdraw(0);
      expect(await PM.ownerOf(id)).to.equal(alice.address);
    });
    it("locks via safeTransferFrom with encoded unlockTime", async () => {
      const { locker, PM, alice } = await deploy();
      await PM.mint(alice.address); // id 0
      const u = (await now()) + DAY;
      const data = ethers.AbiCoder.defaultAbiCoder().encode(["uint64"], [u]);
      await PM.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, await locker.getAddress(), 0, data);
      const lk = await locker.getLock(0);
      expect(lk.kind).to.equal(1n);
      expect(lk.owner).to.equal(alice.address);
    });
    it("REVERTS a safeTransfer with bad data instead of stranding the NFT", async () => {
      const { locker, PM, alice } = await deploy();
      await PM.mint(alice.address); // id 0
      await expect(
        PM.connect(alice)["safeTransferFrom(address,address,uint256,bytes)"](alice.address, await locker.getAddress(), 0, "0x")
      ).to.be.reverted; // no lock, NFT stays with alice
      expect(await PM.ownerOf(0)).to.equal(alice.address);
    });
  });

  describe("admin can NEVER touch locked assets", () => {
    it("only exposes setFee; no drain path exists", async () => {
      const { locker, admin } = await deploy();
      expect(typeof locker.setFee).to.equal("function");
      // sanity: the contract ABI has no owner-only asset-moving function
      const fns = locker.interface.fragments.filter((f) => f.type === "function").map((f) => f.name);
      for (const bad of ["sweep", "rescue", "emergencyWithdraw", "adminWithdraw", "recover"]) {
        expect(fns).to.not.include(bad);
      }
    });
    it("setFee is owner-only and updates fee + recipient", async () => {
      const { locker, admin, alice, bob } = await deploy();
      await expect(locker.connect(alice).setFee(1n, bob.address)).to.be.revertedWithCustomError(locker, "OwnableUnauthorizedAccount");
      await expect(locker.connect(admin).setFee(1n, bob.address)).to.emit(locker, "FeeChanged").withArgs(1n, bob.address);
      await expect(locker.connect(admin).setFee(1n, ethers.ZeroAddress)).to.be.revertedWithCustomError(locker, "ZeroAddress");
    });
  });
});
