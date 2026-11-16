'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  RuleEngine,
  DuplicateRuleError,
  UnknownFieldError,
  RuleCycleError,
  RuleDefinitionError,
} = require('..');
const { schema, payment } = require('./helpers');

test('duplicate rule declaration is rejected', () => {
  const engine = new RuleEngine({ schema });
  engine.addRule({ id: 'uniq', type: 'unique', fields: ['id'] });
  assert.throws(
    () => engine.addRule({ id: 'uniq', type: 'unique', fields: ['orderId'] }),
    DuplicateRuleError,
  );
});

test('unknown fields in rule definitions are rejected', () => {
  const engine = new RuleEngine({ schema });
  assert.throws(
    () => engine.addRule({ id: 'bad', type: 'unique', fields: ['nope'] }),
    UnknownFieldError,
  );
  assert.throws(
    () => engine.addRule({ id: 'bad2', type: 'monotonic', orderBy: 'seq', field: 'ghost' }),
    UnknownFieldError,
  );
  assert.throws(
    () => new RuleEngine({ schema, partitionBy: 'missing-field' }),
    UnknownFieldError,
  );
});

test('rule dependency cycles are reported with the cycle path', () => {
  const engine = new RuleEngine({ schema });
  engine.addRule({ id: 'a', type: 'condition', expect: () => true, dependsOn: ['b'] });
  assert.throws(
    () => engine.addRule({ id: 'b', type: 'condition', expect: () => true, dependsOn: ['a'] }),
    (err) => {
      assert.ok(err instanceof RuleCycleError);
      assert.match(err.message, /a -> b -> a|b -> a -> b/);
      return true;
    },
  );
});

test('depending on an unknown rule is rejected', () => {
  const engine = new RuleEngine({ schema });
  engine.addRule({ id: 'x', type: 'condition', expect: () => true, dependsOn: ['ghost'] });
  assert.throws(() => engine.evaluate([payment({ id: 'p1' })]), RuleDefinitionError);
});

test('dependent rules only see records that survived their dependencies', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'positive', type: 'condition', expect: (r) => r.amount > 0 });
  engine.addRule({ id: 'uniq-id', type: 'unique', fields: ['id'], dependsOn: ['positive'] });
  const records = [
    payment({ id: 'dup', amount: -5, ts: 1 }),
    payment({ id: 'dup', amount: 5, ts: 2 }),
  ];
  const result = engine.evaluate(records);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].rule, 'positive');
  assert.equal(result.accepted.length, 1);
  assert.ok(result.diagnostics.edges.every((e) => e.rule !== 'uniq-id'));
});

test('dependency order is respected even when rules are declared out of order', () => {
  const engine = new RuleEngine({ schema, partitionBy: 'tenant' });
  engine.addRule({ id: 'first', type: 'condition', expect: (r) => r.amount > 0 });
  engine.addRule({ id: 'second', type: 'condition', expect: (r) => r.status === 'success', dependsOn: ['first'] });
  const result = engine.evaluate([payment({ id: 'neg-and-failed', amount: -1, status: 'failed' })]);
  assert.equal(result.rejected.length, 1);
  assert.equal(result.rejected[0].rule, 'first');
});
