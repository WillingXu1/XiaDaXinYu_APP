import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentModel } from './model.js';

test('createAgentModel returns a configured chat model', () => {
  const model = createAgentModel({
    apiKey: 'test-key',
    modelName: 'deepseek-chat',
    temperature: 0.5
  });

  assert.ok(model);
  assert.equal(typeof model.invoke, 'function');
});
