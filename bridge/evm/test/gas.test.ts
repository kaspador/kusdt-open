import { expect } from "chai";
import { ethers } from "hardhat";
import { USDT, depositFrom, gasOf, newRedeemId, refundWith, signRelease, sortByAddress, world18, world6 } from "./helpers";

/** Gas of the user-facing paths, printed for the README (the gas reporter gives averages). */
describe("KusdtVault: gas", () => {
  for (const [label, fixture] of [
    ["6 decimals", world6],
    ["18 decimals", world18],
  ] as const) {
    it(`deposit, release and refund (${label})`, async () => {
      const w = await fixture();
      const v = await w.vault.getAddress();
      await w.token.mint(w.alice.address, 1_000_000n * USDT * w.scale);
      await w.token.connect(w.alice).approve(v, ethers.MaxUint256);
      const dep = (u: bigint) => w.vault.connect(w.alice).deposit(u, 0, ethers.id("o"));
      const first = await gasOf(dep(1_000n * USDT));
      const next = await gasOf(dep(1_000n * USDT));
      const sorted = sortByAddress(w.signerWallets);
      const rel = async (n: number) => {
        const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
        return gasOf(w.vault.release(r, await signRelease(w.vault, sorted.slice(0, n), r)));
      };
      const rel3first = await rel(3); // bob's first incoming transfer (new balance slot)
      const rel3 = await rel(3);
      const rel5 = await rel(5);
      const pay = async () => {
        const r = { redeemId: newRedeemId(), recipient: w.bob.address, units: 100n * USDT };
        await w.vault.release(r, await signRelease(w.vault, sorted.slice(0, 3), r));
        return gasOf(w.vault.executeRelease(r.redeemId));
      };
      const executeRel = await pay();
      const refund = await gasOf(refundWith(w, { nonce: 0n, recipient: w.carol.address, units: 998n * USDT }));
      console.log(
        `      ${label}: deposit first ${first}, deposit ${next}, release(3 sigs, new recipient) ${rel3first}, ` +
          `queue a release(3 sigs) ${rel3}, queue a release(5 sigs) ${rel5}, pay a release ${executeRel}, pay a refund ${refund}`,
      );
      expect(next).to.be.lessThan(150_000n);
      expect(rel3).to.be.lessThan(200_000n);
      expect(executeRel).to.be.lessThan(120_000n);
    });
  }
});
