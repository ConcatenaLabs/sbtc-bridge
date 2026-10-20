// The mint limiter's rule as the covenant computes it, and what a peg-in does
// with a limiter mint it has broadcast: waits while the mint is in flight,
// mints again only when the chain provably never took it, and sends once it
// confirms. Against a mock chain; limiter.regtest.test.mjs runs a real one.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mintNext, limits, explicitCoin, MIN_AGE } from '../limiter.mjs';
import { scanPegins, doneEntry, doneKey, isCompleted, __configureForTest } from '../bridge.mjs';

const instance = { params: { WINDOW: '000a', ALLOWANCE: '0000000005f5e100', RECOVERY_DELAY: '0002' } };
const s = (minted, elapsed, armed = 0) => ({ minted: String(minted), elapsed, armed });

test('the window rule is the covenant\'s', () => {
  assert.deepEqual(limits(instance), { window: 10, allowance: 100000000n, recoveryDelay: 2 });
  assert.deepEqual(mintNext(instance, s(0, 0), 3, 59900000), { next: s(59900000, 3) });
  assert.match(mintNext(instance, s(59900000, 3), 2, 60000000).refused, /allowance/);
  assert.deepEqual(mintNext(instance, s(59900000, 3), 7, 60000000), { next: s(60000000, 0) });
  assert.match(mintNext(instance, s(0, 0), 50, 100000001).refused, /whole allowance/);
  assert.equal(MIN_AGE, 2);
  assert.match(mintNext(instance, s(0, 0), 1, 1).refused, /2/);
  assert.match(mintNext(instance, s(0, 0, 1), 5, 1).refused, /brake/);
});

const SBTC = 'SBTC_ASSET';
const KEY = doneKey('btc', 'dd'.repeat(32), 0);
function world(fate) {
  const state = { pegins: { depo: { seq_recipient: 'tb1user', created: 1 } }, pegouts: {}, done: {}, next_index: 0 };
  state.done[KEY] = { stage: 'pending', txid: null, mint_txid: 'm1', at: 1 };
  const calls = [];
  const seqrpc = async (method, params) => {
    calls.push(method);
    if (method === 'gettransaction') {
      if (fate === 'absent') throw new Error('gettransaction: Invalid or non-wallet transaction id');
      return { confirmations: fate === 'confirmed' ? 1 : 0 };
    }
    if (method === 'listtransactions') return [];
    if (method === 'getbalance') return { [SBTC]: 0.6 };
    if (method === 'sendtoaddress') return 'send1';
    throw new Error('unexpected ' + method);
  };
  const btcrpc = async (method) => {
    if (method === 'listunspent') return [{ txid: 'dd'.repeat(32), vout: 0, address: 'depo', amount: 0.6, confirmations: 3 }];
    throw new Error('unexpected btc ' + method);
  };
  const limiter = { load: () => { throw new Error('no new mint may start'); } };
  __configureForTest({ state, seqrpc, btcrpc, seq: { sbtc_asset: SBTC, fee_asset: 'FEE' }, btc: {}, btcMinConf: 1, limiter });
  return { state, calls };
}

test('a limiter mint in flight holds the credit: no send, no new mint', async () => {
  const { calls } = world('pending');
  await scanPegins();
  assert.equal(doneEntry(KEY).mint_txid, 'm1');
  assert.ok(!calls.includes('sendtoaddress'));
});

test('a limiter mint the wallet never took is dropped, and minted again next scan', async () => {
  const { calls } = world('absent');
  await scanPegins();
  assert.equal(doneEntry(KEY), undefined);
  assert.ok(!calls.includes('sendtoaddress'));
});

test('once the limiter mint confirms, the credit is sent from the wallet, once', async () => {
  const { calls } = world('confirmed');
  await scanPegins();
  assert.ok(isCompleted(KEY));
  assert.equal(doneEntry(KEY).txid, 'send1');
  assert.equal(calls.filter((c) => c === 'sendtoaddress').length, 1);
  assert.ok(!calls.includes('reissueasset'));
});

test('only an explicit coin pays a covenant spend\'s fee', () => {
  const z = '00'.repeat(32);
  assert.equal(explicitCoin({ amount: 1, amountblinder: z, assetblinder: z }), true);
  assert.equal(explicitCoin({ amount: 1, amountcommitment: '08ab', amountblinder: '11'.repeat(32), assetblinder: '22'.repeat(32) }), false);
});
