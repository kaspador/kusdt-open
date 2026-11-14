// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {AccessManager} from "@openzeppelin/contracts/access/manager/AccessManager.sol";

/**
 * Each vault's owner on mainnet: OpenZeppelin's AccessManager (5.1.0) with one function closed and one added.
 *
 * `renounceRole` takes no delay in OpenZeppelin's manager. The Safe could pause a vault and give up
 * EMERGENCY and ADMIN in one transaction, and then nobody could ever unpause it. So a role here ends
 * only through `revokeRole`, an ADMIN call that waits the Safe's 48 hours and that the monitors see.
 * The deployer gives up its first-admin role the same way, as the last call of the setup.
 *
 * `revokeCanceller` removes a canceller. It does what `revokeRole(CANCELLER_ROLE, account)` does, and exists
 * because the two must differ in who may cancel them while they wait. The setup maps `revokeRole` to GUARDED,
 * whose guardian is the cancellers' role: a canceller can then cancel the Safe's removal of its own roles, so
 * stolen Safe keys can't pause a vault and leave it with nobody to unpause it 48 hours later. A canceller that
 * could cancel its own removal could never be removed, so that one revocation has a function of its own, which
 * the setup maps to nothing: only an ADMIN can cancel it.
 */
contract KusdtAccessManager is AccessManager {
    /// @dev The cancellers' role. The setup (scripts/access-manager.ts) gives it this ID, and `mainnet:verify` checks it.
    uint64 public constant CANCELLER_ROLE = 4;

    /// @dev `renounceRole` is closed: a role ends through `revokeRole`.
    error RenounceDisabled();

    constructor(address initialAdmin) AccessManager(initialAdmin) {}

    function renounceRole(uint64, address) public pure override {
        revert RenounceDisabled();
    }

    /**
     * @dev Removes `account` from the cancellers. Left unmapped, it is an ADMIN call like any other of the
     * manager's: the caller's ADMIN execution delay applies (the Safe's 48 hours), and while it waits only the
     * caller or an ADMIN can cancel it. It can remove no other role.
     */
    function revokeCanceller(address account) public virtual onlyAuthorized {
        _revokeRole(CANCELLER_ROLE, account);
    }
}
