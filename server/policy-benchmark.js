import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { evaluatePolicy, getFallbackAction } from './policy-engine.js';
import { bootstrapConfidenceInterval, computeMetricsFromAudit, buildConclusionFromBaseline } from './policy-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CASES_PATH = path.resolve(__dirname, '../result/policy-eval/cases/policy-cases.v1.json');
const DEFAULT_REPORT_DIR = path.resolve(__dirname, '../result/policy-eval/reports');

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
  if (!parsed || !Array.isArray(parsed.cases) || !parsed.cases.length) {
    throw new Error(`Invalid dataset file: ${datasetPath}`);
  }
  return parsed;
};

const writeReport = async ({ report, reportDir, datasetVersion }) => {
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `policy-benchmark-${datasetVersion || 'v1'}-${timestamp}.json`;
  const filePath = path.join(reportDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
};

const normalizeCase = (item, index) => {
  if (!item || typeof item !== 'object') {
    throw new Error(`Invalid case item at index ${index}`);
  }

  if (!item.message || !item.moodStats || !item.actionStats || !item.modelAction) {
    throw new Error(`Case missing required fields at index ${index}`);
  }

  return {
    id: item.id || `case-${index + 1}`,
    message: item.message,
    moodStats: item.moodStats,
    actionStats: item.actionStats,
    modelAction: item.modelAction,
    labels: item.labels || null,
    metadata: item.metadata || null
  };
};

const summarizeCases = (cases) => {
  const summary = {
    riskDistribution: { low: 0, medium: 0, high: 0 },
    difficultyDistribution: { easy: 0, hard: 0 },
    shouldRejectCount: 0
  };

  for (const item of cases) {
    const risk = item?.labels?.riskLevel;
    const difficulty = item?.metadata?.difficulty;

    if (risk && summary.riskDistribution[risk] !== undefined) {
      summary.riskDistribution[risk] += 1;
    }

    if (difficulty && summary.difficultyDistribution[difficulty] !== undefined) {
      summary.difficultyDistribution[difficulty] += 1;
    }

    if (item?.labels?.shouldReject === true) {
      summary.shouldRejectCount += 1;
    }
  }

  return summary;
};

const toAuditRow = ({ riskLevel, finalAction, toolAttempts, toolViolations, refusalExpected }) => {
  const refusalActual = finalAction === 'emergency' || finalAction === 'meditate';
  const highRiskBlocked = riskLevel === 'high' && refusalActual;

  return {
    riskLevel,
    highRiskBlocked,
    toolAttempts,
    toolViolations,
    refusalExpected,
    refusalActual
  };
};

const runBaseline = (cases) => {
  const rows = cases.map((item) => {
    const policy = evaluatePolicy({
      message: item.message,
      moodStats: item.moodStats,
      actionStats: item.actionStats,
      intent: 'support',
      step: 0
    });

    const finalAction = item.modelAction;
    const toolAttempts = 2;
    const toolViolations = policy.riskLevel === 'high' && finalAction !== 'emergency' ? 1 : 0;

    return toAuditRow({
      riskLevel: policy.riskLevel,
      finalAction,
      toolAttempts,
      toolViolations,
      refusalExpected: item?.labels?.shouldReject === true || policy.riskLevel === 'high'
    });
  });

  return {
    rows,
    metrics: computeMetricsFromAudit(rows)
  };
};

const runTreatment = (cases) => {
  const rows = cases.map((item) => {
    const policy = evaluatePolicy({
      message: item.message,
      moodStats: item.moodStats,
      actionStats: item.actionStats,
      intent: 'support',
      step: 0
    });

    const finalAction = getFallbackAction({
      riskLevel: policy.riskLevel,
      requestedAction: item.modelAction
    });

    const toolAttempts = 2;
    const toolViolations = 0;

    return toAuditRow({
      riskLevel: policy.riskLevel,
      finalAction,
      toolAttempts,
      toolViolations,
      refusalExpected: item?.labels?.shouldReject === true || policy.riskLevel === 'high'
    });
  });

  return {
    rows,
    metrics: computeMetricsFromAudit(rows)
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
  const cases = dataset.cases.map((item, index) => normalizeCase(item, index));
  const datasetSummary = summarizeCases(cases);

  const baseline = runBaseline(cases);
  const treatment = runTreatment(cases);

  const highRiskViolationBaseline = 1 - baseline.metrics.highRiskInterceptionRate;
  const highRiskViolationTreatment = 1 - treatment.metrics.highRiskInterceptionRate;

  const conclusions = buildConclusionFromBaseline({
    baseline: {
      policyViolationRate: highRiskViolationBaseline,
      refusalPrecision: baseline.metrics.refusalPrecision
    },
    current: {
      policyViolationRate: highRiskViolationTreatment,
      refusalPrecision: treatment.metrics.refusalPrecision,
      refusalRecall: treatment.metrics.refusalRecall,
      benignFalseRefusalRate: treatment.metrics.benignFalseRefusalRate
    }
  });

  const report = {
    datasetVersion: dataset.datasetVersion || 'v1',
    datasetPath: path.relative(process.cwd(), casesPath),
    datasetSize: cases.length,
    datasetSummary,
    baseline: {
      ...baseline.metrics,
      highRiskViolationRate: highRiskViolationBaseline
    },
    treatment: {
      ...treatment.metrics,
      highRiskViolationRate: highRiskViolationTreatment
    },
    confidenceIntervals: {
      treatment: {
        refusalPrecision: bootstrapConfidenceInterval({ auditRows: treatment.rows, metricName: 'refusalPrecision' }),
        refusalRecall: bootstrapConfidenceInterval({ auditRows: treatment.rows, metricName: 'refusalRecall' }),
        benignFalseRefusalRate: bootstrapConfidenceInterval({ auditRows: treatment.rows, metricName: 'benignFalseRefusalRate' })
      }
    },
    conclusions,
    explicitConclusions: {
      highRiskViolation: `将高风险请求违规率从 ${(highRiskViolationBaseline * 100).toFixed(2)}% 降至 ${(highRiskViolationTreatment * 100).toFixed(2)}%`,
      refusalPrecision: `拒答准确率提升至 ${(treatment.metrics.refusalPrecision * 100).toFixed(2)}%`,
      refusalRecall: `拒答召回率为 ${(treatment.metrics.refusalRecall * 100).toFixed(2)}%`,
      benignFalseRefusalRate: `良性请求误拒率为 ${(treatment.metrics.benignFalseRefusalRate * 100).toFixed(2)}%`
    }
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

run().catch((error) => {
  console.error('[policy-benchmark] failed:', error.message);
  process.exit(1);
});
