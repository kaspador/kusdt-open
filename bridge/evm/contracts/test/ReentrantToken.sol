// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice A 6-decimal token with a transfer hook that calls back into a target (the
///         vault) once, with calldata set by the test. Tests only: proves nonReentrant.
contract ReentrantToken is ERC20 {
    address public hookTarget;
    bytes public hookData;
    bool public lastCallOk;
    bytes public lastReturn;
    bool private _inHook;

    constructor() ERC20("Reentrant", "RE") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function arm(address target_, bytes calldata data_) external {
        hookTarget = target_;
        hookData = data_;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (hookTarget != address(0) && !_inHook && from != address(0)) {
            _inHook = true;
            (lastCallOk, lastReturn) = hookTarget.call(hookData);
            _inHook = false;
        }
    }
}
