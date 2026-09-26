// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AgriVault — collateral and the liquidity pool behind AgriPerp
/// @notice Holds every USDC the perps touch, in four buckets that always add
///         up to (at most) the vault's token balance:
///
///         - `freeCollateral[user]`   deposited, not committed — withdrawable any time
///         - `lockedCollateral[user]` backing open positions and pending orders — not withdrawable
///         - `poolBalance`            the liquidity pool: pays trader profits, takes trader losses
///         - `protocolFees`           opening and closing fees, collected by the owner
///
///         Every order reserves pool liquidity for its position's best case
///         (its capped profit) before it can fill, so a close can always be
///         paid in full: the pool never promises more than it holds.
contract AgriVault is Ownable, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdc;
    /// The one contract that may move collateral between buckets. Set once.
    address public perp;

    mapping(address => uint256) public freeCollateral;
    mapping(address => uint256) public lockedCollateral;
    uint256 public poolBalance;
    /// Pool liquidity promised to open positions' and pending orders' maximum payouts.
    uint256 public reservedLiquidity;
    uint256 public protocolFees;

    event PerpSet(address perp);
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event Locked(address indexed user, uint256 amount, uint256 reserve);
    event Unlocked(address indexed user, uint256 amount, uint256 reserve);
    event FeeTaken(address indexed user, uint256 fee);
    event Settled(address indexed user, uint256 collateral, uint256 payout, address liquidator, uint256 reward, uint256 fee);
    event LiquidityAdded(address indexed provider, uint256 amount);
    event LiquidityRemoved(address indexed to, uint256 amount);
    event FeesCollected(address indexed to, uint256 amount);

    error NotPerp();
    error PerpAlreadySet();
    error ZeroAmount();
    error InsufficientFreeCollateral(uint256 available, uint256 required);
    error InsufficientPoolLiquidity(uint256 available, uint256 required);

    constructor(address usdc_, address owner_) Ownable(owner_) {
        usdc = IERC20(usdc_);
    }

    modifier onlyPerp() {
        if (msg.sender != perp) revert NotPerp();
        _;
    }

    /// @notice Point the vault at its AgriPerp. Only once: afterwards nobody,
    ///         the owner included, can redirect who moves user collateral.
    function setPerp(address perp_) external onlyOwner {
        if (perp != address(0)) revert PerpAlreadySet();
        if (perp_ == address(0)) revert ZeroAmount();
        perp = perp_;
        emit PerpSet(perp_);
    }

    /* ------------------------------------------------------------------ */
    /* Traders                                                             */
    /* ------------------------------------------------------------------ */

    function deposit(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        freeCollateral[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }

    /// @notice Withdraw collateral that isn't committed to a position or an order.
    function withdraw(uint256 amount) external nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 free = freeCollateral[msg.sender];
        if (free < amount) revert InsufficientFreeCollateral(free, amount);
        freeCollateral[msg.sender] = free - amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }

    /* ------------------------------------------------------------------ */
    /* AgriPerp                                                            */
    /* ------------------------------------------------------------------ */

    /// @notice Deposit on the user's behalf as part of an order (one
    ///         transaction instead of two). The user approves the vault.
    function depositFor(address user, uint256 amount) external onlyPerp {
        if (amount == 0) return;
        usdc.safeTransferFrom(user, address(this), amount);
        freeCollateral[user] += amount;
        emit Deposited(user, amount);
    }

    /// @notice Commit `amount` (collateral + opening fee) of free collateral
    ///         to an order, and reserve pool liquidity for its maximum payout.
    function lock(address user, uint256 amount, uint256 reserve) external onlyPerp {
        uint256 free = freeCollateral[user];
        if (free < amount) revert InsufficientFreeCollateral(free, amount);
        uint256 reserved = reservedLiquidity + reserve;
        if (reserved > poolBalance) revert InsufficientPoolLiquidity(poolBalance - reservedLiquidity, reserve);
        freeCollateral[user] = free - amount;
        lockedCollateral[user] += amount;
        reservedLiquidity = reserved;
        emit Locked(user, amount, reserve);
    }

    /// @notice An order that didn't fill: its collateral and fee go back, its reserve is freed.
    function unlock(address user, uint256 amount, uint256 reserve) external onlyPerp {
        lockedCollateral[user] -= amount;
        freeCollateral[user] += amount;
        reservedLiquidity -= reserve;
        emit Unlocked(user, amount, reserve);
    }

    /// @notice The opening fee of a filled order, from what the order locked.
    function takeFee(address user, uint256 fee) external onlyPerp {
        lockedCollateral[user] -= fee;
        protocolFees += fee;
        emit FeeTaken(user, fee);
    }

    /// @notice Release a position: its collateral leaves `locked`, its reserve
    ///         is freed, and `payout` + `reward` + `fee` are paid from the
    ///         collateral, topped up from the pool when the trader made money.
    ///         AgriPerp caps what comes out at collateral + reserve, so the
    ///         top-up is always covered by the reserve set aside at the order.
    function settle(
        address user,
        uint256 collateral,
        uint256 reserve,
        uint256 payout,
        address liquidator,
        uint256 reward,
        uint256 fee
    ) external onlyPerp {
        lockedCollateral[user] -= collateral;
        reservedLiquidity -= reserve;

        uint256 out = payout + reward + fee;
        if (out > collateral) {
            poolBalance -= out - collateral;
        } else {
            poolBalance += collateral - out;
        }
        if (payout > 0) freeCollateral[user] += payout;
        if (reward > 0) freeCollateral[liquidator] += reward;
        if (fee > 0) protocolFees += fee;
        emit Settled(user, collateral, payout, liquidator, reward, fee);
    }

    /* ------------------------------------------------------------------ */
    /* Liquidity and fees (owner)                                          */
    /* ------------------------------------------------------------------ */

    /// @notice Seed the pool (brief: the team LPs first; an LP program comes later).
    function addLiquidity(uint256 amount) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        poolBalance += amount;
        emit LiquidityAdded(msg.sender, amount);
    }

    /// @notice Take liquidity out — never the part reserved for positions and orders.
    function removeLiquidity(uint256 amount, address to) external onlyOwner nonReentrant {
        if (amount == 0) revert ZeroAmount();
        uint256 available = poolBalance - reservedLiquidity;
        if (amount > available) revert InsufficientPoolLiquidity(available, amount);
        poolBalance -= amount;
        usdc.safeTransfer(to, amount);
        emit LiquidityRemoved(to, amount);
    }

    function collectFees(address to) external onlyOwner nonReentrant {
        uint256 amount = protocolFees;
        if (amount == 0) revert ZeroAmount();
        protocolFees = 0;
        usdc.safeTransfer(to, amount);
        emit FeesCollected(to, amount);
    }

    /// @notice Pool liquidity not reserved for positions or orders.
    function availableLiquidity() external view returns (uint256) {
        return poolBalance - reservedLiquidity;
    }
}
