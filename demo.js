#!/usr/bin/env node
'use strict';
/** Boots all three services and walks through success, rollback and oversell. */
const { createInventory } = require('./services/inventory');
const { createPayments } = require('./services/payments');
const { createOrders } = require('./services/orders');

const line = (s) => console.log(s);

(async () => {
  const inv = createInventory({ 'sku-cpu': 3 });
  const pay = createPayments();
  const invPort = await inv.srv.start();
  const payPort = await pay.srv.start();
  const ord = createOrders({
    inventoryUrl: `http://127.0.0.1:${invPort}`,
    paymentsUrl: `http://127.0.0.1:${payPort}`,
  });
  const ordPort = await ord.srv.start();
  const place = (b) => fetch(`http://127.0.0.1:${ordPort}/orders`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b),
  }).then(async (r) => r.json());

  const stock = () => inv.api.level({ sku: 'sku-cpu' }).qty;
  line(`inventory: sku-cpu x${stock()}   payments balance: ${pay.api.all().balance}\n`);

  line('1. a normal order');
  let r = await place({ orderId: 'a1', sku: 'sku-cpu', qty: 1, card: '5555', amount: 120 });
  line(`   -> ${r.status}   stock ${stock()}   balance ${pay.api.all().balance}\n`);

  line('2. a declined card — stock must come back');
  r = await place({ orderId: 'a2', sku: 'sku-cpu', qty: 1, card: '4000123412341234', amount: 120 });
  line(`   -> ${r.status} at "${r.failedStep}", compensated: [${r.compensated}]`);
  line(`   stock ${stock()} (unchanged)   balance ${pay.api.all().balance} (unchanged)\n`);

  line('3. three concurrent orders for the last two units');
  const many = await Promise.all([1, 2, 3].map((i) =>
    place({ orderId: `c${i}`, sku: 'sku-cpu', qty: 1, card: '5555', amount: 120 })));
  line(`   -> ${many.map((m) => m.status).join(', ')}`);
  line(`   stock ${stock()}   balance ${pay.api.all().balance}\n`);

  line('events recorded in each service\'s outbox:');
  line(`   orders:    ${ord.db.state.outbox.map((e) => e.type).join(' ')}`);
  line(`   inventory: ${inv.db.state.outbox.map((e) => e.type).join(' ')}`);
  line(`   payments:  ${pay.db.state.outbox.map((e) => e.type).join(' ')}`);

  await ord.srv.stop(); await inv.srv.stop(); await pay.srv.stop();
})();
