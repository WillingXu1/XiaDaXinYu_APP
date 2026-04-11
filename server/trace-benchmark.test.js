import test from 'node:test';
import assert from 'node:assert/strict';

import { evaluateTraceDataset } from './trace-benchmark.js';

const mockDataset = {
  datasetVersion: 'trace-v1-test',
  traces: [
    {
      labels: {
        riskLevel: 'medium',
        baselineDiagnosisSeconds: 500,
        traceDiagnosisSeconds: 280,
        requestedAction: 'chat_continue',
        treatmentAction: 'micro_action',
        decisionTarget: 'micro_action',
        taskSuccessStrict: true,
        taskSuccessBusiness: true,
        baselineTaskSuccessStrict: false,
        baselineTaskSuccessBusiness: true,
        hallucinationDetected: false,
        baselineHallucinationDetected: false,
        allowedSafeFallback: ['chat_continue']
      },
      metadata: { scenarioDomain: 'study', challengeType: 'none', conversationTurns: 2 },
      events: [
        { ts: '2026-04-05T00:00:00.000Z', type: 'user_input', data: { message_length: 10 } },
        { ts: '2026-04-05T00:00:00.100Z', type: 'policy_decision', data: { risk_level: 'medium', allowed_tools: ['a'] } },
        { ts: '2026-04-05T00:00:00.200Z', type: 'llm_reasoning', data: { step: 0 } },
        { ts: '2026-04-05T00:00:00.300Z', type: 'tool_call', data: { success: true, blocked: false } },
        { ts: '2026-04-05T00:00:00.400Z', type: 'final_output', data: { next_action: 'micro_action', fallback_applied: true } }
      ]
    },
    {
      labels: {
        riskLevel: 'high',
        baselineDiagnosisSeconds: 620,
        traceDiagnosisSeconds: 360,
        requestedAction: 'chat_continue',
        treatmentAction: 'emergency',
        decisionTarget: 'emergency',
        taskSuccessStrict: false,
        taskSuccessBusiness: false,
        baselineTaskSuccessStrict: false,
        baselineTaskSuccessBusiness: false,
        hallucinationDetected: true,
        baselineHallucinationDetected: false,
        allowedSafeFallback: ['meditate']
      },
      metadata: { scenarioDomain: 'internship', challengeType: 'tool_timeout', conversationTurns: 3 },
      events: [
        { ts: '2026-04-05T00:00:00.000Z', type: 'user_input', data: { message_length: 20 } },
        { ts: '2026-04-05T00:00:00.100Z', type: 'policy_decision', data: { risk_level: 'high', allowed_tools: ['go_emergency_kit'] } },
        { ts: '2026-04-05T00:00:00.200Z', type: 'llm_reasoning', data: { step: 0 } },
        { ts: '2026-04-05T00:00:00.300Z', type: 'tool_call', data: { success: false, blocked: false } },
        { ts: '2026-04-05T00:00:00.350Z', type: 'exception', data: { where: 'tool_timeout' } },
        { ts: '2026-04-05T00:00:00.450Z', type: 'final_output', data: { next_action: 'emergency', fallback_applied: true } },
        { ts: '2026-04-05T00:00:00.470Z', type: 'hallucination_flag', data: { severity: 'high' } }
      ]
    }
  ]
};

test('evaluateTraceDataset computes observability metrics', () => {
  const result = evaluateTraceDataset(mockDataset, { baselineToolSuccessRate: 0.5 });

  assert.equal(result.datasetVersion, 'trace-v1-test');
  assert.equal(result.datasetSize, 2);
  assert.ok(result.metrics.taskSuccessRateBusiness >= result.metrics.taskSuccessRateStrict);
  assert.ok(result.metrics.toolCallAccuracy >= 0);
  assert.ok(result.metrics.decisionAccuracy >= 0);
  assert.ok(result.metrics.hallucinationRate >= 0);
  assert.ok(result.metrics.fallbackRate >= 0);
  assert.ok(result.metrics.avgStepsPerTask > 0);
  assert.ok(result.metrics.traceCompletenessRate > 0);
  assert.ok(result.metrics.replayabilityRate > 0);
  assert.ok(result.metrics.localizationEfficiencyUplift > 0);
  assert.ok(result.metrics.multiStepTaskSuccessRate >= 0);
  assert.ok(result.metrics.errorRecoveryRate >= 0);
  assert.ok(result.metrics.consistencyScore >= 0);
  assert.ok(result.metrics.repeatedDecisionRate >= 0);
  assert.ok(result.ablation.modes.full.taskSuccessRateBusiness >= result.ablation.modes.baseline.taskSuccessRateBusiness);
  assert.ok(typeof result.ablation.contribution.retryX === 'number');
  assert.equal(result.metrics.toolSuccessRate, 0.5);
});
