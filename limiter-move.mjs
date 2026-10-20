// limiter-move.mjs — moves the SBTC reissuance token from the bridge wallet
// into a new mint limiter covenant, once.
//
//   node limiter-move.mjs --cold-key <x-only hex> --window <blocks> \
//       --allowance <atoms per window> --recovery-delay <units of 512 s>
//
// Reads config.json (SBTC_BRIDGE_CONFIG overrides the path) for the node, the
// wallet, the SBTC asset, the fee asset and `seq.mint_limiter`: the tool, the
// operator's mnemonic file and the record file it writes. Every unit of the
// token moves in one transfer, or nothing moves: a token unit left outside can
// still mint without limit. A second run, once the record holds a coin,
// changes nothing and says so. The cold key is made on another machine
// (`mint-limiter key --new`) and never comes here; only its public key does.
//
// Stop the bridge first, so no credit runs while the token moves.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { MintLimiter } from './limiter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CFG_PATH = process.env.SBTC_BRIDGE_CONFIG || join(HERE, 'config.json');

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const k = process.argv[i];
  if (!k.startsWith('--') || process.argv[i + 1] === undefined) { console.error('usage: see the head of limiter-move.mjs'); process.exit(2); }
  args[k.slice(2)] = process.argv[i + 1];
}
for (const k of ['cold-key', 'window', 'allowance', 'recovery-delay']) {
  if (!args[k]) { console.error(`--${k} is required`); process.exit(2); }
}

async function rpc(url, method, params, wallet) {
  const u = new URL(url);
  const auth = u.username || u.password
    ? 'Basic ' + Buffer.from(decodeURIComponent(u.username) + ':' + decodeURIComponent(u.password)).toString('base64') : null;
  u.username = ''; u.password = '';
  const base = u.toString().replace(/\/$/, '') + (wallet ? '/wallet/' + encodeURIComponent(wallet) : '');
  const res = await fetch(base, { method: 'POST', headers: { 'content-type': 'application/json', ...(auth ? { authorization: auth } : {}) },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'limiter-move', method, params }), signal: AbortSignal.timeout(60000) });
  const j = await res.json().catch(() => ({ error: { message: 'bad json (HTTP ' + res.status + ')' } }));
  if (j.error) throw new Error(`${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

const CFG = JSON.parse(readFileSync(CFG_PATH, 'utf8'));
const SEQ = CFG.seq;
if (!SEQ.mint_limiter) { console.error(`${CFG_PATH}: no seq.mint_limiter`); process.exit(2); }
const limiter = new MintLimiter(SEQ.mint_limiter, (m, p) => rpc(SEQ.rpc, m, p, SEQ.wallet), SEQ.fee_asset);

const existing = limiter.load();
if (existing?.coin) {
  console.log(JSON.stringify({ already: true, address: existing.address, coin: existing.coin, state: existing.state }, null, 2));
  process.exit(0);
}
try {
  const rec = await limiter.moveIn({
    asset: SEQ.sbtc_asset, coldKey: args['cold-key'], window: Number(args.window),
    allowance: BigInt(args.allowance), recoveryDelay: Number(args['recovery-delay']),
  });
  console.log(JSON.stringify({ moved: true, address: rec.address, coin: rec.coin, token: rec.token, token_atoms: rec.tokenAtoms,
    window_blocks: Number(args.window), allowance_atoms: args.allowance, recovery_delay_seconds: Number(args['recovery-delay']) * 512 }, null, 2));
} catch (e) {
  console.error('limiter-move:', e.message);
  process.exit(1);
}
