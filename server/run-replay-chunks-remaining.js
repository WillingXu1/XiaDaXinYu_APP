import { execSync } from 'node:child_process';

const offsets = [1000, 2000, 3000, 4000, 5000, 6000, 7000, 8000, 9000];
for (const offset of offsets) {
  const cmd = [
    'node',
    'server/trace-replay-benchmark.js',
    '--cases', 'result/policy-eval/cases/trace-cases.v1.campus.json',
    '--report-dir', 'result/policy-eval/reports',
    '--base-url', 'http://127.0.0.1:8788',
    '--offset', String(offset),
    '--limit', '1000',
    '--request-timeout-ms', '20000',
    '--concurrency', '20',
    '--max-request-retries', '2',
    '--baseline-tool-success-rate', '0.72'
  ].join(' ');

  console.log(`[chunk] start offset=${offset}`);
  execSync(cmd, { stdio: 'inherit' });
  console.log(`[chunk] done offset=${offset}`);
}
