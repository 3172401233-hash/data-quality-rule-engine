'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { RuleEngine } = require('..');
const { schema, payment, oneSuccessPerOrder, edgeSummary, violatorKeys } = require('./helpers');

function buildEngine() {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addLookup('orders', [{ id: 'o1' }, { id: 'o2' }, { id: 'o3' }], 'id');
  engine.addRule({ id: 'positive', type: 'condition', expect: (r) => r.amount > 0 });
  engine.addRule({ id: 'order-exists', type: 'reference', field: 'orderId', lookup: 'orders', dependsOn: ['positive'] });
  engine.addRule({ id: 'uniq-id', type: 'unique', fields: ['id'], dependsOn: ['order-exists'] });
  engine.addRule({
    id: 'ts-monotonic',
    type: 'monotonic',
    groupBy: ['orderId'],
    orderBy: 'seq',
    field: 'ts',
    dependsOn: ['uniq-id'],
  });
  engine.addRule({
    id: 'one-success',
    type: 'aggregate',
    groupBy: ['orderId'],
    check: oneSuccessPerOrder,
    dependsOn: ['ts-monotonic'],
  });
  return engine;
}

function baseRecords() {
  return [
    payment({ id: 'p1', orderId: 'o1', ts: 100, seq: 1, tenant: 't1' }),
    payment({ id: 'p2', orderId: 'o1', ts: 300, seq: 2, tenant: 't1' }),
    payment({ id: 'p3', orderId: 'o1', ts: 200, seq: 3, tenant: 't1' }),
    payment({ id: 'p4', orderId: 'o2', ts: 100, seq: 1, tenant: 't2' }),
    payment({ id: 'p5', orderId: 'o2', ts: 150, seq: 2, tenant: 't2' }),
    payment({ id: 'p6', orderId: 'o-missing', ts: 10, seq: 1, tenant: 't2' }),
    payment({ id: 'p7', orderId: 'o3', amount: -1, ts: 10, seq: 1, tenant: 't1' }),
    payment({ id: 'p4', orderId: 'o2', ts: 400, seq: 3, tenant: 't2' }),
  ];
}

function shuffle(records, seed) {
  const out = [...records];
  let s = seed;
  for (let i = out.length - 1; i > 0; i -= 1) {
    s = (s * 1103515245 + 12345) % 2147483648;
    const j = s % (i + 1);
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}

function summarize(result) {
  return {
    accepted: result.accepted.map((r) => `${r.tenant}:${r.id}:${r.seq}`).sort(),
    rejected: result.rejected.map((r) => `${r.record.id}:${r.record.seq}:${r.rule}`).sort(),
    violators: violatorKeys(result.diagnostics),
    edges: edgeSummary(result.diagnostics),
  };
}

test('record arrival order does not change the outcome', () => {
  const records = baseRecords();
  const baseline = summarize(buildEngine().evaluate(records));
  for (const seed of [1, 7, 42, 1337]) {
    const shuffled = summarize(buildEngine().evaluate(shuffle(records, seed)));
    assert.deepEqual(shuffled, baseline);
  }
});

test('replaying the same input yields byte-identical diagnostics', () => {
  const records = baseRecords();
  const first = buildEngine().evaluate(records);
  const second = buildEngine().evaluate(records);
  assert.deepEqual(second.diagnostics, first.diagnostics);
  assert.deepEqual(
    second.rejected.map((r) => `${r.record.id}:${r.rule}`),
    first.rejected.map((r) => `${r.record.id}:${r.rule}`),
  );
});
