/**
 * Unit tests for the SFU room manager.
 *
 * Mocks mediasoup Worker/Router/AudioLevelObserver to test room lifecycle,
 * observer wiring, and cleanup without spawning real C++ processes.
 *
 * @module server/sfu/room-manager.test
 */

import { describe, test, expect, mock, beforeEach } from 'bun:test';
import type { types as mediasoupTypes } from 'mediasoup';
import type { WorkerManager, BroadcastFn } from './types';
import type { ServerToClientMessage } from '../../shared/schemas';
import { createSfuRoomManager } from './room-manager';

// ============================================================================
// Mock factories
// ============================================================================

type EventListener = (...args: unknown[]) => void;

function createMockAudioLevelObserver(): mediasoupTypes.AudioLevelObserver & {
  _listeners: Map<string, EventListener[]>;
  _emit: (event: string, ...args: unknown[]) => void;
  close: ReturnType<typeof mock>;
} {
  const listeners = new Map<string, EventListener[]>();
  const closeFn = mock(() => {});
  return {
    on(event: string, fn: EventListener) {
      const existing = listeners.get(event) ?? [];
      existing.push(fn);
      listeners.set(event, existing);
      return this;
    },
    close: closeFn,
    _listeners: listeners,
    _emit(event: string, ...args: unknown[]) {
      for (const fn of listeners.get(event) ?? []) {
        fn(...args);
      }
    },
  } as unknown as mediasoupTypes.AudioLevelObserver & {
    _listeners: Map<string, EventListener[]>;
    _emit: (event: string, ...args: unknown[]) => void;
    close: ReturnType<typeof mock>;
  };
}

function createMockRouter(
  id: string,
  audioLevelObserver: ReturnType<typeof createMockAudioLevelObserver>,
): mediasoupTypes.Router & {
  close: ReturnType<typeof mock>;
  createAudioLevelObserver: ReturnType<typeof mock>;
} {
  const closeFn = mock(() => {});
  const createAudioLevelObserverFn = mock(async () => audioLevelObserver);

  return {
    id,
    rtpCapabilities: { codecs: [], headerExtensions: [] },
    close: closeFn,
    createRouter: mock(async () => {
      throw new Error('Unexpected nested router creation');
    }),
    createAudioLevelObserver: createAudioLevelObserverFn,
  } as unknown as mediasoupTypes.Router & {
    close: ReturnType<typeof mock>;
    createAudioLevelObserver: ReturnType<typeof mock>;
  };
}

let routerCounter = 0;

function createMockWorkerManager(): WorkerManager & {
  _mockWorker: mediasoupTypes.Worker;
} {
  let mockAudioLevelObserver: ReturnType<typeof createMockAudioLevelObserver>;
  let mockRouter: ReturnType<typeof createMockRouter>;

  const worker = {
    pid: 42,
    createRouter: mock(async () => {
      mockAudioLevelObserver = createMockAudioLevelObserver();
      mockRouter = createMockRouter(`router-${routerCounter++}`, mockAudioLevelObserver);
      return mockRouter;
    }),
  } as unknown as mediasoupTypes.Worker;

  return {
    getNextWorker: () => worker,
    get workerCount() {
      return 1;
    },
    close: () => {},
    _mockWorker: worker,
  };
}

// ============================================================================
// Tests
// ============================================================================

let workerManager: ReturnType<typeof createMockWorkerManager>;
let broadcastCalls: Array<{
  roomId: string;
  message: ServerToClientMessage;
  excludePeerId?: string;
}>;
let broadcastFn: BroadcastFn;

beforeEach(() => {
  routerCounter = 0;
  workerManager = createMockWorkerManager();
  broadcastCalls = [];
  broadcastFn = (roomId, message, excludePeerId) => {
    const entry: { roomId: string; message: ServerToClientMessage; excludePeerId?: string } = {
      roomId,
      message,
    };
    if (excludePeerId !== undefined) {
      entry.excludePeerId = excludePeerId;
    }
    broadcastCalls.push(entry);
  };
});

describe('createSfuRoomManager', () => {
  test('getOrCreateRoom creates a new room with router and observer', async () => {
    const manager = createSfuRoomManager({
      workerManager,
      broadcast: broadcastFn,
      listenIp: '0.0.0.0',
      announcedIp: undefined,
    });

    const room = await manager.getOrCreateRoom('room-1');

    expect(room.router).toBeDefined();
    expect(room.audioLevelObserver).toBeDefined();
    expect(room.peers.size).toBe(0);
    expect(room.producerOwners.size).toBe(0);
    expect(manager.roomCount).toBe(1);
  });

  test('getOrCreateRoom returns the same room on second call', async () => {
    const manager = createSfuRoomManager({
      workerManager,
      broadcast: broadcastFn,
      listenIp: '0.0.0.0',
      announcedIp: undefined,
    });

    const room1 = await manager.getOrCreateRoom('room-1');
    const room2 = await manager.getOrCreateRoom('room-1');

    expect(room1).toBe(room2);
    expect(manager.roomCount).toBe(1);
  });

  test('getOrCreateRoom creates separate rooms for different IDs', async () => {
    const manager = createSfuRoomManager({
      workerManager,
      broadcast: broadcastFn,
      listenIp: '0.0.0.0',
      announcedIp: undefined,
    });

    const room1 = await manager.getOrCreateRoom('room-a');
    const room2 = await manager.getOrCreateRoom('room-b');

    expect(room1).not.toBe(room2);
    expect(manager.roomCount).toBe(2);
  });

  test('getRoom returns undefined for non-existent room', () => {
    const manager = createSfuRoomManager({
      workerManager,
      broadcast: broadcastFn,
      listenIp: '0.0.0.0',
      announcedIp: undefined,
    });

    expect(manager.getRoom('no-such-room')).toBeUndefined();
  });

  test('getRoom returns existing room', async () => {
    const manager = createSfuRoomManager({
      workerManager,
      broadcast: broadcastFn,
      listenIp: '0.0.0.0',
      announcedIp: undefined,
    });

    const created = await manager.getOrCreateRoom('room-1');
    const retrieved = manager.getRoom('room-1');

    expect(retrieved).toBe(created);
  });

  describe('removeRoom', () => {
    test('closes router and observer, removes from map', async () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      const room = await manager.getOrCreateRoom('room-1');
      const routerClose = room.router.close as ReturnType<typeof mock>;
      const observerClose = room.audioLevelObserver.close as ReturnType<typeof mock>;

      manager.removeRoom('room-1');

      expect(routerClose).toHaveBeenCalledTimes(1);
      expect(observerClose).toHaveBeenCalledTimes(1);
      expect(manager.roomCount).toBe(0);
      expect(manager.getRoom('room-1')).toBeUndefined();
    });

    test('no-op for non-existent room', () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      // Should not throw
      manager.removeRoom('no-such-room');
    });
  });

  describe('AudioLevelObserver events', () => {
    test('volumes event broadcasts sfu-active-speaker with peerId', async () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      const room = await manager.getOrCreateRoom('room-1');

      // Simulate a producer owner mapping
      room.producerOwners.set('producer-1', 'peer-alice');

      // Simulate the AudioLevelObserver emitting a volumes event
      const observer = room.audioLevelObserver as unknown as {
        _emit: (event: string, ...args: unknown[]) => void;
      };
      observer._emit('volumes', [{ producer: { id: 'producer-1' }, volume: -40 }]);

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0]!.roomId).toBe('room-1');
      expect(broadcastCalls[0]!.message).toEqual({
        type: 'sfu-active-speaker',
        v: 1,
        peerId: 'peer-alice',
      });
    });

    test('volumes event is ignored when producer owner unknown', async () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      const room = await manager.getOrCreateRoom('room-1');

      const observer = room.audioLevelObserver as unknown as {
        _emit: (event: string, ...args: unknown[]) => void;
      };
      observer._emit('volumes', [{ producer: { id: 'unknown-producer' }, volume: -40 }]);

      expect(broadcastCalls).toHaveLength(0);
    });

    test('silence event broadcasts sfu-active-speaker with null peerId', async () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      const room = await manager.getOrCreateRoom('room-1');

      const observer = room.audioLevelObserver as unknown as {
        _emit: (event: string, ...args: unknown[]) => void;
      };
      observer._emit('silence');

      expect(broadcastCalls).toHaveLength(1);
      expect(broadcastCalls[0]!.message).toEqual({
        type: 'sfu-active-speaker',
        v: 1,
        peerId: null,
      });
    });

    test('volumes event with empty array is ignored', async () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      const room = await manager.getOrCreateRoom('room-1');

      const observer = room.audioLevelObserver as unknown as {
        _emit: (event: string, ...args: unknown[]) => void;
      };
      observer._emit('volumes', []);

      expect(broadcastCalls).toHaveLength(0);
    });
  });

  describe('concurrent access', () => {
    test('concurrent getOrCreateRoom calls create only one router', async () => {
      const manager = createSfuRoomManager({
        workerManager,
        broadcast: broadcastFn,
        listenIp: '0.0.0.0',
        announcedIp: undefined,
      });

      const createRouterFn = workerManager._mockWorker.createRouter as ReturnType<typeof mock>;
      const callsBefore = createRouterFn.mock.calls.length;

      // Fire two concurrent requests for the same room
      const [room1, room2] = await Promise.all([
        manager.getOrCreateRoom('room-1'),
        manager.getOrCreateRoom('room-1'),
      ]);

      expect(room1).toBe(room2);
      expect(createRouterFn.mock.calls.length - callsBefore).toBe(1);
      expect(manager.roomCount).toBe(1);
    });
  });
});
