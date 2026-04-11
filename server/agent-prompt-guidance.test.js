import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const agentServerPath = path.resolve(process.cwd(), 'server/agent-server.js');
const agentServerSource = fs.readFileSync(agentServerPath, 'utf8');

test('system prompt allows low-risk daily companionship to reply without tools', () => {
  assert.match(
    agentServerSource,
    /低风险.*日常.*对话.*无需调用工具|无需调用工具.*低风险.*日常.*对话/
  );
});

test('system prompt prioritizes tools for medium\/high risk and explicit advice needs', () => {
  assert.match(
    agentServerSource,
    /高、中风险.*优先使用 tools|优先使用 tools.*高、中风险/
  );
  assert.match(
    agentServerSource,
    /明确求建议.*明确求行动.*明确要知识支持|明确要知识支持.*明确求行动.*明确求建议/
  );
});

test('system prompt no longer forces every turn to use tools', () => {
  assert.doesNotMatch(agentServerSource, /必须使用 tools/);
});
