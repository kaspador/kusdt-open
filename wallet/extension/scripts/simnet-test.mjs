// npm run test:simnet: the integration test against the local kaspad simnet
// (docker start kusdt-simnet). Same as KUSDT_SIMNET=1 npx vitest run test/simnet.int.test.ts.
import { spawnSync } from 'node:child_process';
const r = spawnSync('npx', ['vitest', 'run', 'test/simnet.int.test.ts'], { stdio: 'inherit', shell: true, env: { ...process.env, KUSDT_SIMNET: '1' } });
process.exit(r.status ?? 1);
