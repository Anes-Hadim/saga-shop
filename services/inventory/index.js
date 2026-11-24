'use strict';
/** inventory — reserves and releases stock. The reservation is the thing a
 *  failed payment has to compensate. */
const { Db } = require('../../shared/db');
const { Outbox } = require('../../shared/outbox');
const { service } = require('../../shared/http');

function createInventory(stock = { 'sku-cpu': 5, 'sku-ram': 2, 'sku-ssd': 0 }) {
  const db = new Db({ stock, reservations: {} });
  const outbox = new Outbox(db);

  const api = {
    /**
     * Reserving is keyed by orderId, which makes it idempotent: the saga
     * orchestrator can retry a reserve whose response was lost without
     * double-decrementing stock.
     */
    reserve({ orderId, sku, qty }) {
      if (!orderId || !sku || !(qty > 0)) {
        throw Object.assign(new Error('orderId, sku and a positive qty are required'), { status: 400 });
      }
      return outbox.commit((tx, emit) => {
        const existing = tx.reservations[orderId];
        if (existing) return { reserved: true, idempotent: true, ...existing };
        const have = tx.stock[sku] ?? 0;
        if (have < qty) {
          throw Object.assign(new Error(`insufficient stock for ${sku}: have ${have}, need ${qty}`), { status: 409 });
        }
        tx.stock[sku] = have - qty;
        tx.reservations[orderId] = { sku, qty, releasedAt: null };
        emit('stock.reserved', { orderId, sku, qty });
        return { reserved: true, sku, qty, remaining: tx.stock[sku] };
      });
    },

    /** The compensating action. Idempotent: releasing twice is a no-op. */
    release({ orderId }) {
      return outbox.commit((tx, emit) => {
        const r = tx.reservations[orderId];
        if (!r) return { released: false, reason: 'no such reservation' };
        if (r.releasedAt) return { released: true, idempotent: true };
        tx.stock[r.sku] += r.qty;
        r.releasedAt = Date.now();
        emit('stock.released', { orderId, sku: r.sku, qty: r.qty });
        return { released: true, sku: r.sku, qty: r.qty, remaining: tx.stock[r.sku] };
      });
    },

    level({ sku }) { return db.read((s) => ({ sku, qty: s.stock[sku] ?? 0 })); },
    all() { return db.read((s) => ({ stock: s.stock, reservations: s.reservations })); },
  };

  const srv = service('inventory', {
    'POST /reserve': (b) => api.reserve(b),
    'POST /release': (b) => api.release(b),
    'POST /level': (b) => api.level(b),
    'GET /state': () => api.all(),
    'GET /outbox': () => ({ pending: outbox.pendingCount(), published: outbox.published.length }),
  });
  return { srv, api, db, outbox };
}

module.exports = { createInventory };
