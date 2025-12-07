/**
 * Message types for WebSocket signaling
 */
export type MessageType =
  | 'join-pin'
  | 'offer'
  | 'answer'
  | 'ice-candidate'
  | 'leave'
  | 'peer-joined'
  | 'peer-left'
  | 'error';

/**
 * Base message structure for WebSocket communication
 */
export interface Message {
  type: MessageType;
  pin?: string;
  data?: any;
  error?: string;
}

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
export interface IceServerConfig {
  urls: string | string[];
  username?: string;
  credential?: string;
}

/**
 * Server configuration
 */
export interface ServerConfig {
  port: number;
  turnUsername?: string;
  turnPassword?: string;
  turnRealm?: string;
  externalIp?: string;
}

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
