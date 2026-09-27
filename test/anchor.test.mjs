// A deposit is credited only once Sequentia's Bitcoin anchor covers the block
// that confirmed it, so a Bitcoin reorg that removes the deposit also removes
// the credit. An unconfirmed deposit is never credited: a double-spend of it
// reorgs nothing.
import test from 'node:test';
import assert from 'node:assert/strict';
import { anchorCovers } from '../bridge.mjs';

const view = (anchorHeight, tip) => ({ ok: true, anchorHeight, tip });

test('an unconfirmed deposit is never covered', () => {
  assert.equal(anchorCovers(view(1000, 1000), { confirmations: 0 }), false);
});

test('covered once the anchor reaches the deposit block', () => {
  // tip 1000, 1 confirmation: the deposit is in block 1000.
  assert.equal(anchorCovers(view(999, 1000), { confirmations: 1 }), false);
  assert.equal(anchorCovers(view(1000, 1000), { confirmations: 1 }), true);
  // deeper deposits are covered by a lagging anchor
  assert.equal(anchorCovers(view(995, 1000), { confirmations: 6 }), true);
});

test('an unreadable or unhealthy anchor never credits', () => {
  assert.equal(anchorCovers({ ok: false, reason: 'rpc down' }, { confirmations: 50 }), false);
  assert.equal(anchorCovers(null, { confirmations: 50 }), false);
});
