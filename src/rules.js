'use strict';

const {
  RuleDefinitionError,
  DuplicateRuleError,
  UnknownFieldError,
  RuleCycleError,
} = require('./errors');

const RULE_TYPES = new Set(['condition', 'unique', 'reference', 'monotonic', 'aggregate']);

function requireFieldList(rule, prop, { optional = false } = {}) {
  const value = rule[prop];
  if (value === undefined || value === null) {
    if (optional) return [];
    throw new RuleDefinitionError(`rule '${rule.id}' (${rule.type}) requires '${prop}'`);
  }
  const list = Array.isArray(value) ? value : [value];
  if (list.length === 0 && !optional) {
    throw new RuleDefinitionError(`rule '${rule.id}' (${rule.type}) requires a non-empty '${prop}'`);
  }
  for (const f of list) {
    if (typeof f !== 'string' || f.length === 0) {
      throw new RuleDefinitionError(`rule '${rule.id}' (${rule.type}) has an invalid field name in '${prop}'`);
    }
  }
  return list;
}

function validateRule(rule, schemaFields, existingIds) {
  if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
    throw new RuleDefinitionError('rule must be a plain object');
  }
  if (typeof rule.id !== 'string' || rule.id.length === 0) {
    throw new RuleDefinitionError('rule requires a non-empty string id');
  }
  if (existingIds.has(rule.id)) {
    throw new DuplicateRuleError(rule.id);
  }
  if (!RULE_TYPES.has(rule.type)) {
    throw new RuleDefinitionError(
      `rule '${rule.id}' has unknown type '${rule.type}'; expected one of ${[...RULE_TYPES].join(', ')}`,
    );
  }

  const checkField = (field) => {
    if (!schemaFields.has(field)) throw new UnknownFieldError(rule.id, field);
  };
  const checkFields = (fields) => fields.forEach(checkField);

  const normalized = {
    id: rule.id,
    type: rule.type,
    dependsOn: requireFieldList(rule, 'dependsOn', { optional: true }),
  };

  switch (rule.type) {
    case 'condition': {
      if (typeof rule.expect !== 'function') {
        throw new RuleDefinitionError(`rule '${rule.id}' (condition) requires an 'expect' function`);
      }
      if (rule.when !== undefined && typeof rule.when !== 'function') {
        throw new RuleDefinitionError(`rule '${rule.id}' (condition) 'when' must be a function`);
      }
      normalized.expect = rule.expect;
      normalized.when = rule.when || null;
      checkFields(requireFieldList(rule, 'uses', { optional: true }));
      break;
    }
    case 'unique': {
      normalized.fields = requireFieldList(rule, 'fields');
      checkFields(normalized.fields);
      normalized.orderBy = rule.orderBy || null;
      if (normalized.orderBy) checkField(normalized.orderBy);
      break;
    }
    case 'reference': {
      normalized.field = requireFieldList(rule, 'field')[0];
      checkField(normalized.field);
      if (typeof rule.lookup !== 'string' || rule.lookup.length === 0) {
        throw new RuleDefinitionError(`rule '${rule.id}' (reference) requires a 'lookup' name`);
      }
      normalized.lookup = rule.lookup;
      normalized.optional = rule.optional === true;
      break;
    }
    case 'monotonic': {
      normalized.groupBy = requireFieldList(rule, 'groupBy', { optional: true });
      checkFields(normalized.groupBy);
      normalized.orderBy = requireFieldList(rule, 'orderBy')[0];
      checkField(normalized.orderBy);
      normalized.field = requireFieldList(rule, 'field')[0];
      checkField(normalized.field);
      const direction = rule.direction || 'asc';
      if (direction !== 'asc' && direction !== 'desc') {
        throw new RuleDefinitionError(`rule '${rule.id}' (monotonic) direction must be 'asc' or 'desc'`);
      }
      normalized.direction = direction;
      break;
    }
    case 'aggregate': {
      if (typeof rule.check !== 'function') {
        throw new RuleDefinitionError(`rule '${rule.id}' (aggregate) requires a 'check' function`);
      }
      normalized.check = rule.check;
      normalized.groupBy = requireFieldList(rule, 'groupBy', { optional: true });
      checkFields(normalized.groupBy);
      break;
    }
    default:
      throw new RuleDefinitionError(`rule '${rule.id}' has unsupported type '${rule.type}'`);
  }
  return normalized;
}

function topoSort(rules, { allowMissing = false } = {}) {
  const byId = new Map(rules.map((r) => [r.id, r]));
  for (const rule of rules) {
    for (const dep of rule.dependsOn) {
      if (!byId.has(dep) && !allowMissing) {
        throw new RuleDefinitionError(`rule '${rule.id}' depends on unknown rule '${dep}'`);
      }
    }
  }
  const state = new Map();
  const ordered = [];
  const stack = [];

  const visit = (id) => {
    const mark = state.get(id);
    if (mark === 'done') return;
    if (mark === 'visiting') {
      const start = stack.indexOf(id);
      throw new RuleCycleError([...stack.slice(start), id]);
    }
    state.set(id, 'visiting');
    stack.push(id);
    for (const dep of byId.get(id).dependsOn) {
      if (byId.has(dep)) visit(dep);
    }
    stack.pop();
    state.set(id, 'done');
    ordered.push(byId.get(id));
  };

  for (const rule of rules) visit(rule.id);
  return ordered;
}

module.exports = { validateRule, topoSort, RULE_TYPES };
