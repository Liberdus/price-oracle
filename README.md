# LIB Price Oracle

This script calculates a **7-day time-weighted average price (TWAP)** for **LIB quoted in DAI** using on-chain data from the **LIB/DAI Uniswap V2 pool on Polygon**.

It does **not** use subgraphs/indexers or price oracles. It reconstructs the price directly from Uniswap V2 reserve updates emitted on-chain.

---

## Run locally

### Prerequisites
- Node.js 18+ recommended
- npm

### Install
```bash
npm init -y
npm i ethers@5
```

### Run
```bash
node lib_price_7d_logs.js
```

The script prints a JSON result containing:
- `avgQuotePerBase` – the 7-day TWAP (DAI per 1 LIB)
- `minQuotePerBase`, `maxQuotePerBase` – min/max hourly prices
- `rpcUsed` – which RPC endpoint succeeded
- `rpcFailures` – RPCs that failed and why

---

## What the script does (high level)

1. Defines a 7-day window ending at **midnight UTC**.
2. Fetches **Uniswap V2 `Sync(reserve0, reserve1)` logs** from the LIB/DAI pool over that window (plus a small buffer).
3. Reconstructs an **hourly price series** from reserve snapshots.
4. Averages the hourly prices to produce a **7-day TWAP**.

---

## Which logs are fetched

The script calls `eth_getLogs` with:
- `address = <LIB/DAI pair contract>`
- `topics[0] = keccak256("Sync(uint112,uint112)")`

Only **`Sync` events** from the LIB/DAI pair are fetched.

Why this is sufficient:
- `Sync` is emitted whenever Uniswap V2 reserves change
- This includes swaps, add liquidity (mint), and remove liquidity (burn)
- Each `Sync` reflects the **final reserve state** after that transaction

No `Swap`, `Mint`, or `Burn` logs are required to compute price.

---

## Multiple Sync events in a block

A single block may contain **multiple `Sync` events** if multiple transactions interact with the pool.

- Logs are strictly ordered by `(blockNumber, logIndex)`
- The script sorts events using this ordering
- For any time boundary, it selects the **last `Sync` event with `blockNumber <= boundaryBlock`**

If multiple `Sync`s occur in the same block, the script naturally uses the **final reserve state of that block**, which matches on-chain reality.

---

## Determining the block and time range

The script works in timestamps, but logs are queried by block range. It bridges the two as follows:

1. **Time window**
   - `endTs` = midnight UTC of the current day
   - `startTs` = `endTs - 7 days`
   - `bufferedStartTs` = `startTs - LOG_BUFFER_DAYS`

2. **Block boundaries**
   - `fromBlock` = first block with timestamp ≥ `bufferedStartTs`
   - `toBlock` = last block with timestamp ≤ `endTs`

These blocks are found via binary search using block timestamps (`eth_getBlockByNumber`).

---

## How the TWAP is calculated

### 1. Split into hourly samples

The 7-day window is divided into **168 hourly boundaries**:

```
startTs, startTs + 1h, startTs + 2h, ... , endTs
```

Each boundary represents one hourly price sample.

---

### 2. Map hourly timestamps to blocks

For each hourly timestamp, the script estimates the corresponding block number using **linear interpolation** between two anchor points:

- `(startTs → startBlock)`
- `(endTs → endBlock)`

This avoids expensive per-hour binary searches and keeps timestamp drift bounded to block-time variance.

---

### 3. Select reserves for each hour

For each hourly boundary block:
- the most recent `Sync` event with `blockNumber <= boundaryBlock` is selected
- if no `Sync` occurs during an hour, the previous reserves are carried forward

This matches Uniswap’s behavior: **price only changes when reserves change**.

---

### 4. Convert reserves to price

Price is derived from reserves as:

```
price = (reserveDAI / 10^daiDecimals) / (reserveLIB / 10^libDecimals)
      = (reserveDAI * 10^libDecimals) / (reserveLIB * 10^daiDecimals)
```

All calculations are done using integer math with a 1e18 fixed-point scale.

---

### 5. Average hourly prices

The final TWAP is computed as:

```
TWAP = (p0 + p1 + ... + p167) / 168
```

The script also tracks minimum and maximum hourly prices for observability.

---

## RPC fallback behavior

The script tries multiple RPC endpoints sequentially:

1. Runs a quick sanity check (`eth_chainId`, `eth_blockNumber`)
2. Attempts the full calculation
3. If an RPC fails (timeout, unauthorized, pruned history, log limits, etc.), it falls back to the next RPC

The first RPC that completes successfully is used. All failures are recorded in the output.

---

## Notes

- This is a proof-of-concept implementation (single-RPC success is sufficient)
- Public RPCs vary widely in quality and history retention
- If no `Sync` event exists at or before the start boundary, increase `LOG_BUFFER_DAYS`

