'use strict';
/** orders — owns order state and runs the saga across the other two services. */
const { Db } = require('../../shared/db');
const { Outbox } = require('../../shared/outbox');
const { service, post } = require('../../shared/http');
const { Saga, SagaError } = require('../../shared/saga');

function createOrders({ inventoryUrl, paymentsUrl, log = () => {}, timeoutMs = 2000,
                        beforeConfirm = null } = {}) {
  const db = new Db({ orders: {} });
  const outbox = new Outbox(db);
  const sagaLog = [];

  async function place({ orderId, sku, qty, card, amount }) {
    if (!orderId) throw Object.assign(new Error('orderId is required'), { status: 400 });

    const already = db.read((s) => s.orders[orderId]);
    if (already) return { orderId, status: already.status, idempotent: true };

    outbox.commit((tx, emit) => {
      tx.orders[orderId] = { orderId, sku, qty, amount, status: 'pending', createdAt: Date.now() };
      emit('order.created', { orderId, sku, qty, amount });
    });

    const saga = new Saga(`place-order:${orderId}`, {
      log: (e) => { sagaLog.push(e); log(e); },
    });

    saga
      .step('reserve-stock',
        () => post(inventoryUrl, '/reserve', { orderId, sku, qty }, { timeoutMs }),
        () => post(inventoryUrl, '/release', { orderId }, { timeoutMs }))
      .step('charge-card',
        () => post(paymentsUrl, '/charge', { orderId, card, amount }, { timeoutMs }),
        () => post(paymentsUrl, '/refund', { orderId }, { timeoutMs }))
      .step('confirm-order',
        () => {
          // Test seam: lets the suite exercise the case where the LAST step
          // fails, which is the only way to reach a failing compensation of
          // an already-successful payment.
          if (beforeConfirm) beforeConfirm(orderId);
          return outbox.commit((tx, emit) => {
            tx.orders[orderId].status = 'confirmed';
            emit('order.confirmed', { orderId });
            return { confirmed: true };
          });
        });

    try {
      await saga.run({ orderId });
      return { orderId, status: 'confirmed' };
    } catch (err) {
      const isSaga = err instanceof SagaError;
      outbox.commit((tx, emit) => {
        const o = tx.orders[orderId];
        o.status = 'cancelled';
        o.failedStep = isSaga ? err.step : null;
        o.reason = err.message;
        // An unreconciled compensation is a state a human has to fix. Marking
        // it on the order is the difference between a known inconsistency and
        // a silent one.
        o.needsReconciliation = isSaga && err.compensationErrors.length > 0;
        emit('order.cancelled', { orderId, reason: err.message });
      });
      throw Object.assign(new Error(err.message), {
        status: 409,
        body: {
          orderId,
          status: 'cancelled',
          failedStep: isSaga ? err.step : null,
          compensated: isSaga ? err.compensated : [],
          compensationErrors: isSaga ? err.compensationErrors : [],
        },
      });
    }
  }

  const api = {
    place,
    get({ orderId }) { return db.read((s) => s.orders[orderId] ?? { error: 'not found' }); },
    all() { return db.read((s) => ({ orders: s.orders })); },
    sagaLog: () => sagaLog,
  };

  const srv = service('orders', {
    'POST /orders': async (b) => {
      try { return { status: 201, body: await api.place(b) }; }
      catch (e) { return { status: e.status || 500, body: e.body || { error: e.message } }; }
    },
    'POST /orders/get': (b) => api.get(b),
    'GET /state': () => api.all(),
    'GET /saga-log': () => ({ events: sagaLog }),
    'GET /outbox': () => ({ pending: outbox.pendingCount(), published: outbox.published.length }),
  });
  return { srv, api, db, outbox };
}

module.exports = { createOrders };
