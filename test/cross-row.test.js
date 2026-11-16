'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleEngine } = require('..');
const {
  schema,
  payment,
  oneSuccessPerOrder,
  nodeKeys,
  violatorKeys,
  edgeSummary,
} = require('./helpers');

test('aggregate cross-row rule: one successful payment per order', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'one-success', type: 'aggregate', groupBy: ['orderId'], check: oneSuccessPerOrder });

  const records = [
    payment({ id: 'p1', orderId: 'o1', ts: 1000 }),
    payment({ id: 'p2', orderId: 'o1', ts: 1001 }),
    payment({ id: 'p3', orderId: 'o2', ts: 1002 }),
    payment({ id: 'p4', orderId: 'o2', status: 'failed', ts: 1003 }),
  ];
  const result = engine.evaluate(records);

  assert.deepEqual(result.rejected.map((r) => r.record.id), ['p2']);
  assert.deepEqual(result.accepted.map((r) => r.id).sort(), ['p1', 'p3', 'p4']);

  assert.deepEqual(violatorKeys(result.diagnostics), ['p2']);
  assert.deepEqual(nodeKeys(result.diagnostics), ['p1', 'p2']);
  assert.deepEqual(edgeSummary(result.diagnostics), ['p2->p1:one-success:group']);
});

test('unique rule keeps deterministic survivor and links duplicates', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'uniq-ts', type: 'unique', fields: ['orderId'], orderBy: 'ts' });

  const records = [
    payment({ id: 'late', orderId: 'o1', ts: 2000 }),
    payment({ id: 'early', orderId: 'o1', ts: 1000 }),
    payment({ id: 'solo', orderId: 'o2', ts: 1500 }),
  ];
  const result = engine.evaluate(records);

  assert.deepEqual(result.rejected.map((r) => r.record.id), ['late']);
  assert.deepEqual(nodeKeys(result.diagnostics), ['early', 'late']);
  assert.deepEqual(edgeSummary(result.diagnostics), ['late->early:uniq-ts:duplicate']);
});

test('monotonic rule flags records that break time ordering within a group', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({
    id: 'ts-monotonic',
    type: 'monotonic',
    groupBy: ['orderId'],
    orderBy: 'seq',
    field: 'ts',
  });

  const records = [
    payment({ id: 'e1', orderId: 'o1', seq: 1, ts: 100 }),
    payment({ id: 'e2', orderId: 'o1', seq: 2, ts: 300 }),
    payment({ id: 'e3', orderId: 'o1', seq: 3, ts: 200 }),
    payment({ id: 'e4', orderId: 'o2', seq: 1, ts: 50 }),
  ];
  const result = engine.evaluate(records);

  assert.deepEqual(result.rejected.map((r) => r.record.id), ['e3']);
  assert.deepEqual(nodeKeys(result.diagnostics), ['e2', 'e3']);
  assert.deepEqual(edgeSummary(result.diagnostics), ['e3->e2:ts-monotonic:order']);
});

test('condition rule evaluates single records with a when filter', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({
    id: 'positive-amount',
    type: 'condition',
    uses: ['amount', 'status'],
    when: (r) => r.status === 'success',
    expect: (r) => r.amount > 0,
  });

  const records = [
    payment({ id: 'ok', amount: 5 }),
    payment({ id: 'bad', amount: -1 }),
    payment({ id: 'skipped', amount: -2, status: 'failed' }),
  ];
  const result = engine.evaluate(records);

  assert.deepEqual(result.rejected.map((r) => r.record.id), ['bad']);
  assert.deepEqual(result.accepted.map((r) => r.id).sort(), ['ok', 'skipped']);
});

test('cross-row rules are scoped to their own partition', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'one-success', type: 'aggregate', groupBy: ['orderId'], check: oneSuccessPerOrder });

  const records = [
    payment({ id: 'a1', orderId: 'o1', tenant: 't1' }),
    payment({ id: 'b1', orderId: 'o1', tenant: 't2' }),
  ];
  const result = engine.evaluate(records);

  assert.equal(result.rejected.length, 0);
  assert.equal(result.stats.partitions, 2);
});
