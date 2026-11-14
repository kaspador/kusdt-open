// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @notice Test USDT for testnets and tests: any decimals, and anyone may mint (a faucet).
///         Like Ethereum USDT it keeps a blacklist that only its deployer edits, with
///         USDT's semantics: a blacklisted address can't send, but can still receive.
///         Never deploy it on a mainnet.
contract MockUSDT is ERC20 {
    uint8 private immutable _decimals;
    address public immutable owner;
    mapping(address => bool) public isBlackListed;

    event AddedBlackList(address indexed user);
    event RemovedBlackList(address indexed user);

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
        owner = msg.sender;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// Permissionless faucet.
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function addBlackList(address user) external {
        require(msg.sender == owner, "owner only");
        isBlackListed[user] = true;
        emit AddedBlackList(user);
    }

    function removeBlackList(address user) external {
        require(msg.sender == owner, "owner only");
        isBlackListed[user] = false;
        emit RemovedBlackList(user);
    }

    /// As on Ethereum USDT, only the sender is checked (`transfer`'s caller,
    /// `transferFrom`'s `from`); a blacklisted recipient still receives.
    function _update(address from, address to, uint256 value) internal override {
        require(from == address(0) || !isBlackListed[from], "blacklisted");
        super._update(from, to, value);
    }
}
