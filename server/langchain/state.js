import { Annotation } from '@langchain/langgraph';

export const AgentGraphState = Annotation.Root({
  message: Annotation(),
  chatContext: Annotation(),
  systemPrompt: Annotation(),
  runtimeState: Annotation(),
  policy: Annotation(),
  lastModelMessage: Annotation(),
  pendingToolCalls: Annotation(),
  finalText: Annotation(),
  loopCount: Annotation(),
  maxLoops: Annotation(),
  messages: Annotation({
    reducer: (left, right) => {
      const next = Array.isArray(right) ? right : [right];
      return [...left, ...next];
    },
    default: () => []
  })
});

export const createInitialGraphState = (payload) => ({
  message: payload.message,
  chatContext: payload.chatContext || [],
  systemPrompt: payload.systemPrompt,
  runtimeState: payload.runtimeState,
  policy: payload.runtimeState.policy,
  lastModelMessage: null,
  pendingToolCalls: [],
  finalText: null,
  loopCount: 0,
  maxLoops: Number(payload.runtimeState?.policy?.maxDepth || 1),
  messages: [
    { role: 'system', content: payload.systemPrompt },
    ...(payload.chatContext || []),
    { role: 'user', content: payload.message }
  ]
});
