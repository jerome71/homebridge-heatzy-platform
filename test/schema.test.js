'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const schema = require('../config.schema.json');
const pkg = require('../package.json');

test('Settings schema: name property, required is an object-level list', () => {
  const { properties, required } = schema.schema;
  assert.equal(properties.name.type, 'string');
  assert.deepEqual(required, ['username', 'password']);
  for (const [key, value] of Object.entries(properties)) {
    assert.notEqual(typeof value.required, 'boolean', `${key}: "required" must not be a boolean`);
  }
});

test('package.json declares the supported transport', () => {
  assert.ok(pkg.keywords.includes('supports-hap'));
  assert.ok(pkg.keywords.includes('homebridge-plugin'));
});
