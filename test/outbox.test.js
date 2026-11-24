'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Db } = require('../shared/db');
const { Outbox } = require('../shared/outbox');

test('a transaction commits data and its event together', () => {
  const db = new Db({ rows: [] });
  const ob = new Outbox(db);
  ob.commit((tx, emit) => { tx.rows.push('a'); emit('row.added', { v: 'a' }); });
  assert.deepEqual(db.state.rows, ['a']);
  assert.equal(db.state.outbox.length, 1);
  assert.equal(db.state.outbox[0].type, 'row.added');
  assert.equal(db.state.outbox[0].sentAt, null);
});

test('a throwing transaction writes neither the row nor the event', () => {
  // This is the whole point. If the event could survive a rolled-back write,
  // downstream services would act on data that does not exist.
  const db = new Db({ rows: [] });
  const ob = new Outbox(db);
  assert.throws(() => ob.commit((tx, emit) => {
    tx.rows.push('ghost');
    emit('row.added', { v: 'ghost' });
    throw new Error('constraint violation');
  }), /constraint violation/);

  assert.deepEqual(db.state.rows, [], 'the row was rolled back');
  assert.equal(db.state.outbox.length, 0, 'and so was its event');
  assert.equal(db.rollbacks, 1);
});

test('the relay publishes pending events and marks them sent', async () => {
  const db = new Db({ rows: [] });
  const ob = new Outbox(db);
  ob.commit((tx, emit) => { emit('e1', {}); emit('e2', {}); });
  assert.equal(ob.pendingCount(), 2);

  const got = [];
  assert.equal(await ob.relay(async (t) => got.push(t)), 2);
  assert.deepEqual(got, ['e1', 'e2']);
  assert.equal(ob.pendingCount(), 0);

  assert.equal(await ob.relay(async (t) => got.push(t)), 0, 'a second pass republishes nothing');
  assert.deepEqual(got, ['e1', 'e2']);
});

test('a publish failure leaves the event pending for the next pass', async () => {
  const db = new Db({ rows: [] });
  const ob = new Outbox(db);
  ob.commit((tx, emit) => emit('flaky', {}));

  let attempts = 0;
  await ob.relay(async () => { attempts++; throw new Error('broker down'); });
  assert.equal(ob.pendingCount(), 1, 'still pending, nothing lost');
  assert.equal(db.state.outbox[0].attempts, 1);

  await ob.relay(async () => { attempts++; });
  assert.equal(ob.pendingCount(), 0, 'delivered on the retry');
  assert.equal(attempts, 2);
});

test('publish-then-mark duplicates rather than loses on a crash', async () => {
  // Simulate: publish succeeds, then the process dies before sentAt is set.
  const db = new Db({ rows: [] });
  const ob = new Outbox(db);
  ob.commit((tx, emit) => emit('e', {}));

  const delivered = [];
  await ob.relay(async (t) => {
    delivered.push(t);
    throw new Error('crash after the broker accepted it');
  });
  // The broker got it, but we could not record that. The next pass sends it
  // again. At-least-once: a duplicate, not a loss.
  await ob.relay(async (t) => delivered.push(t));
  assert.deepEqual(delivered, ['e', 'e'], 'duplicated, which consumers can dedupe');
  assert.equal(ob.pendingCount(), 0);
});
