'use strict';

const { RuleEngine } = require('./src/engine');
const errors = require('./src/errors');

module.exports = { RuleEngine, ...errors };
