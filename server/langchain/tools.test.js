import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentTools } from './tools.js';

test('createAgentTools exposes the expected tool names', () => {
  const tools = createAgentTools({
    runtimeState: {
      next_action: 'chat_continue',
      reason: '',
      confidence: 0.5,
      logs: [],
      kb_hits: []
    },
    deps: {
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      buildKbContextText: () => '',
      searchClinicalGuideline: async () => []
    }
  });

  assert.deepEqual(
    tools.map((item) => item.name).sort(),
    [
      'go_emergency_kit',
      'log_decision',
      'open_treehole',
      'recommend_micro_action',
      'retrieve_kb_snippets'
    ].sort()
  );
});

test('blocked tools still respect the existing policy whitelist', async () => {
  const runtimeState = {
    next_action: 'chat_continue',
    reason: '',
    confidence: 0.5,
    logs: [],
    kb_hits: [],
    toolAttempts: 0,
    toolViolations: 0,
    policy_audit: [],
    policy: {
      allowedTools: ['log_decision']
    }
  };

  const tools = createAgentTools({
    runtimeState,
    deps: {
      clamp: (value, min, max) => Math.max(min, Math.min(max, value)),
      buildKbContextText: () => '',
      isToolAllowed: (toolName, policy) => policy.allowedTools.includes(toolName),
      searchClinicalGuideline: async () => []
    }
  });

  const emergencyTool = tools.find((item) => item.name === 'go_emergency_kit');
  const result = await emergencyTool.invoke({
    reason: 'need help',
    confidence: 0.9,
    level: 'emergency'
  });

  assert.equal(result.ok, false);
  assert.equal(result.blocked, true);
  assert.equal(runtimeState.toolAttempts, 1);
  assert.equal(runtimeState.toolViolations, 1);
});
