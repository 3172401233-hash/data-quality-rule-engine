'use strict';

class DiagnosticGraph {
  constructor() {
    this.nodes = new Map();
    this.edges = [];
    this.edgeKeys = new Set();
  }

  addNode(entry, role, ruleId, partition) {
    const id = `r${entry.rid}`;
    let node = this.nodes.get(id);
    if (!node) {
      node = {
        id,
        key: entry.record && entry.record.id !== undefined ? entry.record.id : null,
        partition,
        role,
        rules: [],
      };
      this.nodes.set(id, node);
    }
    if (role === 'violator') node.role = 'violator';
    if (!node.rules.includes(ruleId)) node.rules.push(ruleId);
    return node;
  }

  addEdge(fromEntry, toEntry, ruleId, kind) {
    const from = `r${fromEntry.rid}`;
    const to = `r${toEntry.rid}`;
    if (from === to) return;
    const key = `${from}|${to}|${ruleId}|${kind}`;
    if (this.edgeKeys.has(key)) return;
    this.edgeKeys.add(key);
    this.edges.push({
      from,
      to,
      fromKey: fromEntry.record && fromEntry.record.id !== undefined ? fromEntry.record.id : null,
      toKey: toEntry.record && toEntry.record.id !== undefined ? toEntry.record.id : null,
      rule: ruleId,
      kind,
    });
  }

  toJSON() {
    const nodes = [...this.nodes.values()]
      .map((n) => ({ ...n, rules: [...n.rules].sort() }))
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    const edges = [...this.edges].sort((a, b) => {
      const ka = `${a.from}|${a.to}|${a.rule}|${a.kind}`;
      const kb = `${b.from}|${b.to}|${b.rule}|${b.kind}`;
      return ka < kb ? -1 : ka > kb ? 1 : 0;
    });
    return { nodes, edges };
  }
}

module.exports = { DiagnosticGraph };
