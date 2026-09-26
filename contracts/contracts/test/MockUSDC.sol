// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/// @title MockUSDC — test collateral for local chains and testnets only
/// @notice Six decimals like USDC, and anyone can mint: it stands in for the
///         real settlement stablecoin until one is chosen on Robinhood Chain.
///         Never deploy it to a mainnet.
contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin (test)", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
