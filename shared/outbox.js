'use strict';
/**
 * outbox.js — the transactional outbox pattern.
 *
 * The bug it fixes is the one everybody writes first:
 *
 *   await db.insertOrder(order);        // committed
 *   await queue.publish('order.created'); // process dies here
 *
 * The order exists and nobody downstream knows. Swap the two lines and you get
 * the mirror-image bug: an event for an order that does not exist.
 *
 * There is no ordering of those two calls that is safe, because they are two
 * systems and you only have one transaction. The outbox fixes it by making the
 * event part of the *same* transaction as the data: the event is written to an
 * outbox table alongside the order, atomically. A separate relay then reads
 * unpublished rows and publishes them.
 *
 * The guarantee this buys is at-least-once publication, not exactly-once — the
 * relay can publish and then crash before marking the row sent, so the event
 * goes out twice. Consumers must be idempotent. Again: there is no exactly-once;
 * there is only being honest about which side you err on.
 */

class Outbox {
  constructor(db) {
    this.db = db;
    this.published = [];
  }

  /** Writes rows and their events in one transaction. */
  commit(writeFn) {
    return this.db.transaction((tx) => {
      const events = [];
      const result = writeFn(tx, (type, payload) => {
        events.push({ type, payload });
      });
      for (const e of events) {
        tx.outbox.push({
          id: `${Date.now()}-${tx.outbox.length}-${Math.random().toString(36).slice(2, 8)}`,
          type: e.type,
          payload: e.payload,
          sentAt: null,
          attempts: 0,
        });
      }
      return result;
    });
  }

  /** Publishes unsent events. Returns how many went out. */
  async relay(publish) {
    const pending = this.db.state.outbox.filter((e) => e.sentAt === null);
    let sent = 0;
    for (const e of pending) {
      e.attempts++;
      try {
        await publish(e.type, e.payload);
        // Published-then-marked, in that order. The reverse would lose events
        // on a crash; this duplicates them instead, which consumers can
        // handle and losing them is not.
        e.sentAt = Date.now();
        this.published.push(e);
        sent++;
      } catch {
        // leave sentAt null: the next relay pass retries it
      }
    }
    return sent;
  }

  pendingCount() { return this.db.state.outbox.filter((e) => e.sentAt === null).length; }
}

module.exports = { Outbox };
