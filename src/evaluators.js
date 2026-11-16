'use strict';

const { RuleDefinitionError } = require('./errors');
const { stableStringify, compareValues } = require('./util');

function groupEntries(entries, fields) {
  const groups = new Map();
  for (const entry of entries) {
    const key = stableStringify(fields.map((f) => entry.record[f]));
    let group = groups.get(key);
    if (!group) {
      group = [];
      groups.set(key, group);
    }
    group.push(entry);
  }
  return groups;
}

function deterministicOrder(entries, orderBy) {
  return [...entries].sort((a, b) => {
    if (orderBy) {
      const cmp = compareValues(a.record[orderBy], b.record[orderBy]);
      if (cmp !== 0) return cmp;
    }
    const sa = stableStringify(a.record);
    const sb = stableStringify(b.record);
    return sa < sb ? -1 : sa > sb ? 1 : 0;
  });
}

function split(entries, rejectedSet) {
  const remaining = [];
  const rejected = [];
  for (const entry of entries) {
    if (rejectedSet.has(entry)) rejected.push(entry);
    else remaining.push(entry);
  }
  return { remaining, rejected };
}

function runCondition(rule, entries, diagnostics, partition) {
  const rejectedSet = new Set();
  for (const entry of entries) {
    const record = entry.record;
    if (rule.when && !rule.when(record)) continue;
    if (!rule.expect(record)) {
      diagnostics.addNode(entry, 'violator', rule.id, partition);
      rejectedSet.add(entry);
    }
  }
  return split(entries, rejectedSet);
}

function runUnique(rule, entries, diagnostics, partition) {
  const rejectedSet = new Set();
  const groups = groupEntries(entries, rule.fields);
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const ordered = deterministicOrder(group, rule.orderBy);
    const keeper = ordered[0];
    diagnostics.addNode(keeper, 'related', rule.id, partition);
    for (const dup of ordered.slice(1)) {
      diagnostics.addNode(dup, 'violator', rule.id, partition);
      diagnostics.addEdge(dup, keeper, rule.id, 'duplicate');
      rejectedSet.add(dup);
    }
  }
  return split(entries, rejectedSet);
}

function runReference(rule, entries, diagnostics, partition, lookups) {
  const lookup = lookups.get(rule.lookup);
  if (!lookup) {
    throw new RuleDefinitionError(`rule '${rule.id}' references unknown lookup '${rule.lookup}'`);
  }
  const rejectedSet = new Set();
  for (const entry of entries) {
    const value = entry.record[rule.field];
    if ((value === null || value === undefined) && rule.optional) continue;
    if (!lookup.keys.has(value)) {
      diagnostics.addNode(entry, 'violator', rule.id, partition);
      rejectedSet.add(entry);
    }
  }
  return split(entries, rejectedSet);
}

function runMonotonic(rule, entries, diagnostics, partition) {
  const rejectedSet = new Set();
  const groups = rule.groupBy.length > 0
    ? groupEntries(entries, rule.groupBy)
    : new Map([['__all__', entries]]);
  for (const group of groups.values()) {
    const ordered = deterministicOrder(group, rule.orderBy);
    let extreme = null;
    for (const entry of ordered) {
      const value = entry.record[rule.field];
      if (extreme === null) {
        extreme = entry;
        continue;
      }
      const cmp = compareValues(value, extreme.record[rule.field]);
      const violates = rule.direction === 'asc' ? cmp < 0 : cmp > 0;
      if (violates) {
        diagnostics.addNode(entry, 'violator', rule.id, partition);
        diagnostics.addNode(extreme, 'related', rule.id, partition);
        diagnostics.addEdge(entry, extreme, rule.id, 'order');
        rejectedSet.add(entry);
      } else {
        const better = rule.direction === 'asc' ? cmp > 0 : cmp < 0;
        if (better) extreme = entry;
      }
    }
  }
  return split(entries, rejectedSet);
}

function runAggregate(rule, entries, diagnostics, partition) {
  const rejectedSet = new Set();
  const groups = rule.groupBy.length > 0
    ? groupEntries(entries, rule.groupBy)
    : new Map([['__all__', entries]]);
  for (const [key, group] of groups) {
    const ordered = deterministicOrder(group, null);
    const records = ordered.map((e) => e.record);
    const result = rule.check(records, key);
    let ok;
    let offenders;
    if (result === true || result === undefined) {
      ok = true;
      offenders = [];
    } else if (result === false || result === null) {
      ok = false;
      offenders = records;
    } else {
      ok = result.ok !== false;
      offenders = result.offenders || (ok ? [] : records);
    }
    if (ok) continue;
    const offenderSet = new Set(offenders);
    const representative = ordered[0];
    let representativeIsOffender = false;
    for (const entry of ordered) {
      if (offenderSet.has(entry.record)) {
        diagnostics.addNode(entry, 'violator', rule.id, partition);
        rejectedSet.add(entry);
        if (entry === representative) representativeIsOffender = true;
        else diagnostics.addEdge(entry, representative, rule.id, 'group');
      } else {
        diagnostics.addNode(entry, 'related', rule.id, partition);
      }
    }
    if (representativeIsOffender && ordered.length > 1) {
      diagnostics.addEdge(representative, ordered[1], rule.id, 'group');
    }
  }
  return split(entries, rejectedSet);
}

function runRule(rule, entries, context) {
  const { diagnostics, partition, lookups } = context;
  switch (rule.type) {
    case 'condition':
      return runCondition(rule, entries, diagnostics, partition);
    case 'unique':
      return runUnique(rule, entries, diagnostics, partition);
    case 'reference':
      return runReference(rule, entries, diagnostics, partition, lookups);
    case 'monotonic':
      return runMonotonic(rule, entries, diagnostics, partition);
    case 'aggregate':
      return runAggregate(rule, entries, diagnostics, partition);
    default:
      throw new RuleDefinitionError(`unsupported rule type '${rule.type}'`);
  }
}

module.exports = { runRule };
