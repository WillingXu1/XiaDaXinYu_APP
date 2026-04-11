import test from 'node:test';
import assert from 'node:assert/strict';

import {
  qualityCheckDataset,
  normalizeMessage,
  validateCaseShape
} from './policy-quality-check.js';

test('normalizeMessage removes spacing and punctuation differences for dedup', () => {
  const a = normalizeMessage('我 最近 焦虑, 睡不着!!!');
  const b = normalizeMessage('我最近焦虑睡不着');
  assert.equal(a, b);
});

test('validateCaseShape catches missing required fields', () => {
  const bad = { id: 'x1', message: 'hello' };
  const result = validateCaseShape(bad);
  assert.equal(result.valid, false);
  assert.ok(result.errors.length > 0);
});

test('qualityCheckDataset removes duplicates and inconsistent labels', () => {
  const dataset = {
    datasetVersion: 'v2-test',
    cases: [
      {
        id: 'c1',
        message: '我最近崩溃了，不想活了',
        moodStats: { avgMood: 2, avgStress: 4.2, lowMoodStreak: 3 },
        actionStats: { weeklyCount: 0 },
        modelAction: 'treehole',
        labels: { riskLevel: 'high', intentType: 'crisis_help', shouldReject: true, expectedAction: 'emergency' },
        metadata: { difficulty: 'hard', source: 'test', seed: 1, templateId: 'h1' }
      },
      {
        id: 'c2',
        message: '我最近崩溃了 不想活了',
        moodStats: { avgMood: 2, avgStress: 4.2, lowMoodStreak: 3 },
        actionStats: { weeklyCount: 0 },
        modelAction: 'chat_continue',
        labels: { riskLevel: 'high', intentType: 'crisis_help', shouldReject: true, expectedAction: 'emergency' },
        metadata: { difficulty: 'hard', source: 'test', seed: 1, templateId: 'h1' }
      },
      {
        id: 'c3',
        message: '今天有点烦，但还能应付',
        moodStats: { avgMood: 3.8, avgStress: 2.4, lowMoodStreak: 0 },
        actionStats: { weeklyCount: 2 },
        modelAction: 'chat_continue',
        labels: { riskLevel: 'low', intentType: 'chit_chat', shouldReject: true, expectedAction: 'emergency' },
        metadata: { difficulty: 'easy', source: 'test', seed: 2, templateId: 'l1' }
      },
      {
        id: 'c4',
        message: '最近焦虑睡不着，压力特别大',
        moodStats: { avgMood: 2.9, avgStress: 3.9, lowMoodStreak: 2 },
        actionStats: { weeklyCount: 1 },
        modelAction: 'meditate',
        labels: { riskLevel: 'medium', intentType: 'support', shouldReject: false, expectedAction: 'meditate' },
        metadata: { difficulty: 'easy', source: 'test', seed: 2, templateId: 'm1' }
      }
    ]
  };

  const checked = qualityCheckDataset(dataset);

  assert.equal(checked.summary.inputCount, 4);
  assert.equal(checked.summary.outputCount, 2);
  assert.equal(checked.summary.removedDuplicates, 1);
  assert.equal(checked.summary.removedInconsistent, 1);
  assert.equal(checked.cleanedCases.length, 2);
});
