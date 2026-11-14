import { ethers } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import {
  DEFAULTS,
  USDT,
  World,
  depositFrom,
  deployWorld,
  expectBooksBalance,
  feeOf,
  makeWallets,
  releaseWith,
  newRedeemId,
  world18,
  world6,
} from "./helpers";

const OWNER = ethers.id("kaspa-owner");

describe("KusdtVault: deposits", () => {
  describe("fee math", () => {
    it("charges the minimum fee on small deposits", async () => {
      const w = await loadFixture(world6);
      // 10 USDT: 0.2 % is 0.02 USDT, below the 0.50 USDT minimum.
      const units = 10n * USDT;
      expect(await w.vault.depositFeeOf(units)).to.equal(500_000n);
      await expect(depositFrom(w, w.alice, units))
        .to.emit(w.vault, "Deposit")
        .withArgs(0n, w.alice.address, 0, OWNER, units, 500_000n, units - 500_000n);
      expect(await w.vault.feesAccrued()).to.equal(500_000n);
      expect(await w.vault.backing()).to.equal(units - 500_000n);
    });

    it("charges the proportional fee above the minimum", async () => {
      const w = await loadFixture(world6);
      const units = 1_000n * USDT; // 0.2 % = 2 USDT
      expect(await w.vault.depositFeeOf(units)).to.equal(2n * USDT);
      await expect(depositFrom(w, w.alice, units))
        .to.emit(w.vault, "Deposit")
        .withArgs(0n, w.alice.address, 0, OWNER, units, 2n * USDT, 998n * USDT);
    });

    it("rounds the proportional fee up", async () => {
      const w = await loadFixture(world6);
      await w.vault.setFees(20, 0, 0);
      // 250 000 001 * 20 / 10^4 = 500 000.0002 -> 500 001
      expect(await w.vault.depositFeeOf(250_000_001n)).to.equal(500_001n);
      expect(await w.vault.depositFeeOf(250_000_000n)).to.equal(500_000n);
      expect(await w.vault.depositFeeOf(1n)).to.equal(1n);
      await w.vault.setFees(1, 0, 0);
      expect(await w.vault.depositFeeOf(10_001n)).to.equal(2n);
      expect(await w.vault.depositFeeOf(10_000n)).to.equal(1n);
      await w.vault.setFees(0, 0, 0);
      expect(await w.vault.depositFeeOf(123_456_789n)).to.equal(0n);
    });

    it("matches the reference model on many amounts and fee settings", async () => {
      const w = await loadFixture(world6);
      const settings: [number, bigint][] = [
        [20, 500_000n],
        [100, 0n],
        [7, 50_000_000n],
        [0, 1n],
        [33, 123_457n],
      ];
      let seed = 12345n;
      const rnd = () => (seed = (seed * 6364136223846793005n + 1442695040888963407n) % (1n << 64n));
      for (const [bps, minFee] of settings) {
        await w.vault.setFees(bps, minFee, minFee);
        for (let i = 0; i < 25; i++) {
          const units = (rnd() % (100_000n * USDT)) + 1n;
          expect(await w.vault.depositFeeOf(units)).to.equal(feeOf(units, bps, minFee));
          expect(await w.vault.releaseFeeOf(units)).to.equal(feeOf(units, bps, minFee));
        }
      }
    });

    it("requires something to mint", async () => {
      const w = await loadFixture(world6);
      await w.vault.setFees(20, 50n * USDT, 0);
      await expect(depositFrom(w, w.alice, 10n * USDT)).to.be.revertedWithCustomError(w.vault, "NothingToMint");
      await expect(depositFrom(w, w.alice, 50n * USDT)).to.be.revertedWithCustomError(w.vault, "NothingToMint");
      await expect(depositFrom(w, w.alice, 50n * USDT + 1n))
        .to.emit(w.vault, "Deposit")
        .withArgs(0n, w.alice.address, 0, OWNER, 50n * USDT + 1n, 50n * USDT, 1n);
    });
  });

  describe("scaling", () => {
    it("6 decimals moves units one to one", async () => {
      const w = await loadFixture(world6);
      expect(await w.vault.scale()).to.equal(1n);
      await depositFrom(w, w.alice, 123n * USDT + 456_789n);
      expect(await w.token.balanceOf(await w.vault.getAddress())).to.equal(123_456_789n);
      expect(await w.token.balanceOf(w.alice.address)).to.equal(0n);
      await expectBooksBalance(w);
    });

    it("18 decimals moves units x 10^12", async () => {
      const w = await loadFixture(world18);
      expect(await w.vault.scale()).to.equal(10n ** 12n);
      expect(await w.vault.tokenDecimals()).to.equal(18);
      const units = 123n * USDT + 456_789n;
      await expect(depositFrom(w, w.alice, units))
        .to.emit(w.vault, "Deposit")
        .withArgs(0n, w.alice.address, 0, OWNER, units, 500_000n, units - 500_000n);
      expect(await w.token.balanceOf(await w.vault.getAddress())).to.equal(units * 10n ** 12n);
      expect(await w.vault.backing()).to.equal(units - 500_000n);
      await expectBooksBalance(w);
    });

    it("18 decimals: pays releases and fees in whole units x 10^12", async () => {
      const w = await loadFixture(world18);
      await depositFrom(w, w.alice, 1_000n * USDT);
      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
      await releaseWith(w, r);
      expect(await w.token.balanceOf(w.bob.address)).to.equal((100n * USDT - 5n * USDT) * 10n ** 12n);
      await w.vault.withdrawFees(w.carol.address, 1n);
      expect(await w.token.balanceOf(w.carol.address)).to.equal(10n ** 12n);
      await expectBooksBalance(w);
    });

    it("ignores sub-unit dust sent directly to an 18-decimal vault", async () => {
      const w = await loadFixture(world18);
      await depositFrom(w, w.alice, 100n * USDT);
      const before = await w.vault.backing();
      await w.token.mint(await w.vault.getAddress(), 10n ** 12n - 1n);
      expect(await w.vault.backing()).to.equal(before);
      await w.token.mint(await w.vault.getAddress(), 1n);
      expect(await w.vault.backing()).to.equal(before + 1n);
    });
  });

  describe("limits and inputs", () => {
    it("enforces minDeposit and maxDeposit inclusively", async () => {
      const w = await loadFixture(world6);
      await expect(depositFrom(w, w.alice, DEFAULTS.minDeposit - 1n))
        .to.be.revertedWithCustomError(w.vault, "DepositOutOfRange")
        .withArgs(DEFAULTS.minDeposit - 1n);
      await expect(depositFrom(w, w.alice, DEFAULTS.maxDeposit + 1n))
        .to.be.revertedWithCustomError(w.vault, "DepositOutOfRange")
        .withArgs(DEFAULTS.maxDeposit + 1n);
      await expect(depositFrom(w, w.alice, 0n)).to.be.revertedWithCustomError(w.vault, "DepositOutOfRange");
      await expect(depositFrom(w, w.alice, DEFAULTS.minDeposit)).to.emit(w.vault, "Deposit");
      await expect(depositFrom(w, w.alice, DEFAULTS.maxDeposit)).to.emit(w.vault, "Deposit");
    });

    it("accepts owner schemes 0 to 4 and rejects the rest", async () => {
      const w = await loadFixture(world6);
      for (let s = 0; s <= 4; s++) {
        await expect(depositFrom(w, w.alice, 20n * USDT, s))
          .to.emit(w.vault, "Deposit")
          .withArgs(BigInt(s), w.alice.address, s, OWNER, 20n * USDT, 500_000n, 20n * USDT - 500_000n);
      }
      for (const s of [5, 6, 0x80, 255]) {
        await expect(depositFrom(w, w.alice, 20n * USDT, s))
          .to.be.revertedWithCustomError(w.vault, "BadOwnerScheme")
          .withArgs(s);
      }
    });

    it("rejects a zero owner", async () => {
      const w = await loadFixture(world6);
      await expect(depositFrom(w, w.alice, 20n * USDT, 0, ethers.ZeroHash)).to.be.revertedWithCustomError(
        w.vault,
        "ZeroOwner",
      );
    });

    it("reverts without allowance or balance, and leaves no trace", async () => {
      const w = await loadFixture(world6);
      await w.token.mint(w.alice.address, 100n * USDT);
      await expect(w.vault.connect(w.alice).deposit(100n * USDT, 0, OWNER)).to.be.reverted;
      await w.token.connect(w.alice).approve(await w.vault.getAddress(), 1000n * USDT);
      await expect(w.vault.connect(w.alice).deposit(1000n * USDT, 0, OWNER)).to.be.reverted;
      expect(await w.vault.depositNonce()).to.equal(0n);
      expect(await w.vault.feesAccrued()).to.equal(0n);
    });

    it("is stopped by pause", async () => {
      const w = await loadFixture(world6);
      await w.vault.connect(w.guardian).pause();
      await expect(depositFrom(w, w.alice, 20n * USDT)).to.be.revertedWithCustomError(w.vault, "EnforcedPause");
      await w.vault.unpause();
      await expect(depositFrom(w, w.alice, 20n * USDT)).to.emit(w.vault, "Deposit");
    });
  });

  describe("nonces and events", () => {
    it("numbers deposits 0, 1, 2, ... and records what each minted", async () => {
      const w = await loadFixture(world6);
      const people = [w.alice, w.bob, w.carol, w.alice, w.bob];
      for (let i = 0; i < people.length; i++) {
        const units = BigInt(10 + i * 37) * USDT + BigInt(i);
        const owner = ethers.id(`owner-${i}`);
        const fee = feeOf(units, DEFAULTS.feeBps, DEFAULTS.minDepositFee);
        const tx = await depositFrom(w, people[i], units, i % 5, owner);
        await expect(tx)
          .to.emit(w.vault, "Deposit")
          .withArgs(BigInt(i), people[i].address, i % 5, owner, units, fee, units - fee);
        expect(await w.vault.depositNonce()).to.equal(BigInt(i + 1));
        expect(await w.vault.depositMinted(i)).to.equal(units - fee);
      }
    });

    it("emits exactly the SPEC §7 event: signature, indexed topics and data", async () => {
      const w = await loadFixture(world6);
      await depositFrom(w, w.bob, 15n * USDT);
      const rc = await (await depositFrom(w, w.alice, 77n * USDT + 1n, 3, ethers.id("p2sh"))).wait();
      const vaultAddr = await w.vault.getAddress();
      const logs = rc!.logs.filter((l) => l.address === vaultAddr);
      expect(logs.length).to.equal(1);
      const log = logs[0];
      const sig = "Deposit(uint64,address,uint8,bytes32,uint256,uint256,uint256)";
      expect(log.topics[0]).to.equal(ethers.id(sig));
      expect(log.topics.length).to.equal(3);
      expect(BigInt(log.topics[1])).to.equal(1n);
      expect(ethers.getAddress(ethers.dataSlice(log.topics[2], 12))).to.equal(w.alice.address);
      const units = 77n * USDT + 1n;
      const fee = feeOf(units, 20, 500_000n);
      const [scheme, owner, u, f, m] = ethers.AbiCoder.defaultAbiCoder().decode(
        ["uint8", "bytes32", "uint256", "uint256", "uint256"],
        log.data,
      );
      expect([scheme, owner, u, f, m]).to.deep.equal([3n, ethers.id("p2sh"), units, fee, units - fee]);
    });
  });

  describe("non-standard tokens", () => {
    async function tetherWorld(): Promise<World & { tether: any }> {
      const [owner, guardian, alice, bob, carol, ...others] = await ethers.getSigners();
      const tether = await (await ethers.getContractFactory("TetherStyleUSDT")).deploy();
      const signerWallets = makeWallets("signer", 5);
      const vault = await (await ethers.getContractFactory("KusdtVault")).deploy(
        await tether.getAddress(),
        6,
        signerWallets.map((x) => x.address) as any,
        guardian.address,
        owner.address,
        DEFAULTS,
        0, 0, 0
      );
      return {
        vault,
        token: tether as any,
        tether,
        decimals: 6,
        scale: 1n,
        signerWallets,
        outsiders: makeWallets("outsider", 5),
        owner,
        guardian,
        alice,
        bob,
        carol,
        others,
      };
    }

    it("works with a Tether-style token that returns nothing", async () => {
      const w = await loadFixture(tetherWorld);
      const t = w.tether;
      const v = await w.vault.getAddress();
      await t.mint(w.alice.address, 1_000n * USDT);
      await t.connect(w.alice).approve(v, 1_000n * USDT);
      await expect(w.vault.connect(w.alice).deposit(1_000n * USDT, 0, OWNER))
        .to.emit(w.vault, "Deposit")
        .withArgs(0n, w.alice.address, 0, OWNER, 1_000n * USDT, 2n * USDT, 998n * USDT);
      expect(await t.balanceOf(v)).to.equal(1_000n * USDT);

      const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 500n * USDT };
      await expect(releaseWith(w, r)).to.emit(w.vault, "Released");
      expect(await t.balanceOf(w.bob.address)).to.equal(495n * USDT);

      await w.vault.withdrawFees(w.carol.address, 7n * USDT);
      expect(await t.balanceOf(w.carol.address)).to.equal(7n * USDT);
      expect(await t.balanceOf(v)).to.equal(await w.vault.backing() + (await w.vault.feesAccrued()));
    });

    it("surfaces a failing Tether-style transferFrom as a revert", async () => {
      const w = await loadFixture(tetherWorld);
      await w.tether.mint(w.alice.address, 100n * USDT);
      await expect(w.vault.connect(w.alice).deposit(100n * USDT, 0, OWNER)).to.be.revertedWith("allowance");
    });

    it("rejects a fee-on-transfer token that delivers less than requested", async () => {
      const [owner, guardian, alice] = await ethers.getSigners();
      const fot = await (await ethers.getContractFactory("FeeOnTransferToken")).deploy(10); // 0.1 %
      const vault = await (await ethers.getContractFactory("KusdtVault")).deploy(
        await fot.getAddress(),
        6,
        makeWallets("signer", 5).map((x) => x.address) as any,
        guardian.address,
        owner.address,
        DEFAULTS,
        0, 0, 0
      );
      await fot.mint(alice.address, 100n * USDT);
      await fot.connect(alice).approve(await vault.getAddress(), 100n * USDT);
      await expect(vault.connect(alice).deposit(100n * USDT, 0, OWNER))
        .to.be.revertedWithCustomError(vault, "WrongAmountReceived")
        .withArgs(100n * USDT, 100n * USDT - 100_000n);
      expect(await vault.depositNonce()).to.equal(0n);
    });

    it("blocks reentry from a token hook during deposit", async () => {
      const [owner, guardian, alice] = await ethers.getSigners();
      const re = await (await ethers.getContractFactory("ReentrantToken")).deploy();
      const vault = await (await ethers.getContractFactory("KusdtVault")).deploy(
        await re.getAddress(),
        6,
        makeWallets("signer", 5).map((x) => x.address) as any,
        guardian.address,
        owner.address,
        DEFAULTS,
        0, 0, 0
      );
      const v = await vault.getAddress();
      await re.mint(alice.address, 1_000n * USDT);
      await re.connect(alice).approve(v, 1_000n * USDT);
      // The hook runs as the token, which tries to deposit again in the middle.
      await re.arm(v, vault.interface.encodeFunctionData("deposit", [20n * USDT, 0, OWNER]));
      await vault.connect(alice).deposit(100n * USDT, 0, OWNER);
      expect(await re.lastCallOk()).to.equal(false);
      expect((await re.lastReturn()).slice(0, 10)).to.equal(vault.interface.getError("ReentrancyGuardReentrantCall")!.selector);
      expect(await vault.depositNonce()).to.equal(1n);
    });
  });

  it("works the same on a vault deployed with other parameters", async () => {
    const w = await deployWorld(6, { ...DEFAULTS, minDepositFee: 0n, feeBps: 0, minDeposit: 1n });
    await expect(depositFrom(w, w.alice, 1n))
      .to.emit(w.vault, "Deposit")
      .withArgs(0n, w.alice.address, 0, OWNER, 1n, 0n, 1n);
  });
});
