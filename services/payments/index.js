'use strict';
/** payments — charges and refunds. Fails on purpose for specific cards so the
 *  rollback path is exercisable. */
const { Db } = require('../../shared/db');
const { Outbox } = require('../../shared/outbox');
const { service } = require('../../shared/http');

function createPayments(opts = {}) {
  const db = new Db({ charges: {}, balance: 0 });
  const outbox = new Outbox(db);
  // Injectable so a test can make payment fail deterministically rather than
  // relying on a magic string in production code.
  const declines = opts.declines ?? ((card) => String(card).startsWith('4000'));
  const fail = opts.failWith ?? null;

  const api = {
    charge({ orderId, card, amount }) {
      if (!orderId || !card || !(amount > 0)) {
        throw Object.assign(new Error('orderId, card and a positive amount are required'), { status: 400 });
      }
      if (fail) throw Object.assign(new Error(fail), { status: 502 });
      return outbox.commit((tx, emit) => {
        const existing = tx.charges[orderId];
        if (existing) return { charged: true, idempotent: true, chargeId: existing.chargeId };
        if (declines(card)) {
          throw Object.assign(new Error(`card declined: ${String(card).slice(0, 4)}****`), { status: 402 });
        }
        const chargeId = `ch_${orderId}`;
        tx.charges[orderId] = { chargeId, amount, refundedAt: null };
        tx.balance += amount;
        emit('payment.charged', { orderId, chargeId, amount });
        return { charged: true, chargeId, amount };
      });
    },

    /** Compensating action. Idempotent. */
    refund({ orderId }) {
      return outbox.commit((tx, emit) => {
        const c = tx.charges[orderId];
        if (!c) return { refunded: false, reason: 'no such charge' };
        if (c.refundedAt) return { refunded: true, idempotent: true };
        tx.balance -= c.amount;
        c.refundedAt = Date.now();
        emit('payment.refunded', { orderId, chargeId: c.chargeId, amount: c.amount });
        return { refunded: true, amount: c.amount };
      });
    },

    all() { return db.read((s) => ({ charges: s.charges, balance: s.balance })); },
  };

  const srv = service('payments', {
    'POST /charge': (b) => api.charge(b),
    'POST /refund': (b) => api.refund(b),
    'GET /state': () => api.all(),
    'GET /outbox': () => ({ pending: outbox.pendingCount(), published: outbox.published.length }),
  });
  return { srv, api, db, outbox };
}

module.exports = { createPayments };
