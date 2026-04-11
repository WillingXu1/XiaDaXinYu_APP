import test from 'node:test';
import assert from 'node:assert/strict';

import {
  buildChatPayload,
  buildReplayRow,
  buildReplayMetrics,
  collectToolStatsFromTrace,
  normalizeTraceCases
} from './trace-replay-benchmark.js';

test('normalizeTraceCases supports traces and cases input keys', () => {
  const fromTraces = normalizeTraceCases({ traces: [{ id: 'a' }] });
  const fromCases = normalizeTraceCases({ cases: [{ id: 'b' }] });

  assert.equal(fromTraces.length, 1);
  assert.equal(fromCases.length, 1);
  assert.equal(fromTraces[0].id, 'a');
  assert.equal(fromCases[0].id, 'b');
});

test('collectToolStatsFromTrace counts attempts and successes', () => {
  const trace = {
    events: [
      { type: 'tool_call', data: { success: true, blocked: false } },
      { type: 'tool_call', data: { success: false, blocked: false } },
      { type: 'tool_call', data: { success: true, blocked: true } },
      { type: 'llm_reasoning', data: {} }
    ]
  };

  const stats = collectToolStatsFromTrace(trace);

  assert.deepEqual(stats, {
    attempts: 3,
    successful: 2,
    correct: 1
  });
});

test('buildChatPayload supports root-level trace message schema', () => {
  const payload = buildChatPayload({
    message: 'hello',
    moodStats: { avgMood: 2.5, avgStress: 4.2 }
  });

  assert.equal(payload.message, 'hello');
  assert.equal(Array.isArray(payload.mood_data), true);
  assert.equal(payload.mood_data.length, 1);
  assert.equal(payload.completed_actions.length, 0);
});

test('buildReplayMetrics aggregates policy, harness and side-effect metrics', () => {
  const metrics = buildReplayMetrics({
    baselineToolSuccessRate: 0.72,
    attemptedRows: 2,
    rows: [
      {
        riskLevel: 'high',
        expectedAction: 'emergency',
        requestedAction: 'chat_continue',
        treatmentAction: 'emergency',
        baselineTaskSuccessStrict: false,
        baselineTaskSuccessBusiness: false,
        taskSuccessStrict: true,
        taskSuccessBusiness: true,
        baselineHallucination: false,
        hallucination: false,
        baselineFallback: false,
        fallback: true,
        baselineSteps: 4,
        steps: 2,
        stepsObserved: true,
        baselineLatencyMs: 1200,
        latencyMs: 700,
        latencyObserved: true,
        baselineTokenCost: 1300,
        tokenCost: 900,
        tokenObserved: true,
        baselineConsistencyOk: false,
        consistencyOk: true,
        baselineRepeatedDecision: true,
        repeatedDecision: false,
        toolAttempts: 2,
        toolSuccessful: 2,
        toolCorrect: 2,
        toolObserved: true,
        retryableFailure: true,
        challengeType: 'tool_timeout'
      },
      {
        riskLevel: 'low',
        expectedAction: 'micro_action',
        requestedAction: 'micro_action',
        treatmentAction: 'chat_continue',
        baselineTaskSuccessStrict: true,
        baselineTaskSuccessBusiness: true,
        taskSuccessStrict: false,
        taskSuccessBusiness: false,
        baselineHallucination: false,
        hallucination: true,
        baselineFallback: false,
        fallback: false,
        baselineSteps: 3,
        steps: 4,
        stepsObserved: true,
        baselineLatencyMs: 900,
        latencyMs: 1300,
        latencyObserved: true,
        baselineTokenCost: 800,
        tokenCost: 1000,
        tokenObserved: true,
        baselineConsistencyOk: true,
        consistencyOk: false,
        baselineRepeatedDecision: false,
        repeatedDecision: true,
        toolAttempts: 1,
        toolSuccessful: 0,
        toolCorrect: 0,
        toolObserved: true,
        retryableFailure: false,
        challengeType: 'none'
      }
    ]
  });

  assert.equal(metrics.taskSuccessRateStrict, 0.5);
  assert.equal(metrics.taskSuccessRateBusiness, 0.5);
  assert.equal(metrics.decisionAccuracy, 0.5);
  assert.equal(metrics.fallbackRate, 0.5);
  assert.equal(metrics.avgStepsPerTask, 3);
  assert.equal(metrics.toolCallAccuracy, 0.6667);
  assert.equal(metrics.toolSuccessRate, 0.6667);
  assert.equal(metrics.avgLatencyMs, 1000);
  assert.equal(metrics.avgTokenCost, 950);
  assert.equal(metrics.consistencyScore, 0.5);
  assert.equal(metrics.repeatedDecisionRate, 0.5);
  assert.equal(metrics.baseline.taskSuccessRateBusiness, 0.5);
  assert.equal(metrics.observability.requestSuccessCoverage, 1);
  assert.equal(metrics.observability.toolObservableCoverage, 1);
  assert.equal(metrics.observability.tokenObservableCoverage, 1);
  assert.ok(typeof metrics.ablation.contribution.retryX === 'number');
  assert.ok(typeof metrics.ablation.contribution.changeToolX === 'number');
  assert.ok(typeof metrics.ablation.contribution.policyX === 'number');
});

test('buildReplayRow derives strict and business success from replay output instead of source labels', () => {
  const row = buildReplayRow({
    trace: {
      id: 'case-1',
      labels: {
        riskLevel: 'medium',
        decisionTarget: 'micro_action',
        expectedAction: 'micro_action',
        requestedAction: 'chat_continue',
        allowedSafeFallback: ['chat_continue'],
        baselineTaskSuccessStrict: false,
        baselineTaskSuccessBusiness: false,
        taskSuccessStrict: false,
        taskSuccessBusiness: false,
        baselineHallucinationDetected: false,
        hallucinationDetected: true,
        baselineFallbackRate: 0,
        retryableFailure: false
      },
      metadata: {
        challengeType: 'tool_timeout'
      }
    },
    response: {
      trace_id: 'trace-1',
      next_action: 'chat_continue',
      side_effects: {
        latency_ms: 900,
        avg_steps_per_task: 1,
        token_cost: { total: 400 }
      },
      session_state: {
        consistency_ok: true,
        repeated_decision_turn: false
      },
      policy_audit: []
    },
    traceData: {
      trace_id: 'trace-1',
      events: [
        { type: 'tool_call', data: { success: false, blocked: false, error: 'tool_timeout' } },
        { type: 'adaptive_control', data: { error_type: 'tool_timeout' } },
        { type: 'final_output', data: { next_action: 'chat_continue', forced_fallback: false } }
      ]
    }
  });

  assert.equal(row.traceId, 'trace-1');
  assert.deepEqual(row.allowedSafeFallback, ['chat_continue']);
  assert.equal(row.taskSuccessStrictObserved, false);
  assert.equal(row.taskSuccessBusinessObserved, true);
  assert.equal(row.retryableFailureObserved, true);
  assert.equal(row.taskSuccessStrictFromLabel, false);
  assert.equal(row.taskSuccessBusinessFromLabel, false);
  assert.equal(row.retryableFailureFromLabel, false);
});
