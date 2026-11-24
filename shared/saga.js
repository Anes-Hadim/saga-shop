'use strict';
/**
 * saga.js — orchestrated saga with compensating transactions.
 *
 * The problem this solves: an order spans three services, each with its own
 * database. There is no transaction that covers all three, so `BEGIN` /
 * `COMMIT` is simply not available. Two-phase commit would give it to you and
 * costs you availability — every participant must be reachable to commit, so
 * one slow service blocks everyone.
 *
 * A saga gives up atomicity and keeps availability. Instead of "all or
 * nothing", it does "each step forward, or every completed step undone":
 *
 *   reserve stock -> charge card -> confirm order
 *        |               |
 *        |               +-- fails --> release stock
 *        +-- fails --> (nothing to undo)
 *
 * What you lose is isolation, and it is worth being explicit about: between
 * "stock reserved" and "payment charged" the system is in a state no single
 * database transaction would ever expose. Another customer can see the stock
 * as unavailable for an order that is about to be cancelled. Sagas do not fix
 * that; they make it visible and bounded.
 *
 * Compensations must be idempotent, because the orchestrator can crash
 * mid-rollback and replay it.
 */

class SagaError extends Error {
  constructor(message, { step, cause, compensated, compensationErrors }) {
    super(message);
    this.name = 'SagaError';
    this.step = step;
    this.cause = cause;
    this.compensated = compensated;
    this.compensationErrors = compensationErrors;
  }
}

class Saga {
  constructor(name, opts = {}) {
    this.name = name;
    this.steps = [];
    this.log = opts.log || (() => {});
  }

  /**
   * @param {string} name
   * @param {(ctx: object) => Promise<any>} action
   * @param {(ctx: object, result: any) => Promise<void>} [compensate]
   *   Must be idempotent: a crashed rollback is replayed.
   */
  step(name, action, compensate) {
    this.steps.push({ name, action, compensate });
    return this;
  }

  async run(ctx = {}) {
    const completed = [];
    for (const step of this.steps) {
      try {
        this.log({ saga: this.name, step: step.name, at: 'start' });
        const result = await step.action(ctx);
        completed.push({ step, result });
        this.log({ saga: this.name, step: step.name, at: 'ok' });
      } catch (err) {
        this.log({ saga: this.name, step: step.name, at: 'failed', error: err.message });
        const { compensated, errors } = await this.#rollback(completed, ctx);
        throw new SagaError(
          `saga "${this.name}" failed at step "${step.name}": ${err.message}`,
          { step: step.name, cause: err, compensated, compensationErrors: errors },
        );
      }
    }
    return ctx;
  }

  /** Undoes completed steps in reverse order. */
  async #rollback(completed, ctx) {
    const compensated = [];
    const errors = [];
    for (const { step, result } of [...completed].reverse()) {
      if (!step.compensate) continue;
      try {
        await step.compensate(ctx, result);
        compensated.push(step.name);
        this.log({ saga: this.name, step: step.name, at: 'compensated' });
      } catch (err) {
        // A failed compensation is the genuinely bad case: the system is now
        // inconsistent and no amount of retrying inside this request will fix
        // it. Collect every failure rather than aborting on the first, so the
        // error names everything a human has to reconcile by hand.
        errors.push({ step: step.name, error: err.message });
        this.log({ saga: this.name, step: step.name, at: 'compensation-failed', error: err.message });
      }
    }
    return { compensated, errors };
  }
}

module.exports = { Saga, SagaError };
