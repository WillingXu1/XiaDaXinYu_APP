import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const ALLOWED_RISK = new Set(['low', 'medium', 'high']);
const ALLOWED_INTENT = new Set(['vent', 'action_req', 'crisis_help', 'chit_chat', 'support']);
const ALLOWED_ACTION = new Set(['emergency', 'meditate', 'treehole', 'micro_action', 'chat_continue']);
const ALLOWED_DIFFICULTY = new Set(['easy', 'hard']);

export const normalizeMessage = (message) => {
  return String(message || '')
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[，。！？,.!?、;；:"'“”‘’()（）【】\[\]{}<>《》-]/g, '');
};

  const buildDedupSignature = (item) => {
    const normalized = normalizeMessage(item.message);
    const mood = Number(item.moodStats.avgMood).toFixed(1);
    const stress = Number(item.moodStats.avgStress).toFixed(1);
    const streak = Number(item.moodStats.lowMoodStreak);
    const weeklyCount = Number(item.actionStats.weeklyCount);
    const risk = item.labels.riskLevel;
    const difficulty = item.metadata.difficulty;
    return [normalized, mood, stress, streak, weeklyCount, risk, difficulty].join('|');
  };

const isFiniteNumber = (v) => Number.isFinite(Number(v));

export const validateCaseShape = (item) => {
  const errors = [];

  if (!item || typeof item !== 'object') {
    return { valid: false, errors: ['case must be object'] };
  }

  if (!item.id) errors.push('missing id');
  if (!item.message) errors.push('missing message');

  if (!item.moodStats || typeof item.moodStats !== 'object') {
    errors.push('missing moodStats');
  } else {
    if (!isFiniteNumber(item.moodStats.avgMood)) errors.push('invalid moodStats.avgMood');
    if (!isFiniteNumber(item.moodStats.avgStress)) errors.push('invalid moodStats.avgStress');
    if (!Number.isInteger(item.moodStats.lowMoodStreak) || item.moodStats.lowMoodStreak < 0) {
      errors.push('invalid moodStats.lowMoodStreak');
    }
  }

  if (!item.actionStats || typeof item.actionStats !== 'object') {
    errors.push('missing actionStats');
  } else if (!Number.isInteger(item.actionStats.weeklyCount) || item.actionStats.weeklyCount < 0) {
    errors.push('invalid actionStats.weeklyCount');
  }

  if (!ALLOWED_ACTION.has(item.modelAction)) {
    errors.push('invalid modelAction');
  }

  if (!item.labels || typeof item.labels !== 'object') {
    errors.push('missing labels');
  } else {
    if (!ALLOWED_RISK.has(item.labels.riskLevel)) errors.push('invalid labels.riskLevel');
    if (!ALLOWED_INTENT.has(item.labels.intentType)) errors.push('invalid labels.intentType');
    if (typeof item.labels.shouldReject !== 'boolean') errors.push('invalid labels.shouldReject');
    if (!ALLOWED_ACTION.has(item.labels.expectedAction)) errors.push('invalid labels.expectedAction');
  }

  if (!item.metadata || typeof item.metadata !== 'object') {
    errors.push('missing metadata');
  } else {
    if (!ALLOWED_DIFFICULTY.has(item.metadata.difficulty)) errors.push('invalid metadata.difficulty');
    if (!item.metadata.source) errors.push('invalid metadata.source');
    if (!Number.isInteger(item.metadata.seed)) errors.push('invalid metadata.seed');
    if (!item.metadata.templateId) errors.push('invalid metadata.templateId');
  }

  return {
    valid: errors.length === 0,
    errors
  };
};

const validateLabelConsistency = (item) => {
  const issues = [];
  const risk = item.labels.riskLevel;
  const shouldReject = item.labels.shouldReject;
  const expectedAction = item.labels.expectedAction;
  const challengeType = item.metadata.challengeType || 'none';

  if (risk === 'high') {
    if (!shouldReject) {
      issues.push('high risk must set shouldReject=true');
    }
    if (expectedAction !== 'emergency') {
      issues.push('high risk expectedAction must be emergency');
    }
  }

  if (risk === 'low') {
    if (shouldReject) {
      issues.push('low risk shouldReject must be false');
    }
    if (expectedAction === 'emergency') {
      issues.push('low risk expectedAction should not be emergency');
    }
  }

  if (shouldReject && risk !== 'high') {
    if (challengeType !== 'policy_abuse') {
      issues.push('non-high shouldReject must be policy_abuse challenge');
    }
    if (expectedAction !== 'emergency') {
      issues.push('non-high shouldReject expectedAction must be emergency');
    }
  }

  const mood = Number(item.moodStats.avgMood);
  const stress = Number(item.moodStats.avgStress);
  const streak = Number(item.moodStats.lowMoodStreak);

  if (risk === 'high' && (mood > 2.8 || stress < 3.5 || streak < 2)) {
    issues.push('high risk moodStats inconsistent');
  }

  if (risk === 'low' && (mood < 2.8 || stress > 3.8)) {
    issues.push('low risk moodStats inconsistent');
  }

  return {
    valid: issues.length === 0,
    issues
  };
};

export const qualityCheckDataset = (dataset) => {
  const sourceCases = Array.isArray(dataset?.cases) ? dataset.cases : [];
  const cleanedCases = [];
  const reports = [];
  const seen = new Set();

  let removedBadShape = 0;
  let removedDuplicates = 0;
  let removedInconsistent = 0;

  sourceCases.forEach((item, index) => {
    const id = item?.id || `case-${index + 1}`;

    const shape = validateCaseShape(item);
    if (!shape.valid) {
      removedBadShape += 1;
      reports.push({ id, index, reason: 'bad_shape', details: shape.errors });
      return;
    }

      const dedupKey = buildDedupSignature(item);
    if (seen.has(dedupKey)) {
      removedDuplicates += 1;
      reports.push({ id, index, reason: 'duplicate_message', details: [dedupKey] });
      return;
    }
    seen.add(dedupKey);

    const consistency = validateLabelConsistency(item);
    if (!consistency.valid) {
      removedInconsistent += 1;
      reports.push({ id, index, reason: 'label_inconsistent', details: consistency.issues });
      return;
    }

    cleanedCases.push(item);
  });

  return {
    cleanedCases,
    removedReports: reports,
    summary: {
      inputCount: sourceCases.length,
      outputCount: cleanedCases.length,
      removedBadShape,
      removedDuplicates,
      removedInconsistent,
      removedTotal: removedBadShape + removedDuplicates + removedInconsistent
    }
  };
};

const getArgValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return null;
  }
  return process.argv[index + 1];
};

const runCli = async () => {
  const inputArg = getArgValue('--in') || 'result/policy-eval/cases/policy-cases.v2.dryrun.json';
  const outputArg = getArgValue('--out') || 'result/policy-eval/cases/policy-cases.v2.dryrun.cleaned.json';
  const reportArg = getArgValue('--report') || 'result/policy-eval/reports/policy-quality-report.latest.json';

  const inPath = path.resolve(process.cwd(), inputArg);
  const outPath = path.resolve(process.cwd(), outputArg);
  const reportPath = path.resolve(process.cwd(), reportArg);

  const raw = await fs.readFile(inPath, 'utf8');
  const dataset = JSON.parse(raw);
  const checked = qualityCheckDataset(dataset);

  const cleanedDataset = {
    ...dataset,
    datasetVersion: `${dataset.datasetVersion || 'v2'}-cleaned`,
    cleanedAt: new Date().toISOString(),
    qualitySummary: checked.summary,
    cases: checked.cleanedCases
  };

  const qualityReport = {
    inputPath: path.relative(process.cwd(), inPath),
    outputPath: path.relative(process.cwd(), outPath),
    reportPath: path.relative(process.cwd(), reportPath),
    datasetVersion: dataset.datasetVersion || 'unknown',
    summary: checked.summary,
    removedReports: checked.removedReports
  };

  await fs.mkdir(path.dirname(outPath), { recursive: true });
  await fs.mkdir(path.dirname(reportPath), { recursive: true });

  await fs.writeFile(outPath, `${JSON.stringify(cleanedDataset, null, 2)}\n`, 'utf8');
  await fs.writeFile(reportPath, `${JSON.stringify(qualityReport, null, 2)}\n`, 'utf8');

  console.log(JSON.stringify({
    outputPath: qualityReport.outputPath,
    reportPath: qualityReport.reportPath,
    ...checked.summary
  }, null, 2));
};

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runCli().catch((error) => {
    console.error('[policy-quality-check] failed:', error.message);
    process.exit(1);
  });
}
