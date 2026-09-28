// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {MockPyth} from "@pythnetwork/pyth-sdk-solidity/MockPyth.sol";

/// Pyth's own mock, under a name of this project's so Hardhat builds an
/// artifact for it. Its update data is (PriceFeed, prevPublishTime), which is
/// what the uniqueness check reads.
contract TestPyth is MockPyth {
    constructor(uint256 validTimePeriod, uint256 singleUpdateFeeInWei) MockPyth(validTimePeriod, singleUpdateFeeInWei) {}
}
