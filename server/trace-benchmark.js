import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// 这是“离线评测脚本（Harness）”：
// 1) 读取合成的 trace 数据
// 2) 计算 baseline vs treatment 的指标差异
// 3) 聚合出 KPI
// 4) 写入可复现的 JSON 报告

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DEFAULT_CASES_PATH = path.resolve(__dirname, '../result/policy-eval/cases/trace-cases.v1.synthetic.json');
const DEFAULT_REPORT_DIR = path.resolve(__dirname, '../result/policy-eval/reports');
const REQUIRED_EVENT_TYPES = ['user_input', 'policy_decision', 'llm_reasoning', 'tool_call', 'final_output'];
const ABLATION_MODES = ['baseline', 'retry', 'retry_change_tool', 'full'];

// 把浮点数按固定小数位输出，保证报告可读、可比较。
const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

// 安全除法：分母为 0 时返回 0，避免出现 NaN / Infinity。
const safeDivide = (numerator, denominator) => (denominator ? numerator / denominator : 0);

// 从命令行参数里取值，例如：--cases xxx.json。
const getArgValue = (flag) => {
  const index = process.argv.indexOf(flag);
  if (index === -1 || index === process.argv.length - 1) {
    return null;
  }
  return process.argv[index + 1];
};

// 读取并校验数据集：必须是 JSON，且包含 traces 数组。
const readDataset = async (datasetPath) => {
  const raw = await fs.readFile(datasetPath, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.traces) || !parsed.traces.length) {
    throw new Error(`Invalid trace dataset file: ${datasetPath}`);
  }
  return parsed;
};

// 把评测结果写入文件，文件名里带时间戳，避免覆盖历史报告。
const writeReport = async ({ report, reportDir, datasetVersion }) => {
  await fs.mkdir(reportDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const fileName = `trace-benchmark-${datasetVersion || 'v1'}-${timestamp}.json`;
  const filePath = path.join(reportDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return filePath;
};

const getTypes = (trace) => new Set((trace?.events || []).map((item) => item?.type));

// 判断单个事件是否“可回放”：
// 不同类型事件要求不同字段，缺字段就不计为可回放事件。
const isReplayableEvent = (event) => {
  if (!event || typeof event !== 'object') return false;
  if (!event.ts || !event.type || !event.data || typeof event.data !== 'object') return false;

  if (event.type === 'tool_call') {
    return typeof event.data.success === 'boolean' || typeof event.data.blocked === 'boolean';
  }

  if (event.type === 'policy_decision') {
    return typeof event.data.risk_level === 'string' && Array.isArray(event.data.allowed_tools);
  }

  if (event.type === 'final_output') {
    return typeof event.data.next_action === 'string';
  }

  return true;
};

// 汇总数据集画像：样本总数、风险分布、场景分布、挑战类型分布。
const summarizeDataset = (traces) => {
  const summary = {
    total: traces.length,
    riskDistribution: { low: 0, medium: 0, high: 0 },
    domainDistribution: {},
    challengeDistribution: {}
  };

  for (const trace of traces) {
    const risk = trace?.labels?.riskLevel || 'low';
    const domain = trace?.metadata?.scenarioDomain || 'unknown';
    const challenge = trace?.metadata?.challengeType || 'none';

    if (summary.riskDistribution[risk] !== undefined) summary.riskDistribution[risk] += 1;
    summary.domainDistribution[domain] = (summary.domainDistribution[domain] || 0) + 1;
    summary.challengeDistribution[challenge] = (summary.challengeDistribution[challenge] || 0) + 1;
  }

  return summary;
};

const getFinalOutputEvent = (trace) => {
  const events = Array.isArray(trace?.events) ? trace.events : [];
  const finals = events.filter((event) => event.type === 'final_output');
  return finals.length ? finals[finals.length - 1] : null;
};

// 优先读 labels.treatmentAction；
// 如果没有，就退回到 final_output.next_action。
const getTreatmentAction = (trace) => {
  const fromLabel = trace?.labels?.treatmentAction;
  if (typeof fromLabel === 'string' && fromLabel) return fromLabel;
  const finalOutput = getFinalOutputEvent(trace);
  return String(finalOutput?.data?.next_action || trace?.labels?.expectedAction || 'chat_continue');
};

// 幻觉标记来源：
// 1) labels.hallucinationDetected
// 2) 事件流里出现 hallucination_flag
const hasHallucination = (trace) => {
  if (trace?.labels?.hallucinationDetected === true) return true;
  return (trace?.events || []).some((event) => event.type === 'hallucination_flag');
};

// 消融实验里“是否成功”的判定规则：
// baseline -> retry -> retry+change_tool -> full。
const getAblationOutcome = ({ trace, mode }) => {
  const baselineBusiness = Boolean(trace?.labels?.baselineTaskSuccessBusiness);
  const treatmentBusiness = Boolean(trace?.labels?.taskSuccessBusiness);
  const retryableFailure = Boolean(trace?.labels?.retryableFailure);
  const challengeType = String(trace?.metadata?.challengeType || 'none');

  if (mode === 'baseline') return baselineBusiness;
  if (mode === 'retry') {
    return baselineBusiness || (retryableFailure && treatmentBusiness);
  }
  if (mode === 'retry_change_tool') {
    return baselineBusiness
      || (retryableFailure && treatmentBusiness)
      || (challengeType === 'tool_blocked' && treatmentBusiness);
  }
  return treatmentBusiness;
};

// 消融实验里“副作用成本”的估算规则（时延/步骤/token）。
const getAblationSideEffects = ({ trace, mode }) => {
  const baselineLatency = Number(trace?.labels?.baselineLatencyMs || 0);
  const baselineSteps = Number(trace?.labels?.baselineAvgSteps || trace?.metadata?.conversationTurns || 0);
  const baselineTokens = Number(trace?.labels?.baselineTokenCost || 0);
  const treatmentLatency = Number(trace?.labels?.treatmentLatencyMs || trace?.metadata?.runtimeMs || baselineLatency);
  const treatmentSteps = Number(trace?.labels?.treatmentAvgSteps || trace?.metadata?.toolCalls || baselineSteps);
  const treatmentTokens = Number(trace?.labels?.treatmentTokenCost || baselineTokens);
  const retryableFailure = Boolean(trace?.labels?.retryableFailure);
  const challengeType = String(trace?.metadata?.challengeType || 'none');

  if (mode === 'baseline') {
    return { latencyMs: baselineLatency, steps: baselineSteps, tokenCost: baselineTokens };
  }

  if (mode === 'retry') {
    return {
      latencyMs: baselineLatency + (retryableFailure ? 120 : 0),
      steps: baselineSteps + (retryableFailure ? 0.6 : 0),
      tokenCost: baselineTokens + (retryableFailure ? 140 : 0)
    };
  }

  if (mode === 'retry_change_tool') {
    const changed = retryableFailure || challengeType === 'tool_blocked';
    return {
      latencyMs: baselineLatency + (changed ? 200 : 0),
      steps: baselineSteps + (changed ? 1 : 0),
      tokenCost: baselineTokens + (changed ? 180 : 0)
    };
  }

  return {
    latencyMs: treatmentLatency,
    steps: treatmentSteps,
    tokenCost: treatmentTokens
  };
};

// 核心评测函数：
// 1) 遍历 traces，累计原始计数器
// 2) 把计数器归一化为比例/均值
// 3) 产出消融结论和文字总结
export const evaluateTraceDataset = (
  dataset,
  {
    baselineToolSuccessRate = 0.72,
    targets = {
      taskSuccessRateBusiness: 0.9,
      toolCallAccuracy: 0.95,
      fallbackRate: 0.2,
      decisionAccuracy: 0.88,
      hallucinationRate: 0.08
    }
  } = {}
) => {
  const traces = Array.isArray(dataset?.traces) ? dataset.traces : [];

  // 下面是一组“计分板变量”：
  // 覆盖 trace 质量、工具调用、任务成功、时延成本、一致性稳定性等维度。
  let tracesComplete = 0;
  let replayableTraces = 0;
  let replayableEventRateSum = 0;
  let totalToolCalls = 0;
  let successfulToolCalls = 0;
  let correctToolCalls = 0;
  let exceptionChains = 0;
  let treatmentReasoningSteps = 0;
  let baselineReasoningSteps = 0;
  let baselineDiagnosisSeconds = 0;
  let traceDiagnosisSeconds = 0;
  let baselineDecisionCorrect = 0;
  let treatmentDecisionCorrect = 0;
  let baselineTaskSuccessStrict = 0;
  let treatmentTaskSuccessStrict = 0;
  let baselineTaskSuccessBusiness = 0;
  let treatmentTaskSuccessBusiness = 0;
  let baselineFallbackCount = 0;
  let treatmentFallbackCount = 0;
  let baselineHallucinations = 0;
  let treatmentHallucinations = 0;
  let multiStepTotal = 0;
  let multiStepSuccess = 0;
  let recoveryEligible = 0;
  let recoverySuccess = 0;
  let baselineLatencySum = 0;
  let treatmentLatencySum = 0;
  let baselineStepSum = 0;
  let treatmentStepSum = 0;
  let baselineTokenCostSum = 0;
  let treatmentTokenCostSum = 0;
  let consistencyEligibleTurns = 0;
  let baselineConsistencyOkTurns = 0;
  let treatmentConsistencyOkTurns = 0;
  let baselineRepeatedDecisionTurns = 0;
  let treatmentRepeatedDecisionTurns = 0;
  const ablation = {
    baseline: { success: 0, latencyMs: 0, steps: 0, tokenCost: 0 },
    retry: { success: 0, latencyMs: 0, steps: 0, tokenCost: 0 },
    retry_change_tool: { success: 0, latencyMs: 0, steps: 0, tokenCost: 0 },
    full: { success: 0, latencyMs: 0, steps: 0, tokenCost: 0 }
  };

  for (const trace of traces) {
    const events = Array.isArray(trace.events) ? trace.events : [];
    const types = getTypes(trace);

    // A) Trace 完整性 + 可回放率
    // complete: 关键事件是否齐全
    // replayableRate: 这条 trace 里可回放事件占比
    const complete = REQUIRED_EVENT_TYPES.every((type) => types.has(type));
    if (complete) tracesComplete += 1;

    const replayableEvents = events.filter((event) => isReplayableEvent(event));
    const replayableRate = safeDivide(replayableEvents.length, events.length);
    replayableEventRateSum += replayableRate;

    if (complete && replayableRate >= 0.85) {
      replayableTraces += 1;
    }

    // B) 工具调用行为
    // attempts: 调用次数
    // successful: 调用成功次数
    // correct: 成功且不是 blocked 的次数
    const toolEvents = events.filter((event) => event.type === 'tool_call');
    totalToolCalls += toolEvents.length;

    // filter()方法返回新数组，不修改原数组
    // 可以理解为："筛选"出一个新列表，然后数这个列表有多少项
    successfulToolCalls += toolEvents.filter((event) => event.data?.success === true).length;
    correctToolCalls += toolEvents.filter((event) => event.data?.success === true && event.data?.blocked !== true).length;

    if (events.some((event) => event.type === 'exception')) {
      exceptionChains += 1;
    }

    // C) 推理步数与决策目标
    // treatmentReasoningSteps: treatment 侧 llm_reasoning 事件数
    // baselineReasoningSteps: baseline 侧历史会话轮数（来自 metadata）
    treatmentReasoningSteps += events.filter((event) => event.type === 'llm_reasoning').length;
    baselineReasoningSteps += Number(trace?.metadata?.conversationTurns || 0);

    const decisionTarget = String(trace?.labels?.decisionTarget || trace?.labels?.expectedAction || 'chat_continue');
    const baselineAction = String(trace?.labels?.requestedAction || 'chat_continue');
    const treatmentAction = getTreatmentAction(trace);
    const allowedSafeFallback = Array.isArray(trace?.labels?.allowedSafeFallback) ? trace.labels.allowedSafeFallback : [];

    const baselineDecisionOK = baselineAction === decisionTarget;
    const treatmentDecisionOK = treatmentAction === decisionTarget;
    baselineDecisionCorrect += baselineDecisionOK ? 1 : 0;
    treatmentDecisionCorrect += treatmentDecisionOK ? 1 : 0;

    const baselineHall = Boolean(trace?.labels?.baselineHallucinationDetected);
    const treatmentHall = hasHallucination(trace);
    baselineHallucinations += baselineHall ? 1 : 0;
    treatmentHallucinations += treatmentHall ? 1 : 0;

    // D) strict/business 成功判定
    // strict: 更严格，强调决策正确且无幻觉
    // business: 允许“安全兜底动作”也算业务成功
    const baselineStrictOK = Boolean(trace?.labels?.baselineTaskSuccessStrict ?? (baselineDecisionOK && !baselineHall));
    const treatmentStrictOK = Boolean(trace?.labels?.taskSuccessStrict ?? (treatmentDecisionOK && !treatmentHall));
    baselineTaskSuccessStrict += baselineStrictOK ? 1 : 0;
    treatmentTaskSuccessStrict += treatmentStrictOK ? 1 : 0;

    const baselineBusinessOK = Boolean(
      trace?.labels?.baselineTaskSuccessBusiness
      ?? ((baselineStrictOK || allowedSafeFallback.includes(baselineAction)) && !baselineHall)
    );
    const treatmentBusinessOK = Boolean(
      trace?.labels?.taskSuccessBusiness
      ?? ((treatmentStrictOK || allowedSafeFallback.includes(treatmentAction)) && !treatmentHall)
    );
    baselineTaskSuccessBusiness += baselineBusinessOK ? 1 : 0;
    treatmentTaskSuccessBusiness += treatmentBusinessOK ? 1 : 0;

    // E) fallback 使用统计
    // baseline 用标签；treatment 可来自标签或 final_output 标记。
    baselineFallbackCount += Number(trace?.labels?.baselineFallbackRate ? 1 : 0);
    const fallbackApplied = Boolean(trace?.labels?.fallbackUsed || getFinalOutputEvent(trace)?.data?.fallback_applied);
    treatmentFallbackCount += fallbackApplied ? 1 : 0;

    // F) 多步任务成功率 + 错误恢复率
    // originallyFailed/recoverySuccess 都是“恢复能力”口径。
    const isMultiStep = Boolean(trace?.labels?.isMultiStep || Number(trace?.labels?.stepCount || 0) >= 2);
    if (isMultiStep) {
      multiStepTotal += 1;
      if (treatmentBusinessOK) {
        multiStepSuccess += 1;
      }
    }

    const originallyFailed = Boolean(trace?.labels?.originallyFailed);
    if (originallyFailed) {
      recoveryEligible += 1;
      if (Boolean(trace?.labels?.recoverySuccess)) {
        recoverySuccess += 1;
      }
    }

    // G) 效率与成本维度
    // 累计诊断耗时、延迟、步骤、token，后面会算均值与变化率。
    baselineDiagnosisSeconds += Number(trace?.labels?.baselineDiagnosisSeconds || 0);
    traceDiagnosisSeconds += Number(trace?.labels?.traceDiagnosisSeconds || 0);

    baselineLatencySum += Number(trace?.labels?.baselineLatencyMs || 0);
    treatmentLatencySum += Number(trace?.labels?.treatmentLatencyMs || 0);
    baselineStepSum += Number(trace?.labels?.baselineAvgSteps || trace?.metadata?.conversationTurns || 0);
    treatmentStepSum += Number(trace?.labels?.treatmentAvgSteps || trace?.metadata?.toolCalls || 0);
    baselineTokenCostSum += Number(trace?.labels?.baselineTokenCost || 0);
    treatmentTokenCostSum += Number(trace?.labels?.treatmentTokenCost || 0);

    // H) 消融模式累计
    // 每条 trace 在 4 种模式下都累计 success 与 side effects。
    for (const mode of ABLATION_MODES) {
      const ok = getAblationOutcome({ trace, mode });
      if (ok) {
        ablation[mode].success += 1;
      }
      const effects = getAblationSideEffects({ trace, mode });
      ablation[mode].latencyMs += Number(effects.latencyMs || 0);
      ablation[mode].steps += Number(effects.steps || 0);
      ablation[mode].tokenCost += Number(effects.tokenCost || 0);
    }

    // I) 会话记忆状态质量
    // 一致性只在 eligible 样本上统计；重复决策在全样本统计。
    const eligibleForConsistency = Boolean(trace?.labels?.eligibleForConsistency);
    if (eligibleForConsistency) {
      consistencyEligibleTurns += 1;
      if (Boolean(trace?.labels?.baselineConsistencyOk)) {
        baselineConsistencyOkTurns += 1;
      }
      if (Boolean(trace?.labels?.treatmentConsistencyOk)) {
        treatmentConsistencyOkTurns += 1;
      }
    }

    baselineRepeatedDecisionTurns += Boolean(trace?.labels?.baselineRepeatedDecisionTurn) ? 1 : 0;
    treatmentRepeatedDecisionTurns += Boolean(trace?.labels?.treatmentRepeatedDecisionTurn) ? 1 : 0;
  }

  // 把“累计计数”转成“可比较指标”（比例/均值）。
  const total = traces.length;
  const traceCompletenessRate = safeDivide(tracesComplete, total);
  const replayabilityRate = safeDivide(replayableTraces, total);
  const avgReplayableEventRate = safeDivide(replayableEventRateSum, total);

  const toolSuccessRate = safeDivide(successfulToolCalls, totalToolCalls);
  const toolCallAccuracy = safeDivide(correctToolCalls, totalToolCalls);
  const toolSuccessRateUplift = safeDivide(toolSuccessRate - baselineToolSuccessRate, baselineToolSuccessRate);
  const toolCallAccuracyUplift = safeDivide(toolCallAccuracy - baselineToolSuccessRate, baselineToolSuccessRate);

  const baselineAvgDiagnosisSeconds = safeDivide(baselineDiagnosisSeconds, total);
  const traceAvgDiagnosisSeconds = safeDivide(traceDiagnosisSeconds, total);
  const localizationEfficiencyUplift = safeDivide(
    baselineAvgDiagnosisSeconds - traceAvgDiagnosisSeconds,
    baselineAvgDiagnosisSeconds
  );

  // 核心 KPI 集合：这是报告里最主要的一组数值。
  const metrics = {
    // 任务成功类
    taskSuccessRateStrict: round(safeDivide(treatmentTaskSuccessStrict, total)),
    taskSuccessRateStrictBaseline: round(safeDivide(baselineTaskSuccessStrict, total)),
    taskSuccessRateBusiness: round(safeDivide(treatmentTaskSuccessBusiness, total)),
    taskSuccessRateBusinessBaseline: round(safeDivide(baselineTaskSuccessBusiness, total)),
    taskSuccessRateBusinessUplift: round(
      safeDivide(
        safeDivide(treatmentTaskSuccessBusiness, total) - safeDivide(baselineTaskSuccessBusiness, total),
        Math.max(safeDivide(baselineTaskSuccessBusiness, total), 0.0001)
      )
    ),
    // 工具与决策质量
    toolCallAccuracy: round(toolCallAccuracy),
    toolCallAccuracyBaseline: round(baselineToolSuccessRate),
    toolCallAccuracyUplift: round(toolCallAccuracyUplift),
    decisionAccuracy: round(safeDivide(treatmentDecisionCorrect, total)),
    decisionAccuracyBaseline: round(safeDivide(baselineDecisionCorrect, total)),
    // 风险控制类
    fallbackRate: round(safeDivide(treatmentFallbackCount, total)),
    fallbackRateBaseline: round(safeDivide(baselineFallbackCount, total)),
    fallbackRateDelta: round(safeDivide(treatmentFallbackCount, total) - safeDivide(baselineFallbackCount, total)),
    hallucinationRate: round(safeDivide(treatmentHallucinations, total)),
    hallucinationRateBaseline: round(safeDivide(baselineHallucinations, total)),
    // Trace 可观测性与可回放质量
    avgStepsPerTask: round(safeDivide(treatmentReasoningSteps, total), 2),
    avgStepsPerTaskBaseline: round(safeDivide(baselineReasoningSteps, total), 2),
    traceCompletenessRate: round(traceCompletenessRate),
    replayabilityRate: round(replayabilityRate),
    avgReplayableEventRate: round(avgReplayableEventRate),
    // 工具成功率与定位效率
    avgReasoningSteps: round(safeDivide(treatmentReasoningSteps, total), 2),
    exceptionChainRate: round(safeDivide(exceptionChains, total)),
    toolSuccessRate: round(toolSuccessRate),
    toolSuccessRateBaseline: round(baselineToolSuccessRate),
    toolSuccessRateUplift: round(toolSuccessRateUplift),
    localizationEfficiencyUplift: round(localizationEfficiencyUplift),
    baselineAvgDiagnosisSeconds: round(baselineAvgDiagnosisSeconds, 2),
    traceAvgDiagnosisSeconds: round(traceAvgDiagnosisSeconds, 2),
    // 多步任务与恢复能力
    multiStepTaskSuccessRate: round(safeDivide(multiStepSuccess, multiStepTotal)),
    multiStepTaskShare: round(safeDivide(multiStepTotal, total)),
    errorRecoveryRate: round(safeDivide(recoverySuccess, recoveryEligible)),
    recoveryEligibleShare: round(safeDivide(recoveryEligible, total)),
    // 时延、步骤、token 成本
    latencyMsBaseline: round(safeDivide(baselineLatencySum, total), 2),
    latencyMs: round(safeDivide(treatmentLatencySum, total), 2),
    latencyDeltaPct: round(safeDivide(safeDivide(treatmentLatencySum, total) - safeDivide(baselineLatencySum, total), Math.max(safeDivide(baselineLatencySum, total), 0.0001))),
    avgStepsBaseline: round(safeDivide(baselineStepSum, total), 2),
    avgSteps: round(safeDivide(treatmentStepSum, total), 2),
    tokenCostBaseline: round(safeDivide(baselineTokenCostSum, total), 2),
    tokenCost: round(safeDivide(treatmentTokenCostSum, total), 2),
    tokenCostDeltaPct: round(safeDivide(safeDivide(treatmentTokenCostSum, total) - safeDivide(baselineTokenCostSum, total), Math.max(safeDivide(baselineTokenCostSum, total), 0.0001))),
    // 多轮一致性与重复决策
    consistencyScoreBaseline: round(safeDivide(baselineConsistencyOkTurns, consistencyEligibleTurns)),
    consistencyScore: round(safeDivide(treatmentConsistencyOkTurns, consistencyEligibleTurns)),
    consistencyScoreUplift: round(
      safeDivide(
        safeDivide(treatmentConsistencyOkTurns, consistencyEligibleTurns) - safeDivide(baselineConsistencyOkTurns, consistencyEligibleTurns),
        Math.max(safeDivide(baselineConsistencyOkTurns, consistencyEligibleTurns), 0.0001)
      )
    ),
    repeatedDecisionRateBaseline: round(safeDivide(baselineRepeatedDecisionTurns, total)),
    repeatedDecisionRate: round(safeDivide(treatmentRepeatedDecisionTurns, total)),
    repeatedDecisionRateDelta: round(safeDivide(treatmentRepeatedDecisionTurns, total) - safeDivide(baselineRepeatedDecisionTurns, total))
  };

  // 消融模式汇总：看每一层控制策略分别带来什么收益/成本。
  const ablationSummary = {
    baseline: {
      taskSuccessRateBusiness: round(safeDivide(ablation.baseline.success, total)),
      latencyMs: round(safeDivide(ablation.baseline.latencyMs, total), 2),
      avgSteps: round(safeDivide(ablation.baseline.steps, total), 2),
      tokenCost: round(safeDivide(ablation.baseline.tokenCost, total), 2)
    },
    retry: {
      taskSuccessRateBusiness: round(safeDivide(ablation.retry.success, total)),
      latencyMs: round(safeDivide(ablation.retry.latencyMs, total), 2),
      avgSteps: round(safeDivide(ablation.retry.steps, total), 2),
      tokenCost: round(safeDivide(ablation.retry.tokenCost, total), 2)
    },
    retry_change_tool: {
      taskSuccessRateBusiness: round(safeDivide(ablation.retry_change_tool.success, total)),
      latencyMs: round(safeDivide(ablation.retry_change_tool.latencyMs, total), 2),
      avgSteps: round(safeDivide(ablation.retry_change_tool.steps, total), 2),
      tokenCost: round(safeDivide(ablation.retry_change_tool.tokenCost, total), 2)
    },
    full: {
      taskSuccessRateBusiness: round(safeDivide(ablation.full.success, total)),
      latencyMs: round(safeDivide(ablation.full.latencyMs, total), 2),
      avgSteps: round(safeDivide(ablation.full.steps, total), 2),
      tokenCost: round(safeDivide(ablation.full.tokenCost, total), 2)
    }
  };

  // 贡献拆解：逐层比较 success 提升（pp）。
  const contribution = {
    retryX: round(ablationSummary.retry.taskSuccessRateBusiness - ablationSummary.baseline.taskSuccessRateBusiness),
    changeToolY: round(ablationSummary.retry_change_tool.taskSuccessRateBusiness - ablationSummary.retry.taskSuccessRateBusiness),
    fullExtra: round(ablationSummary.full.taskSuccessRateBusiness - ablationSummary.retry_change_tool.taskSuccessRateBusiness)
  };

  // 自动生成可直接写进报告的中文结论。
  const conclusions = {
    taskConclusion: `任务完成率（business）提升至 ${(metrics.taskSuccessRateBusiness * 100).toFixed(2)}%，较基线提升 ${(metrics.taskSuccessRateBusinessUplift * 100).toFixed(2)}%。`,
    decisionConclusion: `决策正确率提升至 ${(metrics.decisionAccuracy * 100).toFixed(2)}%。`,
    observabilityConclusion: `Trace 完整率 ${(metrics.traceCompletenessRate * 100).toFixed(2)}%，回放率 ${(metrics.replayabilityRate * 100).toFixed(2)}%。`,
    efficiencyConclusion: `问题定位效率提升 ${(metrics.localizationEfficiencyUplift * 100).toFixed(2)}%。`,
    toolConclusion: `工具调用准确率提升至 ${(metrics.toolCallAccuracy * 100).toFixed(2)}%，较基线提升 ${(metrics.toolCallAccuracyUplift * 100).toFixed(2)}%。`,
    fallbackConclusion: `fallback 率为 ${(metrics.fallbackRate * 100).toFixed(2)}%，较基线变化 ${(metrics.fallbackRateDelta * 100).toFixed(2)} 个百分点。`,
    adaptiveConclusion: `消融贡献：retry=${(contribution.retryX * 100).toFixed(2)}pp，change_tool=${(contribution.changeToolY * 100).toFixed(2)}pp；multi-step成功率 ${(metrics.multiStepTaskSuccessRate * 100).toFixed(2)}%，恢复成功率 ${(metrics.errorRecoveryRate * 100).toFixed(2)}%。`,
    memoryStateConclusion: `多轮一致性得分从 ${(metrics.consistencyScoreBaseline * 100).toFixed(2)}% 提升到 ${(metrics.consistencyScore * 100).toFixed(2)}%，重复决策率从 ${(metrics.repeatedDecisionRateBaseline * 100).toFixed(2)}% 变化到 ${(metrics.repeatedDecisionRate * 100).toFixed(2)}%。`
  };

  return {
    datasetVersion: dataset?.datasetVersion || 'trace-v1',
    datasetSize: total,
    datasetSummary: summarizeDataset(traces),
    targets,
    metrics,
    ablation: {
      modes: ablationSummary,
      contribution
    },
    conclusions
  };
};

// 命令行入口：
// 读参数 -> 评测 -> 组装 report -> 落盘 -> 控制台打印。
const run = async () => {
  const customCasesPath = getArgValue('--cases');
  const customReportDir = getArgValue('--report-dir');
  const baselineToolSuccessRate = Number(getArgValue('--baseline-tool-success-rate') || 0.72);
  const targetTaskSuccessRate = Number(getArgValue('--target-task-success-rate') || 0.9);
  const targetToolCallAccuracy = Number(getArgValue('--target-tool-call-accuracy') || 0.95);
  const targetFallbackRate = Number(getArgValue('--target-fallback-rate') || 0.2);

  const casesPath = customCasesPath
    ? path.resolve(process.cwd(), customCasesPath)
    : DEFAULT_CASES_PATH;

  const reportDir = customReportDir
    ? path.resolve(process.cwd(), customReportDir)
    : DEFAULT_REPORT_DIR;

  const dataset = await readDataset(casesPath);
  const result = evaluateTraceDataset(dataset, {
    baselineToolSuccessRate,
    targets: {
      taskSuccessRateBusiness: targetTaskSuccessRate,
      toolCallAccuracy: targetToolCallAccuracy,
      fallbackRate: targetFallbackRate,
      decisionAccuracy: 0.88,
      hallucinationRate: 0.08
    }
  });

  const report = {
    ...result,
    datasetPath: path.relative(process.cwd(), casesPath),
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

// 只有“直接执行脚本”才 run；
// 被测试文件 import 时不会自动执行，避免副作用。
if (process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1])) {
  run().catch((error) => {
    console.error('[trace-benchmark] failed:', error.message);
    process.exit(1);
  });
}
