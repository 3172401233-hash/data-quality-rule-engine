'use strict';

class RuleDefinitionError extends Error {
  constructor(message) {
    super(message);
    this.name = 'RuleDefinitionError';
  }
}

class DuplicateRuleError extends RuleDefinitionError {
  constructor(ruleId) {
    super(`duplicate rule declaration: '${ruleId}'`);
    this.name = 'DuplicateRuleError';
    this.ruleId = ruleId;
  }
}

class UnknownFieldError extends RuleDefinitionError {
  constructor(ruleId, field) {
    super(`rule '${ruleId}' references unknown field '${field}'`);
    this.name = 'UnknownFieldError';
    this.ruleId = ruleId;
    this.field = field;
  }
}

class RuleCycleError extends RuleDefinitionError {
  constructor(cycle) {
    super(`rule dependency cycle detected: ${cycle.join(' -> ')}`);
    this.name = 'RuleCycleError';
    this.cycle = cycle;
  }
}

class BudgetExceededError extends Error {
  constructor(message) {
    super(message);
    this.name = 'BudgetExceededError';
  }
}

module.exports = {
  RuleDefinitionError,
  DuplicateRuleError,
  UnknownFieldError,
  RuleCycleError,
  BudgetExceededError,
};
