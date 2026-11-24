'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Saga, SagaError } = require('../shared/saga');

test('all steps succeed, nothing is compensated', async () => {
  const done = [];
  const undone = [];
  const s = new Saga('happy')
    .step('a', async () => { done.push('a'); return 1; }, async () => undone.push('a'))
    .step('b', async () => { done.push('b'); return 2; }, async () => undone.push('b'));
  await s.run();
  assert.deepEqual(done, ['a', 'b']);
  assert.deepEqual(undone, [], 'no compensation on success');
});

test('a failure compensates completed steps in reverse order', async () => {
  const undone = [];
  const s = new Saga('rollback')
    .step('a', async () => 'ra', async () => undone.push('a'))
    .step('b', async () => 'rb', async () => undone.push('b'))
    .step('c', async () => { throw new Error('boom'); }, async () => undone.push('c'));

  await assert.rejects(() => s.run(), (err) => {
    assert.ok(err instanceof SagaError);
    assert.equal(err.step, 'c');
    assert.equal(err.cause.message, 'boom');
    assert.deepEqual(err.compensated, ['b', 'a'], 'reverse order');
    return true;
  });
  assert.deepEqual(undone, ['b', 'a'], 'c never completed so it is not compensated');
});

test('a step that fails first has nothing to undo', async () => {
  const undone = [];
  const s = new Saga('early')
    .step('a', async () => { throw new Error('nope'); }, async () => undone.push('a'));
  await assert.rejects(() => s.run(), SagaError);
  assert.deepEqual(undone, []);
});

test('the compensation result is passed the step result', async () => {
  let got = null;
  const s = new Saga('pass')
    .step('a', async () => ({ id: 'xyz' }), async (ctx, result) => { got = result; })
    .step('b', async () => { throw new Error('x'); });
  await assert.rejects(() => s.run());
  assert.deepEqual(got, { id: 'xyz' }, 'compensation knows what it is undoing');
});

test('a failing compensation is collected, not thrown, and the rest still run', async () => {
  // The genuinely bad case: the rollback itself breaks. Aborting on the first
  // compensation error would leave the earlier steps un-undone too, making a
  // bad situation worse. Every compensation is attempted and every failure
  // reported, so a human knows the full list to reconcile.
  const undone = [];
  const s = new Saga('messy')
    .step('a', async () => 1, async () => undone.push('a'))
    .step('b', async () => 2, async () => { throw new Error('refund API down'); })
    .step('c', async () => { throw new Error('trigger'); });

  await assert.rejects(() => s.run(), (err) => {
    assert.deepEqual(err.compensated, ['a'], 'a was still compensated despite b failing');
    assert.deepEqual(err.compensationErrors, [{ step: 'b', error: 'refund API down' }]);
    return true;
  });
  assert.deepEqual(undone, ['a']);
});

test('a step with no compensation is skipped during rollback', async () => {
  const undone = [];
  const s = new Saga('partial')
    .step('a', async () => 1, async () => undone.push('a'))
    .step('b', async () => 2)                      // read-only, nothing to undo
    .step('c', async () => { throw new Error('x'); });
  await assert.rejects(() => s.run(), (e) => {
    assert.deepEqual(e.compensated, ['a']);
    return true;
  });
});

test('ctx is shared and threaded through every step', async () => {
  const s = new Saga('ctx')
    .step('a', async (ctx) => { ctx.a = 1; })
    .step('b', async (ctx) => { ctx.b = ctx.a + 1; });
  const out = await s.run({ seed: 0 });
  assert.deepEqual(out, { seed: 0, a: 1, b: 2 });
});

test('the log records start, ok, failed and compensated for each step', async () => {
  const events = [];
  const s = new Saga('logged', { log: (e) => events.push(`${e.step}:${e.at}`) })
    .step('a', async () => 1, async () => {})
    .step('b', async () => { throw new Error('x'); });
  await assert.rejects(() => s.run());
  assert.deepEqual(events, ['a:start', 'a:ok', 'b:start', 'b:failed', 'a:compensated']);
});
