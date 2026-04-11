import test from 'node:test';
import assert from 'node:assert/strict';
import { createAgentGraph } from './graph.js';

test('createAgentGraph returns an invokable graph', () => {
  const graph = createAgentGraph({
    model: {
      bindTools() {
        return this;
      },
      invoke: async () => ({ content: 'ok' })
    },
    deps: {}
  });

  assert.ok(graph);
  assert.equal(typeof graph.invoke, 'function');
});

test('graph can execute a tool loop and return final text', async () => {
  let callCount = 0;
  const runtimeState = {
    next_action: 'chat_continue',
    reason: '',
    confidence: 0.5,
    logs: [],
    kb_hits: [],
    toolAttempts: 0,
    toolViolations: 0,
    policy_audit: [],
    policy: {
      allowedTools: ['log_decision'],
      maxDepth: 3
    }
  };

  const graph = createAgentGraph({
    model: {
      bindTools() {
        return this;
      },
      async invoke(messages) {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [
              {
                id: 'tool-1',
                name: 'log_decision',
                args: {
                  decision_type: 'chat_continue',
                  reason: 'loop complete',
                  confidence: 0.8
                }
              }
            ]
          };
        }

        const lastToolMessage = messages[messages.length - 1];
        assert.equal(lastToolMessage.role, 'tool');
        return {
          content: 'final answer'
        };
      }
    },
    deps: {}
  });

  const result = await graph.invoke({
    message: 'hello',
    chatContext: [],
    systemPrompt: 'system',
    runtimeState
  });

  assert.equal(result.finalText, 'final answer');
  assert.equal(runtimeState.logs.length, 1);
  assert.equal(runtimeState.logs[0].decision_type, 'chat_continue');
});

test('graph emits graph_node trace events for node transitions', async () => {
  const events = [];
  let callCount = 0;
  const runtimeState = {
    traceId: 'trace-1',
    next_action: 'chat_continue',
    reason: '',
    confidence: 0.5,
    logs: [],
    kb_hits: [],
    toolAttempts: 0,
    toolViolations: 0,
    policy_audit: [],
    adaptive: {
      initialFailures: 0
    },
    moodStats: {},
    actionStats: {},
    intent: 'support',
    policy: {
      riskLevel: 'low',
      allowedTools: ['log_decision'],
      maxDepth: 3
    }
  };

  const graph = createAgentGraph({
    model: {
      bindTools() {
        return this;
      },
      async invoke() {
        callCount += 1;
        if (callCount === 1) {
          return {
            content: '',
            tool_calls: [
              {
                id: 'tool-1',
                name: 'log_decision',
                args: {
                  decision_type: 'chat_continue',
                  reason: 'trace',
                  confidence: 0.8
                }
              }
            ]
          };
        }

        return { content: 'done' };
      }
    },
    deps: {
      traceLogger: {
        async appendEvent(payload) {
          events.push(payload);
        }
      },
      evaluatePolicy: ({ step }) => ({
        riskLevel: 'low',
        allowedTools: ['log_decision'],
        maxDepth: 3 - step > 0 ? 3 : 1
      }),
      isToolAllowed: (toolName, policy) => policy.allowedTools.includes(toolName),
      fallbackReplyByAction: () => 'fallback'
    }
  });

  const result = await graph.invoke({
    message: 'hello',
    chatContext: [],
    systemPrompt: 'system',
    runtimeState
  });

  assert.equal(result.finalText, 'done');
  assert.deepEqual(
    events.filter((item) => item.type === 'graph_node').map((item) => item.data.node),
    ['policy_gate', 'agent_llm', 'tools', 'policy_gate', 'agent_llm', 'finalize']
  );
});
