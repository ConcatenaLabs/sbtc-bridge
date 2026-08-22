# sbtc-bridge

An independent, application-level BTC ⇄ SBTC custody peg for Sequentia. SBTC is pegged 1:1 to
BTC held in the reserve: lock BTC in an N-of-M operator multisig on Bitcoin testnet4, reissue SBTC
1:1 on Sequentia, and release reserve BTC 1:1 on the way back.

It is **not** Elements' consensus peg and needs no consensus change. It is a **trusted** bridge:
a BTC peg cannot be trustless without Bitcoin covenants. `README.md` says so plainly and should
keep saying so.

Native BTC remains the privileged asset everywhere. SBTC is an ordinary, unprivileged, reissuable
Sequentia asset — a narrow wrapper for the two use cases in the design document, not a replacement
for BTC. Node and consensus conventions live in the
[`Sequentia`](https://github.com/GracedEternalKingCabbageMan/Sequentia) repo.

## Shape

One Node ES module, `bridge.mjs`, with no runtime dependencies. It orchestrates two node wallets
over RPC and hand-rolls no crypto: the Sequentia node signs the reissuance and send, and bitcoind
(holding the reserve multisig descriptor) signs the release via PSBT.

```sh
cp config.example.json config.json     # then fill it in
npm start        # node bridge.mjs
npm run check    # node --check bridge.mjs
npm test         # node --test 'test/**/*.test.mjs'
```

`setup-sbtc.mjs` is the one-time setup: it builds the reserve multisig, issues SBTC, and writes
the config. There is no CI, so `npm test` before every PR is the whole gate.

## The supply invariant

SBTC is minted only against a confirmed BTC deposit. Returned SBTC is **not burned** on peg-out:
`destroyamount` cannot pay its fee in a non-SEQ asset, so the bridge keeps the returned coins in its
own wallet as float, out of circulation, and spends that float before reissuing anything on the next
peg-in. Circulating SBTC (issued minus `bridge_sbtc_balance` in `/status`) therefore always equals the
reserve BTC, and total issued supply equals peak circulation. Every rule below exists to protect that
one equation.

## Two failure classes that were closed deliberately

Both are covered by the tests in `test/`. If you change the credit or release paths, keep them
green and extend them.

**Ambiguous failure after broadcast.** An error thrown *after* a credit or release has been
broadcast must never delete the done-sentinel — an RPC timeout would otherwise double-mint SBTC or
double-release reserve BTC on retry. The bridge verifies on chain before any retry: peg-in sends
are comment-marked, and a peg-out's decoded txid and inputs are persisted **before**
`sendrawtransaction`. On boot it reconciles placeholder-done entries from chain state, so a
mid-operation crash cannot permanently wedge a peg either.

**Peg-in/peg-out cannibalization.** Both flows draw from one wallet, so a peg-in credit could spend
the returned-SBTC UTXO of a confirmed-but-unreleased peg-out and silently drop that peg-out. Owed
returns are now earmarked — via `listunspent` with `include_unsafe`, so 0-conf returns count — then
`lockunspent`'d out of coin selection and subtracted from the recyclable float **immediately before
each credit's send**, not once per loop. A blind earmark scan fails that credit closed rather than
minting.

The recurring shape of both: **fail closed, verify against the chain rather than against local
state, and never widen the window between a check and the send it protects.**

## Other things already settled

- Sequentia fees are paid in a configured ordinary asset under the open fee market, never in the
  Sequence token by default.
- RPC credentials go in the `Authorization` header, not in the URL — Node's `fetch` does not accept
  them inline.

## Secrets

`config.json`, `state.json` and `*.log` are gitignored. `config.example.json` is the template and
carries only placeholders — keep real RPC credentials, the bearer token, the multisig descriptor
and the asset id out of it. The repository is public.

## Working in this repo

- **Commit author:**
  `GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`
- **Always open a pull request, then merge it yourself immediately.** The PR exists so the change
  and its reasoning are recorded, not because anyone is waiting to review it. There is no review
  process. If you are ever told to leave one specific PR open, that applies to that PR only and
  never becomes the default.
- PRs go against `master`, which is the remote default.
- **Deployment is pull-only.** The server pulls this repo from GitHub. Never edit source on the
  server and never copy source or binaries onto it.

<!-- BEGIN SHARED AGENT CONVENTIONS: identical in every Sequentia repo. Change it in all of them together. -->
## Working with git and GitHub here

These rules are the same in every Sequentia repository. They are repeated in each
one because this file is the only thing an agent is guaranteed to read, whatever
machine it is working from.

**Nothing pushed to GitHub credits Claude, Anthropic, or any AI tool.** No
`Co-Authored-By: Claude` trailer, no `Claude-Session:` trailer or `claude.ai`
link, no "Generated with Claude Code" in a commit message or a pull request body,
no `claude/*` branch names or session ids, and no mention in source, comments,
docs or issue text. Agent tooling offers several of these by default; compose the
message without them rather than stripping them afterwards.

**Author every commit as**
`GracedEternalKingCabbageMan <151803062+GracedEternalKingCabbageMan@users.noreply.github.com>`.
Never a personal address.

**Every change lands through a pull request that you merge yourself, at once.**
There is no reviewer on this project; the pull request exists so the reasoning is
recorded beside the diff. Branch, push, open it, merge it, delete the branch, all
in one sitting. Pushing straight to the default branch is the rule most often
broken here, and it is the one that costs the record. A pull request stays open
only when the repository owner asks for that specific one, and that never carries
over to the next.

**Name branches `area/short-description`**: `fix/`, `doc/`, `feature/`, `test/`,
`build/`, or the component being changed. Never a tool name, a session id, or
`worktree-*`.

**Write the subject as `area: what changed`**, one line, 72 characters at the
outside and 50 where you can manage it. Put the reasoning in the body, and
explain why rather than what.

**These repositories are public and world-readable.** Never commit private keys,
seeds, `wallet.dat`, RPC credentials, `.env` files or API tokens. Read the diff
before every commit. Secrets belong on the server and in offline backups.

**A file belongs to the repository whose code it describes.** Decide which repo
owns it before writing it; if it landed in the wrong one, move it rather than
deleting it.

**Push the same day you commit.** The testnet server pulls only from GitHub, so a
branch left on one laptop is invisible to every other machine and to the box.
<!-- END SHARED AGENT CONVENTIONS -->
