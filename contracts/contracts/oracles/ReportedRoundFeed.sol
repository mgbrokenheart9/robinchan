// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @title ReportedRoundFeed — prices a reporter posts, as Chainlink-style rounds
/// @notice For markets no oracle network prices on Robinhood Chain (the agri
///         futures): the operator's reporter posts each price with the time it
///         was quoted on its exchange, and AgriFeed lists this feed like a
///         Chainlink proxy — AgriPerp settles on it unchanged.
///
///         **Trust.** This feed is only as honest as its reporter. Nothing
///         here proves a price is the market's; traders trust the operator,
///         and a stolen reporter key can post false prices. What the contract
///         does hold the reporter to: a round's quote time is when the price
///         was quoted, not when it's posted — so an order, which settles on
///         the first round quoted after it, can't be filled at a price anyone
///         could see when they placed it, however late the data arrives. A
///         quote can't be older than an hour, can't be older than the last
///         round's, and can't move the price more than `maxMoveBps` in one
///         round (a data error, or a stolen key, is capped per round); a move
///         past that needs the owner.
///
///         Futures roll: when the reporter moves to the next contract month,
///         it posts both months' prices and the cumulative `rollFactor` takes
///         old/new, keeping the answer continuous — positions neither gain nor
///         lose the calendar spread. `source` says what the reporter reads now.
contract ReportedRoundFeed is Ownable {
    uint256 internal constant ONE = 1e18;
    uint256 internal constant BPS = 10_000;
    /// Round ids carry phase 1 in their top bits, as a Chainlink proxy's do.
    uint80 internal constant PHASE = uint80(1) << 64;

    /// A quote older than this when it's posted is refused.
    uint256 public constant MAX_QUOTE_AGE = 1 hours;
    uint8 public constant decimals = 8;
    uint256 public constant version = 1;

    /// A report moving the answer more than this share in one round is refused.
    uint16 public immutable maxMoveBps;
    string public description;
    /// What the reporter reads, e.g. "Yahoo Finance KCZ26.NYB (delayed)".
    string public source;
    address public reporter;
    /// Cumulative roll adjustment, 1e18 = none yet.
    uint256 public rollFactor = ONE;
    uint64 public roundCount;

    struct Round {
        int128 answer;
        uint64 startedAt;
        uint64 updatedAt;
    }

    mapping(uint64 => Round) internal _rounds;

    event ReporterSet(address reporter);
    event PriceReported(uint80 indexed roundId, int256 answer, uint256 price, uint64 quotedAt, bool checked);
    event Rolled(uint256 fromPrice, uint256 toPrice, uint256 rollFactor, string source);

    error NotReporter();
    error InvalidParam();
    error NoRound(uint80 roundId);
    error QuoteInFuture(uint64 quotedAt);
    error QuoteTooOld(uint64 quotedAt);
    error QuoteNotNewer(uint64 quotedAt, uint64 lastQuotedAt);
    error MoveTooLarge(uint256 answer, uint256 lastAnswer);
    error RollOutOfBounds(uint256 fromPrice, uint256 toPrice);

    modifier onlyReporter() {
        if (msg.sender != reporter) revert NotReporter();
        _;
    }

    constructor(string memory description_, string memory source_, uint16 maxMoveBps_, address reporter_, address owner_)
        Ownable(owner_)
    {
        if (maxMoveBps_ == 0 || maxMoveBps_ > 5_000 || reporter_ == address(0)) revert InvalidParam();
        description = description_;
        source = source_;
        maxMoveBps = maxMoveBps_;
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    /* ------------------------------------------------------------------ */
    /* Reporting                                                           */
    /* ------------------------------------------------------------------ */

    /// @notice A new round: `price` (8-decimal USD, before the roll factor),
    ///         quoted on its exchange at `quotedAt`.
    function report(uint256 price, uint64 quotedAt) external onlyReporter returns (uint80) {
        return _report(price, quotedAt, true);
    }

    /// @notice A round past `maxMoveBps` the owner has checked — a limit-move
    ///         day, a gap over a closure. The other rules still apply.
    function reportUnchecked(uint256 price, uint64 quotedAt) external onlyOwner returns (uint80) {
        return _report(price, quotedAt, false);
    }

    /// @notice Move to the next contract month: both months' prices, quoted
    ///         together, set the roll factor; `newSource` is what's read next.
    function roll(uint256 fromPrice, uint256 toPrice, string calldata newSource) external onlyReporter {
        if (fromPrice == 0 || toPrice == 0) revert InvalidParam();
        if (fromPrice * 5 < toPrice * 4 || fromPrice * 4 > toPrice * 5) revert RollOutOfBounds(fromPrice, toPrice);
        rollFactor = (rollFactor * fromPrice) / toPrice;
        source = newSource;
        emit Rolled(fromPrice, toPrice, rollFactor, newSource);
    }

    function setReporter(address reporter_) external onlyOwner {
        if (reporter_ == address(0)) revert InvalidParam();
        reporter = reporter_;
        emit ReporterSet(reporter_);
    }

    function _report(uint256 price, uint64 quotedAt, bool checkMove) internal returns (uint80 roundId) {
        if (price == 0) revert InvalidParam();
        if (quotedAt > block.timestamp) revert QuoteInFuture(quotedAt);
        if (quotedAt + MAX_QUOTE_AGE < block.timestamp) revert QuoteTooOld(quotedAt);
        uint256 answer = (price * rollFactor) / ONE;
        if (answer == 0 || answer > uint256(uint128(type(int128).max))) revert InvalidParam();
        if (roundCount > 0) {
            Round memory last = _rounds[roundCount];
            if (quotedAt <= last.startedAt) revert QuoteNotNewer(quotedAt, last.startedAt);
            uint256 prev = uint256(int256(last.answer));
            uint256 diff = answer > prev ? answer - prev : prev - answer;
            if (checkMove && diff * BPS > prev * maxMoveBps) revert MoveTooLarge(answer, prev);
        }
        roundCount += 1;
        roundId = PHASE | uint80(roundCount);
        _rounds[roundCount] = Round({answer: int128(int256(answer)), startedAt: quotedAt, updatedAt: uint64(block.timestamp)});
        emit PriceReported(roundId, int256(answer), price, quotedAt, checkMove);
    }

    /* ------------------------------------------------------------------ */
    /* Chainlink's AggregatorV3Interface                                   */
    /* ------------------------------------------------------------------ */

    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundCount == 0) revert NoRound(0);
        return _roundData(roundCount);
    }

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
}
