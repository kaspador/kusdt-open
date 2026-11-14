// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {EIP712} from "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title kUSDT vault (one per EVM chain: Ethereum, BNB Chain). See SPEC.md §7, §8, §11.
/// @notice USDT deposited here is minted 1:1 (less the fee) as kUSDT on Kaspa L1. kUSDT
///         burnt on Kaspa is paid out here by `release`; a deposit Kaspa skipped is
///         returned by `refund`. Both need 3 of the 5 signers and draw from a refilling
///         release allowance.
///
///  Payouts wait. `release` and `refund` only queue a payout; it can be paid, by anyone,
///  once `payoutDelay` has passed (`executeRelease`, `executeRefund`), and not while the
///  vault is paused. So stolen signer keys get nothing out if the guardian pauses within
///  the wait, however small they split the theft. A queued payout that should never be
///  paid is cancelled by the owner, before unpausing.
///
///  Every amount is in base units of 10^-6 USDT ("units"); the token moves
///  `units * scale`, scale = 10^(decimals - 6).
///
///  Accounting: the vault's balance (in units) = backing + feesAccrued. Deposit fees and
///  release fees move into feesAccrued; only the owner withdraws them, never more than
///  feesAccrued. No function moves backing except `executeRelease` and `executeRefund`,
///  and each pays only what a signer quorum queued. The owner sets parameters within hard bounds, rotates the signers,
///  sets the guardian and unpauses; the guardian can only pause.
contract KusdtVault is Ownable2Step, Pausable, ReentrancyGuard, EIP712 {
    using SafeERC20 for IERC20;

    // ── Hard bounds ──────────────────────────────────────────────────────────

    uint256 public constant SIGNER_COUNT = 5;
    /// Signatures needed by release and refund.
    uint256 public constant THRESHOLD = 3;
    /// Highest KCC-2 owner scheme a deposit may name (SPEC §4).
    uint8 public constant MAX_OWNER_SCHEME = 4;
    /// The proportional fee can never be set above 1 %.
    uint16 public constant MAX_FEE_BPS = 100;
    /// The deposit fee at a full deposit meter can never be set above 3 %.
    uint16 public constant MAX_SURGE_FEE_BPS = 300;
    /// The deposit meter empties over this long.
    uint256 public constant SURGE_PERIOD = 1 days;
    /// Neither minimum fee can be set above 50 USDT.
    uint256 public constant MAX_MIN_FEE = 50_000_000;
    /// No deposit limit or release capacity above 1 000 000 000 USDT, the Kaspa hard cap
    /// (SPEC §6); this keeps every amount far below Kaspa's 2^63.
    uint256 public constant MAX_AMOUNT = 1_000_000_000_000_000;
    /// The release allowance may refill fully no faster than once a day (SPEC §8, INV-5).
    uint256 public constant MIN_REFILL_PERIOD = 1 days;
    /// The owner can't make payouts wait less than this, so the guardian always has time.
    /// (The constructor takes any value up to the maximum, for test chains; the deploy
    /// script and the deployer refuse less than this on a mainnet.)
    uint64 public constant MIN_PAYOUT_DELAY = 5 minutes;
    /// Nor more than this, so honest payouts can't be held back for long.
    uint64 public constant MAX_PAYOUT_DELAY = 1 days;

    bytes32 public constant RELEASE_TYPEHASH =
        keccak256("Release(bytes32 redeemId,address recipient,uint256 units)");
    bytes32 public constant REFUND_TYPEHASH =
        keccak256("Refund(uint64 nonce,address recipient,uint256 units)");

    // ── Types ────────────────────────────────────────────────────────────────

    /// A Kaspa redemption to pay out: `units` were burnt to the burn owner naming `recipient`.
    struct Release {
        bytes32 redeemId;
        address recipient;
        uint256 units;
    }

    /// A deposit Kaspa skipped (`skip_nonce`), returned to `recipient`.
    struct Refund {
        uint64 nonce;
        address recipient;
        uint256 units;
    }

    /// Fee and limit parameters, all amounts in units.
    struct Params {
        uint16 feeBps;
        uint256 minDepositFee;
        uint256 minReleaseFee;
        uint256 minDeposit;
        uint256 maxDeposit;
        uint256 releaseCapacity;
        uint256 releaseRefillPerSecond;
    }

    /// A payout that is queued: `units` leave the backing when it is paid, `fee` of them
    /// to feesAccrued and the rest to `recipient`.
    struct Payout {
        address recipient;
        uint64 readyAt;
        uint256 units;
        uint256 fee;
    }

    // ── State ────────────────────────────────────────────────────────────────

    IERC20 public immutable token;
    uint8 public immutable tokenDecimals;
    /// Token amount per unit: 10^(tokenDecimals - 6).
    uint256 public immutable scale;

    /// Next deposit nonce; deposits so far are 0 … depositNonce - 1.
    uint64 public depositNonce;
    uint16 public feeBps;
    address public guardian;

    uint256 public minDepositFee;
    uint256 public minReleaseFee;
    uint256 public minDeposit;
    uint256 public maxDeposit;

    uint256 public releaseCapacity;
    uint256 public releaseRefillPerSecond;
    /// The release allowance as of `releaseUpdatedAt` (see releaseAvailable()).
    uint256 public releaseBucket;
    uint256 public releaseUpdatedAt;

    /// Fees (units) the owner may withdraw. Not part of the backing.
    uint256 public feesAccrued;

    address[5] private _signers;
    mapping(address => bool) public isSigner;

    /// redeemIds already released or queued to be (INV-3).
    mapping(bytes32 => bool) public redeemed;
    /// What each deposit minted, by nonce; cleared to 0 when its refund is queued. A refund
    /// must return exactly this, and only once (INV-2).
    mapping(uint64 => uint256) public depositMinted;

    /// How long a payout waits, in seconds, from being queued.
    uint64 public payoutDelay;
    /// Nothing is paid before this: an unpause starts a full wait again for everything queued,
    /// so a bad payout someone missed gives the guardian the same time to pause again.
    uint64 public payoutsResumeAt;
    /// Units of the backing that queued payouts will take. Part of the backing until paid.
    uint256 public reservedUnits;
    /// Queued payouts, until paid or cancelled.
    mapping(bytes32 => Payout) public pendingReleases;
    mapping(uint64 => Payout) public pendingRefunds;
    /// Payouts the owner cancelled. The signatures a payout was queued with stay valid until the signers are
    /// replaced, so without this anyone could queue a cancelled one again at once. Cleared only by the owner.
    mapping(bytes32 => bool) public releaseCancelled;
    mapping(uint64 => bool) public refundCancelled;

    /// The deposit fee rises with the day's deposits (so that using up the bridge's daily limit costs more than
    /// the plain fee): feeBps while the deposit meter is under half of surgeCapacity, rising in a straight line to
    /// surgeFeeBps at a full meter, and surgeFeeBps beyond. A deposit pays each of its units at the rate where the
    /// meter stands as that unit goes in, so splitting a deposit changes nothing. Off while surgeCapacity is 0.
    uint16 public surgeFeeBps;
    uint256 public surgeCapacity;
    /// Units deposited, less what has drained (surgeCapacity per SURGE_PERIOD), as of depositMeterAt.
    uint256 public depositMeter;
    uint256 public depositMeterAt;

    // ── Events ───────────────────────────────────────────────────────────────

    event Deposit(
        uint64 indexed nonce,
        address indexed sender,
        uint8 ownerScheme,
        bytes32 owner,
        uint256 units,
        uint256 fee,
        uint256 minted
    );
    event ReleaseQueued(bytes32 indexed redeemId, address indexed recipient, uint256 units, uint256 fee, uint256 payout, uint64 readyAt);
    event RefundQueued(uint64 indexed nonce, address indexed recipient, uint256 units, uint64 readyAt);
    /// The USDT has left the vault.
    event Released(bytes32 indexed redeemId, address indexed recipient, uint256 units, uint256 fee, uint256 payout);
    event Refunded(uint64 indexed nonce, address indexed recipient, uint256 units);
    event ReleaseCancelled(bytes32 indexed redeemId);
    event RefundCancelled(uint64 indexed nonce);
    event ReleaseReinstated(bytes32 indexed redeemId);
    event RefundReinstated(uint64 indexed nonce);
    event DepositSurgeSet(uint16 surgeFeeBps, uint256 capacity);
    event PayoutDelaySet(uint64 delay);
    event FeesSet(uint16 feeBps, uint256 minDepositFee, uint256 minReleaseFee);
    event DepositLimitsSet(uint256 minDeposit, uint256 maxDeposit);
    event ReleaseLimitsSet(uint256 capacity, uint256 refillPerSecond);
    event SignersSet(address[5] signers);
    event GuardianSet(address indexed guardian);
    event FeesWithdrawn(address indexed to, uint256 units);

    // ── Errors ───────────────────────────────────────────────────────────────

    error ZeroAddress();
    error BadDecimals(uint8 decimals);
    error BadSigner(address signer);
    error BadOwnerScheme(uint8 ownerScheme);
    error ZeroOwner();
    error DepositOutOfRange(uint256 units);
    error NothingToMint();
    error WrongAmountReceived(uint256 expected, uint256 received);
    error NotEnoughSignatures();
    error SignaturesNotSorted();
    error NotASigner(address recovered);
    error AlreadyRedeemed(bytes32 redeemId);
    error UnknownDeposit(uint64 nonce);
    error AlreadyRefunded(uint64 nonce);
    error WrongRefundAmount(uint256 expected, uint256 signed);
    error AmountNotAboveFee();
    error BadRecipient();
    error InsufficientBacking();
    error ReleaseLimit(uint256 requested, uint256 available);
    error FeeTooHigh();
    error BadLimits();
    error FeesExceeded();
    error NotGuardianOrOwner();
    error RenounceDisabled();
    error BadPayoutDelay();
    error NothingQueued();
    error PayoutCancelled();
    error NotCancelled();
    error MintedBelowMinimum(uint256 minted, uint256 minMinted);
    error PayoutNotReady(uint64 readyAt);

    /// @param token_    the USDT contract.
    /// @param decimals_ its decimals, 6 to 18; checked against token_.decimals() when it has one.
    /// @param signers_  the 5 signers' EVM addresses: distinct, none zero.
    /// @param guardian_ may pause, nothing else.
    /// @param owner_    sets parameters, signers and guardian; unpauses; withdraws fees.
    /// @param payoutDelay_ how long a payout waits, in seconds; at most MAX_PAYOUT_DELAY.
    /// @param surgeFeeBps_ the deposit fee at a full deposit meter, and
    /// @param surgeCapacity_ the meter's size in units a day (see surgeFeeBps); 0 and 0 for a flat fee.
    constructor(
        IERC20 token_,
        uint8 decimals_,
        address[5] memory signers_,
        address guardian_,
        address owner_,
        Params memory initial,
        uint64 payoutDelay_,
        uint16 surgeFeeBps_,
        uint256 surgeCapacity_
    ) Ownable(owner_) EIP712("kUSDT Vault", "1") {
        if (address(token_) == address(0) || address(token_).code.length == 0) revert ZeroAddress();
        if (decimals_ < 6 || decimals_ > 18) revert BadDecimals(decimals_);
        try IERC20Metadata(address(token_)).decimals() returns (uint8 d) {
            if (d != decimals_) revert BadDecimals(decimals_);
        } catch {}
        token = token_;
        tokenDecimals = decimals_;
        scale = 10 ** (decimals_ - 6);

        _setSigners(signers_);
        _setGuardian(guardian_);
        _setFees(initial.feeBps, initial.minDepositFee, initial.minReleaseFee);
        _setDepositLimits(initial.minDeposit, initial.maxDeposit);
        _setReleaseLimits(initial.releaseCapacity, initial.releaseRefillPerSecond);
        if (payoutDelay_ > MAX_PAYOUT_DELAY) revert BadPayoutDelay();
        payoutDelay = payoutDelay_;
        emit PayoutDelaySet(payoutDelay_);
        _setDepositSurge(surgeFeeBps_, surgeCapacity_);
        // A new vault holds nothing, so it may start with its full allowance.
        releaseBucket = initial.releaseCapacity;
        releaseUpdatedAt = block.timestamp;
    }

    // ── Deposits (EVM → Kaspa) ───────────────────────────────────────────────

    /// @notice Locks `units` of USDT for kUSDT on Kaspa, minted to the KCC-2 owner
    ///         (`ownerScheme`, `owner`). The caller must have approved units * scale.
    ///         `units - fee` is minted; the fee stays here as feesAccrued.
    function deposit(uint256 units, uint8 ownerScheme, bytes32 owner)
        external
        whenNotPaused
        nonReentrant
        returns (uint64 nonce)
    {
        return _deposit(units, ownerScheme, owner, 0);
    }

    /// @notice As `deposit`, and reverts unless at least `minMinted` units are minted. The fee depends on what
    ///         was deposited before in the same day (see surgeFeeBps): a deposit that lands just ahead of this
    ///         one can raise it, and this bounds what the depositor accepts.
    function depositAtLeast(uint256 units, uint8 ownerScheme, bytes32 owner, uint256 minMinted)
        external
        whenNotPaused
        nonReentrant
        returns (uint64 nonce)
    {
        return _deposit(units, ownerScheme, owner, minMinted);
    }

    function _deposit(uint256 units, uint8 ownerScheme, bytes32 owner, uint256 minMinted) internal returns (uint64 nonce) {
        if (ownerScheme > MAX_OWNER_SCHEME) revert BadOwnerScheme(ownerScheme);
        if (owner == bytes32(0)) revert ZeroOwner();
        if (units < minDeposit || units > maxDeposit) revert DepositOutOfRange(units);
        uint256 fee = _meterDeposit(units);
        if (units <= fee) revert NothingToMint();
        uint256 minted = units - fee;
        if (minted < minMinted) revert MintedBelowMinimum(minted, minMinted);

        uint256 amount = units * scale;
        uint256 before = token.balanceOf(address(this));
        token.safeTransferFrom(msg.sender, address(this), amount);
        uint256 received = token.balanceOf(address(this)) - before;
        if (received != amount) revert WrongAmountReceived(amount, received);

        nonce = depositNonce++;
        feesAccrued += fee;
        depositMinted[nonce] = minted;
        emit Deposit(nonce, msg.sender, ownerScheme, owner, units, fee, minted);
    }

    // ── Releases and refunds (Kaspa → EVM) ───────────────────────────────────

    /// @notice Queues the payout of a Kaspa redemption: `r.units - fee` to `r.recipient`, given
    ///         at least 3 signatures of distinct current signers over the EIP-712 Release, in
    ///         increasing signer address order. Each redeemId is paid once. It draws `r.units`
    ///         from the allowance now (the fee too: it leaves the backing as well), and can be
    ///         paid by `executeRelease` once `payoutDelay` has passed.
    function release(Release calldata r, bytes[] calldata signatures) external whenNotPaused nonReentrant {
        if (redeemed[r.redeemId]) revert AlreadyRedeemed(r.redeemId);
        if (releaseCancelled[r.redeemId]) revert PayoutCancelled();
        _checkRecipient(r.recipient);
        uint256 fee = releaseFeeOf(r.units);
        if (r.units <= fee) revert AmountNotAboveFee();
        _verify(releaseDigest(r), signatures);
        // The burnt units will leave the backing: the payout to the recipient, the fee to feesAccrued.
        if (r.units > unreservedBacking()) revert InsufficientBacking();
        // The allowance limits what leaves the backing, so it counts the gross units, the fee included.
        _spendAllowance(r.units);

        redeemed[r.redeemId] = true;
        uint64 readyAt = _reserve(r.units);
        pendingReleases[r.redeemId] = Payout(r.recipient, readyAt, r.units, fee);
        emit ReleaseQueued(r.redeemId, r.recipient, r.units, fee, r.units - fee, readyAt);
    }

    /// @notice Pays a queued release whose wait is over. Anyone may call it.
    function executeRelease(bytes32 redeemId) external whenNotPaused nonReentrant {
        Payout memory p = pendingReleases[redeemId];
        _checkDue(p);
        delete pendingReleases[redeemId];
        reservedUnits -= p.units;
        feesAccrued += p.fee;
        uint256 payout = p.units - p.fee;
        token.safeTransfer(p.recipient, payout * scale);
        emit Released(redeemId, p.recipient, p.units, p.fee, payout);
    }

    /// @notice Queues the return of a deposit that Kaspa skipped: exactly what it would have
    ///         minted, once, given at least 3 signatures over the EIP-712 Refund. The deposit
    ///         fee is kept; no release fee is charged. It draws from the release allowance now,
    ///         and can be paid by `executeRefund` once `payoutDelay` has passed.
    function refund(Refund calldata r, bytes[] calldata signatures) external whenNotPaused nonReentrant {
        if (r.nonce >= depositNonce) revert UnknownDeposit(r.nonce);
        uint256 minted = depositMinted[r.nonce];
        if (minted == 0) revert AlreadyRefunded(r.nonce);
        if (refundCancelled[r.nonce]) revert PayoutCancelled();
        if (r.units != minted) revert WrongRefundAmount(minted, r.units);
        _checkRecipient(r.recipient);
        _verify(refundDigest(r), signatures);
        if (r.units > unreservedBacking()) revert InsufficientBacking();
        _spendAllowance(r.units);

        depositMinted[r.nonce] = 0;
        uint64 readyAt = _reserve(r.units);
        pendingRefunds[r.nonce] = Payout(r.recipient, readyAt, r.units, 0);
        emit RefundQueued(r.nonce, r.recipient, r.units, readyAt);
    }

    /// @notice Pays a queued refund whose wait is over. Anyone may call it.
    function executeRefund(uint64 nonce) external whenNotPaused nonReentrant {
        Payout memory p = pendingRefunds[nonce];
        _checkDue(p);
        delete pendingRefunds[nonce];
        reservedUnits -= p.units;
        token.safeTransfer(p.recipient, p.units * scale);
        emit Refunded(nonce, p.recipient, p.units);
    }

    // ── Views ────────────────────────────────────────────────────────────────

    /// USDT (units) that backs kUSDT: the balance less feesAccrued (0 if the token itself
    /// ever took funds from the vault, which the monitor would flag under INV-1).
    function backing() public view returns (uint256) {
        uint256 bal = token.balanceOf(address(this)) / scale;
        uint256 fees = feesAccrued;
        return bal > fees ? bal - fees : 0;
    }

    /// The backing that no queued payout has a claim on: what `release` and `refund` may queue against.
    function unreservedBacking() public view returns (uint256) {
        uint256 b = backing();
        uint256 r = reservedUnits;
        return b > r ? b - r : 0;
    }

    /// Units release and refund may queue right now.
    function releaseAvailable() public view returns (uint256) {
        uint256 avail = releaseBucket + (block.timestamp - releaseUpdatedAt) * releaseRefillPerSecond;
        uint256 cap = releaseCapacity;
        return avail > cap ? cap : avail;
    }

    /// The fee a deposit of `units` would pay if it were made in this block, after what is in it so far.
    function depositFeeOf(uint256 units) public view returns (uint256) {
        return _depositFee(units, depositMeterNow());
    }

    /// The deposit meter now: what was deposited, less what has drained since.
    function depositMeterNow() public view returns (uint256) {
        uint256 cap = surgeCapacity;
        if (cap == 0) return 0;
        uint256 drained = ((block.timestamp - depositMeterAt) * cap) / SURGE_PERIOD;
        uint256 meter = depositMeter;
        return meter > drained ? meter - drained : 0;
    }

    function releaseFeeOf(uint256 units) public view returns (uint256) {
        return _fee(units, minReleaseFee);
    }

    /// The 5 current signers, in the order they were set.
    function signers() external view returns (address[5] memory) {
        return _signers;
    }

    /// Whether deposit `nonce` exists and has been refunded, or its refund is queued.
    function isRefunded(uint64 nonce) external view returns (bool) {
        return nonce < depositNonce && depositMinted[nonce] == 0;
    }

    function params() external view returns (Params memory) {
        return Params(
            feeBps, minDepositFee, minReleaseFee, minDeposit, maxDeposit, releaseCapacity, releaseRefillPerSecond
        );
    }

    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// The EIP-712 digest the signers sign for `r`.
    function releaseDigest(Release calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(RELEASE_TYPEHASH, r.redeemId, r.recipient, r.units)));
    }

    /// The EIP-712 digest the signers sign for `r`.
    function refundDigest(Refund calldata r) public view returns (bytes32) {
        return _hashTypedDataV4(keccak256(abi.encode(REFUND_TYPEHASH, r.nonce, r.recipient, r.units)));
    }

    /// redeemId of the burn output `outputIndex` of Kaspa transaction `kaspaTxId` (SPEC §7).
    function redeemIdOf(bytes32 kaspaTxId, uint32 outputIndex) external pure returns (bytes32) {
        return keccak256(abi.encodePacked("kusdt/redeem/v1", kaspaTxId, outputIndex));
    }

    // ── Admin (owner: an AccessManager under a Safe on mainnet) ──────────────

    function setFees(uint16 feeBps_, uint256 minDepositFee_, uint256 minReleaseFee_) external onlyOwner {
        _setFees(feeBps_, minDepositFee_, minReleaseFee_);
    }

    function setDepositLimits(uint256 minDeposit_, uint256 maxDeposit_) external onlyOwner {
        _setDepositLimits(minDeposit_, maxDeposit_);
    }

    /// The allowance earned so far under the old limits is kept, capped at the new capacity:
    /// raising the capacity never makes more available at once.
    function setReleaseLimits(uint256 capacity, uint256 refillPerSecond) external onlyOwner {
        uint256 avail = releaseAvailable();
        _setReleaseLimits(capacity, refillPerSecond);
        releaseBucket = avail > capacity ? capacity : avail;
        releaseUpdatedAt = block.timestamp;
    }

    /// Payouts queued from now on wait this long; those already queued keep their time.
    function setPayoutDelay(uint64 delay) external onlyOwner {
        if (delay < MIN_PAYOUT_DELAY || delay > MAX_PAYOUT_DELAY) revert BadPayoutDelay();
        payoutDelay = delay;
        emit PayoutDelaySet(delay);
    }

    /// @notice Cancels a queued release: nothing is paid, its allowance comes back, and the
    ///         redeemId stays cancelled: `release` refuses it, whatever signatures it is given,
    ///         until the owner reinstates it. For a payout that should never happen, or one that
    ///         must wait (a recipient the token has blocked). Cancel before unpausing.
    function cancelRelease(bytes32 redeemId) external onlyOwner {
        Payout memory p = pendingReleases[redeemId];
        if (p.recipient == address(0)) revert NothingQueued();
        delete pendingReleases[redeemId];
        reservedUnits -= p.units;
        redeemed[redeemId] = false;
        releaseCancelled[redeemId] = true;
        _returnAllowance(p.units);
        emit ReleaseCancelled(redeemId);
    }

    /// @notice Cancels a queued refund: nothing is paid, its allowance comes back, and the
    ///         deposit counts as not refunded, and stays cancelled until the owner reinstates
    ///         it. See `cancelRelease`.
    function cancelRefund(uint64 nonce) external onlyOwner {
        Payout memory p = pendingRefunds[nonce];
        if (p.recipient == address(0)) revert NothingQueued();
        delete pendingRefunds[nonce];
        reservedUnits -= p.units;
        depositMinted[nonce] = p.units;
        refundCancelled[nonce] = true;
        _returnAllowance(p.units);
        emit RefundCancelled(nonce);
    }

    /// @notice Lets a cancelled release be queued again (with signatures of the current signers, as any release).
    function reinstateRelease(bytes32 redeemId) external onlyOwner {
        if (!releaseCancelled[redeemId]) revert NotCancelled();
        releaseCancelled[redeemId] = false;
        emit ReleaseReinstated(redeemId);
    }

    /// @notice Lets a cancelled refund be queued again.
    function reinstateRefund(uint64 nonce) external onlyOwner {
        if (!refundCancelled[nonce]) revert NotCancelled();
        refundCancelled[nonce] = false;
        emit RefundReinstated(nonce);
    }

    /// @notice Sets the rising deposit fee: `surgeFeeBps_` at a full meter of `capacity` units a day (0: off).
    ///         Never above MAX_SURGE_FEE_BPS. The meter keeps what it holds, up to the new capacity.
    function setDepositSurge(uint16 surgeFeeBps_, uint256 capacity) external onlyOwner {
        _setDepositSurge(surgeFeeBps_, capacity);
    }

    function _setDepositSurge(uint16 surgeFeeBps_, uint256 capacity) internal {
        if (surgeFeeBps_ > MAX_SURGE_FEE_BPS) revert FeeTooHigh();
        if (capacity == 1 || capacity > MAX_AMOUNT) revert BadLimits();
        uint256 meter = depositMeterNow();
        surgeFeeBps = surgeFeeBps_;
        surgeCapacity = capacity;
        depositMeter = meter > capacity ? capacity : meter;
        depositMeterAt = block.timestamp;
        emit DepositSurgeSet(surgeFeeBps_, capacity);
    }

    /// Replaces all 5 signers. Signatures by the old ones stop counting at once.
    function setSigners(address[5] calldata signers_) external onlyOwner {
        for (uint256 i = 0; i < SIGNER_COUNT; i++) isSigner[_signers[i]] = false;
        _setSigners(signers_);
    }

    function setGuardian(address guardian_) external onlyOwner {
        _setGuardian(guardian_);
    }

    /// @notice Sends `units` of the accrued fees to `to`. Never more than feesAccrued: the
    ///         backing can't be withdrawn.
    function withdrawFees(address to, uint256 units) external onlyOwner nonReentrant {
        if (to == address(0)) revert ZeroAddress();
        // Not to the token (lost for good) nor to the vault itself (it would turn into backing nobody is owed).
        _checkRecipient(to);
        if (units > feesAccrued) revert FeesExceeded();
        feesAccrued -= units;
        token.safeTransfer(to, units * scale);
        emit FeesWithdrawn(to, units);
    }

    /// @notice Stops deposits, releases, refunds and the paying of queued payouts (the guardian or the owner).
    function pause() external {
        if (msg.sender != guardian && msg.sender != owner()) revert NotGuardianOrOwner();
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
        payoutsResumeAt = uint64(block.timestamp) + payoutDelay;
    }

    /// Disabled: without an owner the vault could never be unpaused again.
    function renounceOwnership() public view override onlyOwner {
        revert RenounceDisabled();
    }

    // ── Internals ────────────────────────────────────────────────────────────

    function _fee(uint256 units, uint256 minFee) internal view returns (uint256) {
        uint256 prop = (units * feeBps + 9_999) / 10_000;
        return prop > minFee ? prop : minFee;
    }

    /// The fee of a deposit now, and the meter moved by it.
    function _meterDeposit(uint256 units) internal returns (uint256 fee) {
        uint256 used = depositMeterNow();
        fee = _depositFee(units, used);
        uint256 cap = surgeCapacity;
        if (cap != 0) {
            // Kept at the capacity at most: a flood of deposits pays the top rate, and does not hold the rate up
            // for longer than the meter takes to drain from full.
            uint256 filled = used + units;
            depositMeter = filled > cap ? cap : filled;
            depositMeterAt = block.timestamp;
        }
    }

    /// The fee of a deposit of `units` made with the meter at `used`: each unit at the rate of the meter's
    /// level as it goes in (feeBps below half the capacity, a straight line up to surgeFeeBps at the capacity,
    /// surgeFeeBps above), rounded up, and at least minDepositFee. With the surge off, or a surge rate that is
    /// not above feeBps, exactly `_fee`.
    function _depositFee(uint256 units, uint256 used) internal view returns (uint256) {
        uint256 base = feeBps;
        uint256 top = surgeFeeBps;
        uint256 cap = surgeCapacity;
        // The sum over the deposit's units of each one's rate, in units × basis points.
        uint256 weighted;
        if (cap == 0 || top <= base) {
            weighted = units * base;
        } else {
            uint256 half = cap / 2;
            uint256 span = cap - half;
            uint256 end = used + units;
            // The part of [used, end] on the line between half and cap.
            uint256 lo = used < half ? half : (used > cap ? cap : used);
            uint256 hi = end < half ? half : (end > cap ? cap : end);
            // Everything pays the plain rate; the line and what lies beyond it add to that.
            weighted = units * base;
            if (hi > lo) {
                // The line's extra rate at level x is (top - base) × (x - half) / span; summed from lo to hi.
                weighted += ((top - base) * ((hi - half) * (hi - half) - (lo - half) * (lo - half))) / (2 * span);
            }
            if (end > cap) weighted += (end - (used > cap ? used : cap)) * (top - base);
        }
        uint256 prop = (weighted + 9_999) / 10_000;
        uint256 minFee = minDepositFee;
        return prop > minFee ? prop : minFee;
    }

    function _checkRecipient(address recipient) internal view {
        // The token's own address too: it would take the payout, and nothing could ever move it from there.
        if (recipient == address(0) || recipient == address(this) || recipient == address(token)) revert BadRecipient();
    }

    /// At least THRESHOLD signatures, by current signers, recovered addresses strictly
    /// increasing (which proves they are distinct).
    function _verify(bytes32 digest, bytes[] calldata signatures) internal view {
        if (signatures.length < THRESHOLD) revert NotEnoughSignatures();
        address last = address(0);
        for (uint256 i = 0; i < signatures.length; i++) {
            address s = ECDSA.recover(digest, signatures[i]);
            if (s <= last) revert SignaturesNotSorted();
            if (!isSigner[s]) revert NotASigner(s);
            last = s;
        }
    }

    /// Draws `units` (gross: a release's fee leaves the backing too) from the release allowance for a payout
    /// about to be queued. The allowance limits what is queued, and the queue itself is capped at one allowance:
    /// everything waiting can be paid in one block once its wait is over, so payouts left in the queue must not
    /// add up to more than one day's allowance.
    function _spendAllowance(uint256 units) internal {
        uint256 cap = releaseCapacity;
        uint256 queued = reservedUnits;
        if (queued + units > cap) revert ReleaseLimit(units, cap > queued ? cap - queued : 0);
        uint256 avail = releaseAvailable();
        if (units > avail) revert ReleaseLimit(units, avail);
        releaseBucket = avail - units;
        releaseUpdatedAt = block.timestamp;
    }

    function _returnAllowance(uint256 units) internal {
        uint256 back = releaseAvailable() + units;
        uint256 cap = releaseCapacity;
        releaseBucket = back > cap ? cap : back;
        releaseUpdatedAt = block.timestamp;
    }

    /// Sets `units` aside for a payout; answers when it can be paid.
    function _reserve(uint256 units) internal returns (uint64 readyAt) {
        reservedUnits += units;
        readyAt = uint64(block.timestamp) + payoutDelay;
    }

    /// A queued payout whose wait is over, and the backing to pay it (the token itself could have taken funds).
    function _checkDue(Payout memory p) internal view {
        if (p.recipient == address(0)) revert NothingQueued();
        if (block.timestamp < p.readyAt) revert PayoutNotReady(p.readyAt);
        if (block.timestamp < payoutsResumeAt) revert PayoutNotReady(payoutsResumeAt);
        if (p.units > backing()) revert InsufficientBacking();
    }

    function _setSigners(address[5] memory signers_) internal {
        for (uint256 i = 0; i < SIGNER_COUNT; i++) {
            address s = signers_[i];
            if (s == address(0) || isSigner[s]) revert BadSigner(s);
            isSigner[s] = true;
            _signers[i] = s;
        }
        emit SignersSet(signers_);
    }

    function _setGuardian(address guardian_) internal {
        if (guardian_ == address(0)) revert ZeroAddress();
        guardian = guardian_;
        emit GuardianSet(guardian_);
    }

    function _setFees(uint16 feeBps_, uint256 minDepositFee_, uint256 minReleaseFee_) internal {
        if (feeBps_ > MAX_FEE_BPS || minDepositFee_ > MAX_MIN_FEE || minReleaseFee_ > MAX_MIN_FEE) {
            revert FeeTooHigh();
        }
        feeBps = feeBps_;
        minDepositFee = minDepositFee_;
        minReleaseFee = minReleaseFee_;
        emit FeesSet(feeBps_, minDepositFee_, minReleaseFee_);
    }

    function _setDepositLimits(uint256 minDeposit_, uint256 maxDeposit_) internal {
        if (minDeposit_ == 0 || minDeposit_ > maxDeposit_ || maxDeposit_ > MAX_AMOUNT) revert BadLimits();
        minDeposit = minDeposit_;
        maxDeposit = maxDeposit_;
        emit DepositLimitsSet(minDeposit_, maxDeposit_);
    }

    function _setReleaseLimits(uint256 capacity, uint256 refillPerSecond) internal {
        if (capacity > MAX_AMOUNT || refillPerSecond > capacity / MIN_REFILL_PERIOD) revert BadLimits();
        releaseCapacity = capacity;
        releaseRefillPerSecond = refillPerSecond;
        emit ReleaseLimitsSet(capacity, refillPerSecond);
    }
}
