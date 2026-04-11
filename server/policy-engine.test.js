import test from 'node:test';
import assert from 'node:assert/strict';

import {
  evaluatePolicy,
  isToolAllowed,
  getFallbackAction,
  normalizeRiskLevel,
  normalizeAblationMode,
  isRetryableErrorType,
  getAdaptiveControlPolicy
} from './policy-engine.js';

test('normalizeRiskLevel normalizes unknown to low', () => {
  assert.equal(normalizeRiskLevel('bad-value'), 'low');
  assert.equal(normalizeRiskLevel('HIGH'), 'high');
});

test('evaluatePolicy marks high risk and blocks all tools except emergency and log', () => {
  const result = evaluatePolicy({
    message: '我真的崩溃了 不想活了',
    moodStats: { avgMood: 2.2, avgStress: 4.1, lowMoodStreak: 3 },
    actionStats: { weeklyCount: 0 },
    intent: 'support',
    step: 0
  });

  assert.equal(result.riskLevel, 'high');
  assert.deepEqual(result.allowedTools, ['go_emergency_kit', 'log_decision']);
  assert.equal(result.maxDepth, 2);
  assert.equal(result.fallbackMode, 'safe_emergency');
  assert.ok(result.riskSignals.length >= 1);
});

test('evaluatePolicy returns medium risk when anxiety is high', () => {
  const result = evaluatePolicy({
    message: '最近焦虑睡不着',
    moodStats: { avgMood: 3.0, avgStress: 3.8, lowMoodStreak: 1 },
    actionStats: { weeklyCount: 1 },
    intent: 'support',
    step: 0
  });

  assert.equal(result.riskLevel, 'medium');
  assert.equal(result.maxDepth, 4);
  assert.equal(result.fallbackMode, 'calm_then_route');
  assert.ok(result.allowedTools.includes('go_emergency_kit'));
});

test('isToolAllowed blocks disallowed tool by whitelist', () => {
  const policy = {
    riskLevel: 'high',
    allowedTools: ['go_emergency_kit', 'log_decision']
  };

  assert.equal(isToolAllowed('recommend_micro_action', policy), false);
  assert.equal(isToolAllowed('go_emergency_kit', policy), true);
});

test('getFallbackAction follows risk strategy matrix', () => {
  assert.equal(getFallbackAction({ riskLevel: 'high', requestedAction: 'treehole' }), 'emergency');
  assert.equal(getFallbackAction({ riskLevel: 'medium', requestedAction: 'chat_continue' }), 'chat_continue');
  assert.equal(getFallbackAction({ riskLevel: 'medium', requestedAction: 'treehole' }), 'treehole');
  assert.equal(getFallbackAction({ riskLevel: 'medium', requestedAction: 'micro_action' }), 'micro_action');
  assert.equal(getFallbackAction({ riskLevel: 'low', requestedAction: 'chat_continue' }), 'chat_continue');
});

test('normalizeAblationMode falls back to full for unknown values', () => {
  assert.equal(normalizeAblationMode('retry'), 'retry');
  assert.equal(normalizeAblationMode('bad-mode'), 'full');
});

test('isRetryableErrorType identifies retryable errors', () => {
  assert.equal(isRetryableErrorType('tool_timeout'), true);
  assert.equal(isRetryableErrorType('parse_error'), true);
  assert.equal(isRetryableErrorType('tool_not_allowed'), false);
});

test('getAdaptiveControlPolicy enables retry in retry ablation mode', () => {
  const policy = getAdaptiveControlPolicy({
    riskLevel: 'medium',
    ablationMode: 'retry',
    step: 1,
    maxDepth: 4,
    toolErrorType: 'tool_timeout',
    isMultiStep: true,
    isRecoveryAttempt: false
  });

  assert.equal(policy.retry_tool, true);
  assert.equal(policy.change_tool, false);
  assert.equal(policy.max_retry, 1);
});

test('getAdaptiveControlPolicy disables recovery actions in baseline mode', () => {
  const policy = getAdaptiveControlPolicy({
    riskLevel: 'low',
    ablationMode: 'baseline',
    step: 2,
    maxDepth: 6,
    toolErrorType: 'tool_timeout',
    isMultiStep: true,
    isRecoveryAttempt: true
  });

  assert.equal(policy.retry_tool, false);
  assert.equal(policy.change_tool, false);
  assert.equal(policy.use_fallback, false);
});

test('getAdaptiveControlPolicy keeps medium fallback off in full mode', () => {
  const policy = getAdaptiveControlPolicy({
    riskLevel: 'medium',
    ablationMode: 'full',
    step: 1,
    maxDepth: 4,
    toolErrorType: 'tool_timeout',
    isMultiStep: true,
    isRecoveryAttempt: true
  });

  assert.equal(policy.retry_tool, true);
  assert.equal(policy.change_tool, true);
  assert.equal(policy.use_fallback, false);
});

test('getAdaptiveControlPolicy enables full recovery controls for high risk', () => {
  const policy = getAdaptiveControlPolicy({
    riskLevel: 'high',
    ablationMode: 'full',
    step: 1,
    maxDepth: 2,
    toolErrorType: 'parse_error',
    isMultiStep: true,
    isRecoveryAttempt: true
  });

  assert.equal(policy.retry_tool, true);
  assert.equal(policy.change_tool, true);
  assert.equal(policy.use_fallback, true);
  assert.equal(policy.simplify_response, true);
  assert.equal(policy.max_retry, 2);
});
