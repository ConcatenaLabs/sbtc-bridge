# sbtc-bridge

An **independent, application-level** BTC ⇄ SBTC custody bridge for Sequentia. It is **not**
Elements' consensus peg and needs no consensus change — it is a standard lock-and-issue
bridge, no closer to consensus than any third-party bridge.

- **SBTC** is a normal, unprivileged, **reissuable** Sequentia asset; its reissuance token
  lives in this bridge's Sequentia wallet.
- **Reserve BTC** lives in a fixed **N-of-M operator multisig** on Bitcoin (testnet4), held
  as a descriptor wallet in bitcoind. On the testnet the multisig is 2-of-3 and
  `setup-sbtc.mjs` generates all three keys on the bridge host, so today a single operator
  controls the reserve; `GET /status` returns the live descriptor in `reserve_custody`.
  Production splits the keys across independent operators.
- **Native BTC stays the privileged asset** everywhere; SBTC is just a wrapper for the two
  use-cases in the design doc (resting DEX limit orders; confidential-tx wrapping).

It is a **trusted** bridge — a BTC peg cannot be trustless without Bitcoin covenants. Users
trust the N operators to keep the reserve 1:1 and not abscond.

Canonical design:
[`sbtc-peg-design.md`](https://github.com/GracedEternalKingCabbageMan/Sequentia/blob/master/doc/sequentia/sbtc-peg-design.md)
in the node repository.

## Flows
- **Peg-in**: `POST /pegin {seq_recipient}` → a fresh BTC deposit address. Send real BTC there;
  after confirmations the bridge sends **SBTC 1:1** to `seq_recipient`, spending its held float
  first and reissuing only the shortfall.
- **Peg-out**: `POST /pegout {btc_dest}` → a fresh Sequentia address. Send SBTC there; after
  confirmations the bridge **releases reserve BTC 1:1** to `btc_dest`. The returned SBTC is
  **not burned** (`destroyamount` cannot pay its fee in a non-SEQ asset); it stays in the bridge
  wallet as float, out of circulation, and is spent by the next peg-in before anything new is
  reissued.
- `GET /status` → `pegins`, `pegouts`, `processed` counts, `reserve_btc`, `bridge_sbtc_balance`,
  `sbtc_asset`, `reserve_addresses` (per-address reserve balances, checkable against any
  explorer) and `reserve_custody` (the live multisig descriptor).

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
2. `npm start` (`node bridge.mjs`). `SBTC_BRIDGE_CONFIG` and `SBTC_BRIDGE_STATE` override the
   `config.json` / `state.json` paths.
3. `npm test` runs the 15 unit tests against a mock chain; `npm run check` is a syntax check.

The bridge orchestrates the two node wallets over RPC and hand-rolls no crypto: the Sequentia
node signs the reissuance/send, bitcoind (holding the multisig descriptor) signs the reserve
release via PSBT.
