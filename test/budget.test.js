'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { RuleEngine, BudgetExceededError } = require('..');
const { schema, payment, oneSuccessPerOrder } = require('./helpers');

function buildRecords(count) {
  const records = [];
  for (let i = 0; i < count; i += 1) {
    records.push(
      payment({
        id: `p${i}`,
        orderId: `o${Math.floor(i / 2)}`,
        tenant: `t${i % 3}`,
        ts: 1000 + i,
        seq: i,
      }),
    );
  }
  return records;
}

test('insufficient budget without spill raises BudgetExceededError', () => {
  const engine = new RuleEngine({
    schema,
    partitionBy: 'tenant',
    memoryBudgetBytes: 128,
    allowSpill: false,
  });
  engine.addRule({ id: 'uniq', type: 'unique', fields: ['id'] });
  assert.throws(() => engine.evaluate(buildRecords(10)), BudgetExceededError);
});

test('non-positive budget is rejected up front', () => {
  const engine = new RuleEngine({ schema, memoryBudgetBytes: 0 });
  engine.addRule({ id: 'uniq', type: 'unique', fields: ['id'] });
  assert.throws(() => engine.evaluate(buildRecords(1)), BudgetExceededError);
});

test('spilling keeps results identical to an in-memory run', () => {
  const records = buildRecords(60);
  records.push(payment({ id: 'p10', orderId: 'o5', tenant: 't1', ts: 9999, seq: 999 }));

  const makeEngine = (options) => {
    const engine = new RuleEngine({ schema, partitionBy: 'tenant', ...options });
    engine.addRule({ id: 'uniq-id', type: 'unique', fields: ['id'] });
    engine.addRule({ id: 'one-success', type: 'aggregate', groupBy: ['orderId'], check: oneSuccessPerOrder });
    return engine;
  };

  const inMemory = makeEngine({ memoryBudgetBytes: 16 * 1024 * 1024 }).evaluate(records);

  const spillDir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-test-spill-'));
  try {
    const spilled = makeEngine({ memoryBudgetBytes: 512, spillDir }).evaluate(records);
    assert.ok(spilled.stats.spilledPartitions > 0);
    assert.deepEqual(
      spilled.rejected.map((r) => `${r.record.id}:${r.rule}`).sort(),
      inMemory.rejected.map((r) => `${r.record.id}:${r.rule}`).sort(),
    );
    assert.deepEqual(
      spilled.accepted.map((r) => r.id).sort(),
      inMemory.accepted.map((r) => r.id).sort(),
    );
    assert.deepEqual(
      spilled.diagnostics.edges.map((e) => `${e.fromKey}->${e.toKey}:${e.rule}`).sort(),
      inMemory.diagnostics.edges.map((e) => `${e.fromKey}->${e.toKey}:${e.rule}`).sort(),
    );
    assert.equal(fs.readdirSync(spillDir).length, 0, 'spill files are cleaned up');
  } finally {
    fs.rmSync(spillDir, { recursive: true, force: true });
  }
});
