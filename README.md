# saga-shop

Three microservices and one distributed transaction. An orchestrated **saga**
with compensating actions, plus the **transactional outbox** pattern.
**Zero dependencies** — `node:http` and nothing else.

```console
$ npm run demo
inventory: sku-cpu x3   payments balance: 0

1. a normal order
   -> confirmed   stock 2   balance 120

2. a declined card — stock must come back
   -> cancelled at "charge-card", compensated: [reserve-stock]
   stock 2 (unchanged)   balance 120 (unchanged)

3. three concurrent orders for the last two units
   -> confirmed, confirmed, cancelled
   stock 0   balance 360
```

## The problem

An order touches three services, each with its own database:

```
orders  ->  reserve stock (inventory db)  ->  charge card (payments db)  ->  confirm (orders db)
```

There is no transaction that spans all three. `BEGIN` / `COMMIT` is simply not
available. So what happens when the card is declined *after* the stock was
already reserved in a different service's database?

**Two-phase commit** would give you atomicity and charge you availability:
every participant must be reachable to commit, so one slow service blocks
everybody, and a coordinator crash leaves participants holding locks.

**A saga** gives up atomicity and keeps availability. Instead of "all or
nothing" it does "each step forward, or every completed step undone":

```
reserve stock  ->  charge card  ->  confirm order
     |                  |
     |                  +-- declined --> release stock
     +-- out of stock --> (nothing to undo)
```

## What a saga actually costs you

This is the part most write-ups skip, so it is the part this README leads with.

**You lose isolation.** Between "stock reserved" and "payment charged" the
system sits in a state no single database transaction would ever expose: stock
is unavailable for an order that is about to be cancelled, and another customer
can see it that way. A saga does not fix that. It makes the window visible and
bounded instead of pretending it isn't there.

**Compensations must be idempotent**, because the orchestrator can crash
mid-rollback and replay it. Here, `release` and `refund` are both keyed by
`orderId` and are no-ops the second time. Two tests assert exactly that: a
replayed `reserve` does not double-decrement stock, and a replayed `release`
does not over-credit it.

**Compensation can itself fail, and then the system is genuinely broken.** If
the card is charged, the confirm fails, and the refund *also* fails, money has
been taken for an order that will never ship and no automatic action can fix
it. A saga cannot prevent this. What it must not do is lose it silently — so
the rollback attempts every compensation rather than aborting on the first
failure, reports the full list of what did not undo, and marks the order
`needsReconciliation: true` so a human can find the stuck money.

There is a test for precisely that path, with a payments service that accepts
charges and refuses refunds:

```js
assert.deepEqual(res.body.compensationErrors,
  [{ step: 'charge-card', error: 'refund provider unreachable' }]);
assert.equal(order.needsReconciliation, true);
```

## The outbox pattern

Everybody writes this bug first:

```js
await db.insertOrder(order);           // committed
await queue.publish('order.created');  // ...process dies here
```

The order exists and nothing downstream knows. Swap the two lines and you get
the mirror-image bug: an event for an order that does not exist. **There is no
ordering of those two calls that is safe**, because they are two systems and
you only have one transaction.

The outbox makes the event part of the *same* transaction as the data — written
to an outbox table alongside the order, atomically. A relay then publishes
unsent rows. The test that matters asserts that a throwing transaction leaves
**neither** the row nor its event behind.

The relay publishes *then* marks sent, in that order. The reverse would lose
events on a crash; this duplicates them instead. At-least-once, so consumers
must dedupe — a test simulates a crash between the broker accepting an event
and the row being marked, and asserts the event goes out twice rather than
zero times.

## Tests

```console
$ npm test
ℹ tests 24
ℹ pass 24
ℹ fail 0
```

8 saga unit tests (reverse-order rollback, nothing-to-undo, collected
compensation failures, step-with-no-compensation) · 5 outbox tests (atomicity,
retry, crash duplication) · 11 end-to-end tests that boot **all three services
on real ports and talk HTTP between them**:

- happy path moves stock and money
- declined card releases the reservation
- a payments service that is **stopped entirely** still results in released stock
- an unreconcilable rollback flagged for a human
- the same `orderId` twice does not charge twice
- **five concurrent orders for two units confirm exactly two** and stock never goes negative
- each service's outbox holds its own events, including the compensating ones
- the saga log shows the full forward-and-back sequence

## Running it

```console
npm test          # everything, in-process
npm run demo      # narrated walkthrough
docker compose up # three containers, orders waits on the other two being healthy
```

## Known limits

- **The orchestrator is not durable.** The saga lives in the `orders` process's
  memory. If it dies mid-saga, the rollback never runs and the reservation is
  stranded until something else notices. A production saga persists its state
  machine per step and resumes on restart — which is what [`taskq`](https://github.com/Anes-Hadim/taskq)
  exists to make possible, and wiring the two together is the obvious next step.
- **Storage is in-memory, with serial isolation.** `shared/db.js` has real
  all-or-nothing transactions, which is what the outbox demonstration needs,
  but one transaction runs at a time. That hides write skew and lost updates —
  the classic concurrency bugs a real isolation level has to reason about.
- **No timeouts on compensations.** A hanging refund hangs the rollback.
- **The relay is manual.** `outbox.relay()` must be called; nothing polls it on
  a timer, and there is no real broker behind it.
- **No distributed tracing.** The saga log is per-process. Correlating a failure
  across three services means grepping three logs for the `orderId`.

## Layout

```
shared/saga.js        orchestrator: forward steps, reverse compensations, error collection
shared/outbox.js      transactional outbox + relay
shared/db.js          in-memory store with all-or-nothing transactions
shared/http.js        routing and JSON helpers, no framework
services/inventory/   reserve / release stock, both idempotent
services/payments/    charge / refund, both idempotent
services/orders/      owns order state, runs the saga
```

MIT.
