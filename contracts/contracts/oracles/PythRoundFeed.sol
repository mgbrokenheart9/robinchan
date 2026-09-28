// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPyth} from "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import {PythStructs} from "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

/// @title PythRoundFeed — a Pyth price as Chainlink-style rounds
/// @notice Turns one Pyth price feed into a feed AgriFeed can list as it lists
///         a Chainlink proxy: numbered rounds, each with the time the price
///         was observed (`startedAt`, Pyth's publish time) and the time it
///         landed on chain (`updatedAt`). AgriPerp then settles orders on it
///         exactly as it does on Chainlink: at the first round observed after
///         the request, proven from the rounds before it.
///
///         Pyth is pulled — anyone brings a signed price on chain — so the
///         rounds can't be whatever a pusher picks, or whoever holds an order
///         would push the print that suits it. Time is cut into `slot`-long
///         slots, and each round is Pyth's *first* print at or after the next
///         slot's start (the Pyth contract checks the uniqueness: the print
///         before it was earlier). The next slot starts after the slot of the
///         print just recorded. So the whole sequence of rounds follows from
///         Pyth's history alone; pushing only decides when a round lands,
///         never which price it carries. A market that isn't trading prints
///         nothing, and the first print after it reopens is the next round.
///
///         Pyth prices coffee, cocoa and sugar only as dated futures, so the
///         feed walks from one contract month to the next. A roll is announced
///         a day ahead; from its time until it's carried out no round can be
///         pushed, and it's carried out with each month's first print at or
///         after that time — a moment nobody picks. The cumulative
///         `rollFactor` is multiplied by old/new then, keeping the answer
///         continuous across the roll: positions neither gain nor lose the
///         calendar spread.
///
///         Answers have 8 decimals, in USD (feeds quoted in US cents are
///         scaled). A print with a non-positive price or a confidence interval
///         wider than `maxConfBps` of it still makes its round, answering 0,
///         which AgriPerp treats as a bad price: an order it would have
///         settled is cancelled, never filled on it.
contract PythRoundFeed is Ownable {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BPS = 10_000;
    /// Round ids carry phase 1 in their top bits, as a Chainlink proxy's do.
    uint80 internal constant PHASE = uint80(1) << 64;

    /// A roll is announced at least this long before its time.
    uint256 public constant ROLL_NOTICE = 1 days;
    /// Both months' prices must be the first published within this long after the roll time…
    uint256 public constant ROLL_WINDOW = 60;
    /// …and no further apart than this.
    uint256 public constant ROLL_MAX_APART = 5;
    /// A roll not carried out within this long of its time lapses; rounds resume on the old month.
    uint256 public constant ROLL_DEADLINE = 1 hours;
    /// The widest confidence interval a feed can be set to accept.
    uint16 public constant MAX_CONF_BPS = 500;
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;

    IPyth public immutable pyth;
    /// Seconds between the slots rounds are cut at.
    uint64 public immutable slot;
    /// 0 for USD-quoted feeds, -2 for feeds quoted in US cents.
    int8 public immutable unitExp;
    /// Prints whose confidence interval is wider than this share of the price answer 0.
    uint16 public immutable maxConfBps;
    string public description;

    /// The Pyth feed rounds are read from now (the current contract month).
    bytes32 public feedId;
    /// Cumulative roll adjustment, 1e18 = none yet.
    uint256 public rollFactor = ONE;
    /// The next round is Pyth's first print at or after this time.
    uint64 public nextSlot;
    /// Rounds so far; round n has id PHASE | n.
    uint64 public roundCount;

    struct Round {
        int128 answer;
        uint64 startedAt;
        uint64 updatedAt;
    }

    struct PendingRoll {
        bytes32 toFeedId;
        uint64 notBefore;
    }

    mapping(uint64 => Round) internal _rounds;
    PendingRoll public pendingRoll;

    event RoundPushed(uint80 indexed roundId, int256 answer, uint64 publishTime, uint64 nextSlot);
    event RollScheduled(bytes32 toFeedId, uint64 notBefore);
    event RollCancelled();
    event FeedRolled(bytes32 fromFeedId, bytes32 toFeedId, uint256 fromPrice, uint256 toPrice, uint256 rollFactor);

    error InvalidParam();
    error NoRound(uint80 roundId);
    error InsufficientOracleFee(uint256 fee, uint256 sent);
    error RefundFailed();
    error RollDue(uint64 notBefore);
    error NoRollScheduled();
    error RollNotDue(uint64 notBefore);
    error RollExpired(uint64 notBefore);
    error RollPricesApart(uint256 fromPublishTime, uint256 toPublishTime);
    error RollOutOfBounds(uint256 fromPrice, uint256 toPrice);
    error BadRollPrice(bytes32 feedId);

    /// @param firstSlot The first round is Pyth's first print at or after this time (0: the next slot from now).
    constructor(
        address pyth_,
        bytes32 feedId_,
        uint64 slot_,
        int8 unitExp_,
        uint16 maxConfBps_,
        uint64 firstSlot,
        string memory description_,
        address owner_
    ) Ownable(owner_) {
        if (pyth_.code.length == 0 || feedId_ == bytes32(0)) revert InvalidParam();
        if (slot_ < 10 || slot_ > 1 days) revert InvalidParam();
        if (unitExp_ > 0 || unitExp_ < -6) revert InvalidParam();
        if (maxConfBps_ == 0 || maxConfBps_ > MAX_CONF_BPS) revert InvalidParam();
        pyth = IPyth(pyth_);
        feedId = feedId_;
        slot = slot_;
        unitExp = unitExp_;
        maxConfBps = maxConfBps_;
        description = description_;
        nextSlot = firstSlot != 0 ? firstSlot : uint64((block.timestamp / slot_ + 1) * slot_);
    }

    /* ------------------------------------------------------------------ */
    /* Rounds                                                              */
    /* ------------------------------------------------------------------ */

    /// @notice Record the next round: Pyth's first print of `feedId` at or
    ///         after `nextSlot`, from `updateData` (Hermes' update at that
    ///         time). Permissionless — the round is fixed by Pyth's history.
    ///         Pays Pyth's update fee from `msg.value` and returns the rest.
    function push(bytes[] calldata updateData) external payable returns (uint80 roundId) {
        PendingRoll memory r = pendingRoll;
        if (r.notBefore != 0 && block.timestamp >= r.notBefore && block.timestamp <= r.notBefore + ROLL_DEADLINE) {
            revert RollDue(r.notBefore);
        }
        bytes32[] memory ids = new bytes32[](1);
        ids[0] = feedId;
        uint256 fee = _fee(updateData);
        (PythStructs.PriceFeed[] memory feeds, ) =
            pyth.parsePriceFeedUpdatesWithConfig{value: fee}(updateData, ids, nextSlot, type(uint64).max, true, false, false);

        PythStructs.Price memory p = feeds[0].price;
        uint64 published = uint64(p.publishTime);
        int256 answer = _answer(p);
        roundCount += 1;
        roundId = PHASE | uint80(roundCount);
        uint64 landed = uint64(block.timestamp);
        _rounds[roundCount] = Round({answer: int128(answer), startedAt: published < landed ? published : landed, updatedAt: landed});
        nextSlot = (published / slot + 1) * slot;
        emit RoundPushed(roundId, answer, published, nextSlot);
        _refund(fee);
    }

    /// @notice Chainlink's AggregatorV3Interface: the latest round.
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundCount == 0) revert NoRound(0);
        return _roundData(roundCount);
    }

    /// @notice Chainlink's AggregatorV3Interface: round `roundId` (phase 1).
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        uint64 n = uint64(roundId);
        if (roundId >> 64 != 1 || n == 0 || n > roundCount) revert NoRound(roundId);
        return _roundData(n);
    }

    function _roundData(uint64 n) internal view returns (uint80, int256, uint256, uint256, uint80) {
        Round memory r = _rounds[n];
        uint80 id = PHASE | uint80(n);
        return (id, int256(r.answer), r.startedAt, r.updatedAt, id);
    }

    /* ------------------------------------------------------------------ */
    /* Rolls                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice Announce the move to the next contract month at `notBefore`, at least a day ahead.
    function scheduleRoll(bytes32 toFeedId, uint64 notBefore) external onlyOwner {
        if (toFeedId == bytes32(0) || toFeedId == feedId) revert InvalidParam();
        if (notBefore < block.timestamp + ROLL_NOTICE) revert InvalidParam();
        pendingRoll = PendingRoll({toFeedId: toFeedId, notBefore: notBefore});
        emit RollScheduled(toFeedId, notBefore);
    }

    function cancelRoll() external onlyOwner {
        if (pendingRoll.notBefore == 0) revert NoRollScheduled();
        delete pendingRoll;
        emit RollCancelled();
    }

    /// @notice Carry out an announced roll. Permissionless, because the
    ///         prices are fixed by the announcement: for each month, the
    ///         first Pyth print at or after `notBefore` (Pyth's uniqueness
    ///         check), within `ROLL_WINDOW`, the two no more than
    ///         `ROLL_MAX_APART` apart, their ratio within 0.8–1.25. The next
    ///         round is the new month's first print from the roll time on.
    function executeRoll(bytes[] calldata updateData) external payable {
        PendingRoll memory r = pendingRoll;
        if (r.notBefore == 0) revert NoRollScheduled();
        if (block.timestamp < r.notBefore) revert RollNotDue(r.notBefore);
        if (block.timestamp > r.notBefore + ROLL_DEADLINE) revert RollExpired(r.notBefore);

        bytes32[] memory ids = new bytes32[](2);
        ids[0] = feedId;
        ids[1] = r.toFeedId;
        uint256 fee = _fee(updateData);
        (PythStructs.PriceFeed[] memory feeds, ) = pyth.parsePriceFeedUpdatesWithConfig{value: fee}(
            updateData, ids, r.notBefore, r.notBefore + uint64(ROLL_WINDOW), true, false, false
        );
        uint256 fromPrice = _rollPrice(ids[0], feeds[0].price);
        uint256 toPrice = _rollPrice(ids[1], feeds[1].price);
        uint256 fromTime = feeds[0].price.publishTime;
        uint256 toTime = feeds[1].price.publishTime;
        if ((fromTime > toTime ? fromTime - toTime : toTime - fromTime) > ROLL_MAX_APART) revert RollPricesApart(fromTime, toTime);
        if (fromPrice * 5 < toPrice * 4 || fromPrice * 4 > toPrice * 5) revert RollOutOfBounds(fromPrice, toPrice);

        bytes32 fromFeed = feedId;
        rollFactor = (rollFactor * fromPrice) / toPrice;
        feedId = r.toFeedId;
        if (nextSlot < r.notBefore) nextSlot = r.notBefore;
        delete pendingRoll;
        emit FeedRolled(fromFeed, r.toFeedId, fromPrice, toPrice, rollFactor);
        _refund(fee);
    }

    /* ------------------------------------------------------------------ */
    /* Internals                                                           */
    /* ------------------------------------------------------------------ */

    /// @dev The print as an 8-decimal USD answer times the roll factor; 0 for a bad or too uncertain print.
    function _answer(PythStructs.Price memory p) internal view returns (int256) {
        if (p.price <= 0) return 0;
        uint256 raw = uint256(uint64(p.price));
        if (uint256(p.conf) * BPS > raw * maxConfBps) return 0;
        uint256 usd = _scale(raw, p.expo);
        if (usd == 0) return 0;
        uint256 adjusted = (usd * rollFactor) / ONE;
        if (adjusted == 0 || adjusted > uint256(uint128(type(int128).max))) return 0;
        return int256(adjusted);
    }

    /// @dev A roll's price: like an answer before the roll factor, but a bad print reverts the roll instead.
    function _rollPrice(bytes32 id, PythStructs.Price memory p) internal view returns (uint256 usd) {
        if (p.price <= 0) revert BadRollPrice(id);
        uint256 raw = uint256(uint64(p.price));
        if (uint256(p.conf) * BPS > raw * maxConfBps) revert BadRollPrice(id);
        usd = _scale(raw, p.expo);
        if (usd == 0) revert BadRollPrice(id);
    }

    /// @dev raw × 10^(8 + expo + unitExp), 0 when out of range.
    function _scale(uint256 raw, int32 expo) internal view returns (uint256) {
        int256 exp = int256(uint256(decimals)) + int256(expo) + int256(unitExp);
        if (exp > 30 || exp < -30) return 0;
        return exp >= 0 ? raw * 10 ** uint256(exp) : raw / 10 ** uint256(-exp);
    }

    function _fee(bytes[] calldata updateData) internal view returns (uint256 fee) {
        fee = pyth.getUpdateFee(updateData);
        if (msg.value < fee) revert InsufficientOracleFee(fee, msg.value);
    }

    function _refund(uint256 fee) internal {
        uint256 change = msg.value - fee;
        if (change == 0) return;
        (bool ok, ) = msg.sender.call{value: change}("");
        if (!ok) revert RefundFailed();
    }
}
