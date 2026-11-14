// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @notice Audit-3 test double: a line-by-line Solidity 0.8 port of the real Ethereum USDT
///         (TetherToken, 0xdAC17F958D2ee523a2206206994597C13D831ec7, verified source, compiler 0.4.18):
///         same order of checks, the same absent return values, the fee switch, the blacklist,
///         pause and deprecate. Tests only. Each function names the original it ports.
contract Audit3TetherToken {
    uint256 public constant MAX_UINT = type(uint256).max;

    address public owner;
    bool public paused;
    uint256 public _totalSupply;
    mapping(address => uint256) public balances;
    uint256 public basisPointsRate;
    uint256 public maximumFee;
    mapping(address => mapping(address => uint256)) public allowed;
    mapping(address => bool) public isBlackListed;
    string public name = "Tether USD";
    string public symbol = "USDT";
    uint256 public decimals = 6;
    address public upgradedAddress;
    bool public deprecated;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event AddedBlackList(address user);
    event RemovedBlackList(address user);
    event DestroyedBlackFunds(address blackListedUser, uint256 balance);
    event Deprecate(address newAddress);
    event Params(uint256 feeBasisPoints, uint256 maxFee);
    event Issue(uint256 amount);
    event Pause();
    event Unpause();

    modifier onlyOwner() {
        require(msg.sender == owner);
        _;
    }

    modifier whenNotPaused() {
        require(!paused);
        _;
    }

    // BasicToken.onlyPayloadSize: the "short address attack" check.
    modifier onlyPayloadSize(uint256 size) {
        require(!(msg.data.length < size + 4));
        _;
    }

    constructor(uint256 initialSupply) {
        owner = msg.sender;
        _totalSupply = initialSupply;
        balances[owner] = initialSupply;
    }

    // TetherToken.transfer: the blacklist is checked on the sender only.
    function transfer(address _to, uint256 _value) public whenNotPaused {
        require(!isBlackListed[msg.sender]);
        if (deprecated) {
            Audit3UpgradedTether(upgradedAddress).transferByLegacy(msg.sender, _to, _value);
            return;
        }
        _basicTransfer(_to, _value);
    }

    // BasicToken.transfer
    function _basicTransfer(address _to, uint256 _value) internal onlyPayloadSize(2 * 32) {
        uint256 fee = (_value * basisPointsRate) / 10000;
        if (fee > maximumFee) fee = maximumFee;
        uint256 sendAmount = _value - fee;
        balances[msg.sender] = balances[msg.sender] - _value;
        balances[_to] = balances[_to] + sendAmount;
        if (fee > 0) {
            balances[owner] = balances[owner] + fee;
            emit Transfer(msg.sender, owner, fee);
        }
        emit Transfer(msg.sender, _to, sendAmount);
    }

    // TetherToken.transferFrom: the blacklist is checked on `_from` only (msg.sender is not).
    function transferFrom(address _from, address _to, uint256 _value) public whenNotPaused {
        require(!isBlackListed[_from]);
        if (deprecated) {
            Audit3UpgradedTether(upgradedAddress).transferFromByLegacy(msg.sender, _from, _to, _value);
            return;
        }
        _standardTransferFrom(_from, _to, _value);
    }

    // StandardToken.transferFrom
    function _standardTransferFrom(address _from, address _to, uint256 _value) internal onlyPayloadSize(3 * 32) {
        uint256 _allowance = allowed[_from][msg.sender];
        uint256 fee = (_value * basisPointsRate) / 10000;
        if (fee > maximumFee) fee = maximumFee;
        if (_allowance < MAX_UINT) {
            allowed[_from][msg.sender] = _allowance - _value;
        }
        uint256 sendAmount = _value - fee;
        balances[_from] = balances[_from] - _value;
        balances[_to] = balances[_to] + sendAmount;
        if (fee > 0) {
            balances[owner] = balances[owner] + fee;
            emit Transfer(_from, owner, fee);
        }
        emit Transfer(_from, _to, sendAmount);
    }

    // TetherToken.balanceOf
    function balanceOf(address who) public view returns (uint256) {
        if (deprecated) return Audit3UpgradedTether(upgradedAddress).balanceOf(who);
        return balances[who];
    }

    // TetherToken.approve -> StandardToken.approve: changing a non-zero allowance to another non-zero one reverts.
    function approve(address _spender, uint256 _value) public onlyPayloadSize(2 * 32) {
        if (deprecated) {
            Audit3UpgradedTether(upgradedAddress).approveByLegacy(msg.sender, _spender, _value);
            return;
        }
        require(!((_value != 0) && (allowed[msg.sender][_spender] != 0)));
        allowed[msg.sender][_spender] = _value;
        emit Approval(msg.sender, _spender, _value);
    }

    // TetherToken.allowance
    function allowance(address _owner, address _spender) public view returns (uint256 remaining) {
        if (deprecated) return Audit3UpgradedTether(upgradedAddress).allowance(_owner, _spender);
        return allowed[_owner][_spender];
    }

    // TetherToken.totalSupply
    function totalSupply() public view returns (uint256) {
        if (deprecated) return Audit3UpgradedTether(upgradedAddress).totalSupply();
        return _totalSupply;
    }

    // Pausable
    function pause() public onlyOwner whenNotPaused {
        paused = true;
        emit Pause();
    }

    function unpause() public onlyOwner {
        require(paused);
        paused = false;
        emit Unpause();
    }

    // BlackList.addBlackList / removeBlackList / destroyBlackFunds
    function addBlackList(address _evilUser) public onlyOwner {
        isBlackListed[_evilUser] = true;
        emit AddedBlackList(_evilUser);
    }

    function removeBlackList(address _clearedUser) public onlyOwner {
        isBlackListed[_clearedUser] = false;
        emit RemovedBlackList(_clearedUser);
    }

    function destroyBlackFunds(address _blackListedUser) public onlyOwner {
        require(isBlackListed[_blackListedUser]);
        uint256 dirtyFunds = balanceOf(_blackListedUser);
        balances[_blackListedUser] = 0;
        _totalSupply -= dirtyFunds;
        emit DestroyedBlackFunds(_blackListedUser, dirtyFunds);
    }

    // TetherToken.deprecate
    function deprecate(address _upgradedAddress) public onlyOwner {
        deprecated = true;
        upgradedAddress = _upgradedAddress;
        emit Deprecate(_upgradedAddress);
    }

    // TetherToken.issue
    function issue(uint256 amount) public onlyOwner {
        balances[owner] += amount;
        _totalSupply += amount;
        emit Issue(amount);
    }

    // TetherToken.setParams: at most 19 bp and 49 tokens.
    function setParams(uint256 newBasisPoints, uint256 newMaxFee) public onlyOwner {
        require(newBasisPoints < 20);
        require(newMaxFee < 50);
        basisPointsRate = newBasisPoints;
        maximumFee = newMaxFee * (10 ** decimals);
        emit Params(basisPointsRate, maximumFee);
    }
}

/// @notice The minimum of an "UpgradedStandardToken": the legacy contract forwards here once deprecated. Tests only.
contract Audit3UpgradedTether {
    address public immutable legacy;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    uint256 public totalSupply;

    constructor(address legacy_) {
        legacy = legacy_;
    }

    function credit(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
    }

    function transferByLegacy(address from, address to, uint256 value) external {
        require(msg.sender == legacy);
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function transferFromByLegacy(address spender, address from, address to, uint256 value) external {
        require(msg.sender == legacy);
        require(allowance[from][spender] >= value);
        allowance[from][spender] -= value;
        balanceOf[from] -= value;
        balanceOf[to] += value;
    }

    function approveByLegacy(address from, address spender, uint256 value) external {
        require(msg.sender == legacy);
        allowance[from][spender] = value;
    }
}
