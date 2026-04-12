/**
 * SFU room manager — one mediasoup Router per room.
 *
 * Lazily creates a Router + AudioLevelObserver when the first peer joins
 * a room's SFU call. Cleans up when the last peer leaves.
 *
 * @module server/sfu/room-manager
 */

import type { types as mediasoupTypes } from 'mediasoup';
import type { BroadcastFn, SfuRoomState, SfuRoomManagerDeps, SfuRoomManager } from './types';
import { MEDIA_CODECS } from './codecs';

/**
 * Create an SFU room manager.
 *
 * @param deps.workerManager - Pool of mediasoup Workers for Router assignment.
 * @param deps.broadcast - Callback for broadcasting messages to all room peers.
 * @param deps.listenIp - IP for WebRtcTransport to bind on.
 * @param deps.announcedIp - External IP announced in ICE candidates (for TURN relay).
 */
export function createSfuRoomManager(deps: SfuRoomManagerDeps): SfuRoomManager {
  const { workerManager, broadcast } = deps;
  const rooms = new Map<string, SfuRoomState>();

  async function getOrCreateRoom(roomId: string): Promise<SfuRoomState> {
    const existing = rooms.get(roomId);
    if (existing) return existing;

    const worker = workerManager.getNextWorker();
    const router = await worker.createRouter({ mediaCodecs: MEDIA_CODECS });

    const audioLevelObserver = await router.createAudioLevelObserver({
      maxEntries: 1,
      threshold: -60,
      interval: 800,
    });

    const room: SfuRoomState = {
      router,
      audioLevelObserver,
      peers: new Map(),
      producerOwners: new Map(),
    };

    setupAudioLevelObserver(audioLevelObserver, room, roomId, broadcast);

    rooms.set(roomId, room);
    console.log(`[SFU:RoomManager] Created SFU room ${roomId} (router ${router.id})`);

    return room;
  }

  function getRoom(roomId: string): SfuRoomState | undefined {
    return rooms.get(roomId);
  }

  function removeRoom(roomId: string): void {
    const room = rooms.get(roomId);
    if (!room) return;

    room.audioLevelObserver.close();
    room.router.close();
    rooms.delete(roomId);
    console.log(`[SFU:RoomManager] Removed SFU room ${roomId}`);
  }

  return {
    getOrCreateRoom,
    getRoom,
    removeRoom,
    get roomCount() {
      return rooms.size;
    },
  };
}

/**
 * Wire AudioLevelObserver events to broadcast active speaker to all peers.
 */
function setupAudioLevelObserver(
  observer: mediasoupTypes.AudioLevelObserver,
  room: SfuRoomState,
  roomId: string,
  broadcast: BroadcastFn,
): void {
  observer.on('volumes', (volumes: mediasoupTypes.AudioLevelObserverVolume[]) => {
    const loudest = volumes[0];
    if (!loudest) return;

    const producerId = loudest.producer.id;
    const peerId = room.producerOwners.get(producerId);
    if (!peerId) return;

    broadcast(roomId, {
      type: 'sfu-active-speaker',
      v: 1,
      peerId,
    });
  });

  observer.on('silence', () => {
    broadcast(roomId, {
      type: 'sfu-active-speaker',
      v: 1,
      peerId: null,
    });
  });
}
