'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { BudgetExceededError } = require('./errors');
const { estimateSize } = require('./util');

class PartitionStore {
  constructor({ budgetBytes, spillDir = null, allowSpill = true }) {
    if (!(typeof budgetBytes === 'number' && budgetBytes > 0)) {
      throw new BudgetExceededError(`memory budget must be a positive number of bytes, got ${budgetBytes}`);
    }
    this.budgetBytes = budgetBytes;
    this.allowSpill = allowSpill;
    this.ownDir = false;
    this.dir = null;
    if (allowSpill) {
      if (spillDir) {
        fs.mkdirSync(spillDir, { recursive: true });
        this.dir = spillDir;
      } else {
        this.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dq-spill-'));
        this.ownDir = true;
      }
    }
    this.parts = new Map();
    this.totalBytes = 0;
    this.peakBytes = 0;
    this.spilledCount = 0;
    this.seq = 0;
    this.files = [];
  }

  add(partitionKey, entry) {
    let part = this.parts.get(partitionKey);
    if (!part) {
      part = { entries: [], bytes: 0, file: null };
      this.parts.set(partitionKey, part);
    }
    if (part.file) {
      fs.appendFileSync(part.file, JSON.stringify(entry) + '\n');
      return;
    }
    const size = estimateSize(entry.record);
    part.entries.push(entry);
    part.bytes += size;
    this.totalBytes += size;
    if (this.totalBytes > this.peakBytes) this.peakBytes = this.totalBytes;
    this.enforceBudget();
  }

  enforceBudget() {
    if (this.totalBytes <= this.budgetBytes) return;
    if (!this.allowSpill) {
      throw new BudgetExceededError(
        `memory budget of ${this.budgetBytes} bytes exceeded (${this.totalBytes} bytes buffered) and spilling is disabled`,
      );
    }
    const candidates = [...this.parts.entries()]
      .filter(([, p]) => p.entries && p.entries.length > 0)
      .sort((a, b) => b[1].bytes - a[1].bytes);
    for (const [key, part] of candidates) {
      if (this.totalBytes <= this.budgetBytes) break;
      this.spill(key, part);
    }
    if (this.totalBytes > this.budgetBytes) {
      throw new BudgetExceededError(
        `memory budget of ${this.budgetBytes} bytes exceeded and no in-memory partition remains to spill`,
      );
    }
  }

  spill(partitionKey, part) {
    const file = path.join(this.dir, `partition-${this.seq++}.ndjson`);
    const body = part.entries.map((e) => JSON.stringify(e)).join('\n') + '\n';
    fs.writeFileSync(file, body);
    this.files.push(file);
    part.entries = null;
    part.file = file;
    this.totalBytes -= part.bytes;
    part.bytes = 0;
    this.spilledCount += 1;
  }

  partitionKeys() {
    return [...this.parts.keys()].sort();
  }

  load(partitionKey) {
    const part = this.parts.get(partitionKey);
    if (!part) return [];
    if (!part.file) return part.entries;
    const text = fs.readFileSync(part.file, 'utf8');
    return text
      .split('\n')
      .filter((line) => line.length > 0)
      .map((line) => JSON.parse(line));
  }

  cleanup() {
    if (this.ownDir && this.dir) {
      fs.rmSync(this.dir, { recursive: true, force: true });
      this.dir = null;
      return;
    }
    for (const file of this.files) {
      try {
        fs.unlinkSync(file);
      } catch {
        // already gone
      }
    }
    this.files = [];
  }
}

module.exports = { PartitionStore };
