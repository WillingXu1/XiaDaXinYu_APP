import test from 'node:test';
import assert from 'node:assert/strict';

import {
  createMetricsTracker,
  computeMetricsFromAudit,
  bootstrapConfidenceInterval
} from './policy-metrics.js';

test('computeMetricsFromAudit computes three required metrics', () => {
  const audit = [
    {
      riskLevel: 'high',
      highRiskBlocked: true,
      toolAttempts: 2,
      toolViolations: 1,
      refusalExpected: true,
      refusalActual: true
    },
    {
      riskLevel: 'high',
      highRiskBlocked: false,
      toolAttempts: 1,
      toolViolations: 1,
      refusalExpected: true,
      refusalActual: false
    },
    {
      riskLevel: 'low',
      highRiskBlocked: false,
      toolAttempts: 3,
      toolViolations: 0,
      refusalExpected: false,
      refusalActual: true
    }
  ];

  const metrics = computeMetricsFromAudit(audit);

  assert.equal(metrics.policyViolationRate, 2 / 6);
  assert.equal(metrics.highRiskInterceptionRate, 1 / 2);
  assert.equal(metrics.refusalPrecision, 1 / 2);
  assert.equal(metrics.refusalRecall, 1 / 2);
  assert.equal(metrics.benignFalseRefusalRate, 1 / 1);
});

test('createMetricsTracker accumulates request level events', () => {
  const tracker = createMetricsTracker();

  tracker.recordRequestStart({ requestId: 'r1', riskLevel: 'high' });
  tracker.recordToolAttempt({ requestId: 'r1', allowed: false });
  tracker.recordToolAttempt({ requestId: 'r1', allowed: true });
  tracker.recordFinalDecision({
    requestId: 'r1',
    highRiskBlocked: true,
    refusalExpected: true,
    refusalActual: true
  });

  const report = tracker.getReport();
  assert.equal(report.totals.requests, 1);
  assert.equal(report.metrics.policyViolationRate, 0.5);
  assert.equal(report.metrics.highRiskInterceptionRate, 1);
  assert.equal(report.metrics.refusalPrecision, 1);
  assert.equal(report.metrics.refusalRecall, 1);
  assert.equal(report.metrics.benignFalseRefusalRate, 0);
});

test('bootstrapConfidenceInterval returns bounded interval for metric', () => {
  const audit = [
    { riskLevel: 'high', highRiskBlocked: true, toolAttempts: 1, toolViolations: 0, refusalExpected: true, refusalActual: true },
    { riskLevel: 'high', highRiskBlocked: false, toolAttempts: 1, toolViolations: 1, refusalExpected: true, refusalActual: false },
    { riskLevel: 'low', highRiskBlocked: false, toolAttempts: 1, toolViolations: 0, refusalExpected: false, refusalActual: false },
    { riskLevel: 'medium', highRiskBlocked: false, toolAttempts: 1, toolViolations: 0, refusalExpected: false, refusalActual: true }
  ];

  const ci = bootstrapConfidenceInterval({
    auditRows: audit,
    metricName: 'refusalPrecision',
    iterations: 100,
    seed: 123
  });

  assert.equal(typeof ci.lower, 'number');
  assert.equal(typeof ci.upper, 'number');
  assert.equal(typeof ci.mean, 'number');
  assert.ok(ci.lower <= ci.upper);
});
