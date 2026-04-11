import { tool } from '@langchain/core/tools';
import { z } from 'zod';

const DEFAULT_CLAMP = (value, min, max) => Math.max(min, Math.min(max, value));
const DEFAULT_KB_TEXT = (snippets = []) => snippets.map((item) => `[p.${item.page}] ${item.content}`).join('\n');
export const AGENT_TOOL_NAMES = [
  'go_emergency_kit',
  'open_treehole',
  'recommend_micro_action',
  'retrieve_kb_snippets',
  'log_decision'
];

export const createAgentTools = ({ runtimeState, deps = {} }) => {
  const clamp = deps.clamp || DEFAULT_CLAMP;
  const buildKbContextText = deps.buildKbContextText || DEFAULT_KB_TEXT;
  const searchClinicalGuideline = deps.searchClinicalGuideline || (async () => []);
  const isToolAllowed = deps.isToolAllowed || (() => true);

  const withPolicyGuard = (toolName, handler) => async (input) => {
    runtimeState.toolAttempts = Number(runtimeState.toolAttempts || 0) + 1;
    const allowed = isToolAllowed(toolName, runtimeState.policy);

    if (!allowed) {
      runtimeState.toolViolations = Number(runtimeState.toolViolations || 0) + 1;
      runtimeState.policy_audit = Array.isArray(runtimeState.policy_audit) ? runtimeState.policy_audit : [];
      runtimeState.policy_audit.push({
        ts: new Date().toISOString(),
        event: 'tool_blocked',
        tool: toolName,
        risk_level: runtimeState.policy?.riskLevel || 'low',
        reason: 'tool_not_in_whitelist'
      });
      return {
        ok: false,
        blocked: true,
        error: `tool blocked by policy: ${toolName}`
      };
    }

    return handler(input);
  };

  return [
    tool(
      withPolicyGuard('go_emergency_kit', async ({ reason, confidence, level }) => {
        runtimeState.next_action = level === 'emergency' ? 'emergency' : 'meditate';
        runtimeState.reason = String(reason || runtimeState.reason);
        runtimeState.confidence = clamp(Number(confidence || runtimeState.confidence), 0, 1);
        runtimeState.ui_target = '/emergency-kit';
        return {
          ok: true,
          decision_type: runtimeState.next_action,
          ui_target: runtimeState.ui_target
        };
      }),
      {
        name: 'go_emergency_kit',
        schema: z.object({
          reason: z.string(),
          confidence: z.number().min(0).max(1),
          level: z.enum(['meditate', 'emergency'])
        })
      }
    ),
    tool(
      withPolicyGuard('open_treehole', async ({ reason, confidence }) => {
        runtimeState.next_action = 'treehole';
        runtimeState.reason = String(reason || runtimeState.reason);
        runtimeState.confidence = clamp(Number(confidence || runtimeState.confidence), 0, 1);
        runtimeState.ui_target = '/treehole';
        return {
          ok: true,
          decision_type: 'treehole',
          ui_target: '/treehole'
        };
      }),
      {
        name: 'open_treehole',
        schema: z.object({
          reason: z.string(),
          confidence: z.number().min(0).max(1)
        })
      }
    ),
    tool(
      withPolicyGuard('recommend_micro_action', async ({ reason, confidence, action_title, action_description, minutes }) => {
        runtimeState.next_action = 'micro_action';
        runtimeState.reason = String(reason || runtimeState.reason);
        runtimeState.confidence = clamp(Number(confidence || runtimeState.confidence), 0, 1);
        runtimeState.ui_target = '/action';
        runtimeState.recommended_action = {
          title: String(action_title || '3分钟呼吸练习'),
          description: String(action_description || '先做一个很小的行动，建立掌控感。'),
          minutes: clamp(Number(minutes || 5), 3, 10)
        };
        return {
          ok: true,
          decision_type: 'micro_action',
          ui_target: '/action',
          recommended_action: runtimeState.recommended_action
        };
      }),
      {
        name: 'recommend_micro_action',
        schema: z.object({
          reason: z.string(),
          confidence: z.number().min(0).max(1),
          action_title: z.string(),
          action_description: z.string(),
          minutes: z.number().min(3).max(10)
        })
      }
    ),
    tool(
      withPolicyGuard('retrieve_kb_snippets', async ({ query, top_k = 4 }) => {
        const snippets = await searchClinicalGuideline({ query, topK: top_k });
        runtimeState.kbSnippets = snippets;
        runtimeState.kb_hits = snippets.map((item) => ({
          page: item.page,
          score: item.score,
          source: item.source
        }));
        return {
          ok: true,
          snippets,
          summary: buildKbContextText(snippets)
        };
      }),
      {
        name: 'retrieve_kb_snippets',
        schema: z.object({
          query: z.string(),
          top_k: z.number().min(1).max(8).optional()
        })
      }
    ),
    tool(
      withPolicyGuard('log_decision', async ({ decision_type, reason, confidence }) => {
        const log = {
          decision_type,
          reason,
          confidence: clamp(Number(confidence || runtimeState.confidence), 0, 1),
          ts: new Date().toISOString()
        };
        runtimeState.logs.push(log);
        runtimeState.next_action = decision_type;
        runtimeState.reason = reason;
        runtimeState.confidence = log.confidence;
        return {
          ok: true,
          log
        };
      }),
      {
        name: 'log_decision',
        schema: z.object({
          decision_type: z.enum(['meditate', 'treehole', 'micro_action', 'chat_continue', 'emergency']),
          reason: z.string(),
          confidence: z.number().min(0).max(1)
        })
      }
    )
  ];
};
