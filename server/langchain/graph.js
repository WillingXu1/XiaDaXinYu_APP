import { END, START, StateGraph } from '@langchain/langgraph';
import { AgentGraphState, createInitialGraphState } from './state.js';
import { createAgentTools } from './tools.js';

const getMessageContent = (message) => {
  if (!message) return null;
  if (typeof message.content === 'string') {
    return message.content;
  }
  if (Array.isArray(message.content)) {
    return message.content
      .map((item) => {
        if (typeof item === 'string') return item;
        if (typeof item?.text === 'string') return item.text;
        return '';
      })
      .join('')
      .trim();
  }
  return null;
};

const getToolCalls = (message) => {
  return Array.isArray(message?.tool_calls) ? message.tool_calls : [];
};

const shouldContinue = (state) => {
  if (Array.isArray(state.pendingToolCalls) && state.pendingToolCalls.length > 0 && Number(state.loopCount || 0) < Number(state.maxLoops || 1)) {
    return 'tools';
  }
  return 'finalize';
};

const buildToolsMap = (tools) => new Map(tools.map((tool) => [tool.name, tool]));

const appendGraphNodeEvent = async (deps, runtimeState, node, extra = {}) => {
  if (!deps.traceLogger || !runtimeState?.traceId) {
    return;
  }

  await deps.traceLogger.appendEvent({
    traceId: runtimeState.traceId,
    type: 'graph_node',
    data: {
      node,
      ...extra
    }
  });
};

export const createAgentGraph = ({ model, deps }) => {
  const workflow = new StateGraph(AgentGraphState)
    .addNode('policy_gate', async (state) => {
      await appendGraphNodeEvent(deps, state.runtimeState, 'policy_gate', {
        step: Number(state.loopCount || 0)
      });

      const policy = (() => {
        if (typeof deps.evaluatePolicy !== 'function') {
          return state.runtimeState.policy;
        }

        const nextPolicy = deps.evaluatePolicy({
          message: state.message,
          moodStats: state.runtimeState.moodStats,
          actionStats: state.runtimeState.actionStats,
          intent: state.runtimeState.intent,
          step: Number(state.loopCount || 0)
        });

        state.runtimeState.policy = nextPolicy;
        state.runtimeState.policy_audit.push({
          ts: new Date().toISOString(),
          event: 'policy_evaluated',
          risk_level: nextPolicy.riskLevel,
          max_depth: nextPolicy.maxDepth,
          allowed_tools: nextPolicy.allowedTools
        });

        return nextPolicy;
      })();

      if (deps.traceLogger && state.runtimeState?.traceId) {
        await deps.traceLogger.appendEvent({
          traceId: state.runtimeState.traceId,
          type: 'policy_decision',
          data: {
            step: Number(state.loopCount || 0),
            risk_level: policy?.riskLevel,
            max_depth: policy?.maxDepth,
            allowed_tools: policy?.allowedTools
          }
        });
      }

      return {
        policy,
        maxLoops: Number(policy?.maxDepth || 1)
      };
    })
    .addNode('agent_llm', async (state) => {
      await appendGraphNodeEvent(deps, state.runtimeState, 'agent_llm', {
        step: Number(state.loopCount || 0)
      });

      const tools = createAgentTools({
        runtimeState: state.runtimeState,
        deps
      });
      const filteredTools = typeof deps.isToolAllowed === 'function'
        ? tools.filter((item) => deps.isToolAllowed(item.name, state.runtimeState.policy))
        : tools;
      const boundModel = typeof model.bindTools === 'function' ? model.bindTools(filteredTools) : model;
      const response = await boundModel.invoke(state.messages);
      const toolCalls = getToolCalls(response);
      const content = getMessageContent(response);

      if (deps.traceLogger && state.runtimeState?.traceId) {
        await deps.traceLogger.appendEvent({
          traceId: state.runtimeState.traceId,
          type: 'llm_reasoning',
          data: {
            step: Number(state.loopCount || 0),
            has_tool_calls: toolCalls.length > 0,
            content_preview: typeof deps.maskText === 'function' ? deps.maskText(content, 120) : content
          }
        });
      }

      return {
        lastModelMessage: response,
        pendingToolCalls: toolCalls,
        finalText: toolCalls.length ? null : content,
        loopCount: Number(state.loopCount || 0) + 1,
        messages: [
          {
            role: 'assistant',
            content: content || '',
            tool_calls: toolCalls.length ? toolCalls : undefined
          }
        ]
      };
    })
    .addNode('tools', async (state) => {
      await appendGraphNodeEvent(deps, state.runtimeState, 'tools', {
        step: Number(state.loopCount || 0),
        tool_count: Array.isArray(state.pendingToolCalls) ? state.pendingToolCalls.length : 0
      });

      const tools = createAgentTools({
        runtimeState: state.runtimeState,
        deps
      });
      const toolMap = buildToolsMap(tools);
      const toolMessages = [];

      for (const toolCall of state.pendingToolCalls || []) {
        const toolImpl = toolMap.get(toolCall.name);
        if (!toolImpl) {
          toolMessages.push({
            role: 'tool',
            tool_call_id: toolCall.id,
            content: JSON.stringify({ ok: false, error: `unknown tool: ${toolCall.name}` })
          });
          continue;
        }

        const result = await toolImpl.invoke(toolCall.args || {});
        if (!result?.ok) {
          state.runtimeState.adaptive.initialFailures = Number(state.runtimeState?.adaptive?.initialFailures || 0) + 1;
        }

        if (deps.traceLogger && state.runtimeState?.traceId) {
          await deps.traceLogger.appendEvent({
            traceId: state.runtimeState.traceId,
            type: 'tool_call',
            data: {
              step: Number(state.loopCount || 0),
              name: toolCall.name,
              success: Boolean(result?.ok),
              blocked: Boolean(result?.blocked),
              error: result?.error || null
            }
          });
        }

        toolMessages.push({
          role: 'tool',
          tool_call_id: toolCall.id,
          content: typeof result === 'string' ? result : JSON.stringify(result)
        });
      }

      return {
        pendingToolCalls: [],
        messages: toolMessages
      };
    })
    .addNode('finalize', async (state) => {
      await appendGraphNodeEvent(deps, state.runtimeState, 'finalize', {
        step: Number(state.loopCount || 0),
        has_final_text: Boolean(state.finalText)
      });

      let finalText = typeof state.finalText === 'string' ? state.finalText.trim() : null;
      const maxDepthReached = Array.isArray(state.pendingToolCalls) && state.pendingToolCalls.length > 0 && Number(state.loopCount || 0) >= Number(state.maxLoops || 1);

      if (!finalText && maxDepthReached) {
        state.runtimeState.forcedFallback = true;
        state.runtimeState.policy_audit.push({
          ts: new Date().toISOString(),
          event: 'max_depth_reached',
          depth_limit: state.maxLoops
        });
      }

      if (!finalText && (state.runtimeState.forceSimplifiedReply || maxDepthReached) && typeof deps.fallbackReplyByAction === 'function') {
        finalText = deps.fallbackReplyByAction(state.runtimeState.next_action);
      }

      return {
        finalText
      };
    })
    .addEdge(START, 'policy_gate')
    .addEdge('policy_gate', 'agent_llm')
    .addConditionalEdges('agent_llm', shouldContinue, {
      tools: 'tools',
      finalize: 'finalize'
    })
    .addEdge('tools', 'policy_gate')
    .addEdge('finalize', END);

  return {
    async invoke(input) {
      return workflow.compile().invoke(createInitialGraphState(input));
    }
  };
};
