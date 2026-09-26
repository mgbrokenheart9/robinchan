// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title MockAggregator — a Chainlink price feed proxy for tests and local chains
/// @notice Numbers rounds like a Chainlink proxy — (phase << 64) | round — so
///         AgriFeed's proofs run against the same arithmetic as on a live
///         chain. Each phase stands for one aggregator with its own round
///         numbering, readable forever, as a proxy's `phaseAggregators` are;
///         a phase can take rounds before the proxy switches to it and after
///         it has moved on, as aggregators do during a migration. Anyone can
///         post a price: never deploy it anywhere real.
contract MockAggregator {
    struct Round {
        int256 answer;
        /// When the price was observed (Chainlink's `startedAt`).
        uint256 startedAt;
        /// When the round landed on chain.
        uint256 updatedAt;
    }

    uint8 public immutable decimals;
    string public description;
    /// The phase the proxy reads from.
    uint16 public phaseId = 1;
    /// Each phase's latest round.
    mapping(uint16 => uint64) public phaseRounds;
    /// Every read reverts, as a feed retired behind access control would.
    bool public broken;
    mapping(uint80 => Round) internal _rounds;

    event AnswerUpdated(int256 indexed current, uint256 indexed roundId, uint256 updatedAt);

    constructor(uint8 decimals_, string memory description_, int256 initialAnswer) {
        decimals = decimals_;
        description = description_;
        _push(1, initialAnswer, block.timestamp, block.timestamp);
    }

    /// @notice A new round in the current phase, observed and published now.
    function updateAnswer(int256 answer) external {
        _push(phaseId, answer, block.timestamp, block.timestamp);
    }

    /// @notice A new round in the current phase landing now, observed at
    ///         `startedAt` — as a live feed's do, about 13 seconds earlier.
    function updateObserved(int256 answer, uint256 startedAt) external {
        require(startedAt <= block.timestamp, "observed in the future");
        _push(phaseId, answer, startedAt, block.timestamp);
    }

    /// @notice A round in any phase: the next aggregator before the switch, or the old one after it.
    function updateAnswerIn(uint16 phase, int256 answer) external {
        require(phase > 0, "no phase 0");
        _push(phase, answer, block.timestamp, block.timestamp);
    }

    /// @notice The proxy moves to the next phase (whatever rounds it already has).
    function startPhase() external {
        phaseId += 1;
    }

    function setBroken(bool broken_) external {
        broken = broken_;
    }

    function latestRoundData() external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed retired");
        uint80 id = _id(phaseId, phaseRounds[phaseId]);
        Round memory r = _rounds[id];
        return (id, r.answer, r.startedAt, r.updatedAt, id);
    }

    function getRoundData(uint80 roundId) external view returns (uint80, int256, uint256, uint256, uint80) {
        require(!broken, "feed retired");
        Round memory r = _rounds[roundId];
        require(r.updatedAt != 0, "No data present");
        return (roundId, r.answer, r.startedAt, r.updatedAt, roundId);
    }

    function _push(uint16 phase, int256 answer, uint256 startedAt, uint256 updatedAt) internal {
        uint64 round = phaseRounds[phase] + 1;
        phaseRounds[phase] = round;
        uint80 id = _id(phase, round);
        _rounds[id] = Round({answer: answer, startedAt: startedAt, updatedAt: updatedAt});
        emit AnswerUpdated(answer, id, updatedAt);
    }

    function _id(uint16 phase, uint64 round) internal pure returns (uint80) {
        return uint80((uint256(phase) << 64) | round);
    }
}
