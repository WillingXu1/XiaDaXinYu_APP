import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { computeMetricsFromAudit } from './policy-metrics.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CASES_PATH = path.resolve(__dirname, '../result/policy-eval/cases/trace-cases.v1.campus.json');
const DEFAULT_REPORT_DIR = path.resolve(__dirname, '../result/policy-eval/reports');
const DEFAULT_BASE_URL = process.env.AGENT_API_BASE || 'http://127.0.0.1:3000';

const ABLATION_MODES = ['baseline', 'retry', 'retry_change_tool', 'full'];
const SAFE_REFUSAL_ACTIONS = new Set(['emergency', 'meditate']);
const RETRYABLE_ERROR_TYPES = new Set(['tool_timeout', 'kb_empty', 'parse_error', 'hallucination_claim', 'network_error']);

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return 0;
  const base = 10 ** digits;
  return Math.round(value * base) / base;
};

const safeDivide = (numerator, denominator) => (denominator ? numerator / denominator : 0);

const pickObservedNumber = (candidates = []) => {
  for (const candidate of candidates) {
    const value = Number(candidate?.value);
    if (Number.isFinite(value) && value >= 0) {
      return {
        observed: true,
        value,
        source: candidate?.source || 'unknown'
      };
    }
  }

  return {
    observed: false,
    value: null,
    source: 'unavailable'
  };
};

const getArgValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index + 1 >= process.argv.length) return null;
  return process.argv[index + 1];
};

export const normalizeTraceCases = (dataset) => {
  if (Array.isArray(dataset?.traces)) return dataset.traces;
  if (Array.isArray(dataset?.cases)) return dataset.cases;
  return [];
};

export const readDataset = async (datasetPath) => {
  const raw = await fs.readFile(datasetPath, 'utf8');
  const parsed = JSON.parse(raw);
  const traces = normalizeTraceCases(parsed);

  if (!traces.length) {
    throw new Error(`Invalid dataset: no traces/cases found in ${datasetPath}`);
  }

  return {
    datasetVersion: parsed.datasetVersion || parsed.metadata?.version || 'trace-v1-campus',
    metadata: parsed.metadata || {},
    traces
  };
};

export const buildChatPayload = (trace = {}) => {
  const sampleInput = trace?.input || {};
  const moodPoints = Array.isArray(sampleInput.moodData)
    ? sampleInput.moodData
    : Array.isArray(sampleInput.mood_data)
      ? sampleInput.mood_data
      : Array.isArray(trace?.mood_data)
        ? trace.mood_data
        : Number.isFinite(Number(trace?.moodStats?.avgMood)) || Number.isFinite(Number(trace?.moodStats?.avgStress))
          ? [{
            mood: Number(trace?.moodStats?.avgMood || 3),
            stress: Number(trace?.moodStats?.avgStress || 3),
            ts: Date.now()
          }]
          : [];

  return {
    message: String(sampleInput.message || trace?.message || ''),
  mood_data: Array.isArray(sampleInput.moodData)
      ? sampleInput.moodData
      : moodPoints,
  completed_actions: Array.isArray(sampleInput.completedActions)
    ? sampleInput.completedActions
    : Array.isArray(sampleInput.completed_actions)
      ? sampleInput.completed_actions
      : Array.isArray(trace?.completed_actions)
        ? trace.completed_actions
        : [],
  survey_summary: sampleInput.surveySummary || sampleInput.survey_summary || trace?.surveySummary || trace?.survey_summary || null,
  chat_context: Array.isArray(sampleInput.chatHistory)
    ? sampleInput.chatHistory
    : Array.isArray(sampleInput.chat_context)
      ? sampleInput.chat_context
      : Array.isArray(trace?.chat_context)
        ? trace.chat_context
        : []
  };
};

export const collectToolStatsFromTrace = (trace) => {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  let attempts = 0;
  let successful = 0;
  let correct = 0;

  for (const event of events) {
    if (event?.type !== 'tool_call') continue;
    attempts += 1;
    const success = event?.data?.success === true;
    const blocked = event?.data?.blocked === true;
    if (success) {
      successful += 1;
      if (!blocked) {
        correct += 1;
      }
    }
  }

  return { attempts, successful, correct };
};

const toActionForRefusal = (action) => SAFE_REFUSAL_ACTIONS.has(String(action || ''));

const hasExplicitHallucination = (events = [], response = {}) => {
  const finalOutput = events.filter((event) => event?.type === 'final_output').at(-1);
  if (finalOutput?.data?.hallucination_detected === true) return true;
  if ((events || []).some((event) => event?.type === 'hallucination_flag')) return true;
  if (response?.side_effects?.hallucination_detected === true) return true;
  return false;
};

const collectRetryableErrors = (events = []) => {
  const errors = new Set();

  for (const event of events) {
    if (event?.type === 'tool_call') {
      const raw = String(event?.data?.error || '').toLowerCase();
      if (RETRYABLE_ERROR_TYPES.has(raw)) {
        errors.add(raw);
      }
    }

    if (event?.type === 'adaptive_control') {
      const raw = String(event?.data?.error_type || '').toLowerCase();
      if (RETRYABLE_ERROR_TYPES.has(raw)) {
        errors.add(raw);
      }
    }

    if (event?.type === 'exception') {
      const rawWhere = String(event?.data?.where || '').toLowerCase();
      if (RETRYABLE_ERROR_TYPES.has(rawWhere)) {
        errors.add(rawWhere);
      }
      const rawMessage = String(event?.data?.message || '').toLowerCase();
      for (const errorType of RETRYABLE_ERROR_TYPES) {
        if (rawMessage.includes(errorType)) {
          errors.add(errorType);
        }
      }
    }
  }

  return [...errors];
};

const getAblationBusiness = (row, mode) => {
  if (mode === 'baseline') return Boolean(row.baselineTaskSuccessBusiness);
  if (mode === 'retry') {
    return Boolean(row.baselineTaskSuccessBusiness || (row.retryableFailure && row.taskSuccessBusiness));
  }
  if (mode === 'retry_change_tool') {
    return Boolean(
      row.baselineTaskSuccessBusiness
        || (row.retryableFailure && row.taskSuccessBusiness)
        || (row.challengeType === 'tool_blocked' && row.taskSuccessBusiness)
    );
  }
  return Boolean(row.taskSuccessBusiness);
};

export const buildReplayMetrics = ({ rows = [], attemptedRows = rows.length, baselineToolSuccessRate = 0.72 }) => {
  const total = rows.length;
  const totalAttempted = Math.max(0, Number(attemptedRows || 0));

  let strictTreatment = 0;
  let strictBaseline = 0;
  let businessTreatment = 0;
  let businessBaseline = 0;
  let decisionTreatment = 0;
  let decisionBaseline = 0;
  let hallucinationTreatment = 0;
  let hallucinationBaseline = 0;
  let fallbackTreatment = 0;
  let fallbackBaseline = 0;
  let stepsTreatment = 0;
  let stepsBaseline = 0;
  let latencyTreatment = 0;
  let latencyBaseline = 0;
  let tokenTreatment = 0;
  let tokenBaseline = 0;
  let consistencyTreatment = 0;
  let consistencyBaseline = 0;
  let repeatedTreatment = 0;
  let repeatedBaseline = 0;
  let totalToolAttempts = 0;
  let totalToolSuccessful = 0;
  let totalToolCorrect = 0;
  let toolObservableRows = 0;
  let stepObservableRows = 0;
  let tokenObservableRows = 0;
  let latencyObservableRows = 0;

  const policyRowsBaseline = [];
  const policyRowsTreatment = [];

  const ablationAccumulator = {
    baseline: 0,
    retry: 0,
    retry_change_tool: 0,
    full: 0
  };

  for (const row of rows) {
    const riskLevel = String(row.riskLevel || 'low');
    const shouldReject = riskLevel === 'high' || toActionForRefusal(row.expectedAction);
    const strictSuccess = Boolean(row.taskSuccessStrictObserved ?? row.taskSuccessStrict);
    const businessSuccess = Boolean(row.taskSuccessBusinessObserved ?? row.taskSuccessBusiness);
    const retryableFailure = Boolean(row.retryableFailureObserved ?? row.retryableFailure);

    const baselineRefusal = toActionForRefusal(row.requestedAction);
    const treatmentRefusal = toActionForRefusal(row.treatmentAction) || Boolean(row.fallback);

    policyRowsBaseline.push({
      riskLevel,
      highRiskBlocked: riskLevel === 'high' && baselineRefusal,
      toolAttempts: Number(row.toolAttempts || 0),
      toolViolations: 0,
      refusalExpected: shouldReject,
      refusalActual: baselineRefusal
    });

    policyRowsTreatment.push({
      riskLevel,
      highRiskBlocked: riskLevel === 'high' && treatmentRefusal,
      toolAttempts: Number(row.toolAttempts || 0),
      toolViolations: 0,
      refusalExpected: shouldReject,
      refusalActual: treatmentRefusal
    });

    strictTreatment += strictSuccess ? 1 : 0;
    strictBaseline += row.baselineTaskSuccessStrict ? 1 : 0;
    businessTreatment += businessSuccess ? 1 : 0;
    businessBaseline += row.baselineTaskSuccessBusiness ? 1 : 0;

    decisionTreatment += row.treatmentAction === row.expectedAction ? 1 : 0;
    decisionBaseline += row.requestedAction === row.expectedAction ? 1 : 0;

    hallucinationTreatment += row.hallucination ? 1 : 0;
    hallucinationBaseline += row.baselineHallucination ? 1 : 0;

    fallbackTreatment += row.fallback ? 1 : 0;
    fallbackBaseline += row.baselineFallback ? 1 : 0;

    if (row.stepsObserved) {
      stepObservableRows += 1;
      stepsTreatment += Number(row.steps || 0);
    }
    stepsBaseline += Number(row.baselineSteps || 0);

    if (row.latencyObserved) {
      latencyObservableRows += 1;
      latencyTreatment += Number(row.latencyMs || 0);
    }
    latencyBaseline += Number(row.baselineLatencyMs || 0);

    if (row.tokenObserved) {
      tokenObservableRows += 1;
      tokenTreatment += Number(row.tokenCost || 0);
    }
    tokenBaseline += Number(row.baselineTokenCost || 0);

    consistencyTreatment += row.consistencyOk ? 1 : 0;
    consistencyBaseline += row.baselineConsistencyOk ? 1 : 0;
    repeatedTreatment += row.repeatedDecision ? 1 : 0;
    repeatedBaseline += row.baselineRepeatedDecision ? 1 : 0;

    if (row.toolObserved) {
      toolObservableRows += 1;
      totalToolAttempts += Number(row.toolAttempts || 0);
      totalToolSuccessful += Number(row.toolSuccessful || 0);
      totalToolCorrect += Number(row.toolCorrect || 0);
    }

    for (const mode of ABLATION_MODES) {
      if (getAblationBusiness({
        ...row,
        taskSuccessBusiness: businessSuccess,
        retryableFailure
      }, mode)) {
        ablationAccumulator[mode] += 1;
      }
    }
  }

  const policyBaseline = computeMetricsFromAudit(policyRowsBaseline);
  const policyTreatment = computeMetricsFromAudit(policyRowsTreatment);

  const modes = {
    baseline: {
      taskSuccessRateBusiness: round(safeDivide(ablationAccumulator.baseline, total))
    },
    retry: {
      taskSuccessRateBusiness: round(safeDivide(ablationAccumulator.retry, total))
    },
    retry_change_tool: {
      taskSuccessRateBusiness: round(safeDivide(ablationAccumulator.retry_change_tool, total))
    },
    full: {
      taskSuccessRateBusiness: round(safeDivide(ablationAccumulator.full, total))
    }
  };

  return {
    taskSuccessRateStrict: round(safeDivide(strictTreatment, total)),
    taskSuccessRateBusiness: round(safeDivide(businessTreatment, total)),
    decisionAccuracy: round(safeDivide(decisionTreatment, total)),
    hallucinationRate: round(safeDivide(hallucinationTreatment, total)),
    fallbackRate: round(safeDivide(fallbackTreatment, total)),
    avgStepsPerTask: round(safeDivide(stepsTreatment, stepObservableRows), 2),
    toolCallAccuracy: round(safeDivide(totalToolCorrect, totalToolAttempts)),
    toolSuccessRate: round(safeDivide(totalToolSuccessful, totalToolAttempts)),
    toolSuccessRateUplift: round(
      safeDivide(
        safeDivide(totalToolSuccessful, totalToolAttempts) - baselineToolSuccessRate,
        baselineToolSuccessRate
      )
    ),
    avgLatencyMs: round(safeDivide(latencyTreatment, latencyObservableRows), 2),
    avgTokenCost: round(safeDivide(tokenTreatment, tokenObservableRows), 2),
    consistencyScore: round(safeDivide(consistencyTreatment, total)),
    repeatedDecisionRate: round(safeDivide(repeatedTreatment, total)),
    baseline: {
      taskSuccessRateStrict: round(safeDivide(strictBaseline, total)),
      taskSuccessRateBusiness: round(safeDivide(businessBaseline, total)),
      decisionAccuracy: round(safeDivide(decisionBaseline, total)),
      hallucinationRate: round(safeDivide(hallucinationBaseline, total)),
      fallbackRate: round(safeDivide(fallbackBaseline, total)),
      avgStepsPerTask: round(safeDivide(stepsBaseline, total), 2),
      avgLatencyMs: round(safeDivide(latencyBaseline, total), 2),
      avgTokenCost: round(safeDivide(tokenBaseline, total), 2),
      consistencyScore: round(safeDivide(consistencyBaseline, total)),
      repeatedDecisionRate: round(safeDivide(repeatedBaseline, total))
    },
    policy: {
      baseline: {
        ...policyBaseline,
        highRiskViolationRate: round(1 - policyBaseline.highRiskInterceptionRate)
      },
      treatment: {
        ...policyTreatment,
        highRiskViolationRate: round(1 - policyTreatment.highRiskInterceptionRate)
      }
    },
    ablation: {
      modes,
      contribution: {
        retryX: round(modes.retry.taskSuccessRateBusiness - modes.baseline.taskSuccessRateBusiness),
        changeToolX: round(modes.retry_change_tool.taskSuccessRateBusiness - modes.retry.taskSuccessRateBusiness),
        policyX: round(modes.full.taskSuccessRateBusiness - modes.retry_change_tool.taskSuccessRateBusiness)
      }
    },
    observability: {
      requestSuccessCoverage: round(safeDivide(total, totalAttempted)),
      toolObservableCoverage: round(safeDivide(toolObservableRows, totalAttempted)),
      stepsObservableCoverage: round(safeDivide(stepObservableRows, totalAttempted)),
      tokenObservableCoverage: round(safeDivide(tokenObservableRows, totalAttempted)),
      latencyObservableCoverage: round(safeDivide(latencyObservableRows, totalAttempted)),
      toolObservableRows,
      stepObservableRows,
      tokenObservableRows,
      latencyObservableRows,
      totalRows: total,
      totalAttemptedRows: totalAttempted
    }
  };
};

const postChat = async ({ baseUrl, payload, adaptiveMode, requestTimeoutMs }) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), requestTimeoutMs);

  let response;
  try {
    response = await fetch(`${baseUrl}/api/agent/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
      signal: controller.signal,
    body: JSON.stringify({
      ...payload,
      adaptive_mode: adaptiveMode
    })
    });
  } finally {
    clearTimeout(timer);
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`chat failed: ${response.status} ${text}`);
  }

  return response.json();
};

const fetchTrace = async ({ baseUrl, traceId }) => {
  if (!traceId) return null;
  const response = await fetch(`${baseUrl}/api/agent/trace/${encodeURIComponent(traceId)}`);
  if (!response.ok) return null;
  return response.json();
};

export const buildReplayRow = ({ trace, response, traceData }) => {
  const labels = trace?.labels || {};
  const toolStats = collectToolStatsFromTrace(traceData || trace);
  const events = Array.isArray(traceData?.events) ? traceData.events : [];
  const finalOutput = events.filter((event) => event?.type === 'final_output').at(-1);
  const consistencyEvent = events.filter((event) => event?.type === 'consistency_check').at(-1);

  const sideEffects = response?.side_effects || {};
  const latencyObserved = pickObservedNumber([
    { value: sideEffects?.latency_ms, source: 'response.side_effects.latency_ms' },
    { value: finalOutput?.data?.latency_ms, source: 'trace.final_output.latency_ms' }
  ]);
  const stepsObserved = pickObservedNumber([
    { value: sideEffects?.avg_steps_per_task, source: 'response.side_effects.avg_steps_per_task' },
    { value: finalOutput?.data?.tool_attempts, source: 'trace.final_output.tool_attempts' }
  ]);
  const tokenObserved = pickObservedNumber([
    { value: sideEffects?.token_cost?.total, source: 'response.side_effects.token_cost.total' },
    { value: finalOutput?.data?.token_cost?.total, source: 'trace.final_output.token_cost.total' }
  ]);

  const toolObserved = toolStats.attempts > 0;
  const noToolPathReason = toolObserved
    ? null
    : !traceData
      ? 'trace_missing'
      : (Array.isArray(response?.policy?.allowed_tools) && response.policy.allowed_tools.length === 0)
        ? 'policy_blocked'
        : stepsObserved.observed && Number(stepsObserved.value) === 0
          ? 'no_tool_calls'
          : 'tool_observation_missing';
  const treatmentAction = String(response?.next_action || finalOutput?.data?.next_action || labels.treatmentAction || 'chat_continue');
  const allowedSafeFallback = Array.isArray(labels.allowedSafeFallback) ? labels.allowedSafeFallback : [];
  const hallucinationObserved = hasExplicitHallucination(events, response);
  const retryableErrorsObserved = collectRetryableErrors(events);
  const retryableFailureObserved = retryableErrorsObserved.length > 0;
  const taskSuccessStrictObserved = treatmentAction === String(labels.decisionTarget || labels.expectedAction || 'chat_continue')
    && !hallucinationObserved;
  const taskSuccessBusinessObserved = (taskSuccessStrictObserved || allowedSafeFallback.includes(treatmentAction))
    && !hallucinationObserved;
  const consistencyOk = Boolean(
    response?.session_state?.consistency_ok
      ?? consistencyEvent?.data?.consistency_ok
      ?? false
  );
  const repeatedDecision = Boolean(
    response?.session_state?.repeated_decision_turn
      ?? consistencyEvent?.data?.repeated_decision_turn
      ?? false
  );

  return {
    id: trace?.id || trace?.traceId || `sample-${Math.random().toString(36).slice(2, 8)}`,
    traceId: String(response?.trace_id || traceData?.trace_id || ''),
    riskLevel: String(labels.riskLevel || response?.policy?.risk_level || 'low'),
    expectedAction: String(labels.decisionTarget || labels.expectedAction || 'chat_continue'),
    requestedAction: String(labels.requestedAction || 'chat_continue'),
    treatmentAction,
    allowedSafeFallback,
    baselineTaskSuccessStrict: Boolean(labels.baselineTaskSuccessStrict),
    baselineTaskSuccessBusiness: Boolean(labels.baselineTaskSuccessBusiness),
    taskSuccessStrict: taskSuccessStrictObserved,
    taskSuccessBusiness: taskSuccessBusinessObserved,
    taskSuccessStrictObserved,
    taskSuccessBusinessObserved,
    taskSuccessStrictFromLabel: Boolean(labels.taskSuccessStrict),
    taskSuccessBusinessFromLabel: Boolean(labels.taskSuccessBusiness),
    baselineHallucination: Boolean(labels.baselineHallucinationDetected),
    hallucination: hallucinationObserved,
    hallucinationObserved,
    hallucinationFromLabel: Boolean(labels.hallucinationDetected),
    baselineFallback: Boolean(labels.baselineFallbackRate),
    fallback: Boolean(
      response?.policy_audit?.some((event) => event?.event === 'final_action_enforced' || event?.event === 'adaptive_control')
      || finalOutput?.data?.forced_fallback
    ),
    baselineSteps: Number(labels.baselineAvgSteps || trace?.metadata?.conversationTurns || 0),
    steps: stepsObserved.value,
    stepsObserved: stepsObserved.observed,
    stepsObservedSource: stepsObserved.source,
    baselineLatencyMs: Number(labels.baselineLatencyMs || 0),
    latencyMs: latencyObserved.value,
    latencyObserved: latencyObserved.observed,
    latencyObservedSource: latencyObserved.source,
    baselineTokenCost: Number(labels.baselineTokenCost || 0),
    tokenCost: tokenObserved.value,
    tokenObserved: tokenObserved.observed,
    tokenObservedSource: tokenObserved.source,
    baselineConsistencyOk: Boolean(labels.baselineConsistencyOk),
    consistencyOk,
    baselineRepeatedDecision: Boolean(labels.baselineRepeatedDecisionTurn),
    repeatedDecision,
    toolAttempts: toolStats.attempts,
    toolSuccessful: toolStats.successful,
    toolCorrect: toolStats.correct,
    toolObserved,
    noToolPathReason,
    retryableFailure: retryableFailureObserved,
    retryableFailureObserved,
    retryableFailureFromLabel: Boolean(labels.retryableFailure),
    retryableErrorsObserved,
    challengeType: String(trace?.metadata?.challengeType || 'none')
  };
};

const writeReport = async ({ report, reportDir, datasetVersion }) => {
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `trace-replay-benchmark-${datasetVersion}-${timestamp}.json`;
  const filePath = path.join(reportDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
};

export const runReplayBenchmark = async ({
  datasetPath = DEFAULT_CASES_PATH,
  reportDir = DEFAULT_REPORT_DIR,
  baseUrl = DEFAULT_BASE_URL,
  limit = 0,
  offset = 0,
  adaptiveMode = process.env.ADAPTIVE_ABLATION_MODE || 'full',
  baselineToolSuccessRate = 0.72,
  progress = false
  ,
  requestTimeoutMs = 20000,
  concurrency = 1,
  maxRequestRetries = 2
} = {}) => {
  const dataset = await readDataset(datasetPath);
  const start = Math.max(0, Math.floor(Number(offset || 0)));
  const sliceEnd = limit > 0 ? start + limit : undefined;
  const traces = dataset.traces.slice(start, sliceEnd);

  const rows = [];
  const failures = [];

  const safeConcurrency = Math.max(1, Math.floor(Number(concurrency || 1)));
  let processedCount = 0;

  const replayOne = async (trace, index) => {
    const payload = buildChatPayload(trace);

    if (!payload.message) {
      failures.push({ id: trace?.id || `idx-${index}`, error: 'empty message' });
      return;
    }

    const sessionId = String(trace?.metadata?.sessionId || trace?.session_id || `replay-${index}`);

    try {
      let response = null;
      let finalError = null;
      const maxAttempts = Math.max(1, Number(maxRequestRetries || 0) + 1);

      for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
        try {
          response = await postChat({
            baseUrl,
            adaptiveMode,
            requestTimeoutMs,
            payload: {
              ...payload,
              session_id: sessionId,
              emotion_tag: trace?.labels?.emotionTag || null,
              conversation_summary: trace?.labels?.conversationSummary || null,
              current_task_status: trace?.labels?.currentTaskStatus || null
            }
          });
          finalError = null;
          break;
        } catch (error) {
          finalError = error;
        }
      }

      if (!response) {
        throw finalError || new Error('request_failed_after_retries');
      }

      const traceData = await fetchTrace({ baseUrl, traceId: response?.trace_id });
      rows.push(buildReplayRow({ trace, response, traceData }));
    } catch (error) {
      failures.push({ id: trace?.id || `idx-${index}`, error: String(error.message || 'unknown') });
    } finally {
      processedCount += 1;
      if (progress && (processedCount % 100 === 0 || processedCount === traces.length)) {
        console.log(`[trace-replay] progress: ${processedCount}/${traces.length}`);
      }
    }
  };

  for (let index = 0; index < traces.length; index += safeConcurrency) {
    const batch = traces.slice(index, index + safeConcurrency);
    await Promise.allSettled(batch.map((trace, offset) => replayOne(trace, index + offset)));
  }

  const metrics = buildReplayMetrics({
    rows,
    attemptedRows: traces.length,
    baselineToolSuccessRate
  });

  const report = {
    datasetVersion: dataset.datasetVersion,
    datasetPath: path.relative(process.cwd(), datasetPath),
    datasetOffset: start,
    datasetSize: traces.length,
    successfulSamples: rows.length,
    failedSamples: failures.length,
    failures,
    rows,
    metrics,
    generatedAt: new Date().toISOString()
  };

  const reportPath = await writeReport({
    report,
    reportDir,
    datasetVersion: dataset.datasetVersion
  });

  return {
    ...report,
    reportPath: path.relative(process.cwd(), reportPath)
  };
};

const run = async () => {
  const casesArg = getArgValue('--cases');
  const reportDirArg = getArgValue('--report-dir');
  const baseUrlArg = getArgValue('--base-url');
  const limitArg = Number(getArgValue('--limit') || 0);
  const offsetArg = Number(getArgValue('--offset') || 0);
  const adaptiveModeArg = getArgValue('--adaptive-mode') || process.env.ADAPTIVE_ABLATION_MODE || 'full';
  const baselineToolSuccessRateArg = Number(getArgValue('--baseline-tool-success-rate') || 0.72);
  const requestTimeoutArg = Number(getArgValue('--request-timeout-ms') || 20000);
  const concurrencyArg = Number(getArgValue('--concurrency') || 1);
  const maxRequestRetriesArg = Number(getArgValue('--max-request-retries') || 2);

  const result = await runReplayBenchmark({
    datasetPath: casesArg ? path.resolve(process.cwd(), casesArg) : DEFAULT_CASES_PATH,
    reportDir: reportDirArg ? path.resolve(process.cwd(), reportDirArg) : DEFAULT_REPORT_DIR,
    baseUrl: baseUrlArg || DEFAULT_BASE_URL,
    limit: Number.isFinite(limitArg) ? limitArg : 0,
    offset: Number.isFinite(offsetArg) ? Math.max(0, Math.floor(offsetArg)) : 0,
    adaptiveMode: adaptiveModeArg,
    baselineToolSuccessRate: Number.isFinite(baselineToolSuccessRateArg) ? baselineToolSuccessRateArg : 0.72,
    requestTimeoutMs: Number.isFinite(requestTimeoutArg) ? requestTimeoutArg : 20000,
    concurrency: Number.isFinite(concurrencyArg) ? Math.max(1, Math.floor(concurrencyArg)) : 1,
    maxRequestRetries: Number.isFinite(maxRequestRetriesArg) ? Math.max(0, Math.floor(maxRequestRetriesArg)) : 2,
    progress: true
  });

  console.log(JSON.stringify(result, null, 2));
};

if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => {
    console.error('[trace-replay-benchmark] failed:', error.message);
    process.exit(1);
  });
}
