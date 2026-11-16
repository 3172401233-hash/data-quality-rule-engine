'use strict';

const schema = {
  id: 'string',
  orderId: 'string',
  status: 'string',
  amount: 'number',
  ts: 'number',
  seq: 'number',
  tenant: 'string',
};

function payment(overrides) {
  return {
    id: 'p0',
    orderId: 'o0',
    status: 'success',
    amount: 10,
    ts: 1000,
    seq: 1,
    tenant: 't1',
    ...overrides,
  };
}

function oneSuccessPerOrder(records) {
  const successes = records.filter((r) => r.status === 'success');
  if (successes.length <= 1) return true;
  return { ok: false, offenders: successes.slice(1) };
}

function nodeKeys(diagnostics) {
  return diagnostics.nodes.map((n) => n.key).sort();
}

function violatorKeys(diagnostics) {
  return diagnostics.nodes
    .filter((n) => n.role === 'violator')
    .map((n) => n.key)
    .sort();
}

function edgeSummary(diagnostics) {
  return diagnostics.edges
    .map((e) => `${e.fromKey}->${e.toKey}:${e.rule}:${e.kind}`)
    .sort();
}

module.exports = { schema, payment, oneSuccessPerOrder, nodeKeys, violatorKeys, edgeSummary };
