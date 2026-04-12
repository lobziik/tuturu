/**
 * Unit tests for the mediasoup Worker pool manager.
 *
 * Mocks mediasoup.createWorker to avoid spawning real C++ worker processes.
 * Tests round-robin assignment, pool lifecycle, and error cases.
 *
 * @module server/sfu/worker-manager.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { types as mediasoupTypes } from 'mediasoup';

// ============================================================================
// Mock setup
// ============================================================================

/** Create a minimal mock Worker object. */
function createMockWorker(pid: number): mediasoupTypes.Worker {
  const listeners = new Map<string, ((...args: unknown[]) => void)[]>();
  return {
    pid,
    on(event: string, fn: (...args: unknown[]) => void) {
      const existing = listeners.get(event) ?? [];
      existing.push(fn);
      listeners.set(event, existing);
      return this;
    },
    close() {
      // no-op
    },
    // Expose listeners for test assertions
    _listeners: listeners,
  } as unknown as mediasoupTypes.Worker;
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
const { createWorkerManager } = await import('./worker-manager');

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  mockCreateWorker.mockClear();
  mockWorkerPidCounter = 1000;
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

    // Access the mock workers via createWorker call results
    for (const call of mockCreateWorker.mock.results) {
      const worker = (await call.value) as unknown as {
        _listeners: Map<string, ((...args: unknown[]) => void)[]>;
      };
      const diedHandlers = worker._listeners.get('died') ?? [];
      expect(diedHandlers.length).toBe(1);
    }

    manager.close();
  });

  test('worker died event handler calls process.exit(1)', async () => {
    const originalExit = process.exit;
    const exitMock = mock((_code?: number) => {
      throw new Error('process.exit called');
    });
    process.exit = exitMock as unknown as typeof process.exit;

    try {
      const manager = await createWorkerManager('/fake/path', 1);

      const call = mockCreateWorker.mock.results[0]!;
      const worker = (await call.value) as unknown as {
        _listeners: Map<string, ((...args: unknown[]) => void)[]>;
      };
      const diedHandlers = worker._listeners.get('died') ?? [];
      expect(diedHandlers.length).toBe(1);

      // Trigger the died event — should call process.exit(1)
      expect(() => diedHandlers[0]!(new Error('SIGKILL'))).toThrow('process.exit called');
      expect(exitMock).toHaveBeenCalledWith(1);

      manager.close();
    } finally {
      process.exit = originalExit;
    }
  });

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

  describe('close', () => {
    test('closes all workers and sets count to 0', async () => {
      const closeMocks: ReturnType<typeof mock>[] = [];
      mockCreateWorker.mockImplementation(async () => {
        const worker = createMockWorker(mockWorkerPidCounter++);
        const closeSpy = mock(() => {});
        (worker as unknown as Record<string, unknown>).close = closeSpy;
        closeMocks.push(closeSpy);
        return worker;
      });

      const manager = await createWorkerManager('/fake/path', 3);
      expect(manager.workerCount).toBe(3);

      manager.close();

      expect(manager.workerCount).toBe(0);
      for (const spy of closeMocks) {
        expect(spy).toHaveBeenCalledTimes(1);
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
