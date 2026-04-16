/**
 * Unit tests for the mediasoup Worker pool manager.
 *
 * Mocks mediasoup.createWorker to avoid spawning real C++ worker processes.
 * Tests round-robin assignment, pool lifecycle, death handling, and respawn logic.
 *
 * @module server/sfu/worker-manager.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { types as mediasoupTypes } from 'mediasoup';

// ============================================================================
// Mock setup
// ============================================================================

/** Minimal mock Worker with event support and test helpers. */
interface MockWorker extends mediasoupTypes.Worker {
  _listeners: Map<string, ((...args: unknown[]) => void)[]>;
  _emit: (event: string, ...args: unknown[]) => void;
  close: ReturnType<typeof mock>;
}

/** Create a minimal mock Worker object. */
function createMockWorker(pid: number): MockWorker {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    pid,
    on(event: string, fn: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(fn);
      listeners.set(event, existing);
      return this;
    },
    close: mock(() => {}),
    _listeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) {
        fn(...args);
      }
    },
  } as unknown as MockWorker;
}

/** Build an Error in the exact format mediasoup uses for the `died` event. */
function diedError(pid: number, code: number | null, signal: string | null): Error {
  return new Error(`[pid:${pid}, code:${code}, signal:${signal}]`);
}

let mockWorkerPidCounter = 1000;

const mockCreateWorker = mock(
  async (_options?: Record<string, unknown>): Promise<mediasoupTypes.Worker> => {
    const worker = createMockWorker(mockWorkerPidCounter++);
    return worker;
  },
);

// Mock the mediasoup module before importing the module under test
// eslint-disable-next-line @typescript-eslint/no-floating-promises -- mock.module is synchronous in bun:test
mock.module('mediasoup', () => ({
  createWorker: mockCreateWorker,
}));

// Import after mocking
const { createWorkerManager, parseDiedError } = await import('./worker-manager');

/** Get the mock worker created by the Nth call to createWorker. */
async function getMockWorker(callIndex: number): Promise<MockWorker> {
  return (await mockCreateWorker.mock.results[callIndex]!.value) as unknown as MockWorker;
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockWorkerPidCounter = 1000;
  mockCreateWorker.mockClear();
  // Reset to default implementation — custom mockImplementation from prior tests
  // (e.g. deferred-promise tests) does NOT get cleared by mockClear().
  mockCreateWorker.mockImplementation(async () => createMockWorker(mockWorkerPidCounter++));
});

describe('parseDiedError', () => {
  test('parses clean exit (code:0, signal:null)', () => {
    expect(parseDiedError('[pid:1234, code:0, signal:null]')).toEqual({
      code: 0,
      signal: null,
    });
  });

  test('parses crash with non-zero code', () => {
    expect(parseDiedError('[pid:1234, code:1, signal:null]')).toEqual({
      code: 1,
      signal: null,
    });
  });

  test('parses signal kill', () => {
    expect(parseDiedError('[pid:1234, code:null, signal:SIGKILL]')).toEqual({
      code: null,
      signal: 'SIGKILL',
    });
  });

  test('returns nulls for malformed message', () => {
    expect(parseDiedError('something unexpected')).toEqual({
      code: null,
      signal: null,
    });
  });
});

describe('createWorkerManager', () => {
  test('spawns the requested number of workers', async () => {
    const manager = await createWorkerManager('/fake/path', 3);

    expect(mockCreateWorker).toHaveBeenCalledTimes(3);
    expect(manager.workerCount).toBe(3);

    manager.close();
  });

  test('passes workerBin path to createWorker', async () => {
    const binPath = '/opt/mediasoup-worker';
    const manager = await createWorkerManager(binPath, 1);

    expect(mockCreateWorker).toHaveBeenCalledWith(expect.objectContaining({ workerBin: binPath }));

    manager.close();
  });

  test('throws when numWorkers is less than 1', async () => {
    await expect(createWorkerManager('/fake/path', 0)).rejects.toThrow('numWorkers must be >= 1');
  });

  test('registers died event handler on each worker', async () => {
    const manager = await createWorkerManager('/fake/path', 2);

    for (let i = 0; i < 2; i++) {
      const worker = await getMockWorker(i);
      const diedHandlers = worker._listeners.get('died') ?? [];
      expect(diedHandlers.length).toBe(1);
    }

    manager.close();
  });

  // ==========================================================================
  // Worker death handling
  // ==========================================================================

  describe('worker death handling', () => {
    test('clean exit (code:0, signal:null) triggers respawn', async () => {
      const manager = await createWorkerManager('/fake/path', 2);
      const worker0 = await getMockWorker(0);

      // Kill worker 0 with a clean exit
      worker0._emit('died', diedError(1000, 0, null));

      // Flush microtask queue so async respawn completes
      await Bun.sleep(1);

      // 2 initial + 1 respawn
      expect(mockCreateWorker).toHaveBeenCalledTimes(3);
      expect(manager.workerCount).toBe(2);

      manager.close();
    });

    test('crash (code:1, signal:null) removes worker without respawn', async () => {
      const manager = await createWorkerManager('/fake/path', 2);
      const worker0 = await getMockWorker(0);

      worker0._emit('died', diedError(1000, 1, null));
      await Bun.sleep(1);

      // No respawn — still only 2 calls
      expect(mockCreateWorker).toHaveBeenCalledTimes(2);
      expect(manager.workerCount).toBe(1);

      manager.close();
    });

    test('crash (signal:SIGKILL) removes worker without respawn', async () => {
      const manager = await createWorkerManager('/fake/path', 2);
      const worker0 = await getMockWorker(0);

      worker0._emit('died', diedError(1000, null, 'SIGKILL'));
      await Bun.sleep(1);

      expect(mockCreateWorker).toHaveBeenCalledTimes(2);
      expect(manager.workerCount).toBe(1);

      manager.close();
    });

    test('rate limit exceeded stops respawning', async () => {
      const manager = await createWorkerManager('/fake/path', 1);

      // Kill and respawn 3 times (hitting the rate limit)
      for (let i = 0; i < 3; i++) {
        const workerIdx = i; // 0 = initial, 1 = 1st respawn, 2 = 2nd respawn
        const worker = await getMockWorker(workerIdx);
        worker._emit('died', diedError(worker.pid, 0, null));
        await Bun.sleep(1);
      }

      // 1 initial + 3 respawns = 4 total createWorker calls
      expect(mockCreateWorker).toHaveBeenCalledTimes(4);
      expect(manager.workerCount).toBe(1);

      // 4th death — rate limit should prevent respawn
      const worker3 = await getMockWorker(3);
      worker3._emit('died', diedError(worker3.pid, 0, null));
      await Bun.sleep(1);

      // Still 4 calls — no new respawn
      expect(mockCreateWorker).toHaveBeenCalledTimes(4);
      expect(manager.workerCount).toBe(0);
      expect(() => manager.getNextWorker()).toThrow('No workers available');

      manager.close();
    });

    test('close() cancels pending respawn', async () => {
      // Use a deferred promise to control when createWorker resolves
      let resolveRespawn!: (w: mediasoupTypes.Worker) => void;
      const respawnPromise = new Promise<mediasoupTypes.Worker>((resolve) => {
        resolveRespawn = resolve;
      });

      // First call creates normally, second call (respawn) blocks
      let callCount = 0;
      mockCreateWorker.mockImplementation(async () => {
        callCount++;
        if (callCount === 1) {
          return createMockWorker(mockWorkerPidCounter++);
        }
        return respawnPromise;
      });

      const manager = await createWorkerManager('/fake/path', 1);
      const worker0 = await getMockWorker(0);

      // Trigger respawn (clean exit)
      worker0._emit('died', diedError(1000, 0, null));

      // Close manager before respawn resolves
      manager.close();

      // Now resolve the respawn — new worker should be closed immediately
      const respawnedWorker = createMockWorker(9999);
      resolveRespawn(respawnedWorker);
      await Bun.sleep(1);

      expect(manager.workerCount).toBe(0);
      expect((respawnedWorker as MockWorker).close).toHaveBeenCalledTimes(1);
    });

    test('getNextWorker() skips dead workers', async () => {
      const manager = await createWorkerManager('/fake/path', 3);
      const worker1 = await getMockWorker(1);

      // Kill the middle worker with a crash (no respawn)
      worker1._emit('died', diedError(1001, 1, null));
      await Bun.sleep(1);

      // Round-robin should only return workers 0 and 2
      const pids = new Set<number>();
      for (let i = 0; i < 6; i++) {
        pids.add(manager.getNextWorker().pid);
      }

      expect(pids.has(1000)).toBe(true);
      expect(pids.has(1001)).toBe(false);
      expect(pids.has(1002)).toBe(true);

      manager.close();
    });

    test('getNextWorker() throws when all workers are dead', async () => {
      const manager = await createWorkerManager('/fake/path', 2);
      const worker0 = await getMockWorker(0);
      const worker1 = await getMockWorker(1);

      // Crash both
      worker0._emit('died', diedError(1000, 1, null));
      worker1._emit('died', diedError(1001, 1, null));
      await Bun.sleep(1);

      expect(manager.workerCount).toBe(0);
      expect(() => manager.getNextWorker()).toThrow('No workers available');

      manager.close();
    });

    test('workerCount reflects only healthy workers', async () => {
      const manager = await createWorkerManager('/fake/path', 3);
      expect(manager.workerCount).toBe(3);

      const worker0 = await getMockWorker(0);
      worker0._emit('died', diedError(1000, 1, null));
      expect(manager.workerCount).toBe(2);

      const worker1 = await getMockWorker(1);
      worker1._emit('died', diedError(1001, 1, null));
      expect(manager.workerCount).toBe(1);

      manager.close();
    });

    test('respawned worker has its own died handler', async () => {
      const manager = await createWorkerManager('/fake/path', 1);
      const worker0 = await getMockWorker(0);

      // Clean death → respawn
      worker0._emit('died', diedError(1000, 0, null));
      await Bun.sleep(1);
      expect(manager.workerCount).toBe(1);

      // The respawned worker (index 1) should have a died handler
      const respawnedWorker = await getMockWorker(1);
      const diedHandlers = respawnedWorker._listeners.get('died') ?? [];
      expect(diedHandlers.length).toBe(1);

      // Crash the respawned worker — should shrink pool, no respawn
      respawnedWorker._emit('died', diedError(respawnedWorker.pid, 1, null));
      await Bun.sleep(1);

      expect(manager.workerCount).toBe(0);
      // 1 initial + 1 respawn = 2 total (no further respawn for crash)
      expect(mockCreateWorker).toHaveBeenCalledTimes(2);

      manager.close();
    });
  });

  // ==========================================================================
  // Round-robin
  // ==========================================================================

  describe('getNextWorker', () => {
    test('returns workers in round-robin order', async () => {
      const manager = await createWorkerManager('/fake/path', 3);

      const w1 = manager.getNextWorker();
      const w2 = manager.getNextWorker();
      const w3 = manager.getNextWorker();
      // Should cycle back to first
      const w4 = manager.getNextWorker();

      expect(w1.pid).toBe(1000);
      expect(w2.pid).toBe(1001);
      expect(w3.pid).toBe(1002);
      expect(w4.pid).toBe(1000);

      manager.close();
    });

    test('works with a single worker', async () => {
      const manager = await createWorkerManager('/fake/path', 1);

      const w1 = manager.getNextWorker();
      const w2 = manager.getNextWorker();

      expect(w1.pid).toBe(w2.pid);

      manager.close();
    });

    test('throws after close', async () => {
      const manager = await createWorkerManager('/fake/path', 2);
      manager.close();

      expect(() => manager.getNextWorker()).toThrow('No workers available');
    });
  });

  // ==========================================================================
  // Lifecycle
  // ==========================================================================

  describe('close', () => {
    test('closes all workers and sets count to 0', async () => {
      const manager = await createWorkerManager('/fake/path', 3);
      expect(manager.workerCount).toBe(3);

      manager.close();

      expect(manager.workerCount).toBe(0);
      for (let i = 0; i < 3; i++) {
        const worker = await getMockWorker(i);
        expect(worker.close).toHaveBeenCalledTimes(1);
      }
    });

    test('is idempotent', async () => {
      const manager = await createWorkerManager('/fake/path', 1);
      manager.close();
      // Second close should not throw
      manager.close();
      expect(manager.workerCount).toBe(0);
    });
  });
});
