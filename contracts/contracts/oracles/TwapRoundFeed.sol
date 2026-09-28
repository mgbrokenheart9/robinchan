// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";

/// Uniswap V2's pair, as its price oracle reads it.
interface IUniswapV2PairLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast);
    function price0CumulativeLast() external view returns (uint256);
    function price1CumulativeLast() external view returns (uint256);
}

/// Uniswap V3's pool, as its price oracle reads it.
interface IUniswapV3PoolLike {
    function token0() external view returns (address);
    function token1() external view returns (address);
    function observe(uint32[] calldata secondsAgos)
        external
        view
        returns (int56[] memory tickCumulatives, uint160[] memory secondsPerLiquidityCumulativeX128s);
}

/// A Chainlink feed's latest round (the quote token's USD price).
interface IUsdFeed {
    function decimals() external view returns (uint8);
    function latestRoundData() external view returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80);
}

interface IERC20Like {
    function decimals() external view returns (uint8);
    function balanceOf(address account) external view returns (uint256);
}

/// @title TwapRoundFeed — a Uniswap pool's TWAP as Chainlink-style rounds
/// @notice For Robinhood Chain tokens no oracle network prices: each round is
///         the token's time-weighted average price over `window` seconds,
///         read from the pool's own running record of its price — a Uniswap
///         V2 pair's cumulative price, or a V3 pool's cumulative tick — which
///         a trade inside one block can't move (flash loans don't reach it).
///         It's turned into USD with a Chainlink feed for the quote token
///         (ETH/USD for a WETH pool). AgriFeed lists it like a Chainlink
///         proxy and AgriPerp settles on it unchanged. (A V3 average is the
///         geometric mean of the price over the window; a V2 one, the
///         arithmetic mean.)
///
///         A round's observed time (`startedAt`) is when its window *began*,
///         not when it ended. An order settles on the first round observed
///         after it — so on an average of prices that all came after the order.
///         A TWAP read at the end of its window would trail the market, and
///         whoever saw the spot price move could trade against that lag.
///
///         Guards, each answering 0 (a bad-price round: an order it would
///         settle is cancelled and refunded) rather than a doubtful price:
///         the pool holding less than `minLiquidityUsd` (a thin pool's average
///         is cheap to push), or the quote's USD feed being stale. And a
///         circuit breaker: once no round has landed for `maxStaleness`, the
///         latest round reads as 0 — new orders and liquidations stop — until
///         rounds resume.
///
///         `update()` is permissionless: the keeper calls it every
///         `granularity` seconds, and anyone can. It records an observation
///         of the pool's cumulative price and, once one from `window` seconds
///         back is on record, makes a round. Calling it at a chosen moment
///         only moves which second a 15-minute average ends on.
contract TwapRoundFeed is Ownable {
    enum PoolKind {
        UniswapV2,
        UniswapV3
    }

    uint256 internal constant Q128 = 2 ** 128;
    /// Round ids carry phase 1 in their top bits, as a Chainlink proxy's do.
    uint80 internal constant PHASE = uint80(1) << 64;
    /// Observations kept: enough to always find one a window back.
    uint256 internal constant SLOTS = 24;
    /// Uniswap V3's tick range.
    int256 internal constant MAX_TICK = 887_272;

    /// 18, as AgriFeed's own prices: a memecoin worth a millionth of a dollar keeps its digits.
    uint8 public constant decimals = 18;
    uint256 public constant version = 2;

    PoolKind public immutable kind;
    /// The pool: a Uniswap V2 pair or a V3 pool.
    address public immutable pair;
    /// Whether the token priced is the pool's token0 (the quote is the other).
    bool public immutable baseIsToken0;
    /// The other side of the pool.
    address public immutable quoteToken;
    uint8 internal immutable baseDecimals;
    uint8 internal immutable quoteDecimals;
    /// The quote token's USD feed (Chainlink ETH/USD for a WETH pool); zero for a USD-pegged quote.
    IUsdFeed public immutable quoteUsdFeed;
    uint8 internal immutable quoteUsdDecimals;
    /// Seconds a round's average spans.
    uint32 public immutable window;
    /// Seconds between observations: the keeper's cadence.
    uint32 public immutable granularity;
    /// A round with no fresh round after it for this long reads as 0.
    uint32 public immutable maxStaleness;
    /// The quote feed's answer may be at most this old (its heartbeat, and some).
    uint32 public immutable quoteFeedMaxAge;

    string public description;
    /// The pool, for people, e.g. "Uniswap V3 CASHCAT/WETH".
    string public source;
    /// The least the pool may hold, both sides together in USD (18 decimals), for a round to price.
    uint256 public minLiquidityUsd;

    /// A V2 observation's cumulative is the pair's price cumulative; a V3 one's, its tick cumulative (as int256 bits).
    struct Observation {
        uint64 timestamp;
        uint256 cumulative;
    }

    struct Round {
        int128 answer;
        uint64 startedAt;
        uint64 updatedAt;
    }

    Observation[SLOTS] internal _observations;
    uint256 public observationCount;
    uint64 public roundCount;
    mapping(uint64 => Round) internal _rounds;

    event Observed(uint64 timestamp, uint256 cumulative);
    event RoundMade(uint80 indexed roundId, int256 answer, uint64 windowStart, uint256 liquidityUsd);
    event MinLiquiditySet(uint256 minLiquidityUsd);

    error InvalidParam();
    error NoRound(uint80 roundId);
    error TooSoon(uint64 nextAt);

    struct Config {
        PoolKind kind;
        address pair;
        address baseToken;
        address quoteUsdFeed;
        uint32 window;
        uint32 granularity;
        uint32 maxStaleness;
        uint32 quoteFeedMaxAge;
        uint256 minLiquidityUsd;
        string description;
        string source;
    }

    constructor(Config memory c, address owner_) Ownable(owner_) {
        if (c.pair.code.length == 0 || c.granularity < 15 || c.window < c.granularity * 4 || c.window > 1 days) revert InvalidParam();
        if (c.maxStaleness < c.granularity * 2 || c.quoteFeedMaxAge == 0) revert InvalidParam();
        if (uint256(c.window) + uint256(c.granularity) * 4 > uint256(c.granularity) * (SLOTS - 1)) revert InvalidParam();
        // token0()/token1() read the same on either kind of pool.
        IUniswapV2PairLike p = IUniswapV2PairLike(c.pair);
        address t0 = p.token0();
        address t1 = p.token1();
        if (c.baseToken != t0 && c.baseToken != t1) revert InvalidParam();
        kind = c.kind;
        pair = c.pair;
        baseIsToken0 = c.baseToken == t0;
        quoteToken = baseIsToken0 ? t1 : t0;
        baseDecimals = IERC20Like(c.baseToken).decimals();
        quoteDecimals = IERC20Like(quoteToken).decimals();
        if (baseDecimals > 18 || quoteDecimals > 18) revert InvalidParam();
        quoteUsdFeed = IUsdFeed(c.quoteUsdFeed);
        quoteUsdDecimals = c.quoteUsdFeed == address(0) ? 0 : IUsdFeed(c.quoteUsdFeed).decimals();
        if (quoteUsdDecimals > 18) revert InvalidParam();
        window = c.window;
        granularity = c.granularity;
        maxStaleness = c.maxStaleness;
        quoteFeedMaxAge = c.quoteFeedMaxAge;
        minLiquidityUsd = c.minLiquidityUsd;
        description = c.description;
        source = c.source;
        // The pool has to answer as its kind does, or nothing it records means anything.
        _currentCumulative();
        emit MinLiquiditySet(c.minLiquidityUsd);
    }

    /* ------------------------------------------------------------------ */
    /* Observations and rounds                                             */
    /* ------------------------------------------------------------------ */

    /// @notice Record the pool's cumulative price now and, when an observation
    ///         from `window` seconds back is on record, make a round: the
    ///         average since then, in USD. Returns the round's id, or 0 when
    ///         there isn't a window's history yet.
    function update() external returns (uint80 roundId) {
        uint64 nowTs = uint64(block.timestamp);
        if (observationCount > 0) {
            Observation memory last = _observations[(observationCount - 1) % SLOTS];
            if (nowTs < last.timestamp + granularity) revert TooSoon(last.timestamp + granularity);
        }
        uint256 cumulative = _currentCumulative();
        _observations[observationCount % SLOTS] = Observation({timestamp: nowTs, cumulative: cumulative});
        observationCount += 1;
        emit Observed(nowTs, cumulative);

        (bool found, Observation memory start) = _windowStart(nowTs);
        if (!found) return 0;

        uint256 perBase18 = _averagePerBase(start.cumulative, cumulative, nowTs - start.timestamp);
        (int256 answer, uint256 liquidity) = _price(perBase18);
        roundCount += 1;
        roundId = PHASE | uint80(roundCount);
        _rounds[roundCount] = Round({answer: int128(answer), startedAt: start.timestamp, updatedAt: nowTs});
        emit RoundMade(roundId, answer, start.timestamp, liquidity);
    }

    /// @notice The least the pool may hold for a round to price. The owner
    ///         lowers it only knowing a thinner pool's average is cheaper to push.
    function setMinLiquidityUsd(uint256 minLiquidityUsd_) external onlyOwner {
        minLiquidityUsd = minLiquidityUsd_;
        emit MinLiquiditySet(minLiquidityUsd_);
    }

    /// @notice When `update()` next goes through: `granularity` after the last observation (0 before the first).
    function nextUpdateAt() external view returns (uint64) {
        if (observationCount == 0) return 0;
        return _observations[(observationCount - 1) % SLOTS].timestamp + granularity;
    }

    /// @notice What the pool holds now, both sides in USD (18 decimals) — for the page and the keeper.
    function liquidityUsd() external view returns (uint256) {
        (uint256 quoteUsd18, bool fresh) = _quoteUsd();
        if (!fresh) return 0;
        return _liquidity(quoteUsd18);
    }

    /* ------------------------------------------------------------------ */
    /* Chainlink's AggregatorV3Interface                                   */
    /* ------------------------------------------------------------------ */

    /// @notice The latest round — read as 0 once no round has landed for `maxStaleness` (the circuit breaker).
    function latestRoundData()
        external
        view
        returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)
    {
        if (roundCount == 0) revert NoRound(0);
        (roundId, answer, startedAt, updatedAt, answeredInRound) = _roundData(roundCount);
        if (block.timestamp > updatedAt + maxStaleness) answer = 0;
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

    /* ------------------------------------------------------------------ */
    /* Internals                                                           */
    /* ------------------------------------------------------------------ */

    /// @dev The pool's cumulative now, as Uniswap's oracle libraries read it:
    ///      a V2 pair's price cumulative for the base token, counting the time
    ///      since its last trade at the price it has held since; a V3 pool's
    ///      tick cumulative (the pool does that counting itself).
    function _currentCumulative() internal view returns (uint256 cumulative) {
        if (kind == PoolKind.UniswapV3) {
            uint32[] memory ago = new uint32[](1);
            (int56[] memory ticks,) = IUniswapV3PoolLike(pair).observe(ago);
            return uint256(int256(ticks[0]));
        }
        IUniswapV2PairLike p = IUniswapV2PairLike(pair);
        cumulative = baseIsToken0 ? p.price0CumulativeLast() : p.price1CumulativeLast();
        (uint112 r0, uint112 r1, uint32 lastTs) = p.getReserves();
        uint32 nowTs = uint32(block.timestamp);
        if (lastTs != nowTs && r0 > 0 && r1 > 0) {
            unchecked {
                uint32 elapsed = nowTs - lastTs; // wraps like Uniswap's own timestamps
                uint256 price = baseIsToken0 ? (uint256(r1) << 112) / r0 : (uint256(r0) << 112) / r1;
                cumulative += price * elapsed;
            }
        }
    }

    /// @dev The average over `elapsed` seconds between two cumulatives, as the
    ///      quote per whole base token with 18 decimals.
    function _averagePerBase(uint256 from, uint256 to, uint256 elapsed) internal view returns (uint256) {
        if (kind == PoolKind.UniswapV3) {
            int256 delta = int256(to) - int256(from);
            int256 tick = delta / int256(elapsed);
            // Toward negative infinity, as Uniswap's OracleLibrary rounds it.
            if (delta < 0 && delta % int256(elapsed) != 0) tick -= 1;
            return _tickPerBase(tick);
        }
        uint256 average;
        unchecked {
            // Uniswap V2's cumulative prices are meant to wrap: the difference is right mod 2^256.
            average = (to - from) / elapsed;
        }
        // average is quote per base in raw units, UQ112x112: × 10^(18 + baseDecimals − quoteDecimals) / 2^112.
        return Math.mulDiv(average, 10 ** (18 + uint256(baseDecimals)), (uint256(1) << 112) * 10 ** uint256(quoteDecimals));
    }

    /// @dev A V3 tick (token1 per token0 in raw units is 1.0001^tick) as the
    ///      quote per whole base token with 18 decimals.
    function _tickPerBase(int256 tick) internal view returns (uint256) {
        int256 t = baseIsToken0 ? tick : -tick;
        uint256 sqrtQ128 = _sqrtRatioQ128(t);
        // Raw quote per raw base, Q128: at the edge of the tick range it would pass 2^256.
        if (sqrtQ128 >= Q128 << 64) return 0;
        uint256 priceQ128 = Math.mulDiv(sqrtQ128, sqrtQ128, Q128);
        return Math.mulDiv(priceQ128, 10 ** (18 + uint256(baseDecimals)), Q128 * 10 ** uint256(quoteDecimals));
    }

    /// @dev sqrt(1.0001)^t, Q128. Each constant is 2^128 / sqrt(1.0001)^(2^i),
    ///      rounded: the bits of |t| pick which multiply in.
    function _sqrtRatioQ128(int256 t) internal pure returns (uint256 ratio) {
        uint256 a = uint256(t < 0 ? -t : t);
        if (a > uint256(MAX_TICK)) return 0;
        ratio = a & 0x1 != 0 ? 0xfffcb933bd6fad37aa2d162d1a594001 : Q128;
        if (a & 0x2 != 0) ratio = (ratio * 0xfff97272373d413259a46990580e213a) >> 128;
        if (a & 0x4 != 0) ratio = (ratio * 0xfff2e50f5f656932ef12357cf3c7fdcc) >> 128;
        if (a & 0x8 != 0) ratio = (ratio * 0xffe5caca7e10e4e61c3624eaa0941cd0) >> 128;
        if (a & 0x10 != 0) ratio = (ratio * 0xffcb9843d60f6159c9db58835c926644) >> 128;
        if (a & 0x20 != 0) ratio = (ratio * 0xff973b41fa98c081472e6896dfb254c0) >> 128;
        if (a & 0x40 != 0) ratio = (ratio * 0xff2ea16466c96a3843ec78b326b52861) >> 128;
        if (a & 0x80 != 0) ratio = (ratio * 0xfe5dee046a99a2a811c461f1969c3053) >> 128;
        if (a & 0x100 != 0) ratio = (ratio * 0xfcbe86c7900a88aedcffc83b479aa3a4) >> 128;
        if (a & 0x200 != 0) ratio = (ratio * 0xf987a7253ac413176f2b074cf7815e54) >> 128;
        if (a & 0x400 != 0) ratio = (ratio * 0xf3392b0822b70005940c7a398e4b70f3) >> 128;
        if (a & 0x800 != 0) ratio = (ratio * 0xe7159475a2c29b7443b29c7fa6e889d9) >> 128;
        if (a & 0x1000 != 0) ratio = (ratio * 0xd097f3bdfd2022b8845ad8f792aa5825) >> 128;
        if (a & 0x2000 != 0) ratio = (ratio * 0xa9f746462d870fdf8a65dc1f90e061e5) >> 128;
        if (a & 0x4000 != 0) ratio = (ratio * 0x70d869a156d2a1b890bb3df62baf32f7) >> 128;
        if (a & 0x8000 != 0) ratio = (ratio * 0x31be135f97d08fd981231505542fcfa6) >> 128;
        if (a & 0x10000 != 0) ratio = (ratio * 0x9aa508b5b7a84e1c677de54f3e99bc9) >> 128;
        if (a & 0x20000 != 0) ratio = (ratio * 0x5d6af8dedb81196699c329225ee604) >> 128;
        if (a & 0x40000 != 0) ratio = (ratio * 0x2216e584f5fa1ea926041bedfe98) >> 128;
        if (a & 0x80000 != 0) ratio = (ratio * 0x48a170391f7dc42444e8fa2) >> 128;
        // So far sqrt(1.0001)^-|t|; a positive t is its inverse.
        if (t > 0) ratio = type(uint256).max / ratio;
    }

    /// @dev The newest observation at least `window` seconds old — if it's no
    ///      more than four observations older than that (a gap in the record
    ///      means no average until a fresh window has passed).
    function _windowStart(uint64 nowTs) internal view returns (bool, Observation memory) {
        uint256 n = observationCount;
        uint256 kept = n < SLOTS ? n : SLOTS;
        // Newest first, skipping the one just recorded.
        for (uint256 i = 1; i < kept; ++i) {
            Observation memory o = _observations[(n - 1 - i) % SLOTS];
            uint256 age = nowTs - o.timestamp;
            if (age >= window) {
                if (age > uint256(window) + uint256(granularity) * 4) break;
                return (true, o);
            }
        }
        return (false, Observation(0, 0));
    }

    /// @dev An average (quote per whole base, 18 decimals) as an 18-decimal
    ///      USD answer, and the pool's liquidity — 0 when a guard fails.
    function _price(uint256 perBase18) internal view returns (int256 answer, uint256 liquidity) {
        (uint256 quoteUsd18, bool fresh) = _quoteUsd();
        if (!fresh) return (0, 0);
        liquidity = _liquidity(quoteUsd18);
        if (liquidity < minLiquidityUsd) return (0, liquidity);
        uint256 usd18 = Math.mulDiv(perBase18, quoteUsd18, 1e18);
        if (usd18 == 0 || usd18 > uint256(uint128(type(int128).max))) return (0, liquidity);
        answer = int256(usd18);
    }

    /// @dev One quote token in USD (18 decimals), and whether that's fresh.
    function _quoteUsd() internal view returns (uint256 usd18, bool fresh) {
        if (address(quoteUsdFeed) == address(0)) return (1e18, true);
        try quoteUsdFeed.latestRoundData() returns (uint80, int256 answer, uint256, uint256 updatedAt, uint80) {
            if (answer <= 0 || updatedAt + quoteFeedMaxAge < block.timestamp) return (0, false);
            return (uint256(answer) * 10 ** (18 - uint256(quoteUsdDecimals)), true);
        } catch {
            return (0, false);
        }
    }

    /// @dev Both sides of the pool in USD (18 decimals): twice the quote side —
    ///      a V2 pair's reserve, a V3 pool's balance (in range or not).
    function _liquidity(uint256 quoteUsd18) internal view returns (uint256) {
        uint256 quoteHeld;
        if (kind == PoolKind.UniswapV3) {
            quoteHeld = IERC20Like(quoteToken).balanceOf(pair);
        } else {
            (uint112 r0, uint112 r1, ) = IUniswapV2PairLike(pair).getReserves();
            quoteHeld = baseIsToken0 ? r1 : r0;
        }
        return 2 * Math.mulDiv(quoteHeld, quoteUsd18, 10 ** uint256(quoteDecimals));
    }
}
