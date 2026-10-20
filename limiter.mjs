// The mint limiter: SBTC is reissued only through a `sequentia/mint-limiter`
// covenant that holds its reissuance token.
//
// The covenant (sequentia-contracts, templates/mint_limiter and
// docs/mint-limiter.md) lets the operator key mint at most an allowance per
// window of blocks, and lets a cold key stop it: the cold key's signature over
// a message that names no coin applies a brake to whichever coin is current,
// and after a long delay the cold key can take the token. This host holds the
// operator key's mnemonic and nothing else; the cold key never reaches it.
//
// Spends are built by `mint-limiter` (sequentia-contracts, tools/mint-limiter),
// which reaches no node and holds no credential: this module hands it the
// coins as the transactions that made them, has the bridge wallet sign the fee
// coin, and broadcasts. The covenant's signature commits to every input and
// output, so the transaction id the tool returns is final before anything is
// broadcast, and is recorded first.
//
// The limiter's record lives in its own file (`seq.mint_limiter.record`),
// written once by limiter-move.mjs when the token moves in and kept up to date
// by the bridge after:
//   { instance, address, coin: {txid, vout}, coinHex, state: {minted, elapsed, armed},
//     tokenAtoms, token, entropy }

import { execFile } from 'node:child_process';
import { readFileSync, writeFileSync, existsSync, renameSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** Whether a listunspent entry is explicit: no commitment, and zero blinders. */
export function explicitCoin(u) {
  const zero = (h) => !h || /^0+$/.test(h);
  return !u.amountcommitment && !u.assetcommitment && zero(u.amountblinder) && zero(u.assetblinder);
}

/** The least age, in blocks, of a coin a mint spends. */
export const MIN_AGE = 2;

const atomsOf = (amount) => BigInt(Math.round(Number(amount) * 1e8));
const amountOf = (atoms) => {
  const a = BigInt(atoms);
  return `${a / 100000000n}.${(a % 100000000n).toString().padStart(8, '0')}`;
};

/** The limits an instance sets, as numbers. */
export function limits(instance) {
  const p = instance.params;
  return { window: parseInt(p.WINDOW, 16), allowance: BigInt('0x' + p.ALLOWANCE), recoveryDelay: parseInt(p.RECOVERY_DELAY, 16) };
}

/** The state a mint of `amount` atoms, from a coin `age` blocks old, leads to,
 *  as the covenant computes it; or { refused } with the reason. */
export function mintNext(instance, state, age, amount) {
  const { window, allowance } = limits(instance);
  const x = BigInt(amount);
  if (state.armed) return { refused: "the mint limiter's brake is on" };
  if (age < MIN_AGE) return { refused: `the limiter's coin is ${age} block(s) old; a mint needs ${MIN_AGE}` };
  const ended = state.elapsed + age >= window;
  const minted = ended ? x : BigInt(state.minted) + x;
  if (minted > allowance) {
    return { refused: x > allowance
      ? `a mint of ${x} is above the limiter's whole allowance of ${allowance}`
      : `the window's allowance of ${allowance} is used (${state.minted} minted); the window ends in ${window - state.elapsed - age} block(s)` };
  }
  return { next: { minted: minted.toString(), elapsed: ended ? 0 : state.elapsed + age, armed: 0 } };
}

export class MintLimiter {
  /** `cfg` is `seq.mint_limiter`: { tool, operator_mnemonic_file, record, template? }.
   *  `call(method, params)` is the bridge wallet's RPC; `feeAsset` pays every fee. */
  constructor(cfg, call, feeAsset) {
    for (const k of ['tool', 'operator_mnemonic_file', 'record']) {
      if (!cfg?.[k]) throw new Error(`seq.mint_limiter.${k} is required`);
    }
    this.cfg = cfg;
    this.call = call;
    this.feeAsset = feeAsset;
  }

  /** The record, or null before the token has moved in. */
  load() {
    if (!existsSync(this.cfg.record)) return null;
    return JSON.parse(readFileSync(this.cfg.record, 'utf8'));
  }

  save(rec) {
    const tmp = this.cfg.record + '.tmp';
    writeFileSync(tmp, JSON.stringify(rec, null, 2));
    renameSync(tmp, this.cfg.record);
  }

  tool(args, request) {
    return new Promise((resolve, reject) => {
      const child = execFile(this.cfg.tool, args, { maxBuffer: 16 << 20, timeout: 120000 }, (err, stdout, stderr) => {
        if (err) return reject(new Error('mint-limiter: ' + String(stderr || err.message).trim().replace(/^mint-limiter: /, '')));
        try { resolve(JSON.parse(stdout)); } catch (e) { reject(new Error('mint-limiter: unreadable reply: ' + e.message)); }
      });
      child.stdin.end(request === undefined ? '' : JSON.stringify(request));
    });
  }

  templateArgs() { return this.cfg.template ? ['--template', this.cfg.template] : []; }

  async withInstance(instance, fn) {
    const dir = mkdtempSync(join(tmpdir(), 'sbtc-limiter-'));
    const file = join(dir, 'instance.json');
    writeFileSync(file, JSON.stringify(instance));
    try { return await fn(file); } finally { rmSync(dir, { recursive: true, force: true }); }
  }

  async rawTx(txid) {
    try { return (await this.call('gettransaction', { txid })).hex; }
    catch { return this.call('getrawtransaction', { txid }); }
  }

  /** The covenant coin as the chain has it: unspent and how deep, or spent. */
  async coinNow(coin) {
    const out = await this.call('gettxout', { txid: coin.txid, n: coin.vout, include_mempool: true });
    return out ? { spent: false, confirmations: out.confirmations ?? 0 } : { spent: true };
  }

  async spkOf(address) { return (await this.call('getaddressinfo', { address })).scriptPubKey; }

  /** Moves the SBTC reissuance token from the wallet into a new instance, every
   *  unit of it in one transfer, and writes the record. Refuses when a record
   *  with a coin exists. */
  async moveIn({ asset, coldKey, window, allowance, recoveryDelay }) {
    const have = this.load();
    if (have?.coin) throw new Error(`the token is already in mint limiter ${have.address} (${this.cfg.record})`);
    const iss = (await this.call('listissuances', { asset })).find((i) => !i.isreissuance);
    if (!iss) throw new Error(`this wallet holds no issuance of ${asset}`);
    const tx = await this.call('decoderawtransaction', { hexstring: await this.rawTx(iss.txid) });
    const issuance = tx.vin?.[iss.vin]?.issuance;
    if (!issuance || issuance.tokenamountcommitment) throw new Error('the token issuance is not explicit; its supply is not knowable');
    const supply = atomsOf(issuance.tokenamount ?? 0);
    const operatorKey = (await this.tool(['key', '--mnemonic-file', this.cfg.operator_mnemonic_file])).key;
    const genesis = await this.call('getblockhash', { height: 0 });
    const inst = await this.tool(['instance', '--asset', asset, '--token', iss.token, '--entropy', iss.entropy,
      '--operator-key', operatorKey, '--cold-key', coldKey, '--window', String(window), '--allowance', String(allowance),
      '--recovery-delay', String(recoveryDelay), '--genesis', genesis, ...this.templateArgs()]);
    const { address: byChain, ...instance } = inst;
    let address = null;
    for (const a of Object.values(byChain ?? {})) if ((await this.call('validateaddress', { address: a })).isvalid) address = a;
    if (!address) throw new Error('the node accepts none of the instance addresses');
    const coins = await this.call('listunspent', { minconf: 0, include_unsafe: true, query_options: { asset: iss.token } });
    const held = coins.filter((u) => u.asset === iss.token).reduce((a, u) => a + atomsOf(u.amount), 0n);
    if (held !== supply) {
      throw new Error(`the wallet holds ${held} of the token's ${supply} atoms; the limiter takes the whole supply or nothing`);
    }
    const txid = await this.call('sendtoaddress', { address, amount: amountOf(supply), assetlabel: iss.token, fee_asset_label: this.feeAsset });
    const hex = await this.rawTx(txid);
    const d = await this.call('decoderawtransaction', { hexstring: hex });
    const spk = (await this.call('validateaddress', { address })).scriptPubKey;
    const vout = d.vout.findIndex((o) => o.scriptPubKey?.hex === spk);
    if (vout < 0) throw new Error(`the token's transfer ${txid} pays nothing to ${address}`);
    const rec = { instance, address, coin: { txid, vout }, coinHex: hex, state: { minted: '0', elapsed: 0, armed: 0 },
      tokenAtoms: supply.toString(), token: iss.token, entropy: iss.entropy, asset, movedAt: new Date().toISOString() };
    this.save(rec);
    return rec;
  }

  async referenceRate() {
    const n = await this.call('getnetworkinfo', {});
    const m = await this.call('getmempoolinfo', {});
    let est = 0;
    try { est = Number((await this.call('estimatesmartfee', { conf_target: 2 })).feerate ?? 0); } catch {}
    return Math.max(1, Math.ceil(Math.max(Number(n.relayfee ?? 0), Number(m.mempoolminfee ?? 0), est) * 1e8));
  }

  async exchangeRate() {
    const rates = await this.call('getfeeexchangerates', {});
    if (rates[this.feeAsset]) return Number(rates[this.feeAsset]);
    const labels = await this.call('dumpassetlabels', {}).catch(() => ({}));
    for (const [label, id] of Object.entries(labels)) if (id === this.feeAsset && rates[label]) return Number(rates[label]);
    throw new Error(`the node accepts no fee in ${this.feeAsset}`);
  }

  /** The fee for `vsize` vbytes in the fee asset's atoms: the reference fee
   *  converted at the node's rate, rounding up. */
  async feeAtoms(vsize) {
    const ref = Math.ceil(((await this.referenceRate()) * vsize) / 1000);
    return Math.ceil((ref * 1e8) / (await this.exchangeRate()));
  }

  /** Follows spends of the coin this bridge did not record: the brake, its
   *  release, a recovery. Returns the record with its coin unspent, or null
   *  while a spend is in flight; `rec.recovered` marks a token taken out. */
  async reconcile(rec) {
    for (let step = 0; step < 16 && rec.coin; step++) {
      if (!(await this.coinNow(rec.coin)).spent) return rec;
      const hex = await this.findSpender(rec.coin);
      if (!hex) return null;
      const f = await this.withInstance(rec.instance, async (file) => this.tool(['follow', '--instance', file, ...this.templateArgs()], {
        coin: { tx: rec.coinHex ?? await this.rawTx(rec.coin.txid), vout: rec.coin.vout },
        state: { minted: String(rec.state.minted), elapsed: rec.state.elapsed, armed: rec.state.armed },
        tx: hex,
      }));
      if (f.path === 'recover') {
        rec.recovered = { txid: f.txid, at: new Date().toISOString(), token_to: f.token_to };
        delete rec.coin;
        this.save(rec);
        return null;
      }
      if (f.path === 'mint') {
        // A mint this bridge did not record: one its wallet knows is its own
        // (a crash between broadcast and record); any other means the
        // operator key is in other hands.
        const ours = await this.call('gettransaction', { txid: f.successor.txid }).then(() => true, () => false);
        if (!ours) rec.foreignMint = { txid: f.successor.txid, at: new Date().toISOString() };
      }
      rec.coin = { txid: f.successor.txid, vout: 0 };
      rec.coinHex = hex;
      rec.state = { minted: String(f.next_state.minted), elapsed: f.next_state.elapsed, armed: f.next_state.armed };
      this.save(rec);
    }
    return rec.coin ? rec : null;
  }

  async findSpender(coin) {
    const spends = (tx) => (tx.vin ?? []).some((i) => i.txid === coin.txid && i.vout === coin.vout);
    let height;
    const w = await this.call('gettransaction', { txid: coin.txid }).catch(() => null);
    if (w?.blockhash) height = (await this.call('getblockheader', { blockhash: w.blockhash })).height;
    if (height !== undefined) {
      const tip = await this.call('getblockcount', {});
      for (let h = height; h <= tip; h++) {
        const block = await this.call('getblock', { blockhash: await this.call('getblockhash', { height: h }), verbosity: 2 });
        const tx = block.tx.find(spends);
        if (tx) return tx.hex;
      }
    }
    for (const txid of await this.call('getrawmempool', {})) {
      const tx = await this.call('getrawtransaction', { txid, verbose: true }).catch(() => null);
      if (tx && spends(tx)) return tx.hex;
    }
    return null;
  }

  /** A mint of `atoms` through the covenant to a fresh wallet address, signed
   *  and unbroadcast: { txid, hex, next }. Throws with the covenant's reason
   *  when it would refuse (a full window, the brake, a coin too young). */
  async buildMint(rec, atoms) {
    const now = await this.coinNow(rec.coin);
    if (now.spent) throw new Error("the mint limiter's coin is spent; it is being followed");
    const verdict = mintNext(rec.instance, rec.state, now.confirmations, atoms);
    if (verdict.refused) throw Object.assign(new Error(verdict.refused), { waiting: true });
    const unspent = await this.call('listunspent', { minconf: 1, query_options: { asset: this.feeAsset } });
    const locked = new Set((await this.call('listlockunspent', {})).map((l) => `${l.txid}:${l.vout}`));
    // An explicit coin: the covenant spend shows every amount, and the wallet blinds some change.
    const fc = unspent.filter((u) => explicitCoin(u) && !locked.has(`${u.txid}:${u.vout}`))
      .sort((a, b) => Number(b.amount) - Number(a.amount))[0];
    if (!fc) throw new Error(`the wallet has no confirmed explicit coin of the fee asset ${this.feeAsset}`);
    const request = {
      path: 'mint',
      coin: { tx: rec.coinHex ?? await this.rawTx(rec.coin.txid), vout: rec.coin.vout },
      state: { minted: String(rec.state.minted), elapsed: rec.state.elapsed, armed: rec.state.armed },
      entropy: rec.entropy,
      age: now.confirmations,
      amount: String(atoms),
      mint_to: await this.spkOf(await this.call('getnewaddress', {})),
      fee: { coins: [{ tx: await this.rawTx(fc.txid), vout: fc.vout }], atoms: '1', change_to: await this.spkOf(await this.call('getrawchangeaddress', {})) },
    };
    return this.withInstance(rec.instance, async (file) => {
      const args = ['build', '--instance', file, '--mnemonic-file', this.cfg.operator_mnemonic_file, ...this.templateArgs()];
      const sign = async (reply) => {
        const s = await this.call('signrawtransactionwithwallet', { hexstring: reply.hex });
        if (!s.complete) throw new Error('the wallet could not sign the fee coin');
        const d = await this.call('decoderawtransaction', { hexstring: s.hex });
        if (d.txid !== reply.txid) throw new Error(`the signed transaction is ${d.txid}, the tool built ${reply.txid}`);
        return { hex: s.hex, vsize: d.vsize };
      };
      const draft = await sign(await this.tool(args, request));
      request.fee.atoms = String(await this.feeAtoms(draft.vsize + 1));
      const reply = await this.tool(args, request);
      const signed = await sign(reply);
      return { txid: reply.txid, hex: signed.hex, vsize: signed.vsize, next: reply.next_state, from: { ...rec.coin } };
    });
  }

  /** The record after a mint of ours is in the mempool. */
  advance(rec, built) {
    if (rec.coin?.txid !== built.from.txid) return;
    rec.coin = { txid: built.txid, vout: 0 };
    rec.coinHex = built.hex;
    rec.state = { minted: String(built.next.minted), elapsed: built.next.elapsed, armed: built.next.armed };
    this.save(rec);
  }

  /** The record as /status reports it. */
  view(rec) {
    if (!rec) return null;
    const { window, allowance, recoveryDelay } = limits(rec.instance);
    return {
      template: 'sequentia/mint-limiter', instance: rec.instance, address: rec.address, coin: rec.coin ?? null,
      state: rec.state ?? null, token: rec.token, token_atoms: rec.tokenAtoms, window_blocks: window,
      allowance_atoms: allowance.toString(), recovery_delay_seconds: recoveryDelay * 512,
      braked: Boolean(rec.state?.armed), recovered: rec.recovered ?? null, foreign_mint: rec.foreignMint ?? null,
    };
  }
}
