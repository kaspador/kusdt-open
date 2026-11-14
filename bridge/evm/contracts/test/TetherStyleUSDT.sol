// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Imitates Ethereum USDT's non-standard ERC-20: transfer, transferFrom and approve
///         return nothing, and approve refuses to change a non-zero allowance to another
///         non-zero one. Tests only.
contract TetherStyleUSDT {
    string public constant name = "Tether USD (style)";
    string public constant symbol = "USDT";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function transfer(address to, uint256 value) external {
        require(balanceOf[msg.sender] >= value, "balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
    }

    function transferFrom(address from, address to, uint256 value) external {
        uint256 a = allowance[from][msg.sender];
        require(a >= value, "allowance");
        require(balanceOf[from] >= value, "balance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }

    function approve(address spender, uint256 value) external {
        require(!(value != 0 && allowance[msg.sender][spender] != 0), "approve: reset to 0 first");
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
    }
}
