# sbtc-bridge

An **independent, application-level** BTC ⇄ SBTC custody peg for Sequentia: SBTC is pegged
1:1 to BTC held in the bridge's multisig reserve. It is **not** Elements' consensus peg and
needs no consensus change — it is a standard lock-and-issue bridge, no closer to consensus
than any third-party bridge.

- **SBTC** is a normal, unprivileged, **reissuable** Sequentia asset pegged 1:1 to the
  reserve BTC. Its reissuance token sits in a **mint limiter** covenant
  ([sequentia-contracts](https://github.com/ConcatenaLabs/sequentia-contracts),
  `templates/mint_limiter`): the bridge's operator key mints at most an allowance per window of
  blocks, and a cold key that never reaches the bridge host can brake every mint and, after a
  long delay, take the token back. A leaked operator key cannot mint an unbounded supply.
- **Reserve BTC** lives in a fixed **N-of-M operator multisig** on Bitcoin (testnet4), held
  as a descriptor wallet in bitcoind. On the testnet the multisig is 2-of-3 and
  `setup-sbtc.mjs` generates all three keys on the bridge host, so today a single operator
  controls the reserve; `GET /status` returns the live descriptor in `reserve_custody`.
  Production splits the keys across independent operators.
- **Native BTC stays the privileged asset** everywhere; SBTC is just a wrapper for the two
  use-cases in the design doc (resting DEX limit orders; confidential-tx wrapping).

It is a **trusted** bridge — a BTC peg cannot be trustless without Bitcoin covenants. Users
trust the N operators to keep the reserve 1:1 and not abscond.

Design: [`DESIGN.md`](DESIGN.md).

## Flows
- **Peg-in**: `POST /pegin {seq_recipient}` → a fresh BTC deposit address. Send real BTC there;
  once the deposit has one confirmation **and** Sequentia's Bitcoin anchor has reached the block
  holding it, the bridge sends **SBTC 1:1** to `seq_recipient`, spending its held float first and
  minting only the shortfall. A mint is a spend of the mint limiter, minted to the bridge wallet
  and recorded before it is broadcast; the credit is sent once it confirms. A peg-in that would
  take the window over its allowance waits for the next window, and while the limiter is braked
  every peg-in that needs a mint waits. From then on every Sequentia block that can carry the credit is
  anchored at or above the deposit's block, so a Bitcoin reorg that removes the deposit reorgs the
  credit away with it. An unconfirmed deposit is never credited: a double-spend of it reorgs
  nothing. `btc.min_conf` can raise the one-confirmation floor, never lower it.
- **Peg-out**: `POST /pegout {btc_dest}` → a fresh Sequentia address. Send SBTC there; once the
  Sequentia block holding it is final, the bridge **releases reserve BTC 1:1** to `btc_dest`.
  Final means the block is on the node's active chain, certified by the committee (itself or
  through a certified block above it), and anchored at a Bitcoin block that the bridge's
  bitcoind has on its best chain with at least `btc.min_conf` confirmations, the depth a
  deposit needs before a credit. A release is a Bitcoin transaction and cannot be reorged away
  with Sequentia, so it waits until a Bitcoin reorg can no longer take the return back
  without going deeper than that. The returned SBTC is
  **not burned** (`destroyamount` cannot pay its fee in a non-SEQ asset); it stays in the bridge
  wallet as float, out of circulation, and is spent by the next peg-in before anything new is
  reissued.
- `GET /status` → `pegins`, `pegouts`, `processed` counts, `reserve_btc`, `bridge_sbtc_balance`,
  `sbtc_asset`, `reserve_addresses` (per-address reserve balances, checkable against any
  explorer), `reserve_custody` (the live multisig descriptor) and `mint_limiter`: the covenant
  that holds SBTC's reissuance token (its instance, address, coin and state, the allowance per
  window, whether it is braked or recovered), followed on chain, and `token_atoms_in_wallet`,
  which must be zero.
- `GET /pegin/<deposit_address>` → the bound `seq_recipient` and every BTC deposit to that
  address: amount, confirmations (against `min_conf`), `state` (`waiting`, `in_progress`,
  `done`) and the SBTC `credit_txid` once credited, plus `anchor_height` and `btc_tip`: a
  confirmed deposit in block `btc_tip - confirmations + 1` is credited once `anchor_height`
  reaches it.
- `GET /pegout/<sbtc_address>` → the bound `btc_dest` and every SBTC return to that address,
  with the same fields and the BTC `release_txid` once released. A confirmed return shows
  `waiting` until its block is final.

SBTC is minted ONLY against a confirmed BTC deposit, so **circulating** SBTC (issued minus
`bridge_sbtc_balance`) always equals the reserve BTC; total issued supply equals peak circulation.

All routes require `Authorization: Bearer <http.token>` when `http.token` is set. Leaving the
token empty disables auth entirely, so never do that off localhost.

## Run
1. One-time provisioning:
   ```sh
   SBTC_SEQ_RPC=http://<rpcuser>:<rpcpassword>@127.0.0.1:18776 \
   SBTC_BTC_RPC=http://<rpcuser>:<rpcpassword>@127.0.0.1:48332 \
   node setup-sbtc.mjs
   ```
   creates the `sbtc-reserve` 2-of-3 descriptor wallet in bitcoind, issues the reissuable SBTC
   asset in the `sbtc-bridge` Sequentia wallet and writes `config.json`. Optional:
   `SBTC_SEQ_WALLET`, `SBTC_BTC_WALLET`, `SBTC_HTTP_PORT`, `SBTC_FEE_ASSET` (the asset the bridge
   pays its own Sequentia fees in; default USDX) and `SBTC_REGISTRY_SEED` (path to the registry
   seed file to patch with the SBTC entry). Re-running reuses an existing asset id and reserve
   wallet. To fill the config by hand instead, start from `config.example.json`.
2. Move SBTC's reissuance token into its mint limiter, once, with the bridge stopped. Build the
   tool in a sequentia-contracts checkout
   (`cargo build --release --manifest-path tools/mint-limiter/Cargo.toml`), make the operator key
   on this host (`mint-limiter key --new --mnemonic-file limiter-operator.words`), make the cold
   key on another machine (`mint-limiter key --new` prints its words once; write them down
   offline), set `seq.mint_limiter` in `config.json` (`tool`, `operator_mnemonic_file`, and
   `record`, the file the limiter's state is kept in), then:
   ```sh
   node limiter-move.mjs --cold-key <cold key> --window <blocks> \
       --allowance <atoms per window> --recovery-delay <units of 512 s>
   ```
   It moves every unit of the token, or none, and refuses to run twice. The cold key signs the
   brake once, in advance (`mint-limiter arm-signature --instance <instance> --mnemonic-file
   <cold words>`, the instance being `record`'s `instance`); whoever holds that signature can stop
   every mint with the tool's `build` (path `arm`), and only the cold key lifts the brake or, after
   the recovery delay, takes the token (paths `disarm`, `recover`). With `seq.mint_limiter` set and
   no record, the bridge mints nothing; without `seq.mint_limiter` it reissues from its wallet.
3. `npm start` (`node bridge.mjs`). `SBTC_BRIDGE_CONFIG` and `SBTC_BRIDGE_STATE` override the
   `config.json` / `state.json` paths. At startup the service loads its two node wallets itself
   when a node has them on disk but not loaded, so a service manager needs to run nothing
   before it, and no RPC credentials ever appear on a command line or in a unit file.
4. `npm test` runs the unit tests against a mock chain, and, with `SEQUENTIAD` and `MINT_LIMITER`
   naming the node and the tool, a peg-in suite on a Sequentia regtest node: the token moved into
   its limiter whole, peg-ins minted through the covenant and credited once, one over the
   window's allowance credited in the next window, and the brake, applied by another party with
   the cold key's signature, followed and honoured. `npm run check` is a syntax check.

The bridge orchestrates the two node wallets over RPC and hand-rolls no crypto: a mint is a
spend of the mint limiter, built and signed by `mint-limiter` (which reaches no node and holds no
credential) with the bridge wallet signing its fee coin; the Sequentia node signs the send, and
bitcoind (holding the multisig descriptor) signs the reserve release via PSBT.
