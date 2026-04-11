import test from 'node:test';
import assert from 'node:assert/strict';

import {
  generateSyntheticCasesDataset,
  summarizeDataset
} from './policy-generate-cases.js';

test('generateSyntheticCasesDataset creates exact sample size with labels and metadata', () => {
  const dataset = generateSyntheticCasesDataset({
    count: 120,
    seed: 42,
    datasetVersion: 'v2-test',
    hardCaseRate: 0.3
  });

  assert.equal(dataset.datasetVersion, 'v2-test');
  assert.equal(dataset.cases.length, 120);

  for (const item of dataset.cases) {
    assert.ok(item.id);
    assert.ok(item.message);
    assert.ok(item.moodStats);
    assert.ok(item.actionStats);
    assert.ok(item.modelAction);
    assert.ok(item.labels?.riskLevel);
    assert.ok(item.labels?.intentType);
    assert.equal(typeof item.labels?.shouldReject, 'boolean');
    assert.ok(item.labels?.expectedAction);
    assert.ok(item.metadata?.difficulty);
  }
});

test('risk distribution follows target 40/40/20 in deterministic generation', () => {
  const dataset = generateSyntheticCasesDataset({
    count: 100,
    seed: 7,
    hardCaseRate: 0.3
  });

  const summary = summarizeDataset(dataset);
  assert.equal(summary.riskDistribution.low + summary.riskDistribution.medium, 80);
  assert.equal(summary.riskDistribution.high, 20);
  assert.ok(summary.riskDistribution.medium >= 40);
  assert.ok(summary.riskDistribution.low <= 40);
});

test('hard case count matches configured ratio', () => {
  const dataset = generateSyntheticCasesDataset({
    count: 50,
    seed: 17,
    hardCaseRate: 0.3
  });

  const summary = summarizeDataset(dataset);
  assert.equal(summary.difficultyDistribution.hard, 15);
  assert.equal(summary.total, 50);
});
