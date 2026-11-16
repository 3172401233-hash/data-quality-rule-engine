'use strict';

const { validateRule, topoSort } = require('./rules');
const { PartitionStore } = require('./partition');
const { DiagnosticGraph } = require('./diagnostics');
const { runRule } = require('./evaluators');
const { RuleDefinitionError, UnknownFieldError } = require('./errors');

const DEFAULT_BUDGET = 64 * 1024 * 1024;

class RuleEngine {
  constructor(options = {}) {
    const {
      schema = {},
      partitionBy = null,
      memoryBudgetBytes = DEFAULT_BUDGET,
      spillDir = null,
      allowSpill = true,
    } = options;
    this.schema = schema;
    this.schemaFields = new Set(Object.keys(schema));
    if (typeof partitionBy === 'string' && !this.schemaFields.has(partitionBy)) {
      throw new UnknownFieldError('<engine>', partitionBy);
    }
    if (partitionBy !== null && typeof partitionBy !== 'string' && typeof partitionBy !== 'function') {
      throw new RuleDefinitionError('partitionBy must be a field name or a function');
    }
    this.partitionBy = partitionBy;
    this.memoryBudgetBytes = memoryBudgetBytes;
    this.spillDir = spillDir;
    this.allowSpill = allowSpill;
    this.rules = new Map();
    this.lookups = new Map();
  }

  addRule(rule) {
    const normalized = validateRule(rule, this.schemaFields, new Set(this.rules.keys()));
    this.rules.set(normalized.id, normalized);
    topoSort([...this.rules.values()], { allowMissing: true });
    return this;
  }

  addLookup(name, records, keyField) {
    if (typeof name !== 'string' || name.length === 0) {
      throw new RuleDefinitionError('lookup requires a non-empty name');
    }
    if (typeof keyField !== 'string' || keyField.length === 0) {
      throw new RuleDefinitionError(`lookup '${name}' requires a keyField`);
    }
    if (this.lookups.has(name)) {
      throw new RuleDefinitionError(`duplicate lookup declaration: '${name}'`);
    }
    const keys = new Set();
    for (const record of records || []) {
      keys.add(record[keyField]);
    }
    this.lookups.set(name, { keys, keyField });
    return this;
  }

  partitionOf(record, rid) {
    if (this.partitionBy === null) return '__default__';
    if (typeof this.partitionBy === 'function') {
      const value = this.partitionBy(record, rid);
      return String(value === undefined ? '__default__' : value);
    }
    const value = record[this.partitionBy];
    return String(value === undefined ? '__default__' : value);
  }

  evaluate(records) {
    const orderedRules = topoSort([...this.rules.values()]);
    const store = new PartitionStore({
      budgetBytes: this.memoryBudgetBytes,
      spillDir: this.spillDir,
      allowSpill: this.allowSpill,
    });
    const diagnostics = new DiagnosticGraph();
    const accepted = [];
    const rejected = [];
    try {
      (records || []).forEach((record, rid) => {
        store.add(this.partitionOf(record, rid), { rid, record });
      });
      const partitionKeys = store.partitionKeys();
      for (const partition of partitionKeys) {
        let working = store.load(partition);
        for (const rule of orderedRules) {
          const outcome = runRule(rule, working, {
            diagnostics,
            partition,
            lookups: this.lookups,
          });
          working = outcome.remaining;
          for (const entry of outcome.rejected) {
            rejected.push({ record: entry.record, rule: rule.id, partition });
          }
        }
        for (const entry of working) accepted.push(entry.record);
      }
      return {
        accepted,
        rejected,
        diagnostics: diagnostics.toJSON(),
        stats: {
          records: (records || []).length,
          partitions: partitionKeys.length,
          accepted: accepted.length,
          rejected: rejected.length,
          spilledPartitions: store.spilledCount,
          peakBufferedBytes: store.peakBytes,
        },
      };
    } finally {
      store.cleanup();
    }
  }
}

module.exports = { RuleEngine };
