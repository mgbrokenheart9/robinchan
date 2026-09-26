// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// Chainlink's feed interface (AggregatorV3Interface), as its proxies expose it.
interface IChainlinkFeed {
    function decimals() external view returns (uint8);
    function description() external view returns (string memory);
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
    function getRoundData(uint80 roundId)
        external
        view
        returns (uint80, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound);
}

/// @title AgriFeed — Chainlink Data Feeds for the AgriPerp markets
/// @notice Maps a market (keccak256 of its symbol) to a Chainlink price feed
///         proxy and turns its answers into 18-decimal USD prices.
///
///         Chainlink Data Feeds are pushed: a new round lands when the price
///         moves past the feed's deviation threshold, or its heartbeat
///         passes. Each round carries two times: when the oracles observed
///         the price (`startedAt`) and when it landed on chain (`updatedAt`),
///         about 13 seconds later on Robinhood Chain. An order settles on the
///         first round *observed* after its request and landed at least a set
///         delay after it — a price that didn't exist when the order was
///         placed, not one already on its way. It's the only round that
///         qualifies: the rounds landed before it since the request were all
///         observed earlier, which the feed's own history proves (a proxy
///         numbers rounds consecutively within a phase). When no round
///         qualifies in an order's window, the same history proves that too.
///
///         A proxy's phase changes when Chainlink moves it to a new
///         aggregator, and the old aggregator's rounds stay readable. Every
///         read here is pinned to the phase an order was requested in: an
///         order whose feed has moved on can't fill on either aggregator.
///
///         Prices are marked as they come: no roll factor, no split
///         adjustment. Robinhood's stock feeds report the token's total return
///         value, already continuous through splits and dividends.
contract AgriFeed is Ownable {
    struct Feed {
        IChainlinkFeed proxy;
        uint8 decimals;
        bool listed;
    }

    /// Rounds a proof looks back through. Past a request it only passes over
    /// rounds observed before it — in flight when it was placed — and rounds
    /// land 12–73 seconds after they're observed: 64 of them in flight would
    /// take a round a second, beyond what a Chainlink network publishes.
    uint256 public constant MAX_LOOKBACK = 64;

    mapping(bytes32 => Feed) internal _feeds;

    event FeedListed(string symbol, bytes32 indexed market, address proxy, uint8 decimals, string description);

    error UnknownMarket(bytes32 market);
    error AlreadyListed(bytes32 market);
    error InvalidParam();
    error BadPrice(bytes32 market);
    error StalePrice(uint256 updatedAt);
    error RoundNotFound(uint80 roundId);
    error RoundOutOfWindow(uint256 updatedAt);
    error ObservedBeforeRequest(uint256 observedAt);
    error NotFirstRound(uint80 roundId);
    error NotLatestRound(uint80 roundId);
    error WrongPhase(uint80 roundId);
    error FeedUpgraded(uint16 phase);

    constructor(address owner_) Ownable(owner_) {}

    /// @notice Add a market's feed. A listed market's feed never changes: a
    ///         market whose feed Chainlink retires is delisted, not re-pointed.
    function listFeed(string calldata symbol, address proxy) external onlyOwner {
        bytes32 market = keccak256(bytes(symbol));
        if (_feeds[market].listed) revert AlreadyListed(market);
        if (proxy.code.length == 0) revert InvalidParam();
        IChainlinkFeed feed = IChainlinkFeed(proxy);
        uint8 dec = feed.decimals();
        if (dec > 18) revert InvalidParam();
        (, int256 answer, uint256 startedAt, uint256 updatedAt, ) = feed.latestRoundData();
        // Orders need the observation time: a feed without one can't settle them.
        if (answer <= 0 || updatedAt == 0 || startedAt == 0 || startedAt > updatedAt) revert BadPrice(market);
        _feeds[market] = Feed({proxy: feed, decimals: dec, listed: true});
        emit FeedListed(symbol, market, proxy, dec, feed.description());
    }

    /* ------------------------------------------------------------------ */
    /* Reads                                                               */
    /* ------------------------------------------------------------------ */

    /// @notice The latest round, if it was published no more than `maxAge`
    ///         ago (requests, liquidations), and the phase it's in. A healthy
    ///         feed publishes at least once a heartbeat; one quieter than that
    ///         has stopped, or its market is shut.
    function readLatest(bytes32 market, uint256 maxAge)
        external
        view
        returns (uint256 price, uint256 index, uint256 publishTime, uint16 phase)
    {
        Feed storage f = _feed(market);
        (uint80 roundId, int256 answer, , uint256 updatedAt, ) = f.proxy.latestRoundData();
        if (updatedAt == 0 || updatedAt + maxAge < block.timestamp) revert StalePrice(updatedAt);
        price = _normalize(market, answer, f.decimals);
        return (price, price, updatedAt, _phaseOf(roundId));
    }

    /// @notice The latest round however old it is — for views and delisting, never for settling an order.
    function readUnsafe(bytes32 market) external view returns (uint256 price, uint256 index, uint256 publishTime) {
        Feed storage f = _feed(market);
        (, int256 answer, , uint256 updatedAt, ) = f.proxy.latestRoundData();
        price = _normalize(market, answer, f.decimals);
        return (price, price, updatedAt);
    }

    /// @notice The phase the market's proxy reads from now.
    function currentPhase(bytes32 market) public view returns (uint16) {
        (uint80 roundId, , , , ) = _feed(market).proxy.latestRoundData();
        return _phaseOf(roundId);
    }

    /// @notice The price an order settles on: round `roundId` of `phase`, which
    ///         has to be the proxy's phase still, be observed at or after
    ///         `observedFrom`, land between `notBefore` and `notAfter`, and be
    ///         the first round that does — every round landed since
    ///         `notBefore` before it was observed earlier. Also returns when
    ///         the round was observed. A round reporting a non-positive price
    ///         returns 0, so the order is cancelled rather than stuck on it.
    function readRound(bytes32 market, uint16 phase, uint80 roundId, uint256 observedFrom, uint256 notBefore, uint256 notAfter)
        external
        view
        returns (uint256 price, uint256 index, uint256 publishTime, uint256 observedAt)
    {
        Feed storage f = _feed(market);
        _requirePhase(market, phase, roundId);
        (int256 answer, uint256 startedAt, uint256 updatedAt) = _round(f.proxy, roundId);
        if (updatedAt == 0) revert RoundNotFound(roundId);
        if (updatedAt < notBefore || updatedAt > notAfter) revert RoundOutOfWindow(updatedAt);
        observedAt = _observed(startedAt, updatedAt);
        if (observedAt < observedFrom) revert ObservedBeforeRequest(observedAt);
        if (_qualifiesBefore(f.proxy, roundId, observedFrom, notBefore)) revert NotFirstRound(roundId);
        price = answer > 0 ? uint256(answer) * 10 ** (18 - uint256(f.decimals)) : 0;
        return (price, price, updatedAt, observedAt);
    }

    /// @notice Whether no round of `phase` qualified for an order in its
    ///         window (observed at or after `observedFrom`, landed between
    ///         `notBefore` and `notAfter`) — the proof that frees an order
    ///         its feed never priced. `roundId` is the first round landed
    ///         after the window or, when none has yet, the latest.
    function noRoundIn(bytes32 market, uint16 phase, uint80 roundId, uint256 observedFrom, uint256 notBefore, uint256 notAfter)
        external
        view
        returns (bool)
    {
        Feed storage f = _feed(market);
        _requirePhase(market, phase, roundId);
        (, uint256 startedAt, uint256 updatedAt) = _round(f.proxy, roundId);
        if (updatedAt == 0) revert RoundNotFound(roundId);
        if (updatedAt > notAfter) {
            // The first round after the window: the one before it landed in the window, or before it.
            if (uint64(roundId) > 1) {
                (, , uint256 previous) = _round(f.proxy, roundId - 1);
                if (previous > notAfter) revert NotFirstRound(roundId);
            }
            return !_qualifiesBefore(f.proxy, roundId, observedFrom, notBefore);
        }
        (uint80 latestId, , , , ) = f.proxy.latestRoundData();
        if (roundId != latestId) revert NotLatestRound(roundId);
        if (updatedAt < notBefore) return true;
        if (_observed(startedAt, updatedAt) >= observedFrom) return false;
        return !_qualifiesBefore(f.proxy, roundId, observedFrom, notBefore);
    }

    /// @notice Whether an order's price is out: the latest round was observed
    ///         at or after `observedFrom` and landed at or after `notBefore`.
    function publishedSince(bytes32 market, uint256 observedFrom, uint256 notBefore) external view returns (bool) {
        (, , uint256 startedAt, uint256 updatedAt, ) = _feed(market).proxy.latestRoundData();
        return updatedAt >= notBefore && _observed(startedAt, updatedAt) >= observedFrom;
    }

    function feedOf(bytes32 market) external view returns (address proxy, uint8 decimals, bool listed) {
        Feed storage f = _feeds[market];
        return (address(f.proxy), f.decimals, f.listed);
    }

    function isListed(bytes32 market) external view returns (bool) {
        return _feeds[market].listed;
    }

    function _feed(bytes32 market) internal view returns (Feed storage f) {
        f = _feeds[market];
        if (!f.listed) revert UnknownMarket(market);
    }

    function _requirePhase(bytes32 market, uint16 phase, uint80 roundId) internal view {
        if (_phaseOf(roundId) != phase) revert WrongPhase(roundId);
        if (currentPhase(market) != phase) revert FeedUpgraded(phase);
    }

    /// @dev Whether a round before `roundId`, landed at or after `notBefore`,
    ///      was observed at or after `observedFrom` — walking back to the
    ///      first round landed before `notBefore`. Reverts when it can't tell
    ///      (the start of a phase, or past MAX_LOOKBACK).
    function _qualifiesBefore(IChainlinkFeed proxy, uint80 roundId, uint256 observedFrom, uint256 notBefore)
        internal
        view
        returns (bool)
    {
        uint80 id = roundId;
        for (uint256 i = 0; i < MAX_LOOKBACK && uint64(id) > 1; ++i) {
            id -= 1;
            (, uint256 s, uint256 u) = _round(proxy, id);
            if (u == 0) break;
            if (u < notBefore) return false;
            if (_observed(s, u) >= observedFrom) return true;
        }
        revert NotFirstRound(roundId);
    }

    /// @dev When a round's price was observed: no later than it landed, whatever the oracles' clocks say.
    function _observed(uint256 startedAt, uint256 updatedAt) internal pure returns (uint256) {
        return startedAt < updatedAt ? startedAt : updatedAt;
    }

    function _phaseOf(uint80 roundId) internal pure returns (uint16) {
        return uint16(roundId >> 64);
    }

    /// @dev A round's answer and times; zeros when the proxy has no such round (some revert, some return zeros).
    function _round(IChainlinkFeed proxy, uint80 roundId)
        internal
        view
        returns (int256 answer, uint256 startedAt, uint256 updatedAt)
    {
        try proxy.getRoundData(roundId) returns (uint80, int256 a, uint256 s, uint256 u, uint80) {
            return (a, s, u);
        } catch {
            return (0, 0, 0);
        }
    }

    /// @dev answer × 10^(18 − decimals), refusing non-positive answers.
    function _normalize(bytes32 market, int256 answer, uint8 dec) internal pure returns (uint256) {
        if (answer <= 0) revert BadPrice(market);
        return uint256(answer) * 10 ** (18 - uint256(dec));
    }
}
