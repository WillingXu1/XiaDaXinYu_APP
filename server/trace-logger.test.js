import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';

import {
  createTraceLogger,
  summarizeTraceEvents,
  maskText,
  normalizeTraceMetrics
} from './trace-logger.js';

test('maskText should shorten and sanitize user input', () => {
  const text = '我最近焦虑睡不着，真的有点崩溃，想找人聊聊。';
  const masked = maskText(text, 8);
  assert.equal(typeof masked, 'string');
  assert.ok(masked.length <= 12);
});

test('summarizeTraceEvents calculates steps/tool success/error ratio', () => {
  const summary = summarizeTraceEvents([
    { type: 'llm_reasoning', data: { step: 1 } },
    { type: 'llm_reasoning', data: { step: 2 } },
    { type: 'tool_call', data: { success: true } },
    { type: 'tool_call', data: { success: false } },
    { type: 'exception', data: { where: 'llm' } }
  ]);

  assert.equal(summary.reasoningSteps, 2);
  assert.equal(summary.toolCalls, 2);
  assert.equal(summary.toolSuccessRate, 0.5);
  assert.equal(summary.exceptionRate, 1);
});

test('normalizeTraceMetrics aggregates traces', () => {
  const metrics = normalizeTraceMetrics([
    { trace_id: 't1', events: [{ type: 'llm_reasoning' }, { type: 'tool_call', data: { success: true } }] },
    { trace_id: 't2', events: [{ type: 'llm_reasoning' }, { type: 'llm_reasoning' }, { type: 'tool_call', data: { success: false } }, { type: 'exception' }] }
  ]);

  assert.equal(metrics.totalTraces, 2);
  assert.equal(metrics.avgReasoningSteps, 1.5);
  assert.equal(metrics.toolCallSuccessRate, 0.5);
  assert.equal(metrics.exceptionChainRate, 0.5);
});

test('trace logger writes and reads traces by trace_id', async () => {
  const tempDir = path.resolve(process.cwd(), 'result/policy-eval/traces-test');
  const logger = createTraceLogger({ traceDir: tempDir });

  const traceId = 'trace-test-001';
  await logger.startTrace({ traceId, requestId: 'r1', route: '/api/agent/chat' });
  await logger.appendEvent({ traceId, type: 'user_input', data: { message: 'hello' } });
  await logger.appendEvent({ traceId, type: 'final_output', data: { next_action: 'chat_continue' } });
  await logger.finishTrace({ traceId, status: 'ok' });

  const loaded = await logger.getTrace(traceId);
  assert.equal(loaded.trace_id, traceId);
  assert.equal(Array.isArray(loaded.events), true);
  assert.ok(loaded.events.length >= 2);

  await fs.rm(tempDir, { recursive: true, force: true });
});
