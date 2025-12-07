/**
 * WebSocket signaling message types
 * Split into direction-specific unions for strict typing
 */
export type ClientToServerMessage =
  | { type: 'join-pin'; pin: string }
  | { type: 'offer'; data: RTCSessionDescriptionInit }
  | { type: 'answer'; data: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; data: RTCIceCandidateInit }
  | { type: 'leave' };

export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

export type ServerToClientMessage =
  | { type: 'join-pin'; data: { iceServers: IceServerConfig[] } }
  | { type: 'peer-joined' }
  | { type: 'offer'; data: RTCSessionDescriptionInit }
  | { type: 'answer'; data: RTCSessionDescriptionInit }
  | { type: 'ice-candidate'; data: RTCIceCandidateInit }
  | { type: 'peer-left' }
  | { type: 'error'; error: string };

/**
 * Client data stored in WebSocket
 */
export interface ClientData {
  id: string;
  pin: string;
}

/**
 * ICE server configuration
 */
// Note: `IceServerConfig` moved above to allow use in ServerToClientMessage

/**
 * Error types for explicit failure handling
 */
export class SignalingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SignalingError';
  }
}

export class RoomFullError extends SignalingError {
  constructor(pin: string) {
    super(`Room ${pin} is full (maximum 2 clients)`);
    this.name = 'RoomFullError';
  }
}

export class InvalidPinError extends SignalingError {
  constructor(pin: string) {
    super(`Invalid PIN format: ${pin}. Must be 6 digits`);
    this.name = 'InvalidPinError';
  }
}

export class InvalidMessageError extends SignalingError {
  constructor(reason: string) {
    super(`Invalid message: ${reason}`);
    this.name = 'InvalidMessageError';
  }
}
