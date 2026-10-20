// SBTC minted through the mint limiter, on a real Sequentia regtest node.
//
// The Bitcoin side is a stand-in (a deposit is a row listunspent returns); the
// Sequentia side is a node on an `elementsregtest` chain with Simplicity active
// from genesis, the bridge wallet holding only a fee asset that is not the
// Sequence token, and `mint-limiter` from sequentia-contracts building every
// covenant spend. It proves, with scanPegins as the bridge runs it:
//   - limiter-move's path moves the whole SBTC token into the covenant and the
//     wallet keeps none;
//   - a peg-in is minted through the covenant, recorded before broadcast, and
//     credited once the mint confirms, exactly once;
//   - a peg-in over the window's allowance waits, and is credited in the next
//     window;
//   - the brake, applied with the cold key's signature made in advance by a
//     party of its own, stops every mint; the bridge follows the spend it did
//     not make, and /status-level reads report it.
//
//   SEQUENTIAD=/path/to/sequentiad MINT_LIMITER=/path/to/mint-limiter node --test test/limiter.regtest.test.mjs
//
// Skipped unless both are set.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import net from 'node:net';
import { scanPegins, doneEntry, doneKey, isCompleted, __configureForTest } from '../bridge.mjs';
import { MintLimiter } from '../limiter.mjs';

const SEQUENTIAD = process.env.SEQUENTIAD;
const TOOL = process.env.MINT_LIMITER;
const skip = !SEQUENTIAD || !TOOL || !existsSync(SEQUENTIAD) || !existsSync(TOOL)
  ? 'set SEQUENTIAD and MINT_LIMITER to run against a regtest node' : false;

const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('SBTC minted through the mint limiter on regtest', { skip, timeout: 600000 }, async (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'sbtc-limiter-'));
  const port = await freePort();
  const p2p = await freePort();
  const node = spawn(SEQUENTIAD, [
    `-datadir=${dir}`, '-chain=elementsregtest', `-rpcport=${port}`, `-port=${p2p}`, '-rpcuser=t', '-rpcpassword=t',
    '-listen=0', '-connect=0', '-validatepegin=0', '-con_blocksubsidy=5000000000', '-signblockscript=51',
    '-blindedaddresses=0', '-con_default_blinded_addresses=0', '-con_any_asset_fees=1', '-txindex=1',
    '-evbparams=simplicity:-1:::', '-fallbackfee=0.0001', '-printtoconsole=0',
  ], { stdio: 'ignore' });
  const url = `http://127.0.0.1:${port}`;
  const auth = 'Basic ' + Buffer.from('t:t').toString('base64');
  const rpc = async (method, params = [], wallet) => {
    const res = await fetch(url + (wallet ? '/wallet/' + wallet : ''), { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '1.0', id: 't', method, params }) });
    const j = await res.json();
    if (j.error) throw new Error(`${method}: ${j.error.message}`);
    return j.result;
  };
  t.after(async () => {
    await rpc('stop').catch(() => {});
    for (let i = 0; i < 50 && node.exitCode === null; i++) await sleep(200);
    if (node.exitCode === null) node.kill();
    rmSync(dir, { recursive: true, force: true });
  });
  for (let i = 0; i < 100; i++) { try { await rpc('getblockcount'); break; } catch { await sleep(300); } }

  await rpc('createwallet', ['miner']);
  await rpc('createwallet', ['bridge']);
  await rpc('createwallet', ['user']);
  await rpc('createwallet', ['watcher']);
  const mineTo = await rpc('getnewaddress', [], 'miner');
  const mine = (n = 1) => rpc('generatetoaddress', [n, mineTo]);
  await mine(110);
  await rpc('setfeeexchangerates', [{ bitcoin: 100000000 }]);
  const FEE = (await rpc('issueasset', { assetamount: 1000000, tokenamount: 0, blind: false, fee_asset: 'bitcoin' }, 'miner')).asset;
  await rpc('setfeeexchangerates', [{ bitcoin: 100000000, [FEE]: 100000000 }]);
  await mine();
  for (const w of ['bridge', 'watcher']) {
    await rpc('sendtoaddress', { address: await rpc('getnewaddress', [], w), amount: 1000, assetlabel: FEE, fee_asset_label: FEE }, 'miner');
  }
  await mine();
  const bridge = (m, p) => rpc(m, p, 'bridge');
  // SBTC, as setup-sbtc.mjs issues it: a tiny float and one reissuance token, the fee in FEE.
  const sbtc = await bridge('issueasset', [0.001, 1, false, null, FEE]);
  await mine();
  assert.equal((await bridge('getbalance', {}))['bitcoin'] ?? 0, 0, 'the bridge wallet holds no policy asset');

  const words = (name) => { const f = join(dir, name); execFileSync(TOOL, ['key', '--new', '--mnemonic-file', f]); return f; };
  const opWords = words('operator.words');
  const coldWords = words('cold.words');
  const coldKey = JSON.parse(execFileSync(TOOL, ['key', '--mnemonic-file', coldWords]).toString()).key;
  const cfg = { tool: TOOL, operator_mnemonic_file: opWords, record: join(dir, 'limiter.json') };
  const limiter = new MintLimiter(cfg, bridge, FEE);

  // --- the token moves in, whole.
  const ALLOW = 100000000; // 1 SBTC a window of 10 blocks
  const rec = await limiter.moveIn({ asset: sbtc.asset, coldKey, window: 10, allowance: BigInt(ALLOW), recoveryDelay: 2 });
  await mine();
  assert.equal(rec.tokenAtoms, '100000000');
  const tokenLeft = await bridge('listunspent', { minconf: 0, include_unsafe: true, query_options: { asset: sbtc.token } });
  assert.equal(tokenLeft.length, 0, 'the wallet keeps no token unit');
  const coin = await rpc('gettxout', [rec.coin.txid, rec.coin.vout, true]);
  assert.equal(coin.asset, sbtc.token);
  assert.equal(Math.round(coin.value * 1e8), 100000000);
  await assert.rejects(limiter.moveIn({ asset: sbtc.asset, coldKey, window: 10, allowance: 1n, recoveryDelay: 2 }), /already in mint limiter/);

  // --- peg-ins, through scanPegins.
  const user = await rpc('getnewaddress', [], 'user');
  const STATE = { pegins: {}, pegouts: {}, done: {}, next_index: 0 };
  const deposits = [];
  const btcrpc = async (method) => {
    if (method === 'listunspent') return deposits;
    throw new Error('unexpected btc call ' + method);
  };
  __configureForTest({ state: STATE, seqrpc: bridge, btcrpc, seq: { sbtc_asset: sbtc.asset, fee_asset: FEE }, btc: {}, btcMinConf: 1, limiter });
  const deposit = (txid, btc) => {
    const address = 'bcrt1-deposit-' + txid;
    STATE.pegins[address] = { seq_recipient: user, created: 1 };
    deposits.push({ txid, vout: 0, address, amount: btc, confirmations: 6 });
    return doneKey('btc', txid, 0);
  };
  const userSbtc = async () => Math.round(Number((await rpc('getbalance', {}, 'user'))[sbtc.asset] ?? 0) * 1e8);
  // Mines and scans until the credit is sent, then mines it.
  const settle = async (key) => {
    for (let i = 0; i < 12 && !isCompleted(key); i++) { await mine(); await scanPegins(); }
    await mine();
    return isCompleted(key);
  };

  // 0.6 SBTC: the float (0.001) does not cover it, so 0.599 is minted through the covenant.
  await mine(2);
  const k1 = deposit('aa'.repeat(32), 0.6);
  await scanPegins();
  const e1 = doneEntry(k1);
  assert.ok(e1 && e1.mint_txid, 'the credit records its limiter mint before it is sent');
  const m1 = await bridge('decoderawtransaction', { hexstring: await rpc('getrawtransaction', [e1.mint_txid]) });
  assert.equal(m1.vin[0].txid, rec.coin.txid, 'the mint spends the limiter coin');
  assert.equal(m1.vin[0].issuance?.isreissuance, true);
  assert.equal(Math.round(m1.vin[0].issuance.assetamount * 1e8), 59900000);
  assert.ok(await settle(k1), 'credited once the mint confirms');
  assert.equal(await userSbtc(), 60000000, 'the user holds exactly 0.6 SBTC');
  const after1 = limiter.load();
  assert.equal(after1.state.minted, '59900000');
  assert.equal(after1.coin.txid, e1.mint_txid);

  // 0.6 more in the same window: 0.599 + 0.6 is over the 1 SBTC allowance, so it waits.
  await mine(1);
  const k2 = deposit('bb'.repeat(32), 0.6);
  await scanPegins();
  assert.equal(doneEntry(k2), undefined, 'over the allowance, nothing is minted and nothing is pending');
  assert.equal(await userSbtc(), 60000000);
  // The window ends ten blocks after it opened; then it is credited.
  assert.ok(await settle(k2), 'credited in the next window');
  assert.equal(await userSbtc(), 120000000);
  const after2 = limiter.load();
  assert.equal(after2.state.minted, '60000000', 'the next window counts only this mint');
  assert.equal(after2.state.elapsed, 0);

  // --- the brake, applied by the watcher's own wallet with the cold key's signature.
  writeFileSync(join(dir, 'instance.json'), JSON.stringify(after2.instance));
  const sig = JSON.parse(execFileSync(TOOL, ['arm-signature', '--instance', join(dir, 'instance.json'), '--mnemonic-file', coldWords]).toString());
  const fc = (await rpc('listunspent', { minconf: 1, query_options: { asset: FEE } }, 'watcher'))[0];
  const change = (await rpc('getaddressinfo', [await rpc('getnewaddress', [], 'watcher')], 'watcher')).scriptPubKey;
  const arm = JSON.parse(execFileSync(TOOL, ['build', '--instance', join(dir, 'instance.json')], { input: JSON.stringify({
    path: 'arm',
    coin: { tx: await rpc('getrawtransaction', [after2.coin.txid]), vout: 0 },
    state: { minted: Number(after2.state.minted), elapsed: after2.state.elapsed, armed: 0 },
    arm_signature: sig.arm_signature,
    fee: { coins: [{ tx: await rpc('getrawtransaction', [fc.txid]), vout: fc.vout }], atoms: 20000, change_to: change },
  }) }).toString());
  const signed = await rpc('signrawtransactionwithwallet', [arm.hex], 'watcher');
  await rpc('sendrawtransaction', [signed.hex]);
  await mine(3);
  const k3 = deposit('cc'.repeat(32), 0.3);
  await scanPegins();
  assert.equal(doneEntry(k3), undefined, 'while braked, nothing is minted');
  const braked = limiter.load();
  assert.equal(braked.state.armed, 1, 'the bridge followed the brake it did not apply');
  assert.equal(braked.coin.txid, arm.txid);
  assert.equal(limiter.view(braked).braked, true);
  assert.equal(await userSbtc(), 120000000);
});
