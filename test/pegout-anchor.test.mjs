// A peg-out releases reserve BTC only once the Sequentia block holding the
// returned SBTC is final: certified by the committee (itself, or through a
// certified block above it on the active chain) and with its Bitcoin anchor
// buried to the depth the peg-in side asks of a deposit (btc.min_conf). Until
// then a Bitcoin reorg of that anchor would reorg the return away, after the
// bitcoin had already left the reserve.
//
// The mock chain below models what the gate reads: the Sequentia wallet's view
// of the return (gettransaction -> blockhash), the Sequentia block headers
// (anchorheight, anchorhash, poscertified, nextblockhash, confirmations = -1
// off the active chain), the node's anchor health (getanchorstatus), and
// bitcoind's view of the anchor block (getblockheader -> confirmations, -1 when
// it is not on Bitcoin's best chain).
//
// Run: node --test test/pegout-anchor.test.mjs
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanPegouts, doneKey, isCompleted, __configureForTest } from '../bridge.mjs';

const SBTC = 'SBTC_ASSET_ID';
const SEQ_CFG = { sbtc_asset: SBTC, fee_asset: 'FEE_ASSET_ID' };
const BTC_CFG = { change_addr: 'reserveChange', fee_sat_vb: 2 };
const KEY = doneKey('seq', 'retTx', 0);

// A chain where the return confirmed in Sequentia block S1, anchored at Bitcoin
// block 1000. S2 and S3 follow it on the active chain.
function makeChain() {
  const c = {
    btcTip: 1000,
    btcStale: new Set(),            // anchor hashes no longer on Bitcoin's best chain
    anchorStatus: 'ok',
    headers: {
      S1: { hash: 'S1', height: 50, confirmations: 3, anchorheight: 1000, anchorhash: 'A1000', poscertified: true, nextblockhash: 'S2' },
      S2: { hash: 'S2', height: 51, confirmations: 2, anchorheight: 1000, anchorhash: 'A1000', poscertified: true, nextblockhash: 'S3' },
      S3: { hash: 'S3', height: 52, confirmations: 1, anchorheight: 1000, anchorhash: 'A1000', poscertified: true },
    },
    released: [],
  };
  c.seqrpc = async (method, params) => {
    if (method === 'listunspent') {
      return [{ txid: 'retTx', vout: 0, address: 'retAddr', amount: 0.3, asset: SBTC, confirmations: 3 }];
    }
    if (method === 'gettransaction') return { txid: params[0], blockhash: 'S1', confirmations: 3 };
    if (method === 'getblockheader') {
      const h = c.headers[params[0]];
      if (!h) throw new Error('Block not found');
      return h;
    }
    if (method === 'getanchorstatus') {
      const tip = Object.values(c.headers).find((h) => !h.nextblockhash && h.confirmations === 1);
      return { anchorstatus: c.anchorStatus, anchorheight: tip.anchorheight, anchorhash: tip.anchorhash };
    }
    throw new Error('unexpected seq rpc ' + method);
  };
  c.btcrpc = async (method, params) => {
    if (method === 'getblockcount') return c.btcTip;
    if (method === 'getblockheader') {
      const hash = params[0];
      const height = Number(hash.slice(1));
      return { hash, height, confirmations: c.btcStale.has(hash) ? -1 : c.btcTip - height + 1 };
    }
    if (method === 'walletcreatefundedpsbt') return { psbt: 'psbt0' };
    if (method === 'walletprocesspsbt') return { psbt: 'psbt1' };
    if (method === 'finalizepsbt') return { complete: true, hex: 'DEADBEEF' };
    if (method === 'decoderawtransaction') return { txid: 'relTx', vin: [{ txid: 'reserveUTXO', vout: 0 }] };
    if (method === 'sendrawtransaction') { c.released.push(params[0]); return 'relTx'; }
    throw new Error('unexpected btc rpc ' + method);
  };
  return c;
}

function setup(c, { btcMinConf = 2 } = {}) {
  const state = { pegins: {}, pegouts: { retAddr: { btc_dest: 'btcDest', created: 0 } }, done: {}, next_index: 0 };
  __configureForTest({
    state, seqrpc: c.seqrpc, btcrpc: c.btcrpc, seq: SEQ_CFG, btc: BTC_CFG,
    seqMinConf: 1, btcMinConf, requireAnchor: true,
  });
}

test('a return whose anchor is not yet buried does not release, and does once it is', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 2 });

  // Bitcoin tip 1000: the anchor block has one confirmation, the peg-in side asks for two.
  await scanPegouts();
  assert.equal(c.released.length, 0, 'no release while the anchor has 1 of 2 confirmations');
  assert.equal(isCompleted(KEY), false);

  // Bitcoin block 1001 arrives: the anchor now has two confirmations.
  c.btcTip = 1001;
  await scanPegouts();
  assert.equal(c.released.length, 1, 'released once the anchor is buried');
  assert.equal(isCompleted(KEY), true);

  // Never released twice.
  await scanPegouts();
  assert.equal(c.released.length, 1);
});

test('the depth is btc.min_conf: at one confirmation an anchored, certified return releases', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 1 });
  await scanPegouts();
  assert.equal(c.released.length, 1);
});

test('an anchor that Bitcoin reorged away holds the release', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 2 });
  c.btcTip = 1010;
  c.btcStale.add('A1000');
  await scanPegouts();
  assert.equal(c.released.length, 0, 'anchor block off the best chain: no release');
  c.btcStale.delete('A1000');
  await scanPegouts();
  assert.equal(c.released.length, 1);
});

test('an unhealthy node anchor holds the release, as it holds a credit', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 1 });
  c.btcTip = 1010;
  c.anchorStatus = 'no_connection';
  await scanPegouts();
  assert.equal(c.released.length, 0);
  c.anchorStatus = 'ok';
  await scanPegouts();
  assert.equal(c.released.length, 1);
});

test('an uncertified block holds the release until a certified block is built on it', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 1 });
  c.btcTip = 1010;
  for (const h of Object.values(c.headers)) h.poscertified = false;
  await scanPegouts();
  assert.equal(c.released.length, 0, 'nothing at or above the return is certified');

  // A certified block above the return makes it final: the node refuses any fork at or below it.
  c.headers.S3.poscertified = true;
  await scanPegouts();
  assert.equal(c.released.length, 1);
});

test('a block header without certification fields holds the release', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 1 });
  c.btcTip = 1010;
  for (const h of Object.values(c.headers)) delete h.poscertified;
  await scanPegouts();
  assert.equal(c.released.length, 0, 'a node that reports no certification cannot show finality');
});

test('a return in a block off the active chain does not release', async () => {
  const c = makeChain();
  setup(c, { btcMinConf: 1 });
  c.btcTip = 1010;
  c.headers.S1.confirmations = -1;
  await scanPegouts();
  assert.equal(c.released.length, 0);
});
