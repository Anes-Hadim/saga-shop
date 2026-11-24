'use strict';
/**
 * db.js — an in-memory store with real transaction semantics.
 *
 * Deliberately not SQLite or Postgres: the project is about the distributed
 * failure modes between services, and a per-service store that can actually
 * roll back is enough to demonstrate them. What it does need to get right is
 * that a transaction is all-or-nothing, so the outbox pattern means something.
 *
 * Isolation is serial — one transaction at a time, no concurrency — which is
 * the one simplification that genuinely hides a class of real bugs (write
 * skew, lost updates). Noted in the README rather than papered over.
 */

class Db {
  constructor(initial = {}) {
    this.state = { outbox: [], ...structuredClone(initial) };
    this.commits = 0;
    this.rollbacks = 0;
  }

  /**
   * Runs fn against a copy. Commits it on return, discards it on throw, so a
   * partially-applied write is never visible.
   */
  transaction(fn) {
    const snapshot = structuredClone(this.state);
    try {
      const result = fn(this.state);
      this.commits++;
      return result;
    } catch (err) {
      this.state = snapshot;
      this.rollbacks++;
      throw err;
    }
  }

  read(fn) { return fn(structuredClone(this.state)); }
}

module.exports = { Db };
