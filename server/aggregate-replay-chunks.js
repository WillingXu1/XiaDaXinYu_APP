import fs from 'node:fs';
import path from 'node:path';

const reportDir = path.resolve('result/policy-eval/reports');
const outputPath = path.resolve('result/policy-eval/reports/trace-replay-aggregate-latest.json');
const wantedOffsets = [0, 1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];

const files = fs.readdirSync(reportDir).filter((name) => name.startsWith('trace-replay-benchmark-'));
const byOffset = new Map();

for (const file of files) {
  const fullPath = path.join(reportDir, file);
  const report = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  const offset = Number(report.datasetOffset);
  const size = Number(report.datasetSize);
  if (!Number.isFinite(offset) || !wantedOffsets.includes(offset) || size !== 1000) continue;

  const stat = fs.statSync(fullPath);
  const current = byOffset.get(offset);
  if (!current || stat.mtimeMs > current.mtimeMs) {
    byOffset.set(offset, {
      file,
      mtimeMs: stat.mtimeMs,
      report
    });
  }
}

const missingOffsets = wantedOffsets.filter((offset) => !byOffset.has(offset));

const chosen = wantedOffsets
  .filter((offset) => byOffset.has(offset))
  .map((offset) => {
    const item = byOffset.get(offset);
    return {
      offset,
      file: item.file,
      successfulSamples: Number(item.report.successfulSamples || 0),
      failedSamples: Number(item.report.failedSamples || 0),
      avgTokenCost: Number(item.report.metrics?.avgTokenCost || 0),
      requestSuccessCoverage: Number(item.report.metrics?.observability?.requestSuccessCoverage || 0)
    };
  });

const aggregate = {
  attempted: 0,
  success: 0,
  fail: 0,
  weighted: {
    taskSuccessBusiness: 0,
    taskSuccessStrict: 0,
    decisionAccuracy: 0,
    hallucinationRate: 0,
    fallbackRate: 0,
    consistencyScore: 0,
    repeatedDecisionRate: 0,
    policyHighRiskInterceptionRate: 0,
    policyRefusalPrecision: 0,
    policyRefusalRecall: 0,
    policyBenignFalseRefusalRate: 0
  },
  weightedBaseline: {
    consistencyScore: 0,
    repeatedDecisionRate: 0
  },
  recovery: {
    originallyFailedRows: 0,
    strictRecoveredRows: 0
  },
  observed: {
    stepRows: 0,
    latencyRows: 0,
    tokenRows: 0,
    toolRows: 0,
    sumAvgSteps: 0,
    sumAvgLatency: 0,
    sumAvgToken: 0,
    sumToolCallAccuracy: 0,
    sumToolSuccessRate: 0
  }
};

for (const offset of wantedOffsets) {
  if (!byOffset.has(offset)) continue;
  const report = byOffset.get(offset).report;
  const metrics = report.metrics || {};
  const obs = metrics.observability || {};

  const attempted = Number(obs.totalAttemptedRows || report.datasetSize || 0);
  const success = Number(report.successfulSamples || 0);
  const fail = Number(report.failedSamples || 0);

  aggregate.attempted += attempted;
  aggregate.success += success;
  aggregate.fail += fail;

  aggregate.weighted.taskSuccessBusiness += Number(metrics.taskSuccessRateBusiness || 0) * success;
  aggregate.weighted.taskSuccessStrict += Number(metrics.taskSuccessRateStrict || 0) * success;
  aggregate.weighted.decisionAccuracy += Number(metrics.decisionAccuracy || 0) * success;
  aggregate.weighted.hallucinationRate += Number(metrics.hallucinationRate || 0) * success;
  aggregate.weighted.fallbackRate += Number(metrics.fallbackRate || 0) * success;
  aggregate.weighted.consistencyScore += Number(metrics.consistencyScore || 0) * success;
  aggregate.weighted.repeatedDecisionRate += Number(metrics.repeatedDecisionRate || 0) * success;

  aggregate.weightedBaseline.consistencyScore += Number(metrics.baseline?.consistencyScore || 0) * success;
  aggregate.weightedBaseline.repeatedDecisionRate += Number(metrics.baseline?.repeatedDecisionRate || 0) * success;

  aggregate.weighted.policyHighRiskInterceptionRate += Number(metrics.policy?.treatment?.highRiskInterceptionRate || 0) * success;
  aggregate.weighted.policyRefusalPrecision += Number(metrics.policy?.treatment?.refusalPrecision || 0) * success;
  aggregate.weighted.policyRefusalRecall += Number(metrics.policy?.treatment?.refusalRecall || 0) * success;
  aggregate.weighted.policyBenignFalseRefusalRate += Number(metrics.policy?.treatment?.benignFalseRefusalRate || 0) * success;

  const stepRows = Number(obs.stepObservableRows || 0);
  const latencyRows = Number(obs.latencyObservableRows || 0);
  const tokenRows = Number(obs.tokenObservableRows || 0);
  const toolRows = Number(obs.toolObservableRows || 0);

  aggregate.observed.stepRows += stepRows;
  aggregate.observed.latencyRows += latencyRows;
  aggregate.observed.tokenRows += tokenRows;
  aggregate.observed.toolRows += toolRows;

  aggregate.observed.sumAvgSteps += Number(metrics.avgStepsPerTask || 0) * stepRows;
  aggregate.observed.sumAvgLatency += Number(metrics.avgLatencyMs || 0) * latencyRows;
  aggregate.observed.sumAvgToken += Number(metrics.avgTokenCost || 0) * tokenRows;
  aggregate.observed.sumToolCallAccuracy += Number(metrics.toolCallAccuracy || 0) * toolRows;
  aggregate.observed.sumToolSuccessRate += Number(metrics.toolSuccessRate || 0) * toolRows;

  // Strict recovery: originally_failed AND final_success(strict)
  const rows = Array.isArray(report.rows) ? report.rows : [];
  for (const row of rows) {
    if (row?.retryableFailure) {
      aggregate.recovery.originallyFailedRows += 1;
      if (row?.taskSuccessStrict) {
        aggregate.recovery.strictRecoveredRows += 1;
      }
    }
  }
}

const safeDivide = (n, d) => (d ? n / d : null);

const avgLatencyObserved = safeDivide(aggregate.observed.sumAvgLatency, aggregate.observed.latencyRows);

const summary = {
  attempted: aggregate.attempted,
  success: aggregate.success,
  fail: aggregate.fail,
  requestSuccessCoverage: safeDivide(aggregate.success, aggregate.attempted),
  taskSuccessBusiness: safeDivide(aggregate.weighted.taskSuccessBusiness, aggregate.success),
  taskSuccessStrict: safeDivide(aggregate.weighted.taskSuccessStrict, aggregate.success),
  decisionAccuracy: safeDivide(aggregate.weighted.decisionAccuracy, aggregate.success),
  hallucinationRate: safeDivide(aggregate.weighted.hallucinationRate, aggregate.success),
  fallbackRate: safeDivide(aggregate.weighted.fallbackRate, aggregate.success),
  consistencyScore: safeDivide(aggregate.weighted.consistencyScore, aggregate.success),
  repeatedDecisionRate: safeDivide(aggregate.weighted.repeatedDecisionRate, aggregate.success),
  avgStepsObserved: safeDivide(aggregate.observed.sumAvgSteps, aggregate.observed.stepRows),
  avgLatencyObserved,
  qpsSerialEquivalent: avgLatencyObserved ? 1000 / avgLatencyObserved : null,
  avgTokenObserved: safeDivide(aggregate.observed.sumAvgToken, aggregate.observed.tokenRows),
  toolCallAccuracyObserved: safeDivide(aggregate.observed.sumToolCallAccuracy, aggregate.observed.toolRows),
  toolSuccessRateObserved: safeDivide(aggregate.observed.sumToolSuccessRate, aggregate.observed.toolRows),
  tokenObservableCoverage: safeDivide(aggregate.observed.tokenRows, aggregate.attempted),
  stepsObservableCoverage: safeDivide(aggregate.observed.stepRows, aggregate.attempted),
  latencyObservableCoverage: safeDivide(aggregate.observed.latencyRows, aggregate.attempted),
  errorRecoveryRateStrict: safeDivide(aggregate.recovery.strictRecoveredRows, aggregate.recovery.originallyFailedRows),
  errorRecoveryDenominator: aggregate.recovery.originallyFailedRows,
  baseline: {
    consistencyScore: safeDivide(aggregate.weightedBaseline.consistencyScore, aggregate.success),
    repeatedDecisionRate: safeDivide(aggregate.weightedBaseline.repeatedDecisionRate, aggregate.success)
  },
  policyTreatment: {
    highRiskInterceptionRate: safeDivide(aggregate.weighted.policyHighRiskInterceptionRate, aggregate.success),
    refusalPrecision: safeDivide(aggregate.weighted.policyRefusalPrecision, aggregate.success),
    refusalRecall: safeDivide(aggregate.weighted.policyRefusalRecall, aggregate.success),
    benignFalseRefusalRate: safeDivide(aggregate.weighted.policyBenignFalseRefusalRate, aggregate.success)
  }
};

const result = {
  generatedAt: new Date().toISOString(),
  missingOffsets,
  chosen,
  summary
};

fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 2));
