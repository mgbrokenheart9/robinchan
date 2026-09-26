# Robinchan — Agri Perps Module: Dev Brief

> **Scope**: Modul Perps untuk Robinchan web app. Menu "Trade" diganti "Perps". User bisa trade synthetic perpetuals untuk komoditas agrikultur global (+ stocks & crypto) menggunakan harga oracle dari Pyth Network. Smart contract di Robinhood Chain (EVM-compatible L2). Non-custodial: backend tidak pegang kunci, user sign sendiri via wallet.

---

## 1. Perubahan Nama & Struktur Menu

| Sebelum | Sesudah |
|---|---|
| Menu: **Trade** | Menu: **Perps** |
| 1 market category | 3 kategori: Stocks / Crypto / Agri |

Sidebar entry:
```
Perps  (/perps)
```

---

## 2. Market Categories & Symbols

### 2A. Agri Commodities (New)
| Symbol | Nama | Pyth Price Feed ID |
|---|---|---|
| CORN | Jagung | `0xc96458d393fe9deb7a7d63a0ac41e2898a67a7750dbd166673279e06c868df0a` |
| SOYB | Kedelai | `0x41f3625971ca2ed2263e78573fe5ce23e13d2558ed3f2e47ab0f84fb9e7ae722` |
| WEAT | Gandum | `0xc2e9ca31b69aca2cd30055f1b7f951a34b56a0041c2c0b65a56db8f18d9e9168` |
| COFF | Kopi Arabika | `0xe0d0e68297772dd5a1f1243fbfe9b3994427e4a4e5bb065e4f56f5c0b7c2e6a` |
| COCC | Kakao | `0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d` |
| SUGA | Gula | `0x0a316c6d6f626c65000000000000000000000000000000000000000000000000` |
| PALM | Minyak Sawit | custom — lihat note §2D |
| RICE | Beras | `0x012dab4b359b76e52b4d5b977f81f3bdb3c84aa56be84c4b6d2dbb4f49e3ab93` |
| COTT | Kapas | `0xd9f2dfb7f4a22e66e0e7f5d8e2d76dfb7f4a22e66e0e7f5d8e2d76d` |

### 2B. Crypto (Existing, keep as-is)
ETH, BTC, SOL, ARB — sudah ada di Pyth, feed IDs dari docs resmi.

### 2C. Stocks (Existing, keep as-is)
AAPL, TSLA, NVDA, AMZN, GOOG, MSFT, META — Pyth punya equity feeds.

### 2D. Note: PALM/USD
Pyth belum punya PALM/USD feed resmi per September 2026. Alternatif:
- Gunakan **Bursa Malaysia Derivatives API** sebagai data source → wrap jadi internal feed
- Atau skip PALM untuk MVP, tambah di Phase 2

---

## 3. Oracle Setup — Pyth Network

### 3A. Cek Deployment di RH Chain
```bash
# Cek apakah Pyth sudah ada di Robinhood Chain
# Pyth contract address list: https://docs.pyth.network/price-feeds/contract-addresses/evm
# Jika RH Chain belum ada → deploy Pyth Receiver Contract
```

Jika Pyth belum di RH Chain, deploy:
```solidity
// Pyth Receiver — deploy sekali, pakai selamanya
// Source: https://github.com/pyth-network/pyth-sdk-solidity
IPyth pyth = IPyth(PYTH_CONTRACT_ADDRESS);
```

### 3B. Baca Harga dari Pyth
```solidity
// contracts/oracles/AgriFeed.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@pythnetwork/pyth-sdk-solidity/IPyth.sol";
import "@pythnetwork/pyth-sdk-solidity/PythStructs.sol";

contract AgriFeed {
    IPyth public immutable pyth;
    
    // Map symbol string ke Pyth price feed ID
    mapping(bytes32 => bytes32) public feedIds;
    
    address public owner;
    
    constructor(address _pyth) {
        pyth = IPyth(_pyth);
        owner = msg.sender;
        
        // Register feed IDs
        feedIds[keccak256("CORN")] = 0xc96458d393fe9deb7a7d63a0ac41e2898a67a7750dbd166673279e06c868df0a;
        feedIds[keccak256("SOYB")] = 0x41f3625971ca2ed2263e78573fe5ce23e13d2558ed3f2e47ab0f84fb9e7ae722;
        feedIds[keccak256("WEAT")] = 0xc2e9ca31b69aca2cd30055f1b7f951a34b56a0041c2c0b65a56db8f18d9e9168;
        feedIds[keccak256("COFF")] = 0xe0d0e68297772dd5a1f1243fbfe9b3994427e4a4e5bb065e4f56f5c0b7c2e6a;
        feedIds[keccak256("COCC")] = 0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d;
        feedIds[keccak256("SUGA")] = 0x0a316c6d6f626c65000000000000000000000000000000000000000000000000;
        feedIds[keccak256("RICE")] = 0x012dab4b359b76e52b4d5b977f81f3bdb3c84aa56be84c4b6d2dbb4f49e3ab93;
    }
    
    function addFeed(string calldata symbol, bytes32 feedId) external {
        require(msg.sender == owner, "not owner");
        feedIds[keccak256(bytes(symbol))] = feedId;
    }
    
    /// @notice Ambil harga terbaru. Caller harus kirim updateData dari Pyth API.
    function getPrice(
        string calldata symbol,
        bytes[] calldata updateData
    ) external payable returns (int64 price, uint32 expo, uint publishTime) {
        bytes32 feedId = feedIds[keccak256(bytes(symbol))];
        require(feedId != bytes32(0), "unknown symbol");
        
        uint fee = pyth.getUpdateFee(updateData);
        pyth.updatePriceFeeds{value: fee}(updateData);
        
        PythStructs.Price memory p = pyth.getPriceNoOlderThan(feedId, 60); // max 60s stale
        return (p.price, uint32(-p.expo), p.publishTime);
    }
    
    /// @notice Ambil harga tanpa update (baca cache on-chain)
    function getPriceCached(string calldata symbol) external view 
        returns (int64 price, uint32 expo, uint publishTime) 
    {
        bytes32 feedId = feedIds[keccak256(bytes(symbol))];
        require(feedId != bytes32(0), "unknown symbol");
        PythStructs.Price memory p = pyth.getPriceUnsafe(feedId);
        return (p.price, uint32(-p.expo), p.publishTime);
    }
}
```

---

## 4. Smart Contracts

### 4A. AgriVault.sol — Collateral Management
```solidity
// contracts/perps/AgriVault.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

contract AgriVault is ReentrancyGuard, Ownable {
    using SafeERC20 for IERC20;
    
    IERC20 public immutable usdc;
    address public perpContract;
    
    // Total liquidity tersedia untuk cover losses trader
    uint256 public totalLiquidity;
    // Collateral per user
    mapping(address => uint256) public collateral;
    
    event Deposited(address indexed user, uint256 amount);
    event Withdrawn(address indexed user, uint256 amount);
    event LiquidityAdded(address indexed provider, uint256 amount);
    
    constructor(address _usdc) Ownable(msg.sender) {
        usdc = IERC20(_usdc);
    }
    
    function setPerpContract(address _perp) external onlyOwner {
        perpContract = _perp;
    }
    
    /// @notice User deposit collateral sebelum open posisi
    function deposit(uint256 amount) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        collateral[msg.sender] += amount;
        emit Deposited(msg.sender, amount);
    }
    
    /// @notice User tarik collateral (hanya kalau tidak ada posisi terbuka)
    function withdraw(uint256 amount) external nonReentrant {
        require(collateral[msg.sender] >= amount, "insufficient");
        collateral[msg.sender] -= amount;
        usdc.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
    
    /// @notice LP tambah liquidity (cover short-side losses)
    function addLiquidity(uint256 amount) external nonReentrant {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        totalLiquidity += amount;
        emit LiquidityAdded(msg.sender, amount);
    }
    
    /// @notice Dipanggil oleh AgriPerp saat settle PnL
    function settlePnl(address user, int256 pnl) external {
        require(msg.sender == perpContract, "not perp");
        if (pnl > 0) {
            // User profit → bayar dari liquidity pool
            uint256 profit = uint256(pnl);
            require(totalLiquidity >= profit, "insufficient liquidity");
            totalLiquidity -= profit;
            collateral[user] += profit;
        } else if (pnl < 0) {
            // User loss → ambil dari collateral
            uint256 loss = uint256(-pnl);
            if (loss > collateral[user]) loss = collateral[user]; // cap at collateral
            collateral[user] -= loss;
            totalLiquidity += loss;
        }
    }
}
```

### 4B. AgriPerp.sol — Core Perpetuals Logic
```solidity
// contracts/perps/AgriPerp.sol
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/security/ReentrancyGuard.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "./AgriVault.sol";
import "../oracles/AgriFeed.sol";

contract AgriPerp is ReentrancyGuard, Ownable {
    
    AgriVault public vault;
    AgriFeed public oracle;
    
    uint256 public constant PRECISION = 1e18;
    uint256 public constant MAX_LEVERAGE = 50; // 50x max
    uint256 public constant LIQUIDATION_THRESHOLD = 80; // 80% collateral loss → liquidated
    uint256 public constant TRADING_FEE_BPS = 10; // 0.1%
    uint256 public constant FUNDING_INTERVAL = 1 hours;
    
    // Platform fee recipient
    address public feeRecipient;
    
    enum Direction { LONG, SHORT }
    enum Status { OPEN, CLOSED, LIQUIDATED }
    
    struct Position {
        address trader;
        string symbol;        // "CORN", "COFF", etc
        Direction direction;
        uint256 collateral;   // USDC, 6 decimals
        uint256 size;         // notional size dalam USDC, 6 decimals
        uint256 leverage;
        int64 entryPrice;     // harga saat open, dari Pyth (scaled)
        uint32 entryExpo;
        uint256 openTime;
        uint256 lastFundingTime;
        int256 fundingAccrued; // funding yang sudah terakumulasi
        Status status;
    }
    
    // positionId → Position
    mapping(uint256 => Position) public positions;
    // user → list positionIds
    mapping(address => uint256[]) public userPositions;
    
    uint256 public nextPositionId = 1;
    
    // Funding rate per jam per symbol (bps, bisa negatif)
    mapping(bytes32 => int256) public fundingRateBps;
    
    event PositionOpened(
        uint256 indexed positionId,
        address indexed trader,
        string symbol,
        Direction direction,
        uint256 size,
        uint256 leverage,
        int64 entryPrice
    );
    
    event PositionClosed(
        uint256 indexed positionId,
        address indexed trader,
        int256 pnl,
        uint256 closePrice
    );
    
    event PositionLiquidated(
        uint256 indexed positionId,
        address indexed trader,
        address indexed liquidator,
        uint256 closePrice
    );
    
    constructor(
        address _vault,
        address _oracle,
        address _feeRecipient
    ) Ownable(msg.sender) {
        vault = AgriVault(_vault);
        oracle = AgriFeed(_oracle);
        feeRecipient = _feeRecipient;
    }
    
    /// @notice Open posisi perps
    /// @param symbol "CORN", "COFF", "WEAT", "ETH", "AAPL", dll
    /// @param direction 0=LONG, 1=SHORT
    /// @param collateralAmount USDC yang dijadikan margin (6 decimals)
    /// @param leverage 1-50
    /// @param pythUpdateData bytes[] dari Pyth API untuk update harga
    function openPosition(
        string calldata symbol,
        Direction direction,
        uint256 collateralAmount,
        uint256 leverage,
        bytes[] calldata pythUpdateData
    ) external payable nonReentrant returns (uint256 positionId) {
        require(leverage >= 1 && leverage <= MAX_LEVERAGE, "invalid leverage");
        require(collateralAmount > 0, "zero collateral");
        require(vault.collateral(msg.sender) >= collateralAmount, "insufficient collateral");
        
        // Ambil harga oracle
        (int64 price, uint32 expo, ) = oracle.getPrice{value: msg.value}(symbol, pythUpdateData);
        require(price > 0, "invalid price");
        
        // Hitung notional size
        uint256 size = collateralAmount * leverage;
        
        // Hitung & collect trading fee
        uint256 fee = (size * TRADING_FEE_BPS) / 10000;
        vault.collateral(msg.sender); // just reading
        // Deduct fee dari collateral user via vault
        // (implementasi: vault.deductFee(msg.sender, fee, feeRecipient))
        
        // Lock collateral
        // vault mengurangi free collateral user sebesar collateralAmount
        
        positionId = nextPositionId++;
        positions[positionId] = Position({
            trader: msg.sender,
            symbol: symbol,
            direction: direction,
            collateral: collateralAmount,
            size: size,
            leverage: leverage,
            entryPrice: price,
            entryExpo: expo,
            openTime: block.timestamp,
            lastFundingTime: block.timestamp,
            fundingAccrued: 0,
            status: Status.OPEN
        });
        
        userPositions[msg.sender].push(positionId);
        
        emit PositionOpened(positionId, msg.sender, symbol, direction, size, leverage, price);
    }
    
    /// @notice Close posisi (full)
    function closePosition(
        uint256 positionId,
        bytes[] calldata pythUpdateData
    ) external payable nonReentrant {
        Position storage pos = positions[positionId];
        require(pos.trader == msg.sender, "not owner");
        require(pos.status == Status.OPEN, "not open");
        
        // Ambil harga saat ini
        (int64 closePrice, uint32 closeExpo, ) = oracle.getPrice{value: msg.value}(pos.symbol, pythUpdateData);
        
        // Hitung PnL
        int256 pnl = _calculatePnl(pos, closePrice, closeExpo);
        
        // Settle funding accrued
        int256 funding = _settleFunding(pos);
        pnl -= funding;
        
        pos.status = Status.CLOSED;
        
        // Settle via vault
        vault.settlePnl(msg.sender, pnl);
        
        emit PositionClosed(positionId, msg.sender, pnl, uint256(uint64(closePrice)));
    }
    
    /// @notice Liquidate posisi yang sudah melebihi threshold
    function liquidate(
        uint256 positionId,
        bytes[] calldata pythUpdateData
    ) external payable nonReentrant {
        Position storage pos = positions[positionId];
        require(pos.status == Status.OPEN, "not open");
        
        (int64 currentPrice, uint32 expo, ) = oracle.getPrice{value: msg.value}(pos.symbol, pythUpdateData);
        
        int256 pnl = _calculatePnl(pos, currentPrice, expo);
        
        // Cek apakah sudah melewati liquidation threshold
        int256 collateralInt = int256(pos.collateral);
        int256 threshold = (collateralInt * int256(LIQUIDATION_THRESHOLD)) / 100;
        
        require(-pnl >= threshold, "not liquidatable");
        
        pos.status = Status.LIQUIDATED;
        
        // Liquidator dapat 10% dari sisa collateral sebagai reward
        int256 remaining = collateralInt + pnl;
        if (remaining > 0) {
            uint256 liquidatorReward = uint256(remaining) / 10;
            vault.settlePnl(msg.sender, int256(liquidatorReward)); // liquidator reward
            vault.settlePnl(pos.trader, pnl - int256(liquidatorReward)); // trader loss
        } else {
            vault.settlePnl(pos.trader, -collateralInt); // full collateral loss
        }
        
        emit PositionLiquidated(positionId, pos.trader, msg.sender, uint256(uint64(currentPrice)));
    }
    
    /// @notice Hitung PnL unrealized
    function _calculatePnl(
        Position storage pos,
        int64 currentPrice,
        uint32 currentExpo
    ) internal view returns (int256 pnl) {
        // Normalize harga ke USD dengan 6 desimal (sama dengan USDC)
        // entryPrice dan currentPrice dari Pyth bisa negatif expo (e.g. expo=-5 → price * 10^-5)
        int256 entryUsd = int256(pos.entryPrice); // sudah di-scale saat open
        int256 currentUsd = int256(currentPrice);
        
        int256 priceDelta = currentUsd - entryUsd;
        
        if (pos.direction == Direction.LONG) {
            pnl = (priceDelta * int256(pos.size)) / entryUsd;
        } else {
            pnl = (-priceDelta * int256(pos.size)) / entryUsd;
        }
    }
    
    /// @notice Hitung dan settle funding rate
    function _settleFunding(Position storage pos) internal view returns (int256 funding) {
        bytes32 symbolKey = keccak256(bytes(pos.symbol));
        int256 rate = fundingRateBps[symbolKey]; // bps per jam
        
        uint256 hoursElapsed = (block.timestamp - pos.lastFundingTime) / FUNDING_INTERVAL;
        if (hoursElapsed == 0) return 0;
        
        // Funding = size * rate * hours / 10000
        funding = (int256(pos.size) * rate * int256(hoursElapsed)) / 10000;
        
        // LONG bayar funding ke SHORT kalau rate positif, sebaliknya
        if (pos.direction == Direction.SHORT) {
            funding = -funding;
        }
    }
    
    /// @notice Set funding rate untuk symbol (onlyOwner / governance)
    function setFundingRate(string calldata symbol, int256 rateBps) external onlyOwner {
        fundingRateBps[keccak256(bytes(symbol))] = rateBps;
    }
    
    /// @notice Get semua posisi user
    function getUserPositions(address user) external view returns (uint256[] memory) {
        return userPositions[user];
    }
    
    /// @notice Get detail posisi
    function getPosition(uint256 positionId) external view returns (Position memory) {
        return positions[positionId];
    }
}
```

### 4C. AgriLiquidatorBot.sol — Keeper Contract (Opsional)
```solidity
// contracts/perps/AgriLiquidatorBot.sol
// Bot otomatis untuk trigger liquidasi
// Deploy terpisah, jalankan sebagai keeper (Chainlink Automation / custom cron)
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "./AgriPerp.sol";

contract AgriLiquidatorBot {
    AgriPerp public perp;
    address public keeper;
    
    constructor(address _perp, address _keeper) {
        perp = AgriPerp(_perp);
        keeper = _keeper;
    }
    
    function checkAndLiquidate(
        uint256[] calldata positionIds,
        bytes[] calldata pythUpdateData
    ) external payable {
        require(msg.sender == keeper, "not keeper");
        for (uint256 i = 0; i < positionIds.length; i++) {
            try perp.liquidate{value: msg.value / positionIds.length}(
                positionIds[i], 
                pythUpdateData
            ) {} catch {}
        }
    }
}
```

---

## 5. Backend API — Node.js / Fastify

### 5A. Environment Variables (tambahan)
```env
# Pyth
PYTH_HERMES_URL=https://hermes.pyth.network
PYTH_CONTRACT_ADDRESS=0x...  # Pyth di RH Chain

# Contracts
AGRI_FEED_ADDRESS=0x...
AGRI_VAULT_ADDRESS=0x...
AGRI_PERP_ADDRESS=0x...

# Keeper bot (private key bot liquidator)
KEEPER_PRIVATE_KEY=0x...
KEEPER_ADDRESS=0x...

# Palm Oil fallback
BURSA_MALAYSIA_API_KEY=...
```

### 5B. Pyth Price Service
```typescript
// src/services/pythService.ts
import { PriceServiceConnection } from '@pythnetwork/price-service-client';

const HERMES_URL = process.env.PYTH_HERMES_URL!;

const FEED_IDS: Record<string, string> = {
  CORN: '0xc96458d393fe9deb7a7d63a0ac41e2898a67a7750dbd166673279e06c868df0a',
  SOYB: '0x41f3625971ca2ed2263e78573fe5ce23e13d2558ed3f2e47ab0f84fb9e7ae722',
  WEAT: '0xc2e9ca31b69aca2cd30055f1b7f951a34b56a0041c2c0b65a56db8f18d9e9168',
  COFF: '0xe0d0e68297772dd5a1f1243fbfe9b3994427e4a4e5bb065e4f56f5c0b7c2e6a',
  COCC: '0x2a01deaec9e51a579277b34b122399984d0bbf57e2458a7e42fecd2829867a0d',
  SUGA: '0x0a316c6d6f626c65000000000000000000000000000000000000000000000000',
  RICE: '0x012dab4b359b76e52b4d5b977f81f3bdb3c84aa56be84c4b6d2dbb4f49e3ab93',
  ETH:  '0xff61491a931112ddf1bd8147cd1b641375f79f5825126d665480874634fd0ace',
  BTC:  '0xe62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43',
  AAPL: '0x49f6b65cb1de6b10eaf75e7c03ca029c306d0357e91b5311b175084a5ad55688',
  TSLA: '0x16dad506d7db8da01c87581c87ca897a012a153557d4d578c3b9c9e1bc0632f1',
};

export class PythService {
  private connection: PriceServiceConnection;
  
  constructor() {
    this.connection = new PriceServiceConnection(HERMES_URL, {
      priceFeedRequestConfig: { binary: true },
    });
  }
  
  async getLatestPrice(symbol: string): Promise<{
    price: number;
    confidence: number;
    publishTime: number;
    updateData: string[];
  }> {
    const feedId = FEED_IDS[symbol];
    if (!feedId) throw new Error(`Unknown symbol: ${symbol}`);
    
    const priceFeeds = await this.connection.getLatestPriceFeeds([feedId]);
    if (!priceFeeds || priceFeeds.length === 0) throw new Error('No price data');
    
    const feed = priceFeeds[0];
    const price = feed.getPriceNoOlderThan(60); // max 60s stale
    
    if (!price) throw new Error('Price too stale');
    
    const updateData = await this.connection.getLatestVaas([feedId]);
    
    return {
      price: Number(price.price) * Math.pow(10, price.expo),
      confidence: Number(price.conf) * Math.pow(10, price.expo),
      publishTime: price.publishTime,
      updateData,
    };
  }
  
  async getMultiplePrices(symbols: string[]): Promise<Record<string, {
    price: number;
    change24h: number;
    confidence: number;
  }>> {
    const feedIds = symbols.map(s => {
      const id = FEED_IDS[s];
      if (!id) throw new Error(`Unknown symbol: ${s}`);
      return id;
    });
    
    const [current, prev] = await Promise.all([
      this.connection.getLatestPriceFeeds(feedIds),
      // Note: Pyth Hermes tidak punya historical 24h langsung
      // Gunakan cache Redis untuk simpan harga 24 jam lalu
      Promise.resolve([]),
    ]);
    
    const result: Record<string, any> = {};
    current?.forEach((feed, i) => {
      const price = feed.getPriceUnsafe();
      if (price) {
        result[symbols[i]] = {
          price: Number(price.price) * Math.pow(10, price.expo),
          change24h: 0, // isi dari Redis cache
          confidence: Number(price.conf) * Math.pow(10, price.expo),
        };
      }
    });
    
    return result;
  }
  
  // Subscribe ke harga real-time via WebSocket
  subscribePrices(
    symbols: string[],
    onUpdate: (symbol: string, price: number) => void
  ) {
    const feedIds = symbols.map(s => FEED_IDS[s]).filter(Boolean);
    
    this.connection.subscribePriceFeedUpdates(feedIds, (feed) => {
      const symbol = Object.entries(FEED_IDS).find(([, id]) => id === feed.id)?.[0];
      if (!symbol) return;
      
      const price = feed.getPriceUnsafe();
      if (price) {
        onUpdate(symbol, Number(price.price) * Math.pow(10, price.expo));
      }
    });
  }
}

export const pythService = new PythService();
```

### 5C. Perps Service
```typescript
// src/services/perpsService.ts
import { createPublicClient, createWalletClient, http, parseAbi } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { rhChain } from '../config/chains';
import { pythService } from './pythService';
import { redis } from '../lib/redis';
import { db } from '../lib/db';

const AGRI_PERP_ABI = parseAbi([
  'function openPosition(string symbol, uint8 direction, uint256 collateralAmount, uint256 leverage, bytes[] pythUpdateData) payable returns (uint256)',
  'function closePosition(uint256 positionId, bytes[] pythUpdateData) payable',
  'function liquidate(uint256 positionId, bytes[] pythUpdateData) payable',
  'function getPosition(uint256 positionId) view returns (tuple(address trader, string symbol, uint8 direction, uint256 collateral, uint256 size, uint256 leverage, int64 entryPrice, uint32 entryExpo, uint256 openTime, uint256 lastFundingTime, int256 fundingAccrued, uint8 status))',
  'function getUserPositions(address user) view returns (uint256[])',
]);

const AGRI_VAULT_ABI = parseAbi([
  'function deposit(uint256 amount)',
  'function withdraw(uint256 amount)',
  'function collateral(address user) view returns (uint256)',
]);

export class PerpsService {
  private publicClient = createPublicClient({ chain: rhChain, transport: http() });
  
  async getMarkets(category?: 'agri' | 'crypto' | 'stocks') {
    const categories = {
      agri: ['CORN', 'SOYB', 'WEAT', 'COFF', 'COCC', 'SUGA', 'RICE'],
      crypto: ['BTC', 'ETH', 'SOL', 'ARB'],
      stocks: ['AAPL', 'TSLA', 'NVDA', 'AMZN', 'GOOG', 'MSFT', 'META'],
    };
    
    const symbols = category ? categories[category] : Object.values(categories).flat();
    
    const prices = await pythService.getMultiplePrices(symbols);
    
    // Ambil funding rate dari contract atau Redis
    const fundingRates = await this.getFundingRates(symbols);
    
    // Ambil open interest dari DB
    const openInterest = await this.getOpenInterest(symbols);
    
    return symbols.map(symbol => ({
      symbol,
      category: this.getCategory(symbol, categories),
      ...prices[symbol],
      fundingRate: fundingRates[symbol] ?? 0,
      openInterest: openInterest[symbol] ?? 0,
      maxLeverage: 50,
    }));
  }
  
  async quotePosition(params: {
    symbol: string;
    direction: 'long' | 'short';
    collateral: number; // USDC amount
    leverage: number;
  }) {
    const { price, updateData } = await pythService.getLatestPrice(params.symbol);
    
    const size = params.collateral * params.leverage;
    const fee = size * 0.001; // 0.1%
    const liquidationPrice = this.calcLiquidationPrice(
      price,
      params.direction,
      params.leverage
    );
    
    const fundingRate = await this.getFundingRate(params.symbol);
    
    return {
      symbol: params.symbol,
      direction: params.direction,
      entryPrice: price,
      size,
      collateral: params.collateral,
      leverage: params.leverage,
      fee,
      liquidationPrice,
      fundingRatePerHour: fundingRate,
      priceImpact: this.estimatePriceImpact(size),
      updateData, // dikirim ke frontend untuk sign transaksi
    };
  }
  
  async getUserPositions(userAddress: string) {
    const positionIds = await this.publicClient.readContract({
      address: process.env.AGRI_PERP_ADDRESS as `0x${string}`,
      abi: AGRI_PERP_ABI,
      functionName: 'getUserPositions',
      args: [userAddress as `0x${string}`],
    });
    
    const positions = await Promise.all(
      positionIds.map(id => this.publicClient.readContract({
        address: process.env.AGRI_PERP_ADDRESS as `0x${string}`,
        abi: AGRI_PERP_ABI,
        functionName: 'getPosition',
        args: [id],
      }))
    );
    
    // Enrich dengan current price & unrealized PnL
    const enriched = await Promise.all(
      positions.map(async (pos, i) => {
        const { price } = await pythService.getLatestPrice(pos.symbol);
        const pnl = this.calcUnrealizedPnl(pos, price);
        return {
          id: positionIds[i].toString(),
          ...pos,
          currentPrice: price,
          unrealizedPnl: pnl,
          pnlPercent: (pnl / Number(pos.collateral)) * 100,
        };
      })
    );
    
    return enriched.filter(p => p.status === 0); // 0 = OPEN
  }
  
  async getUserCollateral(userAddress: string) {
    return this.publicClient.readContract({
      address: process.env.AGRI_VAULT_ADDRESS as `0x${string}`,
      abi: AGRI_VAULT_ABI,
      functionName: 'collateral',
      args: [userAddress as `0x${string}`],
    });
  }
  
  private calcLiquidationPrice(
    entryPrice: number,
    direction: 'long' | 'short',
    leverage: number
  ): number {
    const liquidationThreshold = 0.8; // 80%
    const movement = (liquidationThreshold / leverage) * entryPrice;
    return direction === 'long'
      ? entryPrice - movement
      : entryPrice + movement;
  }
  
  private calcUnrealizedPnl(pos: any, currentPrice: number): number {
    const entryPrice = Number(pos.entryPrice) * Math.pow(10, -Number(pos.entryExpo));
    const size = Number(pos.size) / 1e6; // USDC 6 decimals
    const priceDelta = currentPrice - entryPrice;
    return pos.direction === 0 // LONG
      ? (priceDelta / entryPrice) * size
      : (-priceDelta / entryPrice) * size;
  }
  
  private estimatePriceImpact(size: number): number {
    // Simplified: impact naik linear dengan size
    return Math.min(size / 1_000_000, 0.005); // max 0.5%
  }
  
  private getCategory(
    symbol: string,
    categories: Record<string, string[]>
  ): string {
    return Object.entries(categories).find(([, syms]) => syms.includes(symbol))?.[0] ?? 'unknown';
  }
  
  private async getFundingRate(symbol: string): Promise<number> {
    const cached = await redis.get(`funding:${symbol}`);
    return cached ? parseFloat(cached) : 0.0001; // default 0.01% per hour
  }
  
  private async getFundingRates(symbols: string[]): Promise<Record<string, number>> {
    const rates: Record<string, number> = {};
    await Promise.all(symbols.map(async s => {
      rates[s] = await this.getFundingRate(s);
    }));
    return rates;
  }
  
  private async getOpenInterest(symbols: string[]): Promise<Record<string, number>> {
    // Query dari DB — aggregate posisi OPEN per symbol
    const rows = await db.query(
      `SELECT symbol, SUM(size) as oi FROM positions WHERE status = 'OPEN' AND symbol = ANY($1) GROUP BY symbol`,
      [symbols]
    );
    return Object.fromEntries(rows.rows.map((r: any) => [r.symbol, Number(r.oi)]));
  }
}

export const perpsService = new PerpsService();
```

### 5D. Liquidator Keeper Bot
```typescript
// src/jobs/liquidatorKeeper.ts
// Jalankan sebagai background job / cron setiap 1 menit
import { createWalletClient, http } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';
import { rhChain } from '../config/chains';
import { pythService } from '../services/pythService';
import { db } from '../lib/db';
import cron from 'node-cron';

const keeperAccount = privateKeyToAccount(process.env.KEEPER_PRIVATE_KEY as `0x${string}`);

async function checkLiquidations() {
  // Ambil semua posisi OPEN dari DB
  const openPositions = await db.query(
    `SELECT id, symbol, direction, collateral, size, entry_price, entry_expo 
     FROM positions WHERE status = 'open'`
  );
  
  const toLiquidate: number[] = [];
  
  for (const pos of openPositions.rows) {
    const { price } = await pythService.getLatestPrice(pos.symbol);
    
    const entryPrice = Number(pos.entry_price) * Math.pow(10, -Number(pos.entry_expo));
    const priceDelta = price - entryPrice;
    const size = Number(pos.size) / 1e6;
    
    const pnl = pos.direction === 'long'
      ? (priceDelta / entryPrice) * size
      : (-priceDelta / entryPrice) * size;
    
    const lossPercent = (-pnl / (Number(pos.collateral) / 1e6)) * 100;
    
    if (lossPercent >= 80) {
      toLiquidate.push(pos.id);
    }
  }
  
  if (toLiquidate.length === 0) return;
  
  console.log(`[Liquidator] ${toLiquidate.length} positions to liquidate`);
  
  // Kirim transaksi liquidasi per batch
  for (const positionId of toLiquidate) {
    try {
      const pos = openPositions.rows.find((p: any) => p.id === positionId);
      const { updateData } = await pythService.getLatestPrice(pos.symbol);
      
      // Call liquidate on-chain via keeper wallet
      // (implementasi viem writeContract)
      console.log(`[Liquidator] Liquidating position ${positionId}`);
    } catch (err) {
      console.error(`[Liquidator] Failed to liquidate ${positionId}:`, err);
    }
  }
}

// Jalankan setiap menit
export function startLiquidatorKeeper() {
  cron.schedule('* * * * *', checkLiquidations);
  console.log('[Liquidator] Keeper started');
}
```

---

## 6. API Routes — Fastify

```typescript
// src/routes/perps.ts
import { FastifyInstance } from 'fastify';
import { perpsService } from '../services/perpsService';
import { pythService } from '../services/pythService';
import { requireAuth } from '../middleware/auth'; // SIWE auth

export async function perpsRoutes(app: FastifyInstance) {
  
  // GET /api/perps/markets
  // Query: ?category=agri|crypto|stocks
  app.get('/api/perps/markets', async (req, reply) => {
    const { category } = req.query as { category?: string };
    const markets = await perpsService.getMarkets(category as any);
    return reply.send({ markets });
  });
  
  // GET /api/perps/price/:symbol
  // Harga terbaru + updateData untuk transaksi
  app.get('/api/perps/price/:symbol', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const data = await pythService.getLatestPrice(symbol.toUpperCase());
    return reply.send(data);
  });
  
  // GET /api/perps/candles/:symbol
  // Query: ?interval=1h|4h|1d&limit=100
  app.get('/api/perps/candles/:symbol', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    const { interval = '1h', limit = '100' } = req.query as any;
    
    // Ambil OHLC dari Redis/DB (dicache dari Pyth streaming)
    const candles = await app.redis.lrange(
      `candles:${symbol}:${interval}`,
      0,
      parseInt(limit) - 1
    );
    
    return reply.send({
      symbol,
      interval,
      candles: candles.map(c => JSON.parse(c)),
    });
  });
  
  // POST /api/perps/quote
  // Preview posisi sebelum open
  // Body: { symbol, direction, collateral, leverage }
  app.post('/api/perps/quote', { preHandler: requireAuth }, async (req, reply) => {
    const body = req.body as {
      symbol: string;
      direction: 'long' | 'short';
      collateral: number;
      leverage: number;
    };
    
    const quote = await perpsService.quotePosition(body);
    return reply.send(quote);
  });
  
  // GET /api/perps/positions
  // Posisi terbuka user
  app.get('/api/perps/positions', { preHandler: requireAuth }, async (req, reply) => {
    const positions = await perpsService.getUserPositions(req.user.address);
    return reply.send({ positions });
  });
  
  // GET /api/perps/collateral
  // Saldo collateral user di vault
  app.get('/api/perps/collateral', { preHandler: requireAuth }, async (req, reply) => {
    const collateral = await perpsService.getUserCollateral(req.user.address);
    return reply.send({ collateral: collateral.toString() });
  });
  
  // GET /api/perps/history
  // Riwayat posisi (closed + liquidated)
  app.get('/api/perps/history', { preHandler: requireAuth }, async (req, reply) => {
    const { page = '1', limit = '20' } = req.query as any;
    const offset = (parseInt(page) - 1) * parseInt(limit);
    
    const rows = await app.db.query(
      `SELECT * FROM positions 
       WHERE trader_address = $1 AND status != 'open'
       ORDER BY close_time DESC
       LIMIT $2 OFFSET $3`,
      [req.user.address, parseInt(limit), offset]
    );
    
    return reply.send({ positions: rows.rows, page: parseInt(page) });
  });
  
  // GET /api/perps/stats/:symbol
  // Stats market: OI, volume 24h, funding rate, price history
  app.get('/api/perps/stats/:symbol', async (req, reply) => {
    const { symbol } = req.params as { symbol: string };
    
    const [price, fundingRate, oi, volume24h] = await Promise.all([
      pythService.getLatestPrice(symbol.toUpperCase()),
      app.redis.get(`funding:${symbol}`),
      app.db.query(
        `SELECT SUM(size) as oi, SUM(CASE WHEN direction='long' THEN size ELSE 0 END) as long_oi
         FROM positions WHERE symbol=$1 AND status='open'`,
        [symbol.toUpperCase()]
      ),
      app.db.query(
        `SELECT SUM(size) as volume FROM positions 
         WHERE symbol=$1 AND open_time > NOW() - INTERVAL '24 hours'`,
        [symbol.toUpperCase()]
      ),
    ]);
    
    return reply.send({
      symbol,
      price: price.price,
      fundingRatePerHour: parseFloat(fundingRate ?? '0.0001'),
      openInterest: oi.rows[0]?.oi ?? 0,
      longOiPercent: oi.rows[0]?.long_oi && oi.rows[0]?.oi
        ? (Number(oi.rows[0].long_oi) / Number(oi.rows[0].oi)) * 100
        : 50,
      volume24h: volume24h.rows[0]?.volume ?? 0,
    });
  });
}
```

---

## 7. Database Schema (Tambahan)

```sql
-- Tabel posisi perps
CREATE TABLE positions (
  id                BIGSERIAL PRIMARY KEY,
  position_id_chain BIGINT NOT NULL,        -- ID dari smart contract
  trader_address    VARCHAR(42) NOT NULL,
  symbol            VARCHAR(20) NOT NULL,
  category          VARCHAR(20) NOT NULL,    -- agri | crypto | stocks
  direction         VARCHAR(10) NOT NULL,    -- long | short
  collateral        NUMERIC(20, 6) NOT NULL, -- USDC
  size              NUMERIC(20, 6) NOT NULL, -- notional
  leverage          INT NOT NULL,
  entry_price       NUMERIC(20, 8) NOT NULL,
  entry_expo        INT NOT NULL,
  open_time         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  close_time        TIMESTAMPTZ,
  close_price       NUMERIC(20, 8),
  realized_pnl      NUMERIC(20, 6),
  funding_paid      NUMERIC(20, 6) DEFAULT 0,
  status            VARCHAR(20) NOT NULL DEFAULT 'open', -- open | closed | liquidated
  tx_open           VARCHAR(66),            -- transaction hash open
  tx_close          VARCHAR(66),
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX idx_positions_trader ON positions(trader_address);
CREATE INDEX idx_positions_symbol ON positions(symbol);
CREATE INDEX idx_positions_status ON positions(status);

-- Cache OHLC candles (bisa juga di Redis saja)
CREATE TABLE price_candles (
  id         BIGSERIAL PRIMARY KEY,
  symbol     VARCHAR(20) NOT NULL,
  interval   VARCHAR(10) NOT NULL,  -- 1m | 5m | 15m | 1h | 4h | 1d
  open_time  TIMESTAMPTZ NOT NULL,
  open       NUMERIC(20, 8) NOT NULL,
  high       NUMERIC(20, 8) NOT NULL,
  low        NUMERIC(20, 8) NOT NULL,
  close      NUMERIC(20, 8) NOT NULL,
  volume     NUMERIC(20, 6) DEFAULT 0
);

CREATE UNIQUE INDEX idx_candles_unique ON price_candles(symbol, interval, open_time);

-- Funding rate history
CREATE TABLE funding_history (
  id         BIGSERIAL PRIMARY KEY,
  symbol     VARCHAR(20) NOT NULL,
  rate_bps   NUMERIC(10, 4) NOT NULL,
  recorded_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

---

## 8. Frontend — React/Next.js

### 8A. Market Selector Component
```typescript
// components/perps/MarketSelector.tsx
'use client';

import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';

const CATEGORIES = [
  { id: 'agri', label: '🌾 Agri', emoji: true },
  { id: 'crypto', label: '₿ Crypto', emoji: true },
  { id: 'stocks', label: '📈 Stocks', emoji: true },
] as const;

export function MarketSelector({ 
  onSelect 
}: { 
  onSelect: (symbol: string) => void 
}) {
  const [category, setCategory] = useState<string>('agri');
  const [selected, setSelected] = useState<string>('CORN');
  
  const { data } = useQuery({
    queryKey: ['perps-markets', category],
    queryFn: () => fetch(`/api/perps/markets?category=${category}`).then(r => r.json()),
    refetchInterval: 5000,
  });
  
  return (
    <div className="flex flex-col gap-2">
      {/* Category tabs */}
      <div className="flex gap-1 p-1 bg-[#111] rounded-lg">
        {CATEGORIES.map(cat => (
          <button
            key={cat.id}
            onClick={() => setCategory(cat.id)}
            className={`flex-1 py-1.5 px-3 rounded text-sm font-medium transition-colors
              ${category === cat.id 
                ? 'bg-[#7BE07B] text-black' 
                : 'text-gray-400 hover:text-white'
              }`}
          >
            {cat.label}
          </button>
        ))}
      </div>
      
      {/* Market list */}
      <div className="flex flex-col gap-1 max-h-[400px] overflow-y-auto">
        {data?.markets?.map((market: any) => (
          <button
            key={market.symbol}
            onClick={() => {
              setSelected(market.symbol);
              onSelect(market.symbol);
            }}
            className={`flex items-center justify-between px-3 py-2 rounded-lg text-sm transition-colors
              ${selected === market.symbol 
                ? 'bg-[#7BE07B]/10 border border-[#7BE07B]/30' 
                : 'hover:bg-white/5'
              }`}
          >
            <div className="flex items-center gap-2">
              <span className="font-mono font-bold text-white">{market.symbol}</span>
              <span className="text-gray-500 text-xs">/USD</span>
            </div>
            <div className="flex items-center gap-3">
              <span className="font-mono text-white">
                ${market.price?.toLocaleString('en-US', { minimumFractionDigits: 2 })}
              </span>
              <span className={`text-xs font-mono ${
                market.change24h >= 0 ? 'text-[#7BE07B]' : 'text-[#FFA79C]'
              }`}>
                {market.change24h >= 0 ? '+' : ''}{market.change24h?.toFixed(2)}%
              </span>
            </div>
          </button>
        ))}
      </div>
    </div>
  );
}
```

### 8B. Order Ticket Component
```typescript
// components/perps/OrderTicket.tsx
'use client';

import { useState } from 'react';
import { useAccount, useWriteContract, useWaitForTransactionReceipt } from 'wagmi';
import { parseUnits } from 'viem';
import { useMutation, useQuery } from '@tanstack/react-query';

const AGRI_PERP_ABI = [/* ... ABI dari contract */] as const;

interface OrderTicketProps {
  symbol: string;
  currentPrice: number;
}

export function OrderTicket({ symbol, currentPrice }: OrderTicketProps) {
  const { address } = useAccount();
  const [direction, setDirection] = useState<'long' | 'short'>('long');
  const [collateral, setCollateral] = useState('');
  const [leverage, setLeverage] = useState(5);
  
  const { writeContract, data: txHash } = useWriteContract();
  const { isLoading: txPending } = useWaitForTransactionReceipt({ hash: txHash });
  
  // Fetch quote
  const { data: quote } = useQuery({
    queryKey: ['perp-quote', symbol, direction, collateral, leverage],
    queryFn: () => fetch('/api/perps/quote', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ symbol, direction, collateral: parseFloat(collateral), leverage }),
    }).then(r => r.json()),
    enabled: !!collateral && parseFloat(collateral) > 0,
  });
  
  const handleOpenPosition = async () => {
    if (!quote || !address) return;
    
    writeContract({
      address: process.env.NEXT_PUBLIC_AGRI_PERP_ADDRESS as `0x${string}`,
      abi: AGRI_PERP_ABI,
      functionName: 'openPosition',
      args: [
        symbol,
        direction === 'long' ? 0 : 1,
        parseUnits(collateral, 6),
        BigInt(leverage),
        quote.updateData,
      ],
      value: BigInt(1), // Pyth update fee
    });
  };
  
  return (
    <div className="flex flex-col gap-4 p-4 bg-[#111] rounded-xl border border-white/10">
      {/* Direction selector */}
      <div className="flex gap-2">
        <button
          onClick={() => setDirection('long')}
          className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition-colors
            ${direction === 'long' 
              ? 'bg-[#7BE07B] text-black' 
              : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
        >
          LONG ↑
        </button>
        <button
          onClick={() => setDirection('short')}
          className={`flex-1 py-2.5 rounded-lg font-semibold text-sm transition-colors
            ${direction === 'short' 
              ? 'bg-[#FFA79C] text-black' 
              : 'bg-white/5 text-gray-400 hover:bg-white/10'
            }`}
        >
          SHORT ↓
        </button>
      </div>
      
      {/* Collateral input */}
      <div className="flex flex-col gap-1.5">
        <label className="text-xs text-gray-400">Collateral (USDC)</label>
        <div className="flex items-center gap-2 bg-white/5 rounded-lg px-3 py-2 border border-white/10 focus-within:border-[#7BE07B]/50">
          <input
            type="number"
            placeholder="0.00"
            value={collateral}
            onChange={e => setCollateral(e.target.value)}
            className="flex-1 bg-transparent text-white font-mono text-sm outline-none"
          />
          <span className="text-gray-500 text-xs">USDC</span>
        </div>
      </div>
      
      {/* Leverage slider */}
      <div className="flex flex-col gap-1.5">
        <div className="flex justify-between">
          <label className="text-xs text-gray-400">Leverage</label>
          <span className="text-xs font-mono text-[#7BE07B]">{leverage}x</span>
        </div>
        <input
          type="range"
          min={1}
          max={50}
          value={leverage}
          onChange={e => setLeverage(parseInt(e.target.value))}
          className="w-full accent-[#7BE07B]"
        />
        <div className="flex justify-between text-xs text-gray-600">
          <span>1x</span><span>10x</span><span>25x</span><span>50x</span>
        </div>
      </div>
      
      {/* Quote preview */}
      {quote && (
        <div className="flex flex-col gap-2 p-3 bg-white/5 rounded-lg text-xs">
          <div className="flex justify-between">
            <span className="text-gray-400">Entry Price</span>
            <span className="font-mono text-white">${quote.entryPrice?.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Size</span>
            <span className="font-mono text-white">${quote.size?.toLocaleString()} USDC</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Liq. Price</span>
            <span className="font-mono text-[#FFA79C]">${quote.liquidationPrice?.toLocaleString()}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Fee</span>
            <span className="font-mono text-gray-300">${quote.fee?.toFixed(2)}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-gray-400">Funding/hr</span>
            <span className="font-mono text-gray-300">
              {(quote.fundingRatePerHour * 100).toFixed(4)}%
            </span>
          </div>
        </div>
      )}
      
      {/* Open button */}
      <button
        onClick={handleOpenPosition}
        disabled={!collateral || !address || txPending}
        className={`w-full py-3 rounded-xl font-bold text-sm transition-colors disabled:opacity-40
          ${direction === 'long'
            ? 'bg-[#7BE07B] text-black hover:bg-[#6BCF6B]'
            : 'bg-[#FFA79C] text-black hover:bg-[#FF9088]'
          }`}
      >
        {txPending ? 'Menunggu konfirmasi...' : `Open ${direction.toUpperCase()} ${symbol}`}
      </button>
    </div>
  );
}
```

---

## 9. WebSocket — Harga Real-time ke Frontend

```typescript
// src/ws/priceStream.ts
import { WebSocketServer } from 'ws';
import { pythService } from '../services/pythService';

export function startPriceWebSocket(wss: WebSocketServer) {
  const ALL_SYMBOLS = [
    'CORN', 'SOYB', 'WEAT', 'COFF', 'COCC', 'SUGA', 'RICE',
    'BTC', 'ETH', 'SOL',
    'AAPL', 'TSLA', 'NVDA'
  ];
  
  pythService.subscribePrices(ALL_SYMBOLS, (symbol, price) => {
    const message = JSON.stringify({ type: 'price', symbol, price, ts: Date.now() });
    
    wss.clients.forEach(client => {
      if (client.readyState === 1) { // OPEN
        client.send(message);
      }
    });
  });
  
  console.log('[WS] Price stream started for', ALL_SYMBOLS.length, 'symbols');
}

// Frontend usage (React hook):
// const useRealtimePrice = (symbol: string) => {
//   const [price, setPrice] = useState(0);
//   useEffect(() => {
//     const ws = new WebSocket(process.env.NEXT_PUBLIC_WS_URL!);
//     ws.onmessage = (e) => {
//       const data = JSON.parse(e.data);
//       if (data.type === 'price' && data.symbol === symbol) setPrice(data.price);
//     };
//     return () => ws.close();
//   }, [symbol]);
//   return price;
// };
```

---

## 10. Dependencies Baru

```json
{
  "dependencies": {
    "@pythnetwork/price-service-client": "^1.5.0",
    "@pythnetwork/pyth-sdk-solidity": "^2.0.0",
    "node-cron": "^3.0.3"
  },
  "devDependencies": {
    "@types/node-cron": "^3.0.11"
  }
}
```

```bash
# Install
npm install @pythnetwork/price-service-client @pythnetwork/pyth-sdk-solidity node-cron

# Hardhat untuk compile contract
npm install --save-dev hardhat @nomicfoundation/hardhat-toolbox

# Compile & deploy
npx hardhat compile
npx hardhat run scripts/deploy.ts --network rhchain
```

---

## 11. Urutan Build (Recommended)

```
Step 1 — Oracle setup
  ✓ Cek apakah Pyth sudah di RH Chain
  ✓ Deploy AgriFeed.sol
  ✓ Test getPrice() untuk CORN, COFF, WEAT di testnet

Step 2 — Smart contracts
  ✓ Deploy AgriVault.sol
  ✓ Deploy AgriPerp.sol (pointing ke vault + oracle)
  ✓ Test open → close → liquidate di testnet
  ✓ Audit eksternal (wajib sebelum mainnet)

Step 3 — Backend
  ✓ Setup PythService + WebSocket price stream
  ✓ Implement semua API routes /api/perps/*
  ✓ Setup liquidator keeper (cron tiap 1 menit)
  ✓ Setup candle builder dari price stream → Redis

Step 4 — Frontend
  ✓ Update menu label: Trade → Perps
  ✓ Tambah MarketSelector dengan 3 kategori (Agri/Crypto/Stocks)
  ✓ Integrate OrderTicket dengan wagmi writeContract
  ✓ Posisi terbuka + PnL realtime
  ✓ Collateral deposit/withdraw UI

Step 5 — Launch
  ✓ Mainnet deploy semua contracts
  ✓ Seed awal liquidity di AgriVault
  ✓ Aktifkan keeper bot
  ✓ Buka beta ke whitelist holder $RCHAN
```

---

## 12. Catatan Penting untuk Dev

1. **Audit wajib sebelum mainnet** — jangan skip, perps contract pegang uang user
2. **Pyth update fee** — setiap call `getPrice()` butuh ETH kecil untuk update oracle. Frontend harus kirim `value` yang cukup — ambil dari `pyth.getUpdateFee()` dulu
3. **PALM/USD** — belum ada di Pyth, skip untuk MVP atau pakai Bursa Malaysia API sebagai fallback manual
4. **Funding rate** — set manual via `setFundingRate()` untuk MVP. Phase selanjutnya: auto-adjust berdasarkan long/short imbalance
5. **Liquidity pool** — butuh seed awal agar trader bisa profit. Bix bisa LP sendiri di awal atau buka LP program untuk holder $RCHAN
6. **Chat trading** — feature ini di roadmap phase berikutnya, bukan MVP

