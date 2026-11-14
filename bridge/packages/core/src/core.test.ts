import { describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { core } from './index';

/**
 * The native CLI's answer, run as bridge/devnet's kusdt-tx.ts runs it: the binary named by KUSDT_TX, or the release
 * build in the `kusdt-target` volume (`bash tools/rust.sh bridge/kaspa cargo build --release --bin kusdt-tx`) inside
 * the Rust container tools/rust.sh runs, by its digest and with no network (run 21, Daybreak [6]). It answers on
 * stdout even when it refuses ({"error": ...}), so no answer at all is a machine where it could not run.
 */
function native(command: string, request: unknown): { stdout: string; why: string } {
  const input = JSON.stringify(request);
  const run = process.env.KUSDT_TX
    ? spawnSync(process.env.KUSDT_TX, [command], { input, encoding: 'utf8' })
    : spawnSync('docker', ['run', '--rm', '-i', '--network', 'none', '-v', 'kusdt-target:/target', 'docker.io/library/rust:1.94.1@sha256:652612f07bfbbdfa3af34761c1e435094c00dde4a98036132fca28c7bb2b165c', '/target/release/kusdt-tx', command], {
        input, encoding: 'utf8', env: { ...process.env, MSYS_NO_PATHCONV: '1' },
      });
  return { stdout: run.stdout ?? '', why: String(run.error?.message ?? run.stderr ?? '').trim().slice(-300) };
}

describe('the WebAssembly core', () => {
  it('lists the same commands as the CLI', () => {
    expect(core.commands()).toContain('pool-buy');
    expect(core.commands()).toContain('pool-tick');
    expect(core.commands()).toContain('mint');
  });

  it('carries the standard KCC20 template', () => {
    const t = core.call('template').value;
    expect(t.templateHash).toBe('9703112ee6e3555107cd168858992b77d3b74f655205b2b463b1f9ec2ec73cf7');
  });

  it('computes the same mint digest and burn owner as the native CLI', (ctx) => {
    const req = { covenantId: 'ab'.repeat(32), chain: 1, firstNonce: 7, recipients: [{ ownerScheme: 0, owner: '11'.repeat(32), amount: 123456789 }] };
    const digest = native('mint-digest', req);
    // Without the native build there is nothing to compare with: said as a skip, never as a pass.
    ctx.skip(!digest.stdout, `the native kusdt-tx could not be run here (${digest.why || 'no answer'}): build it with bash tools/rust.sh bridge/kaspa cargo build --release --bin kusdt-tx, or name a binary in KUSDT_TX`);
    expect(core.call('mint-digest', req).value.digest).toBe(JSON.parse(digest.stdout).digest);
    const burn = { chain: 2, address: '22'.repeat(20) };
    expect(core.call('burn-owner', burn).value.owner).toHaveLength(64);
    expect(core.call('burn-owner', burn).value.owner).toBe(JSON.parse(native('burn-owner', burn).stdout).owner);
  });

  it('reports errors as CoreError', () => {
    expect(() => core.call('mint-digest', { chain: 1 })).toThrow(/mint-digest: bad request/);
  });
});
