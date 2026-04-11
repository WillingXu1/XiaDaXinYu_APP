import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';

const DEFAULT_TRACE_DIR = path.resolve(process.cwd(), 'result/policy-eval/traces');

const round = (value, digits = 4) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
};

export const createTraceId = () => `trace-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;

export const maskText = (text, maxLength = 72) => {
  if (!text) return '';
  const normalized = String(text).replace(/\s+/g, ' ').trim();
  if (!normalized) return '';
  if (normalized.length <= maxLength) return normalized;
  return `${normalized.slice(0, maxLength)}...`;
};

export const summarizeTraceEvents = (events = []) => {
  const reasoningSteps = events.filter((event) => event.type === 'llm_reasoning').length;
  const toolEvents = events.filter((event) => event.type === 'tool_call');
  const toolCalls = toolEvents.length;
  const toolSuccesses = toolEvents.filter((event) => event.data?.success === true).length;
  const exceptions = events.filter((event) => event.type === 'exception').length;

  return {
    reasoningSteps,
    toolCalls,
    toolSuccessRate: toolCalls ? round(toolSuccesses / toolCalls) : 1,
    exceptionRate: exceptions > 0 ? 1 : 0
  };
};

export const normalizeTraceMetrics = (traces = []) => {
  const totalTraces = traces.length;
  if (!totalTraces) {
    return {
      totalTraces: 0,
      avgReasoningSteps: 0,
      toolCallSuccessRate: 1,
      exceptionChainRate: 0
    };
  }

  let reasoningSteps = 0;
  let toolCalls = 0;
  let toolSuccesses = 0;
  let exceptionChains = 0;

  traces.forEach((trace) => {
    const summary = summarizeTraceEvents(trace.events || []);
    reasoningSteps += summary.reasoningSteps;
    toolCalls += summary.toolCalls;
    toolSuccesses += Math.round(summary.toolCalls * summary.toolSuccessRate);
    if (summary.exceptionRate > 0) {
      exceptionChains += 1;
    }
  });

  return {
    totalTraces,
    avgReasoningSteps: round(reasoningSteps / totalTraces),
    toolCallSuccessRate: toolCalls ? round(toolSuccesses / toolCalls) : 1,
    exceptionChainRate: round(exceptionChains / totalTraces)
  };
};

export const createTraceLogger = ({ traceDir = DEFAULT_TRACE_DIR } = {}) => {
  const activeTraces = new Map();

  const ensureTraceDir = async () => {
    await fs.mkdir(traceDir, { recursive: true });
  };

  const getTracePath = (traceId) => path.join(traceDir, `${traceId}.json`);

  const persistTrace = async (trace) => {
    await ensureTraceDir();
    const filePath = getTracePath(trace.trace_id);
    await fs.writeFile(filePath, `${JSON.stringify(trace, null, 2)}\n`, 'utf8');
  };

  const loadTrace = async (traceId) => {
    const fromMemory = activeTraces.get(traceId);
    if (fromMemory) {
      return fromMemory;
    }

    try {
      const file = await fs.readFile(getTracePath(traceId), 'utf8');
      return JSON.parse(file);
    } catch {
      return null;
    }
  };

  return {
    async startTrace({ traceId, requestId, route, clientTraceId, meta = {} }) {
      const trace = {
        trace_id: traceId,
        request_id: requestId,
        client_trace_id: clientTraceId || null,
        route,
        status: 'in_progress',
        started_at: new Date().toISOString(),
        ended_at: null,
        meta,
        events: []
      };
      activeTraces.set(traceId, trace);
      await persistTrace(trace);
      return trace;
    },

    async appendEvent({ traceId, type, data = {} }) {
      const trace = await loadTrace(traceId);
      if (!trace) return null;
      const event = {
        ts: new Date().toISOString(),
        type,
        data
      };
      trace.events.push(event);
      activeTraces.set(traceId, trace);
      await persistTrace(trace);
      return event;
    },

    async finishTrace({ traceId, status = 'ok', httpStatus, error }) {
      const trace = await loadTrace(traceId);
      if (!trace) return null;
      trace.status = status;
      trace.http_status = httpStatus || (status === 'ok' ? 200 : 500);
      trace.error = error || null;
      trace.ended_at = new Date().toISOString();
      trace.summary = summarizeTraceEvents(trace.events || []);
      activeTraces.delete(traceId);
      await persistTrace(trace);
      return trace;
    },

    async getTrace(traceId) {
      return loadTrace(traceId);
    },

    async getRecentTraces({ limit = 100 } = {}) {
      await ensureTraceDir();
      const entries = await fs.readdir(traceDir, { withFileTypes: true });
      const files = entries
        .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
        .map((entry) => path.join(traceDir, entry.name));

      const stats = await Promise.all(
        files.map(async (filePath) => {
          const stat = await fs.stat(filePath);
          return { filePath, mtimeMs: stat.mtimeMs };
        })
      );

      stats.sort((a, b) => b.mtimeMs - a.mtimeMs);
      const selected = stats.slice(0, Math.max(1, Number(limit) || 100));

      const traces = await Promise.all(
        selected.map(async (item) => {
          const file = await fs.readFile(item.filePath, 'utf8');
          return JSON.parse(file);
        })
      );

      return traces;
    },

    async getMetrics({ limit = 100 } = {}) {
      const traces = await this.getRecentTraces({ limit });
      return normalizeTraceMetrics(traces);
    }
  };
};
