// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// A token as far as a price oracle cares: its decimals, and who holds how much.
contract MockToken {
    uint8 public immutable decimals;
    mapping(address => uint256) public balanceOf;

    constructor(uint8 decimals_) {
        decimals = decimals_;
    }

    function setBalance(address account, uint256 amount) external {
        balanceOf[account] = amount;
    }
}

/// Uniswap V2's pair as its oracle reads it: reserves, and cumulative prices
/// accrued at the old reserves each time they change (UniswapV2Pair._update).
contract MockUniswapV2Pair {
    address public immutable token0;
    address public immutable token1;
    uint112 internal _reserve0;
    uint112 internal _reserve1;
    uint32 internal _blockTimestampLast;
    uint256 public price0CumulativeLast;
    uint256 public price1CumulativeLast;

    constructor(address a, address b) {
        (token0, token1) = a < b ? (a, b) : (b, a);
    }

    function getReserves() external view returns (uint112, uint112, uint32) {
        return (_reserve0, _reserve1, _blockTimestampLast);
    }

    /// Jump the cumulative prices, e.g. to just short of 2^256, as a pool that's run for ages.
    function setCumulatives(uint256 price0, uint256 price1) external {
        price0CumulativeLast = price0;
        price1CumulativeLast = price1;
    }

    /// A trade (or a deposit): the time since the last one counts at the old price, then the reserves move.
    function setReserves(uint112 reserve0, uint112 reserve1) external {
        uint32 nowTs = uint32(block.timestamp);
        unchecked {
            uint32 elapsed = nowTs - _blockTimestampLast;
            if (elapsed > 0 && _reserve0 != 0 && _reserve1 != 0) {
                price0CumulativeLast += ((uint256(_reserve1) << 112) / _reserve0) * elapsed;
                price1CumulativeLast += ((uint256(_reserve0) << 112) / _reserve1) * elapsed;
            }
        }
        _reserve0 = reserve0;
        _reserve1 = reserve1;
        _blockTimestampLast = nowTs;
    }
}

/// Uniswap V3's pool as its oracle reads it: the current tick, and the tick
/// cumulative — written at the old tick before a swap moves it, as the pool's
/// own observations are.
contract MockUniswapV3Pool {
    address public immutable token0;
    address public immutable token1;
    int24 public tick;
    int56 internal _cumulative;
    uint32 internal _lastTs;

    constructor(address a, address b, int24 tick_) {
        (token0, token1) = a < b ? (a, b) : (b, a);
        tick = tick_;
        _lastTs = uint32(block.timestamp);
    }

    /// A swap: the time since the last one counts at the old tick, then the price moves.
    function setTick(int24 tick_) external {
        _cumulative = _cumulativeNow();
        _lastTs = uint32(block.timestamp);
        tick = tick_;
    }

    function observe(uint32[] calldata secondsAgos) external view returns (int56[] memory ticks, uint160[] memory perLiquidity) {
        ticks = new int56[](secondsAgos.length);
        perLiquidity = new uint160[](secondsAgos.length);
        for (uint256 i = 0; i < secondsAgos.length; ++i) {
            require(secondsAgos[i] == 0, "mock: now only");
            ticks[i] = _cumulativeNow();
        }
    }

    function _cumulativeNow() internal view returns (int56) {
        return _cumulative + int56(tick) * int56(uint56(block.timestamp - _lastTs));
    }
}
