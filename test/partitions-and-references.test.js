'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleEngine } = require('..');
const { schema, payment, nodeKeys, violatorKeys } = require('./helpers');

test('empty input yields empty result without errors', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'uniq', type: 'unique', fields: ['id'] });
  engine.addRule({
    id: 'one-success',
    type: 'aggregate',
    groupBy: ['orderId'],
    check: (records) => records.filter((r) => r.status === 'success').length <= 1,
  });

  const result = engine.evaluate([]);
  assert.deepEqual(result.accepted, []);
  assert.deepEqual(result.rejected, []);
  assert.deepEqual(result.diagnostics, { nodes: [], edges: [] });
  assert.equal(result.stats.partitions, 0);
});

test('partition whose records are all quarantined leaves no survivors', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'positive', type: 'condition', expect: (r) => r.amount > 0 });

  const result = engine.evaluate([
    payment({ id: 'x1', tenant: 'empty-soon', amount: -1 }),
    payment({ id: 'x2', tenant: 'empty-soon', amount: -2 }),
    payment({ id: 'y1', tenant: 'healthy', amount: 3 }),
  ]);

  assert.deepEqual(result.accepted.map((r) => r.id), ['y1']);
  assert.equal(result.rejected.length, 2);
  assert.ok(result.rejected.every((r) => r.partition === 'empty-soon'));
});

test('orphan reference is rejected and kept in the diagnostic graph', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addLookup('orders', [{ id: 'o1' }, { id: 'o2' }], 'id');
  engine.addRule({ id: 'order-exists', type: 'reference', field: 'orderId', lookup: 'orders' });

  const result = engine.evaluate([
    payment({ id: 'fine', orderId: 'o1' }),
    payment({ id: 'orphan', orderId: 'o-missing' }),
  ]);

  assert.deepEqual(result.accepted.map((r) => r.id), ['fine']);
  assert.deepEqual(result.rejected.map((r) => r.record.id), ['orphan']);
  assert.deepEqual(violatorKeys(result.diagnostics), ['orphan']);
  assert.deepEqual(nodeKeys(result.diagnostics), ['orphan']);
});

test('optional reference allows null values', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addLookup('orders', [{ id: 'o1' }], 'id');
  engine.addRule({ id: 'order-exists', type: 'reference', field: 'orderId', lookup: 'orders', optional: true });

  const record = payment({ id: 'no-order' });
  delete record.orderId;
  const result = engine.evaluate([record]);
  assert.equal(result.rejected.length, 0);
});
