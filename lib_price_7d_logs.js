#!/usr/bin/env node
'use strict';

/**
 * LIB/DAI Uniswap V2 (Polygon) — 7-day average price via Sync logs (no archive needed)
 *
 * PoC:
 * - Hardcoded config
 * - Tries multiple RPCs, skips failures, uses first that works
 * - Minimal progress logs (stderr) so you can tell it's alive
 *
 * Requires:
 *   npm i ethers@5
 *
 * Run:
 *   node lib_price_7d_logs.js
 */

const { ethers } = require('ethers');

// =====================
// HARD-CODED CONFIG
// =====================

// Uniswap V2 Pair (Polygon): LIB/DAI
const PAIR_ADDRESS = '0x958b98ed7b1362ee2580df87150d00439030661d';

// Polygon PoS DAI address
const POLYGON_DAI = '0x8f3cf7ad23cd3cadbd9735aff958023239c6a063';

// Public RPCs to try (no API keys)
// Sources: chainid.network / dRPC chainlist pages
const RPC_URLS = [
  'https://polygon.drpc.org',
  'https://polygon.gateway.tenderly.co',
];

// How far back to fetch logs BEFORE the 7d window, to ensure we have a Sync <= start boundary
const LOG_BUFFER_DAYS = 2;

// Log query chunk size (blocks). Smaller = safer on public RPCs, but slower.
const MAX_LOG_CHUNK_BLOCKS = 8000;

// Hard timeout (ms) for each RPC request (ethers will abort)
const REQUEST_TIMEOUT_MS = 20_000;

// Window definition
const INTERVAL_SECONDS = 3600;          // hourly
const WINDOW_SECONDS = 7 * 24 * 3600;   // 7 days

// =====================
// ABIs
// =====================
const UNISWAP_V2_PAIR_ABI = [
  'event Sync(uint112 reserve0, uint112 reserve1)',
  'function token0() external view returns (address)',
  'function token1() external view returns (address)',
  'function getReserves() external view returns (uint112 reserve0, uint112 reserve1, uint32 blockTimestampLast)',
];

const ERC20_ABI = [
  'function symbol() external view returns (string)',
  'function decimals() external view returns (uint8)',
];

// =====================
// Helpers
// =====================
function logp(msg) {
  console.error(msg);
}

function toMidnightUTC(date = new Date()) {
  return Math.floor(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()) / 1000);
}

function pow10BigInt(n) {
  let x = 1n;
  for (let i = 0; i < n; i++) x *= 10n;
  return x;
}

function formatFixed18(x18) {
  const s = x18.toString();
  const neg = s.startsWith('-');
  const raw = neg ? s.slice(1) : s;

  const pad = raw.length <= 18 ? '0'.repeat(18 - raw.length + 1) + raw : raw;
  const intPart = pad.slice(0, -18);
  const fracPart = pad.slice(-18).replace(/0+$/, '');
  return (neg ? '-' : '') + intPart + (fracPart ? '.' + fracPart : '');
}

async function getBlock(provider, blockNumber) {
  const b = await provider.getBlock(blockNumber);
  if (!b || !b.timestamp) throw new Error(`Failed to fetch block ${blockNumber}`);
  return b;
}

/**
 * Quick RPC sanity check so we skip dead endpoints fast.
 */
async function sanityCheck(provider) {
  // These should be very fast. If they hang, timeout kicks in.
  const chainIdHex = await provider.send('eth_chainId', []);
  const bnHex = await provider.send('eth_blockNumber', []);
  const chainId = parseInt(chainIdHex, 16);
  if (chainId !== 137) throw new Error(`Unexpected chainId=${chainId} (wanted 137)`);
  if (!bnHex) throw new Error('No blockNumber returned');
}

/**
 * Find the smallest block with timestamp >= targetTs.
 */
async function findFirstBlockAtOrAfter(provider, targetTs, lowBlock, highBlock) {
  let lo = lowBlock;
  let hi = highBlock;
  let ans = highBlock;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await getBlock(provider, mid);

    if (b.timestamp >= targetTs) {
      ans = mid;
      hi = mid - 1;
    } else {
      lo = mid + 1;
    }
  }
  return ans;
}

/**
 * Find the greatest block with timestamp <= targetTs.
 */
async function findLastBlockAtOrBefore(provider, targetTs, lowBlock, highBlock) {
  let lo = lowBlock;
  let hi = highBlock;
  let ans = lowBlock;

  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    const b = await getBlock(provider, mid);

    if (b.timestamp <= targetTs) {
      ans = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return ans;
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

/**
 * Chunked getLogs with adaptive chunk sizing on failure.
 */
async function fetchLogsChunked(provider, filter, fromBlock, toBlock, maxChunkBlocks) {
  const out = [];
  let from = fromBlock;
  let chunk = maxChunkBlocks;

  let chunksDone = 0;
  const totalBlocks = (toBlock - fromBlock + 1);

  while (from <= toBlock) {
    const to = Math.min(toBlock, from + chunk - 1);

    if (chunksDone % 30 === 0) {
      const doneBlocks = (from - fromBlock);
      const pct = totalBlocks > 0 ? Math.floor((doneBlocks * 100) / totalBlocks) : 0;
      logp(`[logs] ${pct}% range, chunk=${chunk}, from=${from}, to=${to}`);
    }

    try {
      const logs = await provider.getLogs({ ...filter, fromBlock: from, toBlock: to });
      out.push(...logs);
      from = to + 1;
      chunksDone++;

      if (chunk < maxChunkBlocks) chunk = Math.min(maxChunkBlocks, Math.floor(chunk * 1.25));
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);

      const fatal =
        msg.includes('History has been pruned') ||
        msg.includes('history has been pruned') ||
        msg.includes('Access token missing') ||
        msg.includes('missing or invalid') ||
        msg.includes('Unauthorized') ||
        msg.includes('unauthorized') ||
        msg.includes('401');

      if (fatal) throw new Error(`getLogs fatal on this RPC: ${msg}`);

      if (chunk <= 200) {
        throw new Error(`getLogs failed even at small chunk size (${chunk}) fromBlock=${from} toBlock=${to}: ${msg}`);
      }
      chunk = Math.floor(chunk / 2);
      await sleep(250);
    }
  }

  return out;
}

// =====================
// Core computation per RPC
// =====================
async function computeWithRpc(rpcUrl) {
  logp(`\n[rpc] trying ${rpcUrl}`);

  // Force Polygon network + real request timeout (ethers v5)
  const provider = new ethers.providers.JsonRpcProvider(
    { url: rpcUrl, timeout: REQUEST_TIMEOUT_MS },
    { chainId: 137, name: 'matic' }
  );
  provider.pollingInterval = 4000;

  logp(`[rpc] sanity check...`);
  await sanityCheck(provider);

  // Window: previous 7d ending at midnight UTC (exclusive end)
  const endTs = toMidnightUTC(new Date());
  const startTs = endTs - WINDOW_SECONDS;
  const bufferedStartTs = startTs - (LOG_BUFFER_DAYS * 24 * 3600);

  logp(`[window] ${new Date(startTs * 1000).toISOString()} → ${new Date(endTs * 1000).toISOString()} (buffer ${LOG_BUFFER_DAYS}d)`);

  // Latest block and sanity
  const latestBlockNumber = await provider.getBlockNumber();
  const latestBlock = await getBlock(provider, latestBlockNumber);

  if (endTs > latestBlock.timestamp) {
    throw new Error(`RPC behind: endTs=${endTs} latestTs=${latestBlock.timestamp}`);
  }

  // Contracts & metadata
  const pair = new ethers.Contract(PAIR_ADDRESS, UNISWAP_V2_PAIR_ABI, provider);
  const [token0Raw, token1Raw] = await Promise.all([pair.token0(), pair.token1()]);
  const token0 = token0Raw.toLowerCase();
  const token1 = token1Raw.toLowerCase();

  const t0 = new ethers.Contract(token0, ERC20_ABI, provider);
  const t1 = new ethers.Contract(token1, ERC20_ABI, provider);

  const [sym0, dec0, sym1, dec1] = await Promise.all([t0.symbol(), t0.decimals(), t1.symbol(), t1.decimals()]);

  let daiIs0;
  if (token0 === POLYGON_DAI.toLowerCase()) daiIs0 = true;
  else if (token1 === POLYGON_DAI.toLowerCase()) daiIs0 = false;
  else throw new Error(`Neither token in pair is Polygon DAI. token0=${token0} token1=${token1}`);

  const libSymbol = daiIs0 ? sym1 : sym0;
  const daiSymbol = daiIs0 ? sym0 : sym1;
  const libDecimals = daiIs0 ? dec1 : dec0;
  const daiDecimals = daiIs0 ? dec0 : dec1;

  logp(`[pair] token0=${sym0}(${dec0}) ${token0} | token1=${sym1}(${dec1}) ${token1} => pricing ${daiSymbol}/${libSymbol}`);

  // Find block range for logs
  const lowBound = 1;
  logp(`[range] locating from/to blocks by timestamp...`);
  const fromBlock = await findFirstBlockAtOrAfter(provider, bufferedStartTs, lowBound, latestBlockNumber);
  const toBlock = await findLastBlockAtOrBefore(provider, endTs, lowBound, latestBlockNumber);

  if (fromBlock > toBlock) throw new Error(`Bad log range: fromBlock=${fromBlock} toBlock=${toBlock}`);

  logp(`[range] fromBlock=${fromBlock} toBlock=${toBlock} (~${toBlock - fromBlock + 1} blocks)`);

  // Fetch Sync logs
  const iface = new ethers.utils.Interface(UNISWAP_V2_PAIR_ABI);
  const syncTopic = iface.getEventTopic('Sync');

  logp(`[logs] fetching Sync logs (maxChunk=${MAX_LOG_CHUNK_BLOCKS})...`);
  const rawLogs = await fetchLogsChunked(
    provider,
    { address: PAIR_ADDRESS, topics: [syncTopic] },
    fromBlock,
    toBlock,
    MAX_LOG_CHUNK_BLOCKS
  );

  logp(`[logs] fetched ${rawLogs.length} raw logs`);

  // Parse logs into events
  const syncEvents = [];
  for (const log of rawLogs) {
    const parsed = iface.parseLog(log);
    syncEvents.push({
      blockNumber: log.blockNumber,
      logIndex: log.logIndex,
      reserve0: parsed.args.reserve0.toString(),
      reserve1: parsed.args.reserve1.toString(),
    });
  }

  if (syncEvents.length === 0) {
    logp(`[warn] no Sync logs found; falling back to current getReserves()`);
    const r = await pair.getReserves();
    const r0 = BigInt(r.reserve0.toString());
    const r1 = BigInt(r.reserve1.toString());
    const reserveDAI = daiIs0 ? r0 : r1;
    const reserveLIB = daiIs0 ? r1 : r0;
    if (reserveDAI === 0n || reserveLIB === 0n) throw new Error('Zero current reserves; cannot price.');

    const SCALE_18 = 10n ** 18n;
    const tenLib = pow10BigInt(libDecimals);
    const tenDai = pow10BigInt(daiDecimals);
    const price18 = (reserveDAI * tenLib * SCALE_18) / (reserveLIB * tenDai);

    return { avgPrice18: price18, minPrice18: price18, maxPrice18: price18, libSymbol, daiSymbol };
  }

  // Sort by (blockNumber, logIndex)
  syncEvents.sort((a, b) => {
    if (a.blockNumber !== b.blockNumber) return a.blockNumber - b.blockNumber;
    return a.logIndex - b.logIndex;
  });

  // Build hourly boundaries (168)
  const boundaries = [];
  for (let ts = startTs; ts < endTs; ts += INTERVAL_SECONDS) boundaries.push(ts);
  if (boundaries.length !== 168) throw new Error(`Expected 168 hourly boundaries, got ${boundaries.length}`);

  // Boundary blocks: anchor + interpolation + local refine (fast, avoids timestamping every event)
  const startBlockForInterp = await findFirstBlockAtOrAfter(provider, startTs, lowBound, latestBlockNumber);
  const endBlockForInterp = await findLastBlockAtOrBefore(provider, endTs, lowBound, latestBlockNumber);
  const startBlockObj = await getBlock(provider, startBlockForInterp);
  const endBlockObj = await getBlock(provider, endBlockForInterp);

  const blockSpan = endBlockForInterp - startBlockForInterp;
  const timeSpan = endBlockObj.timestamp - startBlockObj.timestamp;
  if (blockSpan <= 0 || timeSpan <= 0) throw new Error('Bad interpolation anchors.');

  async function refineBlockAtOrBefore(targetTs, estBlock) {
    let bNum = Math.min(Math.max(estBlock, startBlockForInterp), endBlockForInterp);
    let b = await getBlock(provider, bNum);

    let steps = 0;
    while (b.timestamp > targetTs && bNum > startBlockForInterp) {
      bNum--;
      b = await getBlock(provider, bNum);
      if (++steps > 30) return await findLastBlockAtOrBefore(provider, targetTs, startBlockForInterp, endBlockForInterp);
    }

    steps = 0;
    while (bNum < endBlockForInterp) {
      const next = await getBlock(provider, bNum + 1);
      if (next.timestamp <= targetTs) {
        bNum++;
        b = next;
        if (++steps > 30) return await findLastBlockAtOrBefore(provider, targetTs, startBlockForInterp, endBlockForInterp);
      } else break;
    }

    return bNum;
  }

  logp(`[calc] locating 168 hourly boundary blocks...`);
  const boundaryBlocks = [];
  for (let i = 0; i < boundaries.length; i++) {
    const ts = boundaries[i];
    const est = startBlockForInterp + Math.floor(((ts - startBlockObj.timestamp) * blockSpan) / timeSpan);

    // Clamp to anchor range
    const bn = Math.min(Math.max(est, startBlockForInterp), endBlockForInterp);
    boundaryBlocks.push(bn);

    if ((i + 1) % 42 === 0) logp(`[calc] boundary blocks: ${i + 1}/168`);
  }

  // Ensure we have a Sync event at or before the first boundary block
  if (syncEvents[0].blockNumber > boundaryBlocks[0]) {
    throw new Error(`No Sync <= start boundary. Increase LOG_BUFFER_DAYS (currently ${LOG_BUFFER_DAYS}).`);
  }

  const SCALE_18 = 10n ** 18n;
  const tenLib = pow10BigInt(libDecimals);
  const tenDai = pow10BigInt(daiDecimals);

  function priceFromReservesStrings(r0s, r1s) {
    const r0 = BigInt(r0s);
    const r1 = BigInt(r1s);
    const reserveDAI = daiIs0 ? r0 : r1;
    const reserveLIB = daiIs0 ? r1 : r0;
    if (reserveDAI === 0n || reserveLIB === 0n) throw new Error('Encountered zero reserves in Sync event.');
    return (reserveDAI * tenLib * SCALE_18) / (reserveLIB * tenDai);
  }

  logp(`[calc] computing hourly prices...`);

  let sumPrice18 = 0n;
  let minPrice18 = null;
  let maxPrice18 = null;

  let evIdx = 0;
  let current = syncEvents[0];

  for (let i = 0; i < boundaryBlocks.length; i++) {
    const bBlock = boundaryBlocks[i];

    while (evIdx + 1 < syncEvents.length && syncEvents[evIdx + 1].blockNumber <= bBlock) {
      evIdx++;
      current = syncEvents[evIdx];
    }

    const p18 = priceFromReservesStrings(current.reserve0, current.reserve1);
    sumPrice18 += p18;
    if (minPrice18 === null || p18 < minPrice18) minPrice18 = p18;
    if (maxPrice18 === null || p18 > maxPrice18) maxPrice18 = p18;

    if ((i + 1) % 56 === 0) logp(`[calc] samples: ${i + 1}/168`);
  }

  const avgPrice18 = sumPrice18 / BigInt(boundaryBlocks.length);

  logp(`[done] avg=${formatFixed18(avgPrice18)} ${daiSymbol}/${libSymbol}`);

  return { avgPrice18, minPrice18, maxPrice18, libSymbol, daiSymbol, rpcUsed: rpcUrl };
}

// =====================
// Main
// =====================
async function main() {
  const pairAddr = PAIR_ADDRESS.toLowerCase();
  const daiAddr = POLYGON_DAI.toLowerCase();

  logp(`[start] pair=${pairAddr} dai=${daiAddr}`);
  logp(`[start] trying ${RPC_URLS.length} RPC(s)`);

  const failures = [];

  for (const rpc of RPC_URLS) {
    try {
      const r = await computeWithRpc(rpc);

      const out = {
        chain: 'polygon',
        pairAddress: pairAddr,
        method: 'uniswap_v2_sync_logs_hourly_time_average_poc',
        window: {
          startISO: new Date((toMidnightUTC(new Date()) - WINDOW_SECONDS) * 1000).toISOString(),
          endISO: new Date(toMidnightUTC(new Date()) * 1000).toISOString(),
          days: 7,
          intervalSeconds: INTERVAL_SECONDS,
          logBufferDays: LOG_BUFFER_DAYS,
        },
        price: {
          quote: r.daiSymbol,
          base: r.libSymbol,
          avgQuotePerBase: formatFixed18(r.avgPrice18),
          minQuotePerBase: formatFixed18(r.minPrice18),
          maxQuotePerBase: formatFixed18(r.maxPrice18),
          avg_x1e18: r.avgPrice18.toString(),
        },
        rpcUsed: r.rpcUsed,
        rpcFailures: failures,
      };

      console.log(JSON.stringify(out, null, 2));
      return;
    } catch (e) {
      const msg = e && e.message ? e.message : String(e);
      failures.push({ rpc, error: msg });
      logp(`[skip] ${rpc}: ${msg}`);
    }
  }

  throw new Error('No working RPC found.\n' + failures.map(f => `- ${f.rpc}: ${f.error}`).join('\n'));
}

main().catch(err => {
  console.error('FAILED:', err && err.stack ? err.stack : String(err));
  process.exit(1);
});
