# data-quality-rule-engine

JavaScript 数据质量规则引擎：在入库前对记录做唯一键、引用完整性、时间单调性、条件与跨行聚合约束检查，支持分区评估、内存预算内溢写、坏记录隔离与规则依赖。

## 快速开始

```js
const { RuleEngine } = require('./');

const engine = new RuleEngine({
  schema: { id: 'string', orderId: 'string', status: 'string', amount: 'number', ts: 'number', seq: 'number', tenant: 'string' },
  partitionBy: 'tenant',        // 字段名或 (record) => key
  memoryBudgetBytes: 64 * 1024 * 1024,
  allowSpill: true,
});

engine.addLookup('orders', orderRows, 'id');

engine.addRule({ id: 'positive', type: 'condition', expect: (r) => r.amount > 0 });
engine.addRule({ id: 'order-exists', type: 'reference', field: 'orderId', lookup: 'orders', dependsOn: ['positive'] });
engine.addRule({ id: 'uniq-id', type: 'unique', fields: ['id'], dependsOn: ['order-exists'] });
engine.addRule({ id: 'ts-monotonic', type: 'monotonic', groupBy: ['orderId'], orderBy: 'seq', field: 'ts', dependsOn: ['uniq-id'] });
engine.addRule({
  id: 'one-success',
  type: 'aggregate',
  groupBy: ['orderId'],
  dependsOn: ['ts-monotonic'],
  check: (records) => {
    const ok = records.filter((r) => r.status === 'success');
    return ok.length <= 1 || { ok: false, offenders: ok.slice(1) };
  },
});

const { accepted, rejected, diagnostics, stats } = engine.evaluate(payments);
```

## 规则类型

- `condition`：单行谓词。`expect(record)` 必须返回真；可选 `when(record)` 做前置过滤；可选 `uses: [...]` 声明用到的字段以参与校验。
- `unique`：`fields` 组合在分区内唯一。重复组中按 `orderBy`（缺省为记录的确定性序列化）保留一条，其余判为违规，违规者与保留者之间建立 `duplicate` 边。
- `reference`：`field` 的值必须存在于 `addLookup(name, rows, keyField)` 注册的键集合中；`optional: true` 允许空值。孤儿引用会被拒绝并进入诊断图。
- `monotonic`：在 `groupBy` 组内按 `orderBy` 排序后，`field` 必须单调（`direction: 'asc' | 'desc'`）。破坏单调性的记录与其参照记录之间建立 `order` 边。
- `aggregate`：跨行规则。`check(records, groupKey)` 接收同组全部记录（顺序确定，与到达顺序无关），返回 `true`/`false`，或 `{ ok, offenders }` 指明违规子集——例如“一个订单只能有一笔成功支付”。

## 规则定义校验

- 同一 `id` 重复声明抛出 `DuplicateRuleError`。
- 规则引用了 `schema` 中不存在的字段抛出 `UnknownFieldError`（含 `partitionBy`、`groupBy`、`orderBy`、`uses`）。
- `dependsOn` 构成环时抛出 `RuleCycleError`，错误信息包含环路径；`dependsOn` 指向不存在的规则在求值时抛出 `RuleDefinitionError`（允许前向引用，便于按任意顺序声明）。

## 内存预算与溢写

评估前，记录按分区键进入 `PartitionStore` 缓冲，并按序列化大小估算占用。缓冲总量超过 `memoryBudgetBytes` 时，最大的内存分区以 NDJSON 溢写到 `spillDir`（缺省为系统临时目录，求值结束自动清理）；之后该分区的记录直接追加到溢写文件。`allowSpill: false` 或预算非正数时超限抛出 `BudgetExceededError`。溢写只改变驻留策略，不改变评估结果。

## 隔离语义

- 规则按 `dependsOn` 拓扑序逐条执行；记录一旦在某条规则上失败，立即被隔离（quarantine），从后续所有规则的输入中移除。因此依赖规则只看到通过了上游规则的记录，不会对同一条坏记录重复报错。
- 被隔离的记录进入 `rejected`（含触发规则与分区），绝不出现在 `accepted` 中；`accepted` 与 `rejected` 不相交且覆盖全部输入。
- 跨行规则（`unique` / `monotonic` / `aggregate`）只作用于同一分区内的记录，分区之间互不影响。

## 诊断图

失败不只输出计数。`diagnostics` 是一张图：

- `nodes`：每条涉及违规的记录一个节点，`role` 为 `violator`（违规者）或 `related`（关联记录，如重复组中的保留者、单调性参照点、聚合组内其他成员），并标注涉及规则。
- `edges`：`{ from, to, rule, kind }`，`kind` 为 `duplicate` / `order` / `group`，把违规记录与其上下文连接起来，便于下游回放现场。

## 重放语义

- 评估是 `(rules, lookups, records)` 的纯函数：分组键、平局裁决（`orderBy` 后接记录的稳定序列化）与聚合输入顺序全部确定，因此**记录到达顺序不影响结果**——乱序重放同一批数据得到相同的拒绝集合与诊断图。
- 溢写对结果透明：同一输入在纯内存与溢写两种路径下产出完全一致。
- 相同输入重复求值（重放）产生字节级一致的诊断输出；诊断中的节点与边在输出前按确定顺序排序。

## 测试

```sh
node --test
```

覆盖跨行约束、空分区、孤儿引用、规则依赖（隔离顺序、环、未知依赖、重复声明、未知字段）、预算不足与溢写等价性、记录顺序变化与重放确定性。
