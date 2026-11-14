// npm run test:stack: the wallet against the live local stack (bridge/devnet: npm run local:stack).
// Same as KUSDT_STACK=1 npx vitest run test/stack.e2e.test.ts. Set KUSDT_E2E_OUT=file to keep the record.
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['vitest', 'run', 'test/stack.e2e.test.ts'], { stdio: 'inherit', shell: true, env: { ...process.env, KUSDT_STACK: '1' } });
process.exit(r.status ?? 1);
