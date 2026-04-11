const RISK_WORDS = ['崩溃', '绝望', '活不下去', '不想活', '自残', '伤害自己', '结束生命'];
const ANXIETY_WORDS = ['焦虑', '慌', '压力', '睡不着', '失眠', '紧张', '害怕'];

const TOOL_WHITELIST = {
  high: ['go_emergency_kit', 'log_decision'],
  medium: ['go_emergency_kit', 'open_treehole', 'recommend_micro_action', 'retrieve_kb_snippets', 'log_decision'],
  low: ['go_emergency_kit', 'open_treehole', 'recommend_micro_action', 'retrieve_kb_snippets', 'log_decision']
};

const MAX_DEPTH = {
  high: 2,
  medium: 5,
  low: 10
};

const FALLBACK_MODE = {
  high: 'safe_emergency',
  medium: 'calm_then_route',
  low: 'continue_chat'
};

const RETRYABLE_ERROR_TYPES = ['tool_timeout', 'kb_empty', 'parse_error', 'hallucination_claim', 'network_error'];
const ABLATION_MODES = ['baseline', 'retry', 'retry_change_tool', 'full'];

const ADAPTIVE_CONTROL_MATRIX = {
  baseline: {
    high: { retry_tool: false, change_tool: false, use_fallback: true, simplify_response: false, max_retry: 0 },
    medium: { retry_tool: false, change_tool: false, use_fallback: false, simplify_response: false, max_retry: 0 },
    low: { retry_tool: false, change_tool: false, use_fallback: false, simplify_response: false, max_retry: 0 }
  },
  retry: {
    high: { retry_tool: true, change_tool: false, use_fallback: true, simplify_response: true, max_retry: 1 },
    medium: { retry_tool: true, change_tool: false, use_fallback: false, simplify_response: false, max_retry: 1 },
    low: { retry_tool: true, change_tool: false, use_fallback: false, simplify_response: false, max_retry: 1 }
  },
  retry_change_tool: {
    high: { retry_tool: true, change_tool: true, use_fallback: true, simplify_response: true, max_retry: 1 },
    medium: { retry_tool: true, change_tool: true, use_fallback: false, simplify_response: false, max_retry: 1 },
    low: { retry_tool: true, change_tool: true, use_fallback: false, simplify_response: false, max_retry: 1 }
  },
  full: {
    high: { retry_tool: true, change_tool: true, use_fallback: true, simplify_response: true, max_retry: 2 },
    medium: { retry_tool: true, change_tool: true, use_fallback: false, simplify_response: true, max_retry: 2 },
    low: { retry_tool: true, change_tool: true, use_fallback: false, simplify_response: false, max_retry: 1 }
  }
};

const includesAny = (text, keywords) => keywords.some((word) => text.includes(word));

export const normalizeRiskLevel = (value) => {
  const normalized = String(value || '').toLowerCase();
  if (normalized === 'high' || normalized === 'medium' || normalized === 'low') {
    return normalized;
  }
  return 'low';
};

export const normalizeAblationMode = (value) => {
  const normalized = String(value || '').toLowerCase();
  return ABLATION_MODES.includes(normalized) ? normalized : 'full';
};

export const isRetryableErrorType = (errorType) => {
  const normalized = String(errorType || 'none').toLowerCase();
  return RETRYABLE_ERROR_TYPES.includes(normalized);
};

const buildRiskSignals = ({ message, moodStats }) => {
  const signals = [];

  if (includesAny(message, RISK_WORDS)) {
    signals.push('risk_words');
  }

  if (includesAny(message, ANXIETY_WORDS)) {
    signals.push('anxiety_words');
  }

  if (Number(moodStats?.lowMoodStreak || 0) >= 2) {
    signals.push('low_mood_streak');
  }

  if (Number(moodStats?.avgStress || 0) >= 3.8) {
    signals.push('high_stress');
  }

  return signals;
};

export const evaluatePolicy = ({
  message = '',
  moodStats = {},
  actionStats = {},
  intent = 'support',
  step = 0
}) => {
  const safeMessage = String(message || '').trim();
  const signals = buildRiskSignals({ message: safeMessage, moodStats });
  const hasRiskWords = signals.includes('risk_words');
  const hasAnxietyWords = signals.includes('anxiety_words');

  let riskLevel = 'low';
  if (hasRiskWords || (hasAnxietyWords && Number(moodStats.lowMoodStreak || 0) >= 2 && Number(moodStats.avgStress || 0) >= 3.8)) {
    riskLevel = 'high';
  } else if (hasAnxietyWords || Number(moodStats.avgStress || 0) >= 3.5 || Number(moodStats.lowMoodStreak || 0) >= 1) {
    riskLevel = 'medium';
  }

  const allowedTools = TOOL_WHITELIST[riskLevel] || TOOL_WHITELIST.low;
  const maxDepth = MAX_DEPTH[riskLevel] || MAX_DEPTH.low;
  const fallbackMode = FALLBACK_MODE[riskLevel] || FALLBACK_MODE.low;

  return {
    riskLevel,
    riskSignals: signals,
    allowedTools,
    maxDepth,
    fallbackMode,
    intent,
    step,
    actionStats: {
      weeklyCount: Number(actionStats?.weeklyCount || 0)
    }
  };
};

export const isToolAllowed = (toolName, policy) => {
  const whitelist = Array.isArray(policy?.allowedTools) ? policy.allowedTools : TOOL_WHITELIST.low;
  return whitelist.includes(String(toolName || ''));
};

export const getFallbackAction = ({ riskLevel, requestedAction }) => {
  const normalized = normalizeRiskLevel(riskLevel);
  const requested = String(requestedAction || 'chat_continue');
  if (normalized === 'high') {
    return 'emergency';
  }
  if (normalized === 'medium') {
    if (requested === 'treehole' || requested === 'micro_action') return requested;
    if (requested === 'emergency' || requested === 'meditate') return 'meditate';
    return 'chat_continue';
  }
  return requested;
};

export const getAdaptiveControlPolicy = ({
  riskLevel,
  ablationMode = 'full',
  step = 0,
  maxDepth = 6,
  toolErrorType = 'none',
  isMultiStep = false,
  isRecoveryAttempt = false
}) => {
  const normalizedRisk = normalizeRiskLevel(riskLevel);
  const normalizedMode = normalizeAblationMode(ablationMode);
  const base = ADAPTIVE_CONTROL_MATRIX[normalizedMode][normalizedRisk];
  const retryable = isRetryableErrorType(toolErrorType);
  const depthPressure = Number(step) >= Math.max(0, Number(maxDepth || 6) - 1);

  const retryTool = base.retry_tool && retryable && Number(step) < Number(maxDepth || 6);
  const changeTool = base.change_tool && retryable && (isMultiStep || isRecoveryAttempt);
  const useFallback = base.use_fallback && (!retryable || depthPressure || isRecoveryAttempt);
  const simplifyResponse = base.simplify_response && (depthPressure || isRecoveryAttempt);

  return {
    riskLevel: normalizedRisk,
    ablationMode: normalizedMode,
    retry_tool: retryTool,
    change_tool: changeTool,
    use_fallback: useFallback,
    simplify_response: simplifyResponse,
    max_retry: retryTool ? Number(base.max_retry || 1) : 0,
    reason: {
      retryable,
      depthPressure,
      isMultiStep: Boolean(isMultiStep),
      isRecoveryAttempt: Boolean(isRecoveryAttempt),
      toolErrorType: String(toolErrorType || 'none')
    }
  };
};
