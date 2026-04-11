import test from 'node:test';
import assert from 'node:assert/strict';
import { getFallbackAction } from '../policy-engine.js';

test('high risk final action is still enforced by policy layer after langgraph migration', () => {
  const enforced = getFallbackAction({
    riskLevel: 'high',
    requestedAction: 'treehole'
  });

  assert.equal(enforced, 'emergency');
});
