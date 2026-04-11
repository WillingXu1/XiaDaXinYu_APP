import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateSyntheticTraceDataset,
  summarizeTraceDataset
} from './trace-generate-cases.js';

test('generateSyntheticTraceDataset creates requested size and event chains', () => {
  const dataset = generateSyntheticTraceDataset({
    count: 120,
    seed: 123,
    datasetVersion: 'trace-test',
    anomalyRate: 0.2,
    completenessDropRate: 0.05
  });

  assert.equal(dataset.datasetVersion, 'trace-test');
  assert.equal(dataset.traces.length, 120);

  for (const item of dataset.traces) {
    assert.ok(item.trace_id);
    assert.ok(item.session_id);
    assert.equal(typeof item.turn_index, 'number');
    assert.ok(item.request_id);
    assert.ok(item.message);
    assert.ok(item.labels?.riskLevel);
    assert.ok(item.labels?.decisionTarget);
    assert.ok(item.labels?.requestedAction);
    assert.ok(item.labels?.treatmentAction);
    assert.ok(item.studentProfile?.demographics?.grade);
    assert.ok(item.studentProfile?.privacy?.piiMasked);
    assert.ok(item.psychoSocialState?.stressors?.academic?.length >= 1);
    assert.ok(item.supportNetwork?.socialSupport);
    assert.ok(item.behaviorPattern?.cognitiveBias?.length >= 1);
    assert.ok(item.labels?.populationTags?.seasonalPhase);
    assert.equal(typeof item.labels?.isMultiStep, 'boolean');
    assert.equal(typeof item.labels?.baselineConsistencyOk, 'boolean');
    assert.equal(typeof item.labels?.treatmentConsistencyOk, 'boolean');
    assert.equal(typeof item.labels?.baselineRepeatedDecisionTurn, 'boolean');
    assert.equal(typeof item.labels?.treatmentRepeatedDecisionTurn, 'boolean');
    assert.equal(typeof item.labels?.originallyFailed, 'boolean');
    assert.equal(typeof item.labels?.recoverySuccess, 'boolean');
    assert.ok(item.labels?.treatmentLatencyMs >= 0);
    assert.ok(item.labels?.treatmentTokenCost >= 0);
    assert.equal(typeof item.labels?.taskSuccessStrict, 'boolean');
    assert.equal(typeof item.labels?.taskSuccessBusiness, 'boolean');
    assert.ok(!item.labels.taskSuccessStrict || item.labels.taskSuccessBusiness);
    assert.ok(item.metadata?.scenarioDomain);
    assert.ok(Array.isArray(item.events));
    assert.ok(item.events.length >= 3);
  }
});

test('summarizeTraceDataset returns distributions and averages', () => {
  const dataset = generateSyntheticTraceDataset({ count: 100, seed: 7 });
  const summary = summarizeTraceDataset(dataset);

  assert.equal(summary.total, 100);
  assert.equal(summary.riskDistribution.low + summary.riskDistribution.medium + summary.riskDistribution.high, 100);
  assert.ok(summary.avgEvents > 0);
  assert.ok(summary.avgComplexityScore >= 1);
  assert.ok(summary.taskSuccessBusinessRate >= summary.taskSuccessStrictRate);
  assert.ok(summary.fallbackRate >= 0);
  assert.ok(summary.hallucinationRate >= 0);
  assert.ok(Object.keys(summary.domainDistribution).length >= 1);
});
