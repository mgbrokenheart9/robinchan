// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title AgriFeed — Pyth prices for the AgriPerp markets
/// @notice Maps a market (keccak256 of its symbol) to a Pyth feed and turns
///         Pyth's integer price and exponent into an 18-decimal USD price.
///
///         Pyth prices coffee, cocoa and sugar only as dated futures, so an
///         agri market walks from one contract month to the next. A roll is
///         announced a day ahead, and then anyone can carry it out with the
///         *first* price each month published at or after the announced time
///         — a moment nobody gets to pick. The cumulative `rollFactor` is
///         multiplied by old/new at that instant, which keeps the index
///         (price × rollFactor) continuous: positions are marked on the index,
///         so they neither gain nor lose the calendar spread.
///
///         Stocks split. A split is announced the same way, with its ratio
///         and the moment it takes effect (between the last price before it
///         and the first after); every price published from that moment on is
///         scaled by the ratio, so the index doesn't move by the split — which
///         would otherwise pay every short out of the pool. The ratio is
///         checked against the market's own prices before it applies: until
///         anyone shows that the first price after the split, times the ratio,
///         is within 0.8–1.25× of one from before it, prices from the split on
///         settle nothing. A ratio or a time that doesn't match a real split
///         can't pass.
contract AgriFeed is Ownable {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BPS = 10_000;
    /// A roll is announced at least this long before it can happen.
    uint256 public constant ROLL_NOTICE = 1 days;
    /// Both months' prices must be the first published within this long after the roll time…
    uint256 public constant ROLL_WINDOW = 60;
    /// …and no further apart than this.
    uint256 public constant ROLL_MAX_APART = 5;
    /// A roll not carried out within this long of its time has to be announced again.
    uint256 public constant ROLL_DEADLINE = 1 hours;
    /// A rebase is folded into the roll factor once no pending order can still need a price from before it.
    uint256 public constant REBASE_SETTLE = 1 days;
    /// A split is checked against the first price at most this long after it; past that, the owner can call it off.
    uint256 public constant REBASE_WINDOW = 1 days;
    /// …and a price from at most this long before it (a long weekend and a holiday).
    uint256 public constant REBASE_LOOKBACK = 4 days;
    /// The widest confidence interval a market can be set to accept.
    uint16 public constant MAX_CONF_BPS = 500;

    IPyth public immutable pyth;

    struct Feed {
        /// The Pyth feed the market reads now.
        bytes32 feedId;
        /// Cumulative roll adjustment, 1e18 = none yet.
        uint256 rollFactor;
        /// 0 for USD-quoted feeds, -2 for feeds quoted in US cents.
        int8 unitExp;
        /// Prices whose confidence interval is wider than this share of the price are refused.
        uint16 maxConfBps;
        bool listed;
    }

    struct PendingRoll {
        bytes32 toFeedId;
        uint64 notBefore;
    }

    /// A split (or reverse split): prices published at or after `effectiveAt` are multiplied by
    /// `multiplier` (1e18 = ×1) — once `active`, i.e. checked against the market's prices.
    struct PendingRebase {
        uint256 multiplier;
        uint64 effectiveAt;
        bool active;
    }

    mapping(bytes32 => Feed) internal _feeds;
    mapping(bytes32 => PendingRoll) public pendingRolls;
    mapping(bytes32 => PendingRebase) public pendingRebases;

    event FeedListed(string symbol, bytes32 indexed market, bytes32 feedId, int8 unitExp, uint16 maxConfBps);
    event RollScheduled(string symbol, bytes32 indexed market, bytes32 toFeed, uint64 notBefore);
    event RollCancelled(bytes32 indexed market);
    event FeedRolled(
        bytes32 indexed market,
        bytes32 fromFeed,
        bytes32 toFeed,
        uint256 fromPrice,
        uint256 toPrice,
        uint256 rollFactor
    );
    event MaxConfSet(bytes32 indexed market, uint16 maxConfBps);
    event RebaseScheduled(bytes32 indexed market, uint256 multiplier, uint64 effectiveAt);
    event RebaseCancelled(bytes32 indexed market);
    event RebaseActivated(bytes32 indexed market, uint256 priceBefore, uint256 priceAfter);
    event RebaseFinalized(bytes32 indexed market, uint256 multiplier, uint256 rollFactor);

    error UnknownMarket(bytes32 market);
    error AlreadyListed(bytes32 market);
    error InvalidParam();
    error BadPrice(bytes32 feedId);
    error ConfidenceTooWide(bytes32 feedId, uint64 conf, int64 price);
    error NoRollScheduled(bytes32 market);
    error RollNotDue(uint64 notBefore);
    error RollPricesApart(uint256 fromPublishTime, uint256 toPublishTime);
    error RollOutOfBounds(uint256 fromPrice, uint256 toPrice);
    error RollExpired(uint64 notBefore);
    error AdjustmentPending(bytes32 market);
    error NoRebaseScheduled(bytes32 market);
    error RebaseNotDue(uint64 effectiveAt);
    error RebaseNotActive(bytes32 market);
    error RebaseAlreadyActive(bytes32 market);
    error RebaseOutOfBounds(uint256 priceBefore, uint256 priceAfter);
    error RebaseLocked(uint64 effectiveAt);
    error RebaseNotSettled(uint256 finalizableAt);
    error StalePrice(uint256 publishTime);
    error InsufficientOracleFee(uint256 required, uint256 sent);
    error RefundFailed();

    constructor(address pyth_, address owner_) Ownable(owner_) {
        if (pyth_ == address(0)) revert InvalidParam();
        pyth = IPyth(pyth_);
    }

    /* ------------------------------------------------------------------ */
    /* Admin                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice Add a market's feed. A listed market's feed only ever changes
    ///         through an announced roll, which keeps its price series continuous.
    function listFeed(string calldata symbol, bytes32 feedId, int8 unitExp, uint16 maxConfBps) external onlyOwner {
        bytes32 market = keccak256(bytes(symbol));
        if (_feeds[market].listed) revert AlreadyListed(market);
        if (feedId == bytes32(0) || unitExp > 0 || unitExp < -18 || maxConfBps == 0 || maxConfBps > MAX_CONF_BPS) {
            revert InvalidParam();
        }
        _feeds[market] = Feed({feedId: feedId, rollFactor: ONE, unitExp: unitExp, maxConfBps: maxConfBps, listed: true});
        emit FeedListed(symbol, market, feedId, unitExp, maxConfBps);
    }

    function setMaxConf(bytes32 market, uint16 maxConfBps) external onlyOwner {
        if (!_feeds[market].listed) revert UnknownMarket(market);
        if (maxConfBps == 0 || maxConfBps > MAX_CONF_BPS) revert InvalidParam();
        _feeds[market].maxConfBps = maxConfBps;
        emit MaxConfSet(market, maxConfBps);
    }

    /// @notice Announce the move to the next futures month, at least a day ahead.
    function scheduleRoll(string calldata symbol, bytes32 toFeedId, uint64 notBefore) external onlyOwner {
        bytes32 market = keccak256(bytes(symbol));
        Feed storage f = _feeds[market];
        if (!f.listed) revert UnknownMarket(market);
        if (toFeedId == bytes32(0) || toFeedId == f.feedId || notBefore < block.timestamp + ROLL_NOTICE) revert InvalidParam();
        if (pendingRebases[market].effectiveAt != 0) revert AdjustmentPending(market);
        pendingRolls[market] = PendingRoll({toFeedId: toFeedId, notBefore: notBefore});
        emit RollScheduled(symbol, market, toFeedId, notBefore);
    }

    function cancelRoll(bytes32 market) external onlyOwner {
        if (pendingRolls[market].notBefore == 0) revert NoRollScheduled(market);
        delete pendingRolls[market];
        emit RollCancelled(market);
    }

    /// @notice Announce a split, at least a day ahead: prices published at or
    ///         after `effectiveAt` — set between the last price before the
    ///         split and the first after it, i.e. while the market is shut —
    ///         are multiplied by `multiplier` (a 10-for-1 split is 10e18),
    ///         once `activateRebase` has checked it against the prices.
    function scheduleRebase(string calldata symbol, uint256 multiplier, uint64 effectiveAt) external onlyOwner {
        bytes32 market = keccak256(bytes(symbol));
        if (!_feeds[market].listed) revert UnknownMarket(market);
        if (multiplier < ONE / 1_000 || multiplier > ONE * 1_000 || multiplier == ONE) revert InvalidParam();
        if (effectiveAt < block.timestamp + ROLL_NOTICE) revert InvalidParam();
        if (pendingRolls[market].notBefore != 0 || pendingRebases[market].effectiveAt != 0) revert AdjustmentPending(market);
        pendingRebases[market] = PendingRebase({multiplier: multiplier, effectiveAt: effectiveAt, active: false});
        emit RebaseScheduled(market, multiplier, effectiveAt);
    }

    /// @notice Call a split off: at least a day before it — so a genuine one
    ///         can't be dropped at the last moment — or once a day has passed
    ///         since its time without the prices bearing it out (it was
    ///         postponed, or announced wrong). An active split can't be.
    function cancelRebase(bytes32 market) external onlyOwner {
        PendingRebase memory r = pendingRebases[market];
        if (r.effectiveAt == 0) revert NoRebaseScheduled(market);
        bool ahead = block.timestamp + ROLL_NOTICE <= r.effectiveAt;
        bool lapsed = !r.active && block.timestamp > uint256(r.effectiveAt) + REBASE_WINDOW;
        if (!ahead && !lapsed) revert RebaseLocked(r.effectiveAt);
        delete pendingRebases[market];
        emit RebaseCancelled(market);
    }

    /// @notice Switch an announced split on, checked against the market's own
    ///         prices: the first price published at or after its time (Pyth's
    ///         uniqueness check picks it), times the ratio, has to land within
    ///         0.8–1.25× of a price from the days before. Permissionless: a
    ///         split that didn't happen — or has the wrong ratio or time —
    ///         can't pass, and until one does, prices from its time on settle
    ///         nothing.
    function activateRebase(string calldata symbol, bytes[] calldata beforeData, bytes[] calldata afterData) external payable {
        bytes32 market = keccak256(bytes(symbol));
        Feed storage f = _feeds[market];
        PendingRebase storage r = pendingRebases[market];
        if (r.effectiveAt == 0) revert NoRebaseScheduled(market);
        if (r.active) revert RebaseAlreadyActive(market);
        if (block.timestamp < r.effectiveAt) revert RebaseNotDue(r.effectiveAt);

        bytes32[] memory ids = new bytes32[](1);
        ids[0] = f.feedId;
        uint256 feeBefore = pyth.getUpdateFee(beforeData);
        uint256 feeAfter = pyth.getUpdateFee(afterData);
        if (msg.value < feeBefore + feeAfter) revert InsufficientOracleFee(feeBefore + feeAfter, msg.value);
        (PythStructs.PriceFeed[] memory pre, ) = pyth.parsePriceFeedUpdatesWithConfig{value: feeBefore}(
            beforeData,
            ids,
            r.effectiveAt - uint64(REBASE_LOOKBACK),
            r.effectiveAt - 1,
            false,
            false,
            false
        );
        (PythStructs.PriceFeed[] memory post, ) = pyth.parsePriceFeedUpdatesWithConfig{value: feeAfter}(
            afterData,
            ids,
            r.effectiveAt,
            r.effectiveAt + uint64(REBASE_WINDOW),
            true,
            false,
            true
        );
        (uint256 priceBefore, ) = _normalize(f.feedId, pre[0].price, f.unitExp, f.maxConfBps);
        (uint256 priceAfter, ) = _normalize(f.feedId, post[0].price, f.unitExp, f.maxConfBps);
        uint256 adjusted = (priceAfter * r.multiplier) / ONE;
        if (adjusted * 5 < priceBefore * 4 || adjusted * 4 > priceBefore * 5) revert RebaseOutOfBounds(priceBefore, priceAfter);
        r.active = true;
        emit RebaseActivated(market, priceBefore, priceAfter);

        uint256 change = msg.value - feeBefore - feeAfter;
        if (change > 0) {
            (bool ok, ) = msg.sender.call{value: change}("");
            if (!ok) revert RefundFailed();
        }
    }

    /// @notice Fold an active split into the roll factor a day after its
    ///         time, once the price stored on chain is from after it (so no
    ///         read can meet a pre-split price again). Permissionless; changes
    ///         no price — the ratio already applied to every price since
    ///         `effectiveAt`.
    function finalizeRebase(string calldata symbol) external {
        bytes32 market = keccak256(bytes(symbol));
        PendingRebase memory r = pendingRebases[market];
        if (r.effectiveAt == 0) revert NoRebaseScheduled(market);
        if (!r.active) revert RebaseNotActive(market);
        uint256 at = uint256(r.effectiveAt) + REBASE_SETTLE;
        if (block.timestamp < at) revert RebaseNotSettled(at);
        Feed storage f = _feeds[market];
        if (pyth.getPriceUnsafe(f.feedId).publishTime < r.effectiveAt) revert RebaseNotSettled(at);
        f.rollFactor = (f.rollFactor * r.multiplier) / ONE;
        delete pendingRebases[market];
        emit RebaseFinalized(market, r.multiplier, f.rollFactor);
    }

    /// @notice Carry out an announced roll. Permissionless, because the
    ///         prices are fixed by the announcement: for each month, the
    ///         first Pyth price published at or after `notBefore` (Pyth's
    ///         uniqueness check), within `ROLL_WINDOW`, the two no more than
    ///         `ROLL_MAX_APART` apart, their ratio within 0.8–1.25.
    function executeRoll(string calldata symbol, bytes[] calldata updateData) external payable {
        bytes32 market = keccak256(bytes(symbol));
        Feed storage f = _feeds[market];
        PendingRoll memory roll = pendingRolls[market];
        if (roll.notBefore == 0) revert NoRollScheduled(market);
        if (pendingRebases[market].effectiveAt != 0) revert AdjustmentPending(market);
        if (block.timestamp < roll.notBefore) revert RollNotDue(roll.notBefore);
        if (block.timestamp > roll.notBefore + ROLL_DEADLINE) revert RollExpired(roll.notBefore);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = f.feedId;
        ids[1] = roll.toFeedId;
        uint256 fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientOracleFee(fee, msg.value);
        (PythStructs.PriceFeed[] memory feeds, ) = pyth.parsePriceFeedUpdatesWithConfig{value: fee}(
            updateData,
            ids,
            roll.notBefore,
            roll.notBefore + uint64(ROLL_WINDOW),
            true,
            false,
            true
        );

        (uint256 fromPrice, uint256 fromTime) = _normalize(f.feedId, feeds[0].price, f.unitExp, f.maxConfBps);
        (uint256 toPrice, uint256 toTime) = _normalize(roll.toFeedId, feeds[1].price, f.unitExp, f.maxConfBps);
        uint256 apart = fromTime > toTime ? fromTime - toTime : toTime - fromTime;
        if (apart > ROLL_MAX_APART) revert RollPricesApart(fromTime, toTime);
        if (fromPrice * 5 < toPrice * 4 || fromPrice * 4 > toPrice * 5) revert RollOutOfBounds(fromPrice, toPrice);

        bytes32 fromFeed = f.feedId;
        f.rollFactor = (f.rollFactor * fromPrice) / toPrice;
        f.feedId = roll.toFeedId;
        delete pendingRolls[market];
        emit FeedRolled(market, fromFeed, roll.toFeedId, fromPrice, toPrice, f.rollFactor);

        uint256 change = msg.value - fee;
        if (change > 0) {
            (bool ok, ) = msg.sender.call{value: change}("");
            if (!ok) revert RefundFailed();
        }
    }

    /* ------------------------------------------------------------------ */
    /* Reads                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice A Pyth price for this market in 18-decimal USD, and the index
    ///         it marks positions on. Refuses non-positive prices and prices
    ///         with too wide a confidence interval.
    function normalize(bytes32 market, PythStructs.Price calldata p) external view returns (uint256 price, uint256 index) {
        Feed storage f = _feeds[market];
        if (!f.listed) revert UnknownMarket(market);
        uint256 publishTime;
        (price, publishTime) = _normalize(f.feedId, p, f.unitExp, f.maxConfBps);
        index = _index(market, f, price, publishTime);
    }

    /// @notice The latest price stored on chain, if it's no older than `maxAge`
    ///         (requests, liquidations). One-sided: a price stamped ahead of
    ///         the chain's clock is fresh, not stale — otherwise whoever pushed
    ///         the newest print could block everyone else's reads.
    function readLatest(bytes32 market, uint256 maxAge)
        external
        view
        returns (uint256 price, uint256 index, uint256 publishTime)
    {
        Feed storage f = _feeds[market];
        if (!f.listed) revert UnknownMarket(market);
        PythStructs.Price memory p = pyth.getPriceUnsafe(f.feedId);
        if (p.publishTime + maxAge < block.timestamp) revert StalePrice(p.publishTime);
        (price, publishTime) = _normalize(f.feedId, p, f.unitExp, f.maxConfBps);
        index = _index(market, f, price, publishTime);
    }

    /// @notice The last price stored on chain however old it is — for views, never for settlement.
    function readUnsafe(bytes32 market) external view returns (uint256 price, uint256 index, uint256 publishTime) {
        Feed storage f = _feeds[market];
        if (!f.listed) revert UnknownMarket(market);
        PythStructs.Price memory p = pyth.getPriceUnsafe(f.feedId);
        (price, publishTime) = _normalize(f.feedId, p, f.unitExp, uint16(BPS));
        index = _index(market, f, price, publishTime);
    }

    /// @notice A price in the terms of one published at `publishTime`, as an
    ///         index — for turning a trader's price limit, quoted off the price
    ///         their request carried, into a limit on the index. Saturates
    ///         instead of overflowing.
    function indexAt(bytes32 market, uint256 price, uint256 publishTime) external view returns (uint256) {
        Feed storage f = _feeds[market];
        if (!f.listed) revert UnknownMarket(market);
        uint256 factor = (f.rollFactor * _rebaseAt(market, publishTime)) / ONE;
        if (price > type(uint256).max / factor) return type(uint256).max;
        return (price * factor) / ONE;
    }

    /// @dev price × rollFactor, and × a split's multiplier for prices published since it took effect.
    function _index(bytes32 market, Feed storage f, uint256 price, uint256 publishTime) internal view returns (uint256) {
        return (((price * f.rollFactor) / ONE) * _rebaseAt(market, publishTime)) / ONE;
    }

    /// @dev The split multiplier for a price published at `publishTime` (1e18 before any split).
    ///      A price from after a split that isn't active yet settles nothing.
    function _rebaseAt(bytes32 market, uint256 publishTime) internal view returns (uint256) {
        PendingRebase storage r = pendingRebases[market];
        if (r.effectiveAt == 0 || publishTime < r.effectiveAt) return ONE;
        if (!r.active) revert RebaseNotActive(market);
        return r.multiplier;
    }

    function feedOf(bytes32 market)
        external
        view
        returns (bytes32 feedId, uint256 rollFactor, int8 unitExp, uint16 maxConfBps, bool listed)
    {
        Feed storage f = _feeds[market];
        return (f.feedId, f.rollFactor, f.unitExp, f.maxConfBps, f.listed);
    }

    function isListed(bytes32 market) external view returns (bool) {
        return _feeds[market].listed;
    }

    /// @dev price × 10^(18 + expo + unitExp), refusing non-positive prices and wide confidence.
    function _normalize(bytes32 feedId, PythStructs.Price memory p, int8 unitExp, uint16 maxConfBps)
        internal
        pure
        returns (uint256 price, uint256 publishTime)
    {
        if (p.price <= 0) revert BadPrice(feedId);
        uint256 raw = uint256(uint64(p.price));
        if (uint256(p.conf) * BPS > raw * maxConfBps) revert ConfidenceTooWide(feedId, p.conf, p.price);
        int256 exp = 18 + int256(p.expo) + int256(unitExp);
        if (exp > 36 || exp < -36) revert BadPrice(feedId);
        price = exp >= 0 ? raw * 10 ** uint256(exp) : raw / 10 ** uint256(-exp);
        if (price == 0) revert BadPrice(feedId);
        publishTime = p.publishTime;
    }
}
