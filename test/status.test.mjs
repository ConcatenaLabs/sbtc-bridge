// Per-transfer status: what a page shows a user about their bitcoin. The
// endpoints only read, so these pin the reading: every receive to the
// address is listed, other addresses and other assets are not, and the stage
// comes from the done-set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { pegInStatus, pegOutStatus, __configureForTest } from '../bridge.mjs';

const SBTC = 'SBTC_ASSET_ID';

test('peg-in status lists each deposit with its stage', async () => {
  const state = {
    pegins: { btcAddr: { seq_recipient: 'tb1seq', created: 1 } }, pegouts: {},
    done: { 'btc:t1:0': { stage: 'done', txid: 'credit1' }, 'btc:t2:1': { stage: 'pending', txid: null } },
    next_index: 1,
  };
  const btcrpc = async (method, params) => {
    if (method === 'listreceivedbyaddress') return [{ address: 'btcAddr', txids: ['t1', 't2', 't3'] }];
    if (method === 'gettransaction') {
      const txid = params[0];
      const vout = txid === 't2' ? 1 : 0;
      return { confirmations: txid === 't3' ? 0 : 5, details: [
        { address: 'btcAddr', category: 'receive', amount: 0.01, vout },
        { address: 'otherAddr', category: 'receive', amount: 9, vout: 7 },
      ] };
    }
    throw new Error('unexpected ' + method);
  };
  __configureForTest({ state, btcrpc, btcMinConf: 2 });
  const r = await pegInStatus('btcAddr');
  assert.equal(r.seq_recipient, 'tb1seq');
  assert.equal(r.min_conf, 2);
  assert.deepEqual(r.deposits.map((d) => [d.txid, d.state, d.credit_txid]), [
    ['t1', 'done', 'credit1'], ['t2', 'in_progress', null], ['t3', 'waiting', null],
  ]);
  assert.equal(r.deposits[0].amount_btc, '0.01000000');
  assert.equal(await pegInStatus('unknown'), null);
});

test('peg-out status lists only SBTC returned to the address', async () => {
  const state = {
    pegins: {}, pegouts: { seqAddr: { btc_dest: 'tb1dest', created: 2 } },
    done: { 'seq:s1:0': { stage: 'done', txid: 'release1' } }, next_index: 0,
  };
  const seqrpc = async (method) => {
    if (method === 'listreceivedbyaddress') return [{ address: 'seqAddr', txids: ['s1'] }];
    if (method === 'gettransaction') return { confirmations: 3, details: [
      { address: 'seqAddr', category: 'receive', amount: 0.5, vout: 0, asset: SBTC },
      { address: 'seqAddr', category: 'receive', amount: 1, vout: 1, asset: 'OTHER' },
    ] };
    throw new Error('unexpected ' + method);
  };
  __configureForTest({ state, seqrpc, seq: { sbtc_asset: SBTC } });
  const r = await pegOutStatus('seqAddr');
  assert.equal(r.btc_dest, 'tb1dest');
  assert.deepEqual(r.returns.map((x) => [x.txid, x.amount_sbtc, x.state, x.release_txid]), [['s1', '0.50000000', 'done', 'release1']]);
});
