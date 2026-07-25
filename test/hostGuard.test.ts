import { describe, expect, it } from 'vitest';
import {
  derivePerHostLimit,
  HostCircuitOpenError,
  HostConcurrencyError,
  HostGuard,
} from '../src/lib/hostGuard.js';

const clock = (start = 1_000_000) => {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms) };
};

describe('HostGuard', () => {
  it('limits concurrent audits per hostname', async () => {
    const guard = new HostGuard({ maxConcurrentPerHost: 1, failureThreshold: 5, cooldownMs: 60_000 });
    let release: (() => void) | undefined;
    const held = guard.run(
      'Example.com',
      () => new Promise<void>((resolve) => (release = resolve)),
      () => false,
    );

    await expect(guard.run('example.com', async () => 'rejected', () => false)).rejects.toBeInstanceOf(
      HostConcurrencyError,
    );

    release?.();
    await held;
    expect(guard.stateFor('example.com')).toBeUndefined();
  });

  it('opens a circuit after consecutive counted failures', async () => {
    const c = clock();
    const guard = new HostGuard({
      maxConcurrentPerHost: 2,
      failureThreshold: 2,
      cooldownMs: 10_000,
      now: c.now,
    });

    const fail = () => guard.run('slow.example', async () => { throw new Error('timeout'); }, () => true);
    await expect(fail()).rejects.toThrow('timeout');
    await expect(fail()).rejects.toThrow('timeout');

    await expect(guard.run('slow.example', async () => 'blocked', () => false)).rejects.toMatchObject({
      retryAfterSeconds: 10,
    });
    expect(guard.stats).toEqual({ trackedHosts: 1, openCircuits: 1 });
  });

  it('does not open the circuit for failures that are not target health signals', async () => {
    const guard = new HostGuard({ maxConcurrentPerHost: 2, failureThreshold: 1, cooldownMs: 60_000 });

    await expect(
      guard.run('bad-input.example', async () => { throw new Error('validation'); }, () => false),
    ).rejects.toThrow('validation');

    await expect(guard.run('bad-input.example', async () => 'ok', () => false)).resolves.toBe('ok');
  });

  it('allows recovery after the cooldown window', async () => {
    const c = clock();
    const guard = new HostGuard({
      maxConcurrentPerHost: 1,
      failureThreshold: 1,
      cooldownMs: 5_000,
      now: c.now,
    });

    await expect(
      guard.run('flaky.example', async () => { throw new Error('network'); }, () => true),
    ).rejects.toThrow('network');
    await expect(guard.run('flaky.example', async () => 'blocked', () => false)).rejects.toBeInstanceOf(
      HostCircuitOpenError,
    );

    c.advance(5_001);
    await expect(guard.run('flaky.example', async () => 'recovered', () => false)).resolves.toBe(
      'recovered',
    );
    expect(guard.stateFor('flaky.example')).toBeUndefined();
  });
});

describe('derivePerHostLimit', () => {
  it('uses an explicit configured limit when present', () => {
    expect(derivePerHostLimit(25, 7)).toBe(7);
  });

  it('derives at least two permits, roughly 15 percent of the global cap', () => {
    expect(derivePerHostLimit(25, 0)).toBe(4);
    expect(derivePerHostLimit(3, 0)).toBe(2);
  });
});
