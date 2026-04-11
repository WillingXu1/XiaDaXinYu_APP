import cors from 'cors';
import dotenv from 'dotenv';
import express from 'express';
import { getKbStatus, searchClinicalGuideline } from './kb/retriever.js';
import { createAgentGraph } from './langchain/graph.js';
import { createAgentModel } from './langchain/model.js';
import { AGENT_TOOL_NAMES } from './langchain/tools.js';
import {
  evaluatePolicy,
  getFallbackAction,
  isToolAllowed,
  normalizeAblationMode
} from './policy-engine.js';
import { buildConclusionFromBaseline, createMetricsTracker } from './policy-metrics.js';
import { createTraceId, createTraceLogger, maskText } from './trace-logger.js';

dotenv.config();

const app = express();
const PORT = Number(process.env.AGENT_SERVER_PORT || 8787);

app.use(cors());
app.use(express.json({ limit: '1mb' }));

const policyMetricsTracker = createMetricsTracker();
const traceLogger = createTraceLogger();

const RISK_WORDS = ['崩溃', '绝望', '活不下去', '不想活', '自残', '伤害自己', '结束生命'];
const ANXIETY_WORDS = ['焦虑', '慌', '压力', '睡不着', '失眠', '紧张', '害怕'];
const VENT_WORDS = ['想倾诉', '想发泄', '不想被说教', '只想说说', '憋屈', '难受'];
const ACTION_WORDS = ['怎么办', '怎么做', '建议', '给我方法', '给我步骤', '下一步'];

const FALLBACK_UI_TARGET = {
  emergency: '/emergency-kit',
  meditate: '/emergency-kit',
  treehole: '/treehole',
  micro_action: '/action',
  chat_continue: '/ai'
};

const RETRYABLE_ERRORS = new Set(['tool_timeout', 'kb_empty', 'parse_error', 'hallucination_claim', 'network_error']);
const SESSION_STORE = new Map();
const SESSION_MAX = 5000;
const SESSION_TTL_MS = 6 * 60 * 60 * 1000;

const POSITIVE_WORDS = ['好一些', '缓解', '稳定', '谢谢', '有帮助', '轻松', '完成了', '好多了'];
const TASK_DONE_WORDS = ['完成了', '做完了', '好多了', '缓解了', '稳定了'];

const createSessionId = () => `sess-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

const createDefaultSessionState = (sessionId) => ({
  session_id: sessionId || createSessionId(),
  emotion_tag: 'negative',
  conversation_summary: '',
  current_task_status: 'idle',
  last_decision_action: 'chat_continue',
  consecutive_same_decision_count: 0,
  last_updated_at: new Date().toISOString()
});

const pruneSessionStore = () => {
  const now = Date.now();
  for (const [key, value] of SESSION_STORE.entries()) {
    const ts = new Date(value.last_updated_at || 0).getTime();
    if (!Number.isFinite(ts) || now - ts > SESSION_TTL_MS) {
      SESSION_STORE.delete(key);
    }
  }

  if (SESSION_STORE.size <= SESSION_MAX) return;
  const entries = Array.from(SESSION_STORE.entries());
  entries.sort((a, b) => new Date(a[1].last_updated_at).getTime() - new Date(b[1].last_updated_at).getTime());
  const removeCount = SESSION_STORE.size - SESSION_MAX;
  for (let i = 0; i < removeCount; i += 1) {
    SESSION_STORE.delete(entries[i][0]);
  }
};

const resolveSessionState = ({ sessionId, incomingState }) => {
  pruneSessionStore();
  const key = String(sessionId || incomingState?.session_id || createSessionId());
  const current = SESSION_STORE.get(key) || createDefaultSessionState(key);
  const merged = {
    ...current,
    session_id: key,
    emotion_tag: incomingState?.emotion_tag || current.emotion_tag,
    conversation_summary: incomingState?.conversation_summary || current.conversation_summary,
    current_task_status: incomingState?.current_task_status || current.current_task_status
  };
  SESSION_STORE.set(key, merged);
  return merged;
};

const inferEmotionTag = ({ message, riskLevel }) => {
  const text = String(message || '');
  if (riskLevel === 'high') return 'negative';
  if (POSITIVE_WORDS.some((word) => text.includes(word))) return 'positive';
  return 'negative';
};

const buildConversationSummary = ({ previousSummary, message, nextAction }) => {
  const current = maskText(message, 36);
  const previous = String(previousSummary || '').trim();
  const merged = previous
    ? `${previous} | 主题:${current}; 动作:${nextAction}`
    : `主题:${current}; 动作:${nextAction}`;
  return merged.slice(-240);
};

const deriveTaskStatus = ({ previousStatus, nextAction, message, riskLevel }) => {
  const normalizedPrev = String(previousStatus || 'idle');
  const text = String(message || '');
  if (riskLevel === 'high' || nextAction === 'emergency') return 'escalated';
  if (TASK_DONE_WORDS.some((word) => text.includes(word))) return 'resolved';
  if (nextAction === 'meditate' || nextAction === 'treehole' || nextAction === 'micro_action') return 'in_progress';
  if (normalizedPrev === 'in_progress' && nextAction === 'chat_continue') return 'resolved';
  return normalizedPrev === 'escalated' ? 'escalated' : 'idle';
};

const classifyToolError = (toolResult) => {
  if (!toolResult) return 'unknown_error';
  if (toolResult.blocked) return 'tool_not_allowed';
  const raw = String(toolResult.error || '').toLowerCase();
  if (!raw) return 'unknown_error';
  if (raw.includes('timeout')) return 'tool_timeout';
  if (raw.includes('kb_empty')) return 'kb_empty';
  if (raw.includes('parse')) return 'parse_error';
  if (raw.includes('hallucination')) return 'hallucination_claim';
  if (raw.includes('network')) return 'network_error';
  return raw.replace(/\s+/g, '_').slice(0, 48) || 'unknown_error';
};

const buildAdaptiveToolCall = ({ targetTool, runtimeState, reason }) => {
  if (targetTool === 'go_emergency_kit') {
    return {
      function: {
        name: 'go_emergency_kit',
        arguments: JSON.stringify({
          reason: reason || '自动降级到安全干预',
          confidence: 0.82,
          level: runtimeState.policy?.riskLevel === 'high' ? 'emergency' : 'meditate'
        })
      }
    };
  }

  if (targetTool === 'open_treehole') {
    return {
      function: {
        name: 'open_treehole',
        arguments: JSON.stringify({
          reason: reason || '主策略失败，转为倾诉通道',
          confidence: 0.72
        })
      }
    };
  }

  if (targetTool === 'recommend_micro_action') {
    return {
      function: {
        name: 'recommend_micro_action',
        arguments: JSON.stringify({
          reason: reason || '主策略失败，降级到低成本微行动',
          confidence: 0.7,
          action_title: '3分钟站立呼吸',
          action_description: '离开屏幕，做30次缓慢呼吸后再回来。',
          minutes: 3
        })
      }
    };
  }

  return {
    function: {
      name: 'log_decision',
      arguments: JSON.stringify({
        decision_type: runtimeState.next_action || 'chat_continue',
        reason: reason || '策略恢复阶段记录决策',
        confidence: clamp(Number(runtimeState.confidence || 0.65), 0, 1)
      })
    }
  };
};

const pickAlternativeTool = ({ failedToolName, policy }) => {
  const allowed = Array.isArray(policy?.allowedTools) ? policy.allowedTools : [];
  if (!allowed.length) return null;

  if (policy?.riskLevel === 'high' && allowed.includes('go_emergency_kit')) {
    return failedToolName === 'go_emergency_kit' ? 'log_decision' : 'go_emergency_kit';
  }

  const rankedCandidates = ['recommend_micro_action', 'open_treehole', 'go_emergency_kit', 'log_decision'];
  for (const candidate of rankedCandidates) {
    if (candidate !== failedToolName && allowed.includes(candidate)) {
      return candidate;
    }
  }

  return null;
};

const AGENT_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'go_emergency_kit',
      description: '在高风险情绪或高焦虑状态下，引导用户进入急救箱进行呼吸稳定。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string', description: '简要原因' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          level: { type: 'string', enum: ['meditate', 'emergency'], description: 'meditate表示呼吸干预，emergency表示高风险兜底' }
        },
        required: ['reason', 'confidence', 'level']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'open_treehole',
      description: '当用户更需要倾诉和释放时，引导进入树洞表达。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['reason', 'confidence']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'recommend_micro_action',
      description: '当用户适合行为激活时，推荐一个3-10分钟微行动。',
      parameters: {
        type: 'object',
        properties: {
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 },
          action_title: { type: 'string' },
          action_description: { type: 'string' },
          minutes: { type: 'number', minimum: 3, maximum: 10 }
        },
        required: ['reason', 'confidence', 'action_title', 'action_description', 'minutes']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'retrieve_kb_snippets',
      description: '从临床指南知识库中检索与当前用户问题相关的参考片段。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          top_k: { type: 'number', minimum: 1, maximum: 8 }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'log_decision',
      description: '记录最终决策日志（用于审计和后续优化）。',
      parameters: {
        type: 'object',
        properties: {
          decision_type: { type: 'string', enum: ['meditate', 'treehole', 'micro_action', 'chat_continue', 'emergency'] },
          reason: { type: 'string' },
          confidence: { type: 'number', minimum: 0, maximum: 1 }
        },
        required: ['decision_type', 'reason', 'confidence']
      }
    }
  }
];

const ALL_TOOL_NAMES = AGENT_TOOLS.map((item) => item.function.name);

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

const includesAny = (text, keywords) => keywords.some((word) => text.includes(word));
const safeJsonParse = (text, fallback = {}) => {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
};

const getRecentMoodStats = (moodData = []) => {
  const recent = [...moodData].slice(-7);
  if (!recent.length) {
    return { avgMood: 3, avgStress: 3, lowMoodStreak: 0 };
  }

  const avgMood = recent.reduce((sum, item) => sum + Number(item.mood || 3), 0) / recent.length;
  const avgStress = recent.reduce((sum, item) => sum + Number(item.stress || 3), 0) / recent.length;

  let lowMoodStreak = 0;
  for (let i = recent.length - 1; i >= 0; i -= 1) {
    if (Number(recent[i].mood || 3) <= 2.5) {
      lowMoodStreak += 1;
    } else {
      break;
    }
  }

  return {
    avgMood: Number(avgMood.toFixed(2)),
    avgStress: Number(avgStress.toFixed(2)),
    lowMoodStreak
  };
};

const getRecentActionStats = (completedActions = []) => {
  const now = Date.now();
  const recent = completedActions.filter((item) => {
    const ts = new Date(item.completedAt || '').getTime();
    return Number.isFinite(ts) && now - ts <= 7 * 24 * 60 * 60 * 1000;
  });

  return {
    weeklyCount: recent.length
  };
};

const detectIntent = (message) => {
  if (includesAny(message, VENT_WORDS)) return 'vent';
  if (includesAny(message, ACTION_WORDS)) return 'action';
  if (message.includes('陪陪') || message.includes('聊聊')) return 'support';
  return 'support';
};

const decideNextAction = ({ message, moodStats, actionStats }) => {
  const hasCrisisWord = includesAny(message, RISK_WORDS);
  const hasAnxietyWord = includesAny(message, ANXIETY_WORDS);
  const intent = detectIntent(message);

  const highRisk = hasCrisisWord || (hasAnxietyWord && moodStats.lowMoodStreak >= 2 && moodStats.avgStress >= 3.8);
  if (highRisk) {
    return {
      next_action: 'emergency',
      reason: '检测到高风险情绪信号，建议优先进行安全稳定干预。',
      confidence: clamp(hasCrisisWord ? 0.95 : 0.88, 0, 1),
      ui_target: '/emergency-kit'
    };
  }

  if (hasAnxietyWord && (moodStats.avgStress >= 3.5 || moodStats.lowMoodStreak >= 1)) {
    return {
      next_action: 'meditate',
      reason: '当前焦虑与压力偏高，先做呼吸训练更容易稳定状态。',
      confidence: 0.84,
      ui_target: '/emergency-kit'
    };
  }

  if (intent === 'vent') {
    return {
      next_action: 'treehole',
      reason: '你更需要先表达和释放情绪，树洞更适合无压力倾诉。',
      confidence: 0.8,
      ui_target: '/treehole'
    };
  }

  if (intent === 'action' || (moodStats.avgMood <= 3.4 && actionStats.weeklyCount < 2)) {
    return {
      next_action: 'micro_action',
      reason: '当前状态适合先做一个3-10分钟的小行动，帮助快速建立掌控感。',
      confidence: 0.78,
      ui_target: '/action'
    };
  }

  return {
    next_action: 'chat_continue',
    reason: '当前状态稳定，先继续对话澄清你的核心困扰。',
    confidence: 0.7,
    ui_target: '/ai'
  };
};

const adjustDecisionBySessionState = ({ decision, sessionState, riskLevel }) => {
  const safeDecision = { ...decision };
  const previousAction = String(sessionState?.last_decision_action || 'chat_continue');
  const previousTaskStatus = String(sessionState?.current_task_status || 'idle');
  const sameAction = previousAction === safeDecision.next_action;
  const repeatCount = Number(sessionState?.consecutive_same_decision_count || 0);

  if (riskLevel !== 'high' && sameAction && repeatCount >= 2 && safeDecision.next_action !== 'chat_continue') {
    if (previousTaskStatus === 'in_progress' && safeDecision.next_action !== 'micro_action') {
      safeDecision.next_action = 'micro_action';
      safeDecision.reason = '检测到建议重复且任务未推进，切换到更小可执行步骤以推动进展。';
      safeDecision.confidence = clamp(Number(safeDecision.confidence || 0.65), 0, 1);
      safeDecision.ui_target = '/action';
      return safeDecision;
    }

    safeDecision.next_action = 'chat_continue';
    safeDecision.reason = '检测到连续重复建议，先继续对话确认进展，避免无效重复路由。';
    safeDecision.confidence = clamp(Number(safeDecision.confidence || 0.65) * 0.9, 0, 1);
    safeDecision.ui_target = '/ai';
  }

  return safeDecision;
};

const buildKbContextText = (snippets = []) => {
  if (!snippets.length) {
    return '当前未命中临床指南片段，可基于通用心理支持原则回复。';
  }

  return snippets
    .map((item, index) => `参考${index + 1}(p.${item.page}): ${item.content.slice(0, 320)}`)
    .join('\n');
};

const buildSystemPrompt = ({ decision, surveySummary, moodStats, completedActions, sessionState }) => {
  const recentActionSummary = completedActions
    .slice(-6)
    .map((item) => item.actionType || item.title || '未命名行动')
    .join('、');

  return [
    '你是厦大心语的心理陪伴助手，语气温柔、具体、不过度说教。',
    '你不是医生，不做诊断，不做病理判断。',
    '你可以选择直接回复，也可以使用 tools 辅助决策；不要为了调用工具而调用工具。',
    '低风险日常陪伴对话时，可以无需调用工具，可以直接聊天，也可以给出温和、简短、不过度指挥的建议。',
    '当处于高、中风险，或用户明确求建议、明确求行动、明确要知识支持时，优先使用 tools。',
    '高风险场景优先安全干预；中风险场景优先在安抚后再决定是继续聊天、树洞倾诉、微行动还是知识检索。',
    '使用 tools 时，一般流程是：先按需调用 retrieve_kb_snippets，再调用 go_emergency_kit/open_treehole/recommend_micro_action 中合适的工具，最后按需调用 log_decision。',
    '如果只是低风险日常聊天且没有明显路由需求，可以不调用工具；如果已经形成明确动作决策，优先使用 log_decision 记录。',
    `规则基线建议动作: ${decision.next_action}`,
    `规则基线理由: ${decision.reason}`,
    `近期情绪摘要: avgMood=${moodStats.avgMood}, avgStress=${moodStats.avgStress}, lowMoodStreak=${moodStats.lowMoodStreak}`,
    `问卷摘要: ${surveySummary ? JSON.stringify(surveySummary) : '无'}`,
    `最近行动摘要: ${recentActionSummary || '无'}`,
    `会话记忆摘要: ${String(sessionState?.conversation_summary || '无')}`,
    `会话任务状态: ${String(sessionState?.current_task_status || 'idle')}`,
    '最终输出时请给出80-140字中文回复：先共情，再给一个明确下一步，并与已调用的决策工具保持一致。'
  ].join('\n');
};

const fallbackReplyByAction = (action) => {
  if (action === 'emergency') {
    return '我感受到你现在很难受，我们先把安全放在第一位。建议你先做10分钟正念呼吸，如果仍然强烈不适，请尽快联系校园心理中心或可信任的老师同学陪伴你。';
  }
  if (action === 'meditate') {
    return '你现在的紧绷感很明显，我们先不硬扛，先做10分钟呼吸练习，让身体慢慢降下来。等状态稳一点，再一起拆解你最担心的那件事。';
  }
  if (action === 'treehole') {
    return '你现在更需要被听见，而不是马上被建议。可以先去树洞把情绪写出来，我会在这里陪你，等你说完我们再决定下一步。';
  }
  if (action === 'micro_action') {
    return '你已经在认真面对自己了。我们先做一个小步骤：选一项3-10分钟的小行动（散步/呼吸/感恩记录），做完再回来复盘感受。';
  }
  return '我在这儿，咱们可以慢慢聊。你愿意先说说，眼下最困扰你的点是哪一件吗？';
};

const executeToolCall = async (toolCall, runtimeState) => {
  const name = toolCall?.function?.name;
  const args = safeJsonParse(toolCall?.function?.arguments || '{}', {});
  const policy = runtimeState.policy;
  const allowed = isToolAllowed(name, policy);

  runtimeState.toolAttempts += 1;
  policyMetricsTracker.recordToolAttempt({
    requestId: runtimeState.requestId,
    allowed
  });

  if (!allowed) {
    runtimeState.toolViolations += 1;
    runtimeState.policy_audit.push({
      ts: new Date().toISOString(),
      event: 'tool_blocked',
      tool: name,
      risk_level: policy?.riskLevel || 'low',
      reason: 'tool_not_in_whitelist'
    });
    return {
      ok: false,
      blocked: true,
      error: `tool blocked by policy: ${name}`
    };
  }

  if (name === 'go_emergency_kit') {
    const level = args.level === 'emergency' ? 'emergency' : 'meditate';
    runtimeState.next_action = level;
    runtimeState.reason = String(args.reason || runtimeState.reason);
    runtimeState.confidence = clamp(Number(args.confidence || runtimeState.confidence), 0, 1);
    runtimeState.ui_target = '/emergency-kit';
    return {
      ok: true,
      decision_type: level,
      ui_target: '/emergency-kit'
    };
  }

  if (name === 'open_treehole') {
    runtimeState.next_action = 'treehole';
    runtimeState.reason = String(args.reason || runtimeState.reason);
    runtimeState.confidence = clamp(Number(args.confidence || runtimeState.confidence), 0, 1);
    runtimeState.ui_target = '/treehole';
    return {
      ok: true,
      decision_type: 'treehole',
      ui_target: '/treehole'
    };
  }

  if (name === 'recommend_micro_action') {
    runtimeState.next_action = 'micro_action';
    runtimeState.reason = String(args.reason || runtimeState.reason);
    runtimeState.confidence = clamp(Number(args.confidence || runtimeState.confidence), 0, 1);
    runtimeState.ui_target = '/action';
    runtimeState.recommended_action = {
      title: String(args.action_title || '3分钟呼吸练习'),
      description: String(args.action_description || '先做一个很小的行动，建立掌控感。'),
      minutes: clamp(Number(args.minutes || 5), 3, 10)
    };
    return {
      ok: true,
      decision_type: 'micro_action',
      ui_target: '/action',
      recommended_action: runtimeState.recommended_action
    };
  }

  if (name === 'retrieve_kb_snippets') {
    const topK = clamp(Number(args.top_k || 4), 1, 8);
    const query = String(args.query || runtimeState.message || '').trim();
    const snippets = await searchClinicalGuideline({ query, topK });
    runtimeState.kbSnippets = snippets;
    runtimeState.kb_hits = snippets.map((item) => ({
      page: item.page,
      score: item.score,
      source: item.source
    }));

    return {
      ok: true,
      snippets: snippets.map((item) => ({
        page: item.page,
        score: item.score,
        source: item.source,
        content: item.content.slice(0, 320)
      })),
      summary: buildKbContextText(snippets)
    };
  }

  if (name === 'log_decision') {
    const log = {
      decision_type: String(args.decision_type || runtimeState.next_action),
      reason: String(args.reason || runtimeState.reason),
      confidence: clamp(Number(args.confidence || runtimeState.confidence), 0, 1),
      ts: new Date().toISOString()
    };
    runtimeState.logs.push(log);
    runtimeState.reason = log.reason;
    runtimeState.confidence = log.confidence;
    if (FALLBACK_UI_TARGET[log.decision_type]) {
      runtimeState.next_action = log.decision_type;
      runtimeState.ui_target = FALLBACK_UI_TARGET[log.decision_type];
    }
    return { ok: true, log };
  }

  return { ok: false, error: `unknown tool: ${name}` };
};

const executeAdaptiveRecovery = async ({ toolCall, toolResult, runtimeState, step, messages }) => {
  const errorType = classifyToolError(toolResult);
  const isMultiStep = runtimeState.toolAttempts >= 2 || step >= 1;
  const recoveryAttempt = runtimeState.adaptive.controlTriggers > 0;
  const control = getAdaptiveControlPolicy({
    riskLevel: runtimeState.policy?.riskLevel,
    ablationMode: runtimeState.ablationMode,
    step,
    maxDepth: runtimeState.policy?.maxDepth,
    toolErrorType: errorType,
    isMultiStep,
    isRecoveryAttempt: recoveryAttempt
  });

  runtimeState.adaptive.controlTriggers += 1;
  runtimeState.policy_audit.push({
    ts: new Date().toISOString(),
    event: 'adaptive_control',
    failed_tool: toolCall?.function?.name || 'unknown',
    error_type: errorType,
    control
  });

  await traceLogger.appendEvent({
    traceId: runtimeState.traceId,
    type: 'adaptive_control',
    data: {
      step,
      failed_tool: toolCall?.function?.name || 'unknown',
      error_type: errorType,
      retry_tool: control.retry_tool,
      change_tool: control.change_tool,
      use_fallback: control.use_fallback,
      simplify_response: control.simplify_response,
      ablation_mode: runtimeState.ablationMode,
      is_multi_step: isMultiStep
    }
  });

  if (control.retry_tool && RETRYABLE_ERRORS.has(errorType)) {
    let retryOk = false;
    for (let attempt = 1; attempt <= control.max_retry; attempt += 1) {
      runtimeState.adaptive.retryAttempts += 1;
      const retryResult = await executeToolCall(toolCall, runtimeState);
      const retrySuccess = Boolean(retryResult?.ok);
      if (retrySuccess) {
        runtimeState.adaptive.retrySuccess += 1;
        retryOk = true;
      }

      await traceLogger.appendEvent({
        traceId: runtimeState.traceId,
        type: 'tool_call',
        data: {
          step,
          name: toolCall?.function?.name || 'unknown',
          success: retrySuccess,
          blocked: Boolean(retryResult?.blocked),
          error: retryResult?.error || null,
          is_retry: true,
          attempt_number: attempt
        }
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(retryResult)
      });

      if (retryOk) {
        return { recovered: true };
      }
    }
  }

  if (control.change_tool) {
    const alternativeTool = pickAlternativeTool({
      failedToolName: toolCall?.function?.name,
      policy: runtimeState.policy
    });
    if (alternativeTool) {
      const adaptiveCall = buildAdaptiveToolCall({
        targetTool: alternativeTool,
        runtimeState,
        reason: `change_tool_after_${errorType}`
      });
      const changedResult = await executeToolCall(adaptiveCall, runtimeState);
      const changedOk = Boolean(changedResult?.ok);
      runtimeState.adaptive.changeToolAttempts += 1;
      if (changedOk) {
        runtimeState.adaptive.changeToolSuccess += 1;
        runtimeState.adaptive.recoverySuccess += 1;
      }

      await traceLogger.appendEvent({
        traceId: runtimeState.traceId,
        type: 'tool_call',
        data: {
          step,
          name: alternativeTool,
          success: changedOk,
          blocked: Boolean(changedResult?.blocked),
          error: changedResult?.error || null,
          recovery_mode: 'change_tool'
        }
      });

      messages.push({
        role: 'tool',
        tool_call_id: toolCall.id,
        content: JSON.stringify(changedResult)
      });

      if (changedOk) {
        return { recovered: true };
      }
    }
  }

  if (control.use_fallback) {
    runtimeState.adaptive.fallbackTriggered += 1;
    runtimeState.forcedFallback = true;
    const fallbackAction = getFallbackAction({
      riskLevel: runtimeState.policy?.riskLevel,
      requestedAction: runtimeState.next_action
    });
    runtimeState.next_action = fallbackAction;
    runtimeState.ui_target = FALLBACK_UI_TARGET[fallbackAction] || '/ai';
    runtimeState.reason = `fallback_due_to_${errorType}`;
  }

  if (control.simplify_response) {
    runtimeState.adaptive.simplifyTriggered += 1;
    runtimeState.forceSimplifiedReply = true;
  }

  return { recovered: false };
};

const callLangGraphAgent = async ({ systemPrompt, chatContext, message, runtimeState }) => {
  const model = createAgentModel();
  if (!model) {
    return null;
  }

  const graph = createAgentGraph({
    model,
    deps: {
      searchClinicalGuideline,
      evaluatePolicy,
      getFallbackAction,
      isToolAllowed,
      buildKbContextText,
      clamp,
      traceLogger,
      maskText,
      fallbackReplyByAction
    }
  });

  const result = await graph.invoke({
    message,
    chatContext: chatContext.slice(-8),
    systemPrompt,
    runtimeState
  });

  return typeof result?.finalText === 'string' ? result.finalText.trim() : null;
};

app.post('/api/agent/chat', async (req, res) => {
  try {
    const {
      message = '',
      mood_data: moodData = [],
      completed_actions: completedActions = [],
      survey_summary: surveySummary = null,
      chat_context: chatContext = [],
      client_trace_id: clientTraceId = null,
      adaptive_mode: adaptiveModeInput = process.env.ADAPTIVE_ABLATION_MODE || 'full',
      session_id: sessionIdInput = null,
      emotion_tag: emotionTagInput = null,
      conversation_summary: conversationSummaryInput = null,
      current_task_status: currentTaskStatusInput = null
    } = req.body || {};

    const normalizedMessage = String(message).trim();
    if (!normalizedMessage) {
      return res.status(400).json({ error: 'message is required' });
    }

    const moodStats = getRecentMoodStats(moodData);
    const actionStats = getRecentActionStats(completedActions);
    const requestId = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const traceId = createTraceId();
    const intent = detectIntent(normalizedMessage);
    const ablationMode = normalizeAblationMode(adaptiveModeInput);
    const sessionState = resolveSessionState({
      sessionId: sessionIdInput,
      incomingState: {
        session_id: sessionIdInput,
        emotion_tag: emotionTagInput,
        conversation_summary: conversationSummaryInput,
        current_task_status: currentTaskStatusInput
      }
    });

    await traceLogger.startTrace({
      traceId,
      requestId,
      route: '/api/agent/chat',
      clientTraceId: clientTraceId || undefined,
      meta: {
        message_length: normalizedMessage.length,
        mood_points: Array.isArray(moodData) ? moodData.length : 0,
        action_points: Array.isArray(completedActions) ? completedActions.length : 0
      }
    });
    await traceLogger.appendEvent({
      traceId,
      type: 'user_input',
      data: {
        preview: maskText(normalizedMessage, 100),
        mood_stats: moodStats,
        action_stats: actionStats
      }
    });
    await traceLogger.appendEvent({
      traceId,
      type: 'session_state_loaded',
      data: {
        session_id: sessionState.session_id,
        emotion_tag: sessionState.emotion_tag,
        current_task_status: sessionState.current_task_status,
        has_summary: Boolean(sessionState.conversation_summary)
      }
    });

    const policy = evaluatePolicy({
      message: normalizedMessage,
      moodStats,
      actionStats,
      intent,
      step: 0
    });

    policyMetricsTracker.recordRequestStart({
      requestId,
      riskLevel: policy.riskLevel
    });

    const baseDecision = decideNextAction({
      message: normalizedMessage,
      moodStats,
      actionStats
    });
    const decision = adjustDecisionBySessionState({
      decision: baseDecision,
      sessionState,
      riskLevel: policy.riskLevel
    });

    const runtimeState = {
      requestId,
      traceId,
      message: normalizedMessage,
      next_action: decision.next_action,
      reason: decision.reason,
      confidence: decision.confidence,
      ui_target: decision.ui_target || FALLBACK_UI_TARGET[decision.next_action] || '/ai',
      intent,
      moodStats,
      actionStats,
      policy,
      ablationMode,
      sessionState,
      policy_audit: [],
      kbSnippets: [],
      kb_hits: [],
      recommended_action: null,
      logs: [],
      forcedFallback: false,
      forceSimplifiedReply: false,
      toolAttempts: 0,
      toolViolations: 0,
      requestStartedAt: Date.now(),
      tokenUsage: {
        prompt: 0,
        completion: 0,
        total: 0
      },
      adaptive: {
        initialFailures: 0,
        retryAttempts: 0,
        retrySuccess: 0,
        changeToolAttempts: 0,
        changeToolSuccess: 0,
        recoverySuccess: 0,
        fallbackTriggered: 0,
        simplifyTriggered: 0,
        controlTriggers: 0
      }
    };

    const systemPrompt = buildSystemPrompt({
      decision,
      surveySummary,
      moodStats,
      completedActions,
      sessionState
    });

    let replyText = null;
    try {
      replyText = await callLangGraphAgent({
        systemPrompt,
        chatContext,
        message: normalizedMessage,
        runtimeState
      });
    } catch (error) {
      console.error('[Agent] LangGraph error:', error.message);
      await traceLogger.appendEvent({
        traceId,
        type: 'exception',
        data: {
          where: 'langgraph_call',
          message: String(error.message || 'unknown_error')
        }
      });
    }

    if (!replyText) {
      replyText = fallbackReplyByAction(runtimeState.next_action);
    }

    if (runtimeState.forceSimplifiedReply) {
      replyText = fallbackReplyByAction(runtimeState.next_action);
    }

    const enforcedAction = getFallbackAction({
      riskLevel: runtimeState.policy.riskLevel,
      requestedAction: runtimeState.next_action
    });

    if (enforcedAction !== runtimeState.next_action) {
      const originalAction = runtimeState.next_action;
      runtimeState.forcedFallback = true;
      runtimeState.next_action = enforcedAction;
      runtimeState.ui_target = FALLBACK_UI_TARGET[enforcedAction] || '/ai';
      replyText = fallbackReplyByAction(enforcedAction);
      runtimeState.policy_audit.push({
        ts: new Date().toISOString(),
        event: 'final_action_enforced',
        risk_level: runtimeState.policy.riskLevel,
        original_action: originalAction,
        enforced_action: enforcedAction
      });
    }

    const refusalExpected = runtimeState.policy.riskLevel === 'high';
    const safeInterventionActions = new Set(['emergency', 'meditate']);
    const refusalActual = safeInterventionActions.has(runtimeState.next_action) || runtimeState.forcedFallback || runtimeState.toolViolations > 0;
    const highRiskBlocked = runtimeState.policy.riskLevel === 'high' && (safeInterventionActions.has(runtimeState.next_action) || runtimeState.forcedFallback || runtimeState.toolViolations > 0);

    policyMetricsTracker.recordFinalDecision({
      requestId,
      highRiskBlocked,
      refusalExpected,
      refusalActual
    });

    const previousAction = String(runtimeState.sessionState?.last_decision_action || 'chat_continue');
    const sameDecision = previousAction === runtimeState.next_action;
    const nextRepeatCount = sameDecision
      ? Number(runtimeState.sessionState?.consecutive_same_decision_count || 0) + 1
      : 1;
    const nextTaskStatus = deriveTaskStatus({
      previousStatus: runtimeState.sessionState?.current_task_status,
      nextAction: runtimeState.next_action,
      message: normalizedMessage,
      riskLevel: runtimeState.policy.riskLevel
    });
    const nextEmotionTag = inferEmotionTag({
      message: normalizedMessage,
      riskLevel: runtimeState.policy.riskLevel
    });
    const consistencyOk = runtimeState.policy.riskLevel === 'high'
      ? true
      : !(sameDecision && nextRepeatCount >= 3 && nextTaskStatus === runtimeState.sessionState?.current_task_status);

    const updatedSessionState = {
      ...runtimeState.sessionState,
      session_id: runtimeState.sessionState?.session_id || createSessionId(),
      emotion_tag: nextEmotionTag,
      conversation_summary: buildConversationSummary({
        previousSummary: runtimeState.sessionState?.conversation_summary,
        message: normalizedMessage,
        nextAction: runtimeState.next_action
      }),
      current_task_status: nextTaskStatus,
      last_decision_action: runtimeState.next_action,
      consecutive_same_decision_count: nextRepeatCount,
      last_updated_at: new Date().toISOString()
    };
    SESSION_STORE.set(updatedSessionState.session_id, updatedSessionState);

    await traceLogger.appendEvent({
      traceId,
      type: 'consistency_check',
      data: {
        session_id: updatedSessionState.session_id,
        consistency_ok: consistencyOk,
        repeated_decision_turn: sameDecision && nextRepeatCount >= 2,
        previous_action: previousAction,
        current_action: runtimeState.next_action,
        task_status_before: runtimeState.sessionState?.current_task_status || 'idle',
        task_status_after: nextTaskStatus
      }
    });

    await traceLogger.appendEvent({
      traceId,
      type: 'session_state_updated',
      data: {
        session_id: updatedSessionState.session_id,
        emotion_tag: updatedSessionState.emotion_tag,
        current_task_status: updatedSessionState.current_task_status,
        consecutive_same_decision_count: updatedSessionState.consecutive_same_decision_count
      }
    });

    const payload = {
      request_id: requestId,
      trace_id: traceId,
      next_action: runtimeState.next_action,
      reason: runtimeState.reason,
      confidence: runtimeState.confidence,
      ui_target: runtimeState.ui_target,
      reply_text: replyText,
      kb_hits: runtimeState.kb_hits,
      recommended_action: runtimeState.recommended_action,
      decision_logs: runtimeState.logs,
      policy: {
        risk_level: runtimeState.policy.riskLevel,
        risk_signals: runtimeState.policy.riskSignals,
        allowed_tools: runtimeState.policy.allowedTools,
        max_depth: runtimeState.policy.maxDepth,
        fallback_mode: runtimeState.policy.fallbackMode,
        adaptive_mode: runtimeState.ablationMode
      },
      adaptive_control: runtimeState.adaptive,
      session_state: {
        session_id: updatedSessionState.session_id,
        emotion_tag: updatedSessionState.emotion_tag,
        conversation_summary: updatedSessionState.conversation_summary,
        current_task_status: updatedSessionState.current_task_status,
        last_decision_action: updatedSessionState.last_decision_action,
        consecutive_same_decision_count: updatedSessionState.consecutive_same_decision_count,
        consistency_ok: consistencyOk,
        repeated_decision_turn: sameDecision && nextRepeatCount >= 2
      },
      side_effects: {
        latency_ms: Date.now() - runtimeState.requestStartedAt,
        avg_steps_per_task: runtimeState.toolAttempts,
        token_cost: runtimeState.tokenUsage
      },
      policy_audit: runtimeState.policy_audit
    };

    await traceLogger.appendEvent({
      traceId,
      type: 'final_output',
      data: {
        next_action: runtimeState.next_action,
        risk_level: runtimeState.policy.riskLevel,
        forced_fallback: runtimeState.forcedFallback,
        tool_attempts: runtimeState.toolAttempts,
        tool_violations: runtimeState.toolViolations,
        ablation_mode: runtimeState.ablationMode,
        adaptive_control: runtimeState.adaptive,
        latency_ms: Date.now() - runtimeState.requestStartedAt,
        token_cost: runtimeState.tokenUsage,
        multi_step: runtimeState.toolAttempts >= 2,
        recovery_success: runtimeState.adaptive.initialFailures > 0
          && (runtimeState.adaptive.retrySuccess + runtimeState.adaptive.changeToolSuccess > 0),
        session_id: updatedSessionState.session_id,
        emotion_tag: updatedSessionState.emotion_tag,
        current_task_status: updatedSessionState.current_task_status,
        repeated_decision_turn: sameDecision && nextRepeatCount >= 2,
        consistency_ok: consistencyOk
      }
    });
    await traceLogger.finishTrace({
      traceId,
      status: 'ok',
      httpStatus: 200
    });

    return res.json(payload);
  } catch (error) {
    console.error('[Agent] Unexpected error:', error);
    const traceId = createTraceId();
    await traceLogger.startTrace({
      traceId,
      requestId: `${Date.now()}-error`,
      route: '/api/agent/chat',
      meta: { stage: 'top_level_catch' }
    });
    await traceLogger.appendEvent({
      traceId,
      type: 'exception',
      data: {
        where: 'agent_handler',
        message: String(error.message || 'unexpected_error')
      }
    });
    await traceLogger.finishTrace({
      traceId,
      status: 'error',
      httpStatus: 500,
      error: String(error.message || 'unexpected_error')
    });
    return res.status(500).json({
      trace_id: traceId,
      next_action: 'chat_continue',
      reason: '服务暂时不可用，已回退到对话模式。',
      confidence: 0.5,
      ui_target: '/ai',
      reply_text: '我在这里，先和你慢慢聊聊。你愿意告诉我，现在最让你难受的一件事是什么吗？'
    });
  }
});

app.get('/api/agent/health', (_, res) => {
  res.json({ ok: true, service: 'agent-server', ts: Date.now() });
});

app.get('/api/agent/kb/status', (_, res) => {
  res.json(getKbStatus());
});

app.get('/api/agent/policy/metrics', (req, res) => {
  const report = policyMetricsTracker.getReport();
  const baselineViolationRate = Number(req.query.baseline_violation_rate || 0);
  const baselineRefusalPrecision = Number(req.query.baseline_refusal_precision || 0);
  const conclusions = buildConclusionFromBaseline({
    baseline: {
      policyViolationRate: baselineViolationRate,
      refusalPrecision: baselineRefusalPrecision
    },
    current: report.metrics
  });

  res.json({
    policy_version: 'v1',
    supported_tools: AGENT_TOOL_NAMES,
    metrics: report.metrics,
    totals: report.totals,
    conclusions
  });
});

app.get('/api/agent/trace/metrics', async (req, res) => {
  const limit = clamp(Number(req.query.limit || 100), 1, 1000);
  const metrics = await traceLogger.getMetrics({ limit });

  return res.json({
    trace_version: 'v1',
    window: { limit },
    metrics
  });
});

app.get('/api/agent/trace/:traceId', async (req, res) => {
  const trace = await traceLogger.getTrace(String(req.params.traceId || '').trim());
  if (!trace) {
    return res.status(404).json({ error: 'trace not found' });
  }
  return res.json(trace);
});

app.listen(PORT, () => {
  console.log(`[Agent] server running at http://localhost:${PORT}`);
});
