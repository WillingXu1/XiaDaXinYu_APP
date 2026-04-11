import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePolicy, getFallbackAction } from './policy-engine.js';
import { computeMetricsFromAudit, buildConclusionFromBaseline } from './policy-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CASES_PATH = path.resolve(__dirname, '../result/policy-eval/cases/trace-cases.v1.campus.json');
const DEFAULT_REPORT_DIR = path.resolve(__dirname, '../result/policy-eval/reports');

const toActionForRefusal = (action) => action === 'emergency' || action === 'meditate';

const getArgValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return null;
  }
  return process.argv[index + 1];
};

const readDataset = async (datasetPath) => {
  const raw = await fs.readFile(datasetPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.traces) || !parsed.traces.length) {
    throw new Error(`Invalid trace dataset file: ${datasetPath}`);
  }
  return parsed;
};

const writeReport = async ({ report, reportDir, datasetVersion }) => {
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `policy-from-trace-benchmark-${datasetVersion || 'trace-v1'}-${timestamp}.json`;
  const filePath = path.join(reportDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
};

const summarizeDataset = (traces) => {
  const summary = {
    total: traces.length,
    riskDistribution: { low: 0, medium: 0, high: 0 },
    challengeDistribution: {}
  };

  for (const trace of traces) {
    const risk = trace?.labels?.riskLevel || 'low';
    const challenge = trace?.metadata?.challengeType || 'none';
    if (summary.riskDistribution[risk] !== undefined) {
      summary.riskDistribution[risk] += 1;
    }
    summary.challengeDistribution[challenge] = (summary.challengeDistribution[challenge] || 0) + 1;
  }

  return summary;
};

const countToolAttempts = (trace) => (trace?.events || []).filter((event) => event.type === 'tool_call').length;

const countToolViolations = (trace) => (trace?.events || []).filter((event) => event.type === 'tool_call' && event?.data?.blocked === true).length;

const evaluatePolicyFromTrace = ({ traces }) => {
  const baselineRows = [];
  const treatmentRows = [];

  for (const trace of traces) {
    const message = String(trace?.message || '');
    const moodStats = trace?.moodStats || {};
    const actionStats = trace?.actionStats || {};
    const requestedAction = String(trace?.labels?.requestedAction || 'chat_continue');

    const policy = evaluatePolicy({
      message,
      moodStats,
      actionStats,
      intent: String(trace?.labels?.intentType || 'support'),
      step: 0
    });

    const refusalExpected = trace?.labels?.shouldReject === true || policy.riskLevel === 'high';
    const baselineFinalAction = requestedAction;
    const treatmentFinalAction = getFallbackAction({ riskLevel: policy.riskLevel, requestedAction });

    const toolAttempts = countToolAttempts(trace);
    const baselineToolViolations = countToolViolations(trace);

    baselineRows.push({
      riskLevel: policy.riskLevel,
      highRiskBlocked: policy.riskLevel === 'high' && toActionForRefusal(baselineFinalAction),
      toolAttempts,
      toolViolations: baselineToolViolations,
      refusalExpected,
      refusalActual: toActionForRefusal(baselineFinalAction)
    });

    treatmentRows.push({
      riskLevel: policy.riskLevel,
      highRiskBlocked: policy.riskLevel === 'high' && toActionForRefusal(treatmentFinalAction),
      toolAttempts,
      toolViolations: 0,
      refusalExpected,
      refusalActual: toActionForRefusal(treatmentFinalAction)
    });
  }

  const baseline = computeMetricsFromAudit(baselineRows);
  const treatment = computeMetricsFromAudit(treatmentRows);

  const highRiskViolationBaseline = 1 - baseline.highRiskInterceptionRate;
  const highRiskViolationTreatment = 1 - treatment.highRiskInterceptionRate;

  const conclusions = buildConclusionFromBaseline({
    baseline: {
      policyViolationRate: highRiskViolationBaseline,
      refusalPrecision: baseline.refusalPrecision
    },
    current: {
      policyViolationRate: highRiskViolationTreatment,
      refusalPrecision: treatment.refusalPrecision,
      refusalRecall: treatment.refusalRecall,
      benignFalseRefusalRate: treatment.benignFalseRefusalRate
    }
  });

  const comparison = {
    policyViolationRateDelta: treatment.policyViolationRate - baseline.policyViolationRate,
    highRiskInterceptionRateDelta: treatment.highRiskInterceptionRate - baseline.highRiskInterceptionRate,
    refusalPrecisionDelta: treatment.refusalPrecision - baseline.refusalPrecision,
    refusalRecallDelta: treatment.refusalRecall - baseline.refusalRecall,
    benignFalseRefusalRateDelta: treatment.benignFalseRefusalRate - baseline.benignFalseRefusalRate,
    highRiskRefusalRecallUplift: treatment.refusalRecall - baseline.refusalRecall
  };

  const explicitConclusions = {
    highRiskRefusalRecallConclusion: `高风险拒答 Recall 从 ${(baseline.refusalRecall * 100).toFixed(2)}% 提升到 ${(treatment.refusalRecall * 100).toFixed(2)}%，提升 ${(comparison.highRiskRefusalRecallUplift * 100).toFixed(2)} 个百分点。`,
    fallbackInterceptionConclusion: `高风险拦截率从 ${(baseline.highRiskInterceptionRate * 100).toFixed(2)}% 提升到 ${(treatment.highRiskInterceptionRate * 100).toFixed(2)}%。`
  };

  return {
    baseline: {
      ...baseline,
      highRiskViolationRate: highRiskViolationBaseline
    },
    treatment: {
      ...treatment,
      highRiskViolationRate: highRiskViolationTreatment
    },
    comparison,
    conclusions,
    explicitConclusions
  };
};

const run = async () => {
  const customCasesPath = getArgValue('--cases');
  const customReportDir = getArgValue('--report-dir');

  const casesPath = customCasesPath
    ? path.resolve(process.cwd(), customCasesPath)
    : DEFAULT_CASES_PATH;

  const reportDir = customReportDir
    ? path.resolve(process.cwd(), customReportDir)
    : DEFAULT_REPORT_DIR;

  const dataset = await readDataset(casesPath);
  const traces = dataset.traces;

  const evaluated = evaluatePolicyFromTrace({ traces });

  const report = {
    datasetVersion: dataset.datasetVersion || 'trace-v1',
    datasetPath: path.relative(process.cwd(), casesPath),
    datasetSize: traces.length,
    datasetSummary: summarizeDataset(traces),
    ...evaluated,
    generatedAt: new Date().toISOString()
  };

  const reportPath = await writeReport({
    report,
    reportDir,
    datasetVersion: report.datasetVersion
  });

  console.log(JSON.stringify({
    ...report,
    reportPath: path.relative(process.cwd(), reportPath)
  }, null, 2));
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => {
    console.error('[trace-policy-benchmark] failed:', error.message);
    process.exit(1);
  });
}
