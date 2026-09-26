// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

import {AgriFeed} from "../oracles/AgriFeed.sol";
import {AgriVault} from "./AgriVault.sol";

/// @title AgriPerp — synthetic perpetuals on agri commodities, crypto and stocks
/// @notice Isolated-margin positions against the AgriVault pool, marked to Pyth.
///
///         Opens and closes are two-step. The trader *requests* — only while
///         the market has a fresh price, pushed in the same transaction — and
///         collateral, fee, pool reserve and open interest are all committed
///         then. The order is *executed* by a keeper, or anyone, at the first
///         Pyth price published at least `minExecutionDelay` after the
///         request (Pyth's uniqueness check picks it). That price didn't exist
///         when the trader committed, so nobody can choose a favourable one.
///         The request's time is the later of the block's and the freshest
///         price's, so an order never settles on a price published before
///         one its request already carried, even where the chain's clock
///         runs behind Pyth's.
///
///         An order fills within `FILL_WINDOW` of its price or not at all:
///         left unexecuted any longer it would be an option — its trader
///         could fill it only once the market had moved their way. Past its
///         deadline it can only be cancelled, by anyone, who earns its
///         execution fee.
///
///         Liquidations are one-step, on the latest price, no older than
///         `liquidationPriceAge`.
///
///         PnL        size × (index / entryIndex − 1), mirrored for shorts,
///                    capped at min(maxProfitBps of collateral, size)
///         Funding    size × Δ(cumulative funding index); positive rates
///                    make longs pay and shorts receive, against the pool
///         Liquidate  once PnL minus funding has eaten the position's
///                    liquidation threshold of its collateral; the liquidator
///                    keeps a share of what's left (never less than a small
///                    floor), and the trader keeps the rest
///
///         Every term is fixed when an order is requested: a parameter change
///         never reaches an order in flight or a position already open.
contract AgriPerp is Ownable, ReentrancyGuard {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BPS = 10_000;
    /// Brief: 50× at most. A market can be set lower, never higher.
    uint256 public constant MAX_LEVERAGE = 50;
    /// Funding can't be set past 0.01% of size per hour in either direction.
    int256 public constant MAX_FUNDING_RATE_PER_HOUR = 1e14;
    /// An order fills within this long of the price it settles on, or is cancelled.
    uint256 public constant FILL_WINDOW = 20;
    /// A market whose price hasn't moved on chain for this long can be delisted
    /// and settled at its last price. Longer than any market holiday.
    uint256 public constant DELIST_AFTER = 7 days;

    AgriVault public immutable vault;
    AgriFeed public immutable feed;
    IPyth public immutable pyth;

    /// Opening fee, share of size (brief: 0.1%).
    uint256 public openFeeBps = 10;
    /// Closing fee, share of size. Makes a round trip cost something.
    uint256 public closeFeeBps = 10;
    /// Liquidatable once losses reach this share of collateral (brief: 80%).
    uint256 public liquidationThresholdBps = 8_000;
    /// The liquidator's cut of the collateral that's left (brief: 10%)…
    uint256 public liquidatorRewardBps = 1_000;
    /// …and never less than this share of the collateral, so a position past
    /// zero equity is still worth liquidating.
    uint256 public minLiquidationRewardBps = 50;
    /// Profit cap, share of collateral (also capped at the position's size).
    uint256 public maxProfitBps = 90_000;
    /// An order fills at the first price published this many seconds after it…
    uint256 public minExecutionDelay = 3;
    /// …which has to come out within this many seconds of the request.
    uint256 public maxExecutionDelay = 60;
    /// Liquidations settle on the latest price, no older than this.
    uint256 public liquidationPriceAge = 5;
    /// A request needs a price at least this fresh: closed markets take no orders.
    uint256 public requestPriceAge = 60;
    /// Smallest collateral per position, USDC units (6 decimals).
    uint256 public minCollateral = 1e6;
    /// Smallest execution fee (wei) sent with an order, paid to whoever executes or cancels it.
    uint256 public minExecutionFee = 0;

    struct Market {
        bool listed;
        /// New orders allowed. Closes and liquidations never stop.
        bool enabled;
        /// The oracle died: positions settle at `settlementIndex` via `settleDelisted`.
        bool delisted;
        uint8 maxLeverage;
        uint64 fundingUpdatedAt;
        /// 1e18 = 100% of size per hour. Positive: longs pay, shorts receive.
        int256 fundingRatePerHour;
        /// Cumulative funding per unit of size, 1e18 = 100%.
        int256 fundingIndex;
        /// Open interest, positions and pending opens, USDC units.
        uint256 longOi;
        uint256 shortOi;
        /// Open interest cap per side, USDC units.
        uint256 maxOi;
        uint256 settlementPrice;
        uint256 settlementIndex;
    }

    enum Status {
        None,
        Open,
        Closed,
        Liquidated
    }

    struct Position {
        address trader;
        bool isLong;
        Status status;
        uint64 openedAt;
        uint16 liquidationThresholdBps;
        uint16 liquidatorRewardBps;
        uint16 minLiquidationRewardBps;
        uint16 closeFeeBps;
        bytes32 market;
        uint256 collateral;
        uint256 size;
        /// Price of the contract traded at open, 18 decimals (display).
        uint256 entryPrice;
        /// Index at open — what PnL is measured against.
        uint256 entryIndex;
        int256 entryFunding;
        /// Pool liquidity set aside for this position's maximum profit.
        uint256 reserve;
        /// A close order waiting to execute, 0 when none.
        uint256 pendingClose;
    }

    enum OrderStatus {
        None,
        Pending,
        Executed,
        Cancelled
    }

    /// The terms an order was requested under, fixed for its execution and its position.
    struct OrderTerms {
        uint32 minDelay;
        uint32 maxDelay;
        uint16 closeFeeBps;
        uint16 liquidationThresholdBps;
        uint16 liquidatorRewardBps;
        uint16 minLiquidationRewardBps;
    }

    struct Order {
        address trader;
        bool isOpen;
        bool isLong;
        OrderStatus status;
        uint64 requestedAt;
        OrderTerms terms;
        bytes32 market;
        uint256 collateral;
        uint256 leverage;
        /// Worst fill in index terms: a buy (open long, close short) fills at or below it, a sell at or above.
        uint256 acceptableIndex;
        /// The position a close order closes, or the one an open order opened.
        uint256 positionId;
        /// Wei, paid to whoever executes or cancels the order.
        uint256 executionFee;
        uint256 fee;
        uint256 reserve;
    }

    mapping(bytes32 => Market) public markets;
    mapping(bytes32 => string) public symbolOf;
    mapping(uint256 => Position) internal _positions;
    mapping(address => uint256[]) internal _positionsOf;
    mapping(uint256 => Order) internal _orders;
    uint256 public nextPositionId = 1;
    uint256 public nextOrderId = 1;

    event MarketListed(string symbol, bytes32 indexed market, uint8 maxLeverage, uint256 maxOi, int256 fundingRatePerHour);
    event MarketUpdated(bytes32 indexed market, bool enabled, uint8 maxLeverage, uint256 maxOi);
    event MarketDelisted(bytes32 indexed market, uint256 settlementPrice, uint256 settlementIndex);
    event FundingRateSet(bytes32 indexed market, int256 fundingRatePerHour, int256 fundingIndex);
    event FeesSet(uint256 openFeeBps, uint256 closeFeeBps);
    event LiquidationSet(uint256 thresholdBps, uint256 rewardBps, uint256 minRewardBps);
    event RiskSet(uint256 maxProfitBps, uint256 minCollateral);
    event ExecutionSet(uint256 minExecutionDelay, uint256 maxExecutionDelay, uint256 liquidationPriceAge, uint256 requestPriceAge, uint256 minExecutionFee);
    event OrderRequested(
        uint256 indexed orderId,
        address indexed trader,
        bytes32 indexed market,
        bool isOpen,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptableIndex,
        uint256 positionId,
        uint256 executionFee,
        uint64 requestedAt
    );
    event OrderExecuted(uint256 indexed orderId, uint256 indexed positionId, address indexed executor, uint256 price, uint256 index);
    event OrderCancelled(uint256 indexed orderId, address indexed trader, string reason);
    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        string symbol,
        bool isLong,
        uint256 collateral,
        uint256 size,
        uint256 leverage,
        uint256 entryPrice,
        uint256 entryIndex,
        int256 entryFunding,
        uint256 fee
    );
    event PositionClosed(
        uint256 indexed positionId,
        address indexed trader,
        uint256 exitPrice,
        uint256 exitIndex,
        int256 pnl,
        int256 funding,
        uint256 fee,
        uint256 payout
    );
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed trader,
        address indexed liquidator,
        uint256 exitPrice,
        uint256 exitIndex,
        int256 pnl,
        int256 funding,
        uint256 payout,
        uint256 reward
    );

    error MarketNotListed(bytes32 market);
    error MarketAlreadyListed(bytes32 market);
    error FeedNotListed(bytes32 market);
    error MarketDisabled(bytes32 market);
    error MarketIsDelisted(bytes32 market);
    error NotDelistable(uint256 lastPublishTime);
    error InvalidLeverage(uint256 leverage);
    error CollateralTooSmall(uint256 collateral, uint256 minimum);
    error FeeAboveMax(uint256 feeBps, uint256 maxFeeBps);
    error ExecutionFeeTooSmall(uint256 sent, uint256 minimum);
    error OpenInterestCapReached(uint256 openInterest, uint256 cap);
    error NotPositionOwner(uint256 positionId);
    error PositionNotOpen(uint256 positionId);
    error CloseAlreadyPending(uint256 orderId);
    error OrderNotPending(uint256 orderId);
    error TooEarlyToCancel(uint256 cancellableAfter);
    error InsufficientOracleFee(uint256 required, uint256 sent);
    error TransferFailed();
    error InvalidParam();

    constructor(address vault_, address feed_, address owner_) Ownable(owner_) {
        vault = AgriVault(vault_);
        feed = AgriFeed(feed_);
        pyth = AgriFeed(feed_).pyth();
    }

    /* ------------------------------------------------------------------ */
    /* Orders                                                              */
    /* ------------------------------------------------------------------ */

    /// @notice Ask to open a position. Collateral + fee, the pool reserve and
    ///         the open interest are committed now; the position opens when
    ///         the order executes, at the first price after `minExecutionDelay`.
    /// @param symbol          "COFF", "ETH", "NVDA", …
    /// @param isLong          true for long, false for short
    /// @param collateral      USDC margin (6 decimals)
    /// @param leverage        1 … the market's max; size = collateral × leverage
    /// @param acceptablePrice worst fill in today's contract price (18 decimals): a long won't fill above it, a short below
    /// @param maxFeeBps       the opening fee you agreed to; reverts if it's since been raised
    /// @param depositAmount   USDC to deposit first in the same transaction (approve the vault); 0 for none
    /// @param updateData      a fresh Pyth update for this market (or [] if one is already stored)
    /// @dev msg.value pays the Pyth update fee; the rest is the order's execution fee.
    function requestOpen(
        string calldata symbol,
        bool isLong,
        uint256 collateral,
        uint256 leverage,
        uint256 acceptablePrice,
        uint256 maxFeeBps,
        uint256 depositAmount,
        bytes[] calldata updateData
    ) external payable nonReentrant returns (uint256 orderId) {
        bytes32 market = keccak256(bytes(symbol));
        Market storage m = markets[market];
        if (!m.listed) revert MarketNotListed(market);
        if (!m.enabled) revert MarketDisabled(market);
        if (leverage == 0 || leverage > m.maxLeverage) revert InvalidLeverage(leverage);
        if (collateral < minCollateral) revert CollateralTooSmall(collateral, minCollateral);
        if (openFeeBps > maxFeeBps) revert FeeAboveMax(openFeeBps, maxFeeBps);
        (uint256 oracleFee, uint64 requestedAt, uint256 quotedAt) = _requireFreshPrice(market, updateData);
        uint256 executionFee = msg.value - oracleFee;
        if (executionFee < minExecutionFee) revert ExecutionFeeTooSmall(executionFee, minExecutionFee);

        uint256 size = collateral * leverage;
        if (isLong) {
            m.longOi += size;
            if (m.longOi > m.maxOi) revert OpenInterestCapReached(m.longOi, m.maxOi);
        } else {
            m.shortOi += size;
            if (m.shortOi > m.maxOi) revert OpenInterestCapReached(m.shortOi, m.maxOi);
        }
        uint256 fee = (size * openFeeBps) / BPS;
        uint256 reserve = _reserveFor(collateral, size);
        if (depositAmount > 0) vault.depositFor(msg.sender, depositAmount);
        vault.lock(msg.sender, collateral + fee, reserve);

        orderId = nextOrderId++;
        uint256 acceptableIndex = _toIndex(market, acceptablePrice, quotedAt);
        _orders[orderId] = Order({
            trader: msg.sender,
            isOpen: true,
            isLong: isLong,
            status: OrderStatus.Pending,
            requestedAt: requestedAt,
            terms: _currentTerms(),
            market: market,
            collateral: collateral,
            leverage: leverage,
            acceptableIndex: acceptableIndex,
            positionId: 0,
            executionFee: executionFee,
            fee: fee,
            reserve: reserve
        });
        emit OrderRequested(orderId, msg.sender, market, true, isLong, collateral, leverage, acceptableIndex, 0, executionFee, requestedAt);
    }

    /// @notice Ask to close a position in full.
    /// @param acceptablePrice worst fill in today's contract price: closing a long won't fill below it, a short above
    /// @param updateData      a fresh Pyth update for this market (or [] if one is already stored)
    /// @dev msg.value pays the Pyth update fee; the rest is the order's execution fee.
    function requestClose(uint256 positionId, uint256 acceptablePrice, bytes[] calldata updateData)
        external
        payable
        nonReentrant
        returns (uint256 orderId)
    {
        Position storage p = _positions[positionId];
        if (p.trader != msg.sender) revert NotPositionOwner(positionId);
        if (p.status != Status.Open) revert PositionNotOpen(positionId);
        if (p.pendingClose != 0) revert CloseAlreadyPending(p.pendingClose);
        if (markets[p.market].delisted) revert MarketIsDelisted(p.market);
        (uint256 oracleFee, uint64 requestedAt, uint256 quotedAt) = _requireFreshPrice(p.market, updateData);
        uint256 executionFee = msg.value - oracleFee;
        if (executionFee < minExecutionFee) revert ExecutionFeeTooSmall(executionFee, minExecutionFee);

        orderId = nextOrderId++;
        uint256 acceptableIndex = _toIndex(p.market, acceptablePrice, quotedAt);
        _orders[orderId] = Order({
            trader: msg.sender,
            isOpen: false,
            isLong: p.isLong,
            status: OrderStatus.Pending,
            requestedAt: requestedAt,
            terms: _currentTerms(),
            market: p.market,
            collateral: p.collateral,
            leverage: p.size / p.collateral,
            acceptableIndex: acceptableIndex,
            positionId: positionId,
            executionFee: executionFee,
            fee: 0,
            reserve: 0
        });
        p.pendingClose = orderId;
        emit OrderRequested(orderId, msg.sender, p.market, false, p.isLong, p.collateral, p.size / p.collateral, acceptableIndex, positionId, executionFee, requestedAt);
    }

    /// @notice Execute a pending order at the first price published at least
    ///         its `minDelay` after it was requested (Pyth checks it's the
    ///         first, so there's nothing to choose). Permissionless: the
    ///         executor gets the order's execution fee. An order whose price
    ///         breaks its bound, or that comes more than `FILL_WINDOW` after
    ///         that price, is cancelled and refunded instead; one past its
    ///         deadline is only ever cancelled.
    function executeOrder(uint256 orderId, bytes[] calldata updateData) external payable nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Pending) revert OrderNotPending(orderId);
        if (block.timestamp > _deadline(o) || markets[o.market].delisted) {
            _cancel(orderId, o, block.timestamp > _deadline(o) ? "expired" : "market delisted");
            _send(msg.sender, o.executionFee + msg.value);
            return;
        }

        (bytes32 feedId, , , , ) = feed.feedOf(o.market);
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        uint256 oracleFee = pyth.getUpdateFee(updateData);
        if (msg.value < oracleFee) revert InsufficientOracleFee(oracleFee, msg.value);
        (PythStructs.PriceFeed[] memory feeds, ) = pyth.parsePriceFeedUpdatesWithConfig{value: oracleFee}(
            updateData,
            ids,
            o.requestedAt + uint64(o.terms.minDelay),
            o.requestedAt + uint64(o.terms.maxDelay),
            true,
            false,
            true
        );
        if (block.timestamp > feeds[0].price.publishTime + FILL_WINDOW) {
            // Late: filling now would let whoever holds it pick the outcome.
            _cancel(orderId, o, "expired");
        } else {
            (uint256 price, uint256 index) = feed.normalize(o.market, feeds[0].price);
            if (o.isOpen) _executeOpen(orderId, o, price, index);
            else _executeClose(orderId, o, price, index);
        }

        _send(msg.sender, o.executionFee + (msg.value - oracleFee));
    }

    /// @notice Cancel an order past its deadline — anyone may, and earns its
    ///         execution fee; the trader's collateral goes back to their free
    ///         balance. Not before: nobody gets to watch the price that
    ///         settles an order and then walk away from it.
    function cancelOrder(uint256 orderId) external nonReentrant {
        Order storage o = _orders[orderId];
        if (o.status != OrderStatus.Pending) revert OrderNotPending(orderId);
        uint256 deadline = _deadline(o);
        bool delisted = markets[o.market].delisted;
        if (block.timestamp <= deadline && !delisted) revert TooEarlyToCancel(deadline);
        _cancel(orderId, o, delisted ? "market delisted" : "expired");
        _send(msg.sender, o.executionFee);
    }

    function _executeOpen(uint256 orderId, Order storage o, uint256 price, uint256 index) internal {
        if (o.isLong ? index > o.acceptableIndex : index < o.acceptableIndex) {
            _cancel(orderId, o, "price past limit");
            return;
        }
        Market storage m = markets[o.market];
        _accrueFunding(m);
        vault.takeFee(o.trader, o.fee);

        uint256 positionId = nextPositionId++;
        uint256 size = o.collateral * o.leverage;
        _positions[positionId] = Position({
            trader: o.trader,
            isLong: o.isLong,
            status: Status.Open,
            openedAt: uint64(block.timestamp),
            liquidationThresholdBps: o.terms.liquidationThresholdBps,
            liquidatorRewardBps: o.terms.liquidatorRewardBps,
            minLiquidationRewardBps: o.terms.minLiquidationRewardBps,
            closeFeeBps: o.terms.closeFeeBps,
            market: o.market,
            collateral: o.collateral,
            size: size,
            entryPrice: price,
            entryIndex: index,
            entryFunding: m.fundingIndex,
            reserve: o.reserve,
            pendingClose: 0
        });
        _positionsOf[o.trader].push(positionId);
        o.status = OrderStatus.Executed;
        o.positionId = positionId;
        emit PositionOpened(positionId, o.trader, symbolOf[o.market], o.isLong, o.collateral, size, o.leverage, price, index, m.fundingIndex, o.fee);
        emit OrderExecuted(orderId, positionId, msg.sender, price, index);
    }

    function _executeClose(uint256 orderId, Order storage o, uint256 price, uint256 index) internal {
        Position storage p = _positions[o.positionId];
        if (p.status != Status.Open) {
            _cancel(orderId, o, "position no longer open");
            return;
        }
        // Closing a long sells (a floor); closing a short buys (a ceiling).
        if (p.isLong ? index < o.acceptableIndex : index > o.acceptableIndex) {
            _cancel(orderId, o, "price past limit");
            return;
        }
        Market storage m = markets[p.market];
        _accrueFunding(m);
        o.status = OrderStatus.Executed;
        _close(o.positionId, p, m, price, index, true);
        emit OrderExecuted(orderId, o.positionId, msg.sender, price, index);
    }

    /// @dev Settles an open position at `index`: PnL and funding, the close fee if `charged`.
    function _close(uint256 positionId, Position storage p, Market storage m, uint256 price, uint256 index, bool charged) internal {
        (int256 pnl, int256 funding) = _pnlAndFunding(p, index, m.fundingIndex);
        uint256 gross = _gross(p, pnl, funding);
        uint256 fee = charged ? (p.size * p.closeFeeBps) / BPS : 0;
        if (fee > gross) fee = gross;
        uint256 payout = gross - fee;
        p.status = Status.Closed;
        p.pendingClose = 0;
        _releaseOi(m, p.isLong, p.size);
        vault.settle(p.trader, p.collateral, p.reserve, payout, address(0), 0, fee);
        emit PositionClosed(positionId, p.trader, price, index, pnl, funding, fee, payout);
    }

    function _cancel(uint256 orderId, Order storage o, string memory reason) internal {
        o.status = OrderStatus.Cancelled;
        if (o.isOpen) {
            _releaseOi(markets[o.market], o.isLong, o.collateral * o.leverage);
            vault.unlock(o.trader, o.collateral + o.fee, o.reserve);
        } else if (_positions[o.positionId].pendingClose == orderId) {
            _positions[o.positionId].pendingClose = 0;
        }
        emit OrderCancelled(orderId, o.trader, reason);
    }

    /// @dev The last moment an order could still fill: its latest possible price, plus the fill window.
    function _deadline(Order storage o) internal view returns (uint256) {
        return uint256(o.requestedAt) + o.terms.maxDelay + FILL_WINDOW;
    }

    function _currentTerms() internal view returns (OrderTerms memory) {
        return OrderTerms({
            minDelay: uint32(minExecutionDelay),
            maxDelay: uint32(maxExecutionDelay),
            closeFeeBps: uint16(closeFeeBps),
            liquidationThresholdBps: uint16(liquidationThresholdBps),
            liquidatorRewardBps: uint16(liquidatorRewardBps),
            minLiquidationRewardBps: uint16(minLiquidationRewardBps)
        });
    }

    /// @dev Pushes `updateData` (paying Pyth from msg.value) and requires the
    ///      market's stored price to be fresh. Returns the Pyth fee paid, the
    ///      request's time (the later of the block's and that price's), and
    ///      that price's time — the terms a trader's limit is quoted in.
    function _requireFreshPrice(bytes32 market, bytes[] calldata updateData)
        internal
        returns (uint256 fee, uint64 requestedAt, uint256 publishTime)
    {
        if (updateData.length > 0) {
            fee = pyth.getUpdateFee(updateData);
            if (msg.value < fee) revert InsufficientOracleFee(fee, msg.value);
            pyth.updatePriceFeeds{value: fee}(updateData);
        }
        (, , publishTime) = feed.readLatest(market, requestPriceAge);
        requestedAt = uint64(publishTime > block.timestamp ? publishTime : block.timestamp);
    }

    /* ------------------------------------------------------------------ */
    /* Liquidation and delisting                                           */
    /* ------------------------------------------------------------------ */

    /// @notice Liquidate whichever of `positionIds` (all on one market) are
    ///         past their threshold, on the latest price — pushed with
    ///         `updateData` and no older than `liquidationPriceAge`. Skips
    ///         the rest instead of reverting. Permissionless.
    function liquidate(string calldata symbol, uint256[] calldata positionIds, bytes[] calldata updateData)
        external
        payable
        nonReentrant
        returns (uint256 liquidated)
    {
        bytes32 market = keccak256(bytes(symbol));
        Market storage m = markets[market];
        if (!m.listed) revert MarketNotListed(market);
        if (m.delisted) revert MarketIsDelisted(market);
        uint256 oracleFee = 0;
        if (updateData.length > 0) {
            oracleFee = pyth.getUpdateFee(updateData);
            if (msg.value < oracleFee) revert InsufficientOracleFee(oracleFee, msg.value);
            pyth.updatePriceFeeds{value: oracleFee}(updateData);
        }
        (uint256 price, uint256 index, ) = feed.readLatest(market, liquidationPriceAge);
        _accrueFunding(m);
        for (uint256 i = 0; i < positionIds.length; i++) {
            if (_liquidate(positionIds[i], market, m, price, index)) liquidated++;
        }
        _send(msg.sender, msg.value - oracleFee);
    }

    function _liquidate(uint256 positionId, bytes32 market, Market storage m, uint256 price, uint256 index) internal returns (bool) {
        Position storage p = _positions[positionId];
        if (p.status != Status.Open || p.market != market) return false;
        (int256 pnl, int256 funding) = _pnlAndFunding(p, index, m.fundingIndex);
        if (funding - pnl < int256((p.collateral * p.liquidationThresholdBps) / BPS)) return false;

        uint256 remaining = _gross(p, pnl, funding);
        uint256 reward = (remaining * p.liquidatorRewardBps) / BPS;
        uint256 floor = (p.collateral * p.minLiquidationRewardBps) / BPS;
        if (reward < floor) reward = floor;
        // Past zero equity the floor comes out of what the pool would have
        // taken, never out of the pool itself: payout + reward ≤ collateral.
        uint256 payout = remaining > reward ? remaining - reward : 0;

        p.status = Status.Liquidated;
        _releaseOi(m, p.isLong, p.size);
        vault.settle(p.trader, p.collateral, p.reserve, payout, msg.sender, reward, 0);
        emit PositionLiquidated(positionId, p.trader, msg.sender, price, index, pnl, funding, payout, reward);
        return true;
    }

    /// @notice The market's price hasn't moved on chain for `DELIST_AFTER`
    ///         (a futures month expired unrolled, a feed was retired): stop
    ///         it, and freeze the last stored price as its settlement price,
    ///         so collateral is never stuck behind a feed that won't come
    ///         back. Push the feed's final print first — the settlement is
    ///         whatever price is stored.
    function delistMarket(string calldata symbol) external onlyOwner {
        bytes32 market = keccak256(bytes(symbol));
        Market storage m = markets[market];
        if (!m.listed) revert MarketNotListed(market);
        if (m.delisted) revert MarketIsDelisted(market);
        (uint256 price, uint256 index, uint256 publishTime) = feed.readUnsafe(market);
        if (block.timestamp < publishTime + DELIST_AFTER) revert NotDelistable(publishTime);
        _accrueFunding(m);
        m.fundingRatePerHour = 0;
        m.enabled = false;
        m.delisted = true;
        m.settlementPrice = price;
        m.settlementIndex = index;
        emit MarketDelisted(market, price, index);
    }

    /// @notice Close positions on a delisted market at its settlement price, with no close fee. Permissionless.
    function settleDelisted(uint256[] calldata positionIds) external nonReentrant returns (uint256 settled) {
        for (uint256 i = 0; i < positionIds.length; i++) {
            Position storage p = _positions[positionIds[i]];
            Market storage m = markets[p.market];
            if (p.status != Status.Open || !m.delisted) continue;
            _close(positionIds[i], p, m, m.settlementPrice, m.settlementIndex, false);
            settled++;
        }
    }

    /* ------------------------------------------------------------------ */
    /* Math                                                                */
    /* ------------------------------------------------------------------ */

    /// @dev Pool liquidity a position can ever take: min(maxProfitBps of collateral, its size).
    function _reserveFor(uint256 collateral, uint256 size) internal view returns (uint256) {
        uint256 byCollateral = (collateral * maxProfitBps) / BPS;
        return byCollateral < size ? byCollateral : size;
    }

    /// @dev A trader's price limit on the index, in the terms of the price their request carried.
    function _toIndex(bytes32 market, uint256 price, uint256 quotedAt) internal view returns (uint256) {
        return feed.indexAt(market, price, quotedAt);
    }

    function _pnlAndFunding(Position storage p, uint256 index, int256 fundingIndex)
        internal
        view
        returns (int256 pnl, int256 funding)
    {
        int256 entry = int256(p.entryIndex);
        pnl = (int256(p.size) * (int256(index) - entry)) / entry;
        if (!p.isLong) pnl = -pnl;
        if (pnl > int256(p.reserve)) pnl = int256(p.reserve);
        funding = (int256(p.size) * (fundingIndex - p.entryFunding)) / int256(ONE);
        if (!p.isLong) funding = -funding;
    }

    /// @dev collateral + PnL − funding, floored at zero and capped at collateral + reserve.
    function _gross(Position storage p, int256 pnl, int256 funding) internal view returns (uint256) {
        int256 value = int256(p.collateral) + pnl - funding;
        if (value <= 0) return 0;
        uint256 cap = p.collateral + p.reserve;
        return uint256(value) > cap ? cap : uint256(value);
    }

    function _accrueFunding(Market storage m) internal {
        uint256 elapsed = block.timestamp - m.fundingUpdatedAt;
        if (elapsed == 0) return;
        m.fundingIndex += (m.fundingRatePerHour * int256(elapsed)) / 3600;
        m.fundingUpdatedAt = uint64(block.timestamp);
    }

    function _releaseOi(Market storage m, bool isLong, uint256 size) internal {
        if (isLong) m.longOi -= size;
        else m.shortOi -= size;
    }

    function _send(address to, uint256 amount) internal {
        if (amount == 0) return;
        (bool ok, ) = to.call{value: amount}("");
        if (!ok) revert TransferFailed();
    }

    /* ------------------------------------------------------------------ */
    /* Views                                                               */
    /* ------------------------------------------------------------------ */

    function getPosition(uint256 positionId) external view returns (Position memory) {
        return _positions[positionId];
    }

    function getOrder(uint256 orderId) external view returns (Order memory) {
        return _orders[orderId];
    }

    function positionsOf(address trader) external view returns (uint256[] memory) {
        return _positionsOf[trader];
    }

    /// @notice When a pending order can only be cancelled.
    function orderDeadline(uint256 orderId) external view returns (uint256) {
        return _deadline(_orders[orderId]);
    }

    /// @notice The market's funding index as of this block.
    function fundingIndexNow(bytes32 market) public view returns (int256) {
        Market storage m = markets[market];
        return m.fundingIndex + (m.fundingRatePerHour * int256(block.timestamp - m.fundingUpdatedAt)) / 3600;
    }

    /// @notice A position marked to the last price stored on chain, however
    ///         old — for display. Settlement always takes a fresh price.
    function positionState(uint256 positionId)
        external
        view
        returns (int256 pnl, int256 funding, uint256 equity, bool liquidatable)
    {
        Position storage p = _positions[positionId];
        if (p.status != Status.Open) revert PositionNotOpen(positionId);
        Market storage m = markets[p.market];
        uint256 index = m.settlementIndex;
        if (!m.delisted) (, index, ) = feed.readUnsafe(p.market);
        (pnl, funding) = _pnlAndFunding(p, index, fundingIndexNow(p.market));
        equity = _gross(p, pnl, funding);
        liquidatable = funding - pnl >= int256((p.collateral * p.liquidationThresholdBps) / BPS);
    }

    /* ------------------------------------------------------------------ */
    /* Admin — every setting bounded, none reaching an order or position   */
    /* ------------------------------------------------------------------ */

    function listMarket(string calldata symbol, uint8 maxLeverage, uint256 maxOi, int256 fundingRatePerHour)
        external
        onlyOwner
    {
        bytes32 market = keccak256(bytes(symbol));
        if (markets[market].listed) revert MarketAlreadyListed(market);
        if (!feed.isListed(market)) revert FeedNotListed(market);
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE) revert InvalidParam();
        _checkFundingRate(fundingRatePerHour);
        markets[market] = Market({
            listed: true,
            enabled: true,
            delisted: false,
            maxLeverage: maxLeverage,
            fundingUpdatedAt: uint64(block.timestamp),
            fundingRatePerHour: fundingRatePerHour,
            fundingIndex: 0,
            longOi: 0,
            shortOi: 0,
            maxOi: maxOi,
            settlementPrice: 0,
            settlementIndex: 0
        });
        symbolOf[market] = symbol;
        emit MarketListed(symbol, market, maxLeverage, maxOi, fundingRatePerHour);
    }

    /// @notice Pause new orders (closes continue), or change leverage and the OI cap for new orders.
    function setMarket(bytes32 market, bool enabled, uint8 maxLeverage, uint256 maxOi) external onlyOwner {
        Market storage m = markets[market];
        if (!m.listed) revert MarketNotListed(market);
        if (m.delisted) revert MarketIsDelisted(market);
        if (maxLeverage == 0 || maxLeverage > MAX_LEVERAGE) revert InvalidParam();
        m.enabled = enabled;
        m.maxLeverage = maxLeverage;
        m.maxOi = maxOi;
        emit MarketUpdated(market, enabled, maxLeverage, maxOi);
    }

    /// @notice Brief §12.4: funding is set by hand for the MVP. Accrues at the
    ///         old rate up to now first, so the change is never retroactive.
    function setFundingRate(bytes32 market, int256 fundingRatePerHour) external onlyOwner {
        Market storage m = markets[market];
        if (!m.listed) revert MarketNotListed(market);
        if (m.delisted) revert MarketIsDelisted(market);
        _checkFundingRate(fundingRatePerHour);
        _accrueFunding(m);
        m.fundingRatePerHour = fundingRatePerHour;
        emit FundingRateSet(market, fundingRatePerHour, m.fundingIndex);
    }

    function setFees(uint256 openFeeBps_, uint256 closeFeeBps_) external onlyOwner {
        if (openFeeBps_ > 100 || closeFeeBps_ > 100) revert InvalidParam();
        openFeeBps = openFeeBps_;
        closeFeeBps = closeFeeBps_;
        emit FeesSet(openFeeBps_, closeFeeBps_);
    }

    function setLiquidation(uint256 thresholdBps, uint256 rewardBps, uint256 minRewardBps) external onlyOwner {
        if (thresholdBps < 5_000 || thresholdBps > 9_500 || rewardBps > 2_500 || minRewardBps > 500) revert InvalidParam();
        liquidationThresholdBps = thresholdBps;
        liquidatorRewardBps = rewardBps;
        minLiquidationRewardBps = minRewardBps;
        emit LiquidationSet(thresholdBps, rewardBps, minRewardBps);
    }

    function setRisk(uint256 maxProfitBps_, uint256 minCollateral_) external onlyOwner {
        if (maxProfitBps_ < BPS || maxProfitBps_ > 200_000 || minCollateral_ == 0) revert InvalidParam();
        maxProfitBps = maxProfitBps_;
        minCollateral = minCollateral_;
        emit RiskSet(maxProfitBps_, minCollateral_);
    }

    function setExecution(uint256 minDelay, uint256 maxDelay, uint256 liquidationAge, uint256 requestAge, uint256 minFee)
        external
        onlyOwner
    {
        if (minDelay < 2 || minDelay > 30 || maxDelay < minDelay + 5 || maxDelay > 600) revert InvalidParam();
        if (liquidationAge < 2 || liquidationAge > 15 || requestAge < 5 || requestAge > 120 || minFee > 0.01 ether) revert InvalidParam();
        minExecutionDelay = minDelay;
        maxExecutionDelay = maxDelay;
        liquidationPriceAge = liquidationAge;
        requestPriceAge = requestAge;
        minExecutionFee = minFee;
        emit ExecutionSet(minDelay, maxDelay, liquidationAge, requestAge, minFee);
    }

    function _checkFundingRate(int256 rate) internal pure {
        if (rate > MAX_FUNDING_RATE_PER_HOUR || rate < -MAX_FUNDING_RATE_PER_HOUR) revert InvalidParam();
    }
}
