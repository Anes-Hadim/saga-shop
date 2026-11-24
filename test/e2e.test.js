'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { createInventory } = require('../services/inventory');
const { createPayments } = require('../services/payments');
const { createOrders } = require('../services/orders');

/** Boots all three services on real ports. */
async function cluster(opts = {}) {
  const inv = createInventory(opts.stock);
  const pay = createPayments(opts.payments);
  const invPort = await inv.srv.start();
  const payPort = await pay.srv.start();
  const ord = createOrders({
    inventoryUrl: `http://127.0.0.1:${invPort}`,
    paymentsUrl: `http://127.0.0.1:${payPort}`,
    timeoutMs: opts.timeoutMs ?? 2000,
    beforeConfirm: opts.beforeConfirm ?? null,
  });
  const ordPort = await ord.srv.start();
  return {
    inv, pay, ord,
    url: `http://127.0.0.1:${ordPort}`,
    payUrl: `http://127.0.0.1:${payPort}`,
    async stop() { await ord.srv.stop(); await inv.srv.stop(); await pay.srv.stop(); },
  };
}

const place = (c, b) => fetch(`${c.url}/orders`, {
  method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
}).then(async (r) => ({ status: r.status, body: await r.json() }));

test('the happy path confirms the order and moves stock and money', async () => {
  const c = await cluster();
  const res = await place(c, { orderId: 'o1', sku: 'sku-cpu', qty: 2, card: '5555', amount: 300 });

  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'confirmed');
  assert.equal(c.inv.api.level({ sku: 'sku-cpu' }).qty, 3, '5 - 2 reserved');
  assert.equal(c.pay.api.all().balance, 300);
  assert.equal(c.ord.api.get({ orderId: 'o1' }).status, 'confirmed');
  await c.stop();
});

test('a declined card rolls the stock reservation back', async () => {
  // This is the case a saga exists for: stock was already reserved in another
  // service's database when payment failed. There is no transaction that
  // covers both, so the reservation has to be actively undone.
  const c = await cluster();
  const res = await place(c, { orderId: 'o2', sku: 'sku-cpu', qty: 2, card: '4000111122223333', amount: 300 });

  assert.equal(res.status, 409);
  assert.equal(res.body.status, 'cancelled');
  assert.equal(res.body.failedStep, 'charge-card');
  assert.deepEqual(res.body.compensated, ['reserve-stock']);
  assert.deepEqual(res.body.compensationErrors, []);

  assert.equal(c.inv.api.level({ sku: 'sku-cpu' }).qty, 5, 'stock is back to 5, not stranded at 3');
  assert.equal(c.pay.api.all().balance, 0, 'no money moved');
  assert.equal(c.ord.api.get({ orderId: 'o2' }).status, 'cancelled');
  await c.stop();
});

test('insufficient stock fails at the first step with nothing to undo', async () => {
  const c = await cluster();
  const res = await place(c, { orderId: 'o3', sku: 'sku-ssd', qty: 1, card: '5555', amount: 100 });
  assert.equal(res.status, 409);
  assert.equal(res.body.failedStep, 'reserve-stock');
  assert.deepEqual(res.body.compensated, [], 'nothing had completed yet');
  assert.equal(c.pay.api.all().balance, 0);
  await c.stop();
});

test('a payments service that is down fails the saga and releases stock', async () => {
  const c = await cluster();
  await c.pay.srv.stop();                     // the service disappears entirely

  const res = await place(c, { orderId: 'o4', sku: 'sku-cpu', qty: 1, card: '5555', amount: 50 });
  assert.equal(res.status, 409);
  assert.equal(res.body.failedStep, 'charge-card');
  assert.deepEqual(res.body.compensated, ['reserve-stock']);
  assert.equal(c.inv.api.level({ sku: 'sku-cpu' }).qty, 5, 'stock released despite payments being gone');

  await c.ord.srv.stop(); await c.inv.srv.stop();
});

test('an unreconcilable rollback is flagged for a human instead of hidden', async () => {
  // The genuinely bad case. Stock is reserved, the card IS charged, then the
  // final confirm fails — and the refund fails too. Money has been taken for
  // an order that will never ship, and no automatic action can fix it.
  //
  // A saga cannot prevent this. What it must not do is lose it silently.
  const c = await cluster({
    beforeConfirm: () => { throw new Error('order DB write failed'); },
  });

  // Break refunds at the service level, leaving charge working.
  c.pay.srv.close();
  const brokenPay = require('node:http').createServer((req, res) => {
    const u = new URL(req.url, 'http://x').pathname;
    let bodyStr = '';
    req.on('data', (d) => { bodyStr += d; });
    req.on('end', () => {
      if (u === '/charge') {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ charged: true, chargeId: 'ch_x', amount: 500 }));
      }
      if (u === '/refund') {
        res.writeHead(502, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ error: 'refund provider unreachable' }));
      }
      res.writeHead(404); res.end('{}');
    });
  });
  await new Promise((r) => brokenPay.listen(new URL(c.payUrl).port, '127.0.0.1', r));

  const res = await place(c, { orderId: 'bad', sku: 'sku-cpu', qty: 1, card: '5555', amount: 500 });

  assert.equal(res.status, 409);
  assert.equal(res.body.failedStep, 'confirm-order');
  assert.deepEqual(res.body.compensated, ['reserve-stock'], 'stock came back');
  assert.deepEqual(
    res.body.compensationErrors,
    [{ step: 'charge-card', error: 'refund provider unreachable' }],
    'the refund failure is reported, not swallowed',
  );

  const order = c.ord.api.get({ orderId: 'bad' });
  assert.equal(order.status, 'cancelled');
  assert.equal(order.needsReconciliation, true,
    'the order is marked for manual reconciliation, so the stuck money is findable');

  await new Promise((r) => { brokenPay.closeAllConnections?.(); brokenPay.close(r); });
  await c.ord.srv.stop(); await c.inv.srv.stop();
});

test('placing the same orderId twice does not charge twice', async () => {
  const c = await cluster();
  const first = await place(c, { orderId: 'dup', sku: 'sku-cpu', qty: 1, card: '5555', amount: 100 });
  const second = await place(c, { orderId: 'dup', sku: 'sku-cpu', qty: 1, card: '5555', amount: 100 });

  assert.equal(first.body.status, 'confirmed');
  assert.equal(second.body.idempotent, true);
  assert.equal(c.pay.api.all().balance, 100, 'charged once, not twice');
  assert.equal(c.inv.api.level({ sku: 'sku-cpu' }).qty, 4, 'stock decremented once');
  await c.stop();
});

test('reserve and release are each idempotent on their own', async () => {
  const c = await cluster();
  c.inv.api.reserve({ orderId: 'r1', sku: 'sku-cpu', qty: 2 });
  const again = c.inv.api.reserve({ orderId: 'r1', sku: 'sku-cpu', qty: 2 });
  assert.equal(again.idempotent, true);
  assert.equal(c.inv.api.level({ sku: 'sku-cpu' }).qty, 3, 'a replayed reserve does not double-decrement');

  c.inv.api.release({ orderId: 'r1' });
  const releasedAgain = c.inv.api.release({ orderId: 'r1' });
  assert.equal(releasedAgain.idempotent, true);
  assert.equal(c.inv.api.level({ sku: 'sku-cpu' }).qty, 5, 'a replayed release does not over-credit stock');
  await c.stop();
});

test('concurrent orders cannot oversell the last units', async () => {
  // Two units in stock, five simultaneous orders for one each. Exactly two
  // must succeed. Anything else is overselling.
  const c = await cluster({ stock: { 'sku-ram': 2 } });
  const results = await Promise.all(
    [1, 2, 3, 4, 5].map((i) => place(c, { orderId: `c${i}`, sku: 'sku-ram', qty: 1, card: '5555', amount: 10 })),
  );
  const confirmed = results.filter((r) => r.body.status === 'confirmed').length;
  const cancelled = results.filter((r) => r.body.status === 'cancelled').length;

  assert.equal(confirmed, 2, `exactly 2 confirmed, got ${confirmed}`);
  assert.equal(cancelled, 3);
  assert.equal(c.inv.api.level({ sku: 'sku-ram' }).qty, 0, 'stock hit zero and never went negative');
  assert.equal(c.pay.api.all().balance, 20, 'only the two winners were charged');
  await c.stop();
});

test('every service records its events in its own outbox', async () => {
  const c = await cluster();
  await place(c, { orderId: 'ob1', sku: 'sku-cpu', qty: 1, card: '5555', amount: 100 });

  const ordEvents = c.ord.db.state.outbox.map((e) => e.type);
  assert.deepEqual(ordEvents, ['order.created', 'order.confirmed']);
  assert.deepEqual(c.inv.db.state.outbox.map((e) => e.type), ['stock.reserved']);
  assert.deepEqual(c.pay.db.state.outbox.map((e) => e.type), ['payment.charged']);

  // And a rollback records the compensating events too, so the event stream
  // tells the whole story and not just the happy half.
  await place(c, { orderId: 'ob2', sku: 'sku-cpu', qty: 1, card: '4000', amount: 100 });
  assert.deepEqual(c.inv.db.state.outbox.map((e) => e.type), ['stock.reserved', 'stock.reserved', 'stock.released']);
  await c.stop();
});

test('the saga log shows the full forward-and-back sequence', async () => {
  const c = await cluster();
  await place(c, { orderId: 'log1', sku: 'sku-cpu', qty: 1, card: '4000', amount: 100 });
  const seq = c.ord.api.sagaLog().map((e) => `${e.step}:${e.at}`);
  assert.deepEqual(seq, [
    'reserve-stock:start', 'reserve-stock:ok',
    'charge-card:start', 'charge-card:failed',
    'reserve-stock:compensated',
  ]);
  await c.stop();
});

test('health endpoints answer on every service', async () => {
  const c = await cluster();
  for (const [name, srv] of [['orders', c.ord.srv], ['inventory', c.inv.srv], ['payments', c.pay.srv]]) {
    const r = await fetch(`http://127.0.0.1:${srv.address().port}/healthz`);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, service: name });
  }
  await c.stop();
});
