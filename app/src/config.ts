/**
 * Type-safe server configuration with runtime validation
 * Uses Zod for fail-fast validation at startup
 */

import { z } from 'zod';

/**
 * Configuration schema with strict validation
 */
const configSchema = z.object({
  // Server configuration
  port: z.coerce
    .number()
    .min(1000, 'Port must be at least 1000')
    .max(65535, 'Port must be at most 65535')
    .default(3000),

  nodeEnv: z
    .enum(['development', 'production', 'test'])
    .default('development'),

  // STUN servers (comma-separated list)
  stunServers: z
    .string()
    .default('stun:stun.l.google.com:19302')
    .transform((str) => str.split(',').map((s) => s.trim()))
    .pipe(
      z.array(
        z.string().min(1, 'STUN server URL cannot be empty')
      )
    ),

  // TURN server configuration (optional, but all fields required together)
  turnUsername: z.string().min(1).optional(),
  turnPassword: z.string().min(8, 'TURN password must be at least 8 characters').optional(),
  turnRealm: z.string().min(1).optional(),
  externalIp: z
    .string()
    .regex(
      /^(?:(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)\.){3}(?:25[0-5]|2[0-4][0-9]|[01]?[0-9][0-9]?)$/,
      'External IP must be a valid IPv4 address'
    )
    .optional(),
});

/**
 * Parse and validate environment variables
 * FAILS LOUD with detailed error if validation fails
 */
function loadConfig() {
  const parseResult = configSchema.safeParse({
    port: process.env.BUN_PORT,
    nodeEnv: process.env.NODE_ENV,
    stunServers: process.env.STUN_SERVERS,
    turnUsername: process.env.TURN_USERNAME,
    turnPassword: process.env.TURN_PASSWORD,
    turnRealm: process.env.TURN_REALM,
    externalIp: process.env.EXTERNAL_IP,
  });

  if (!parseResult.success) {
    // FAIL FAST with detailed error messages
    console.error('[CONFIG ERROR] Invalid configuration:');
    parseResult.error.errors.forEach((err) => {
      console.error(`  - ${err.path.join('.')}: ${err.message}`);
    });
    throw new Error(
      `Configuration validation failed. Fix the errors above and restart the server.`
    );
  }

  const config = parseResult.data;

  // Validate TURN configuration: all fields required together or all absent
  const turnFields = [
    config.turnUsername,
    config.turnPassword,
    config.turnRealm,
    config.externalIp,
  ];
  const definedCount = turnFields.filter((f) => f !== undefined).length;

  if (definedCount > 0 && definedCount < 4) {
    const missingFields: string[] = [];
    if (!config.turnUsername) missingFields.push('TURN_USERNAME');
    if (!config.turnPassword) missingFields.push('TURN_PASSWORD');
    if (!config.turnRealm) missingFields.push('TURN_REALM');
    if (!config.externalIp) missingFields.push('EXTERNAL_IP');

    throw new Error(
      `TURN server configuration incomplete. Missing: ${missingFields.join(', ')}. ` +
      `All TURN fields must be provided together or all omitted.`
    );
  }

  return config;
}

/**
 * Validated configuration object
 * Loaded at module import time - server won't start if invalid
 */
export const config = loadConfig();

/**
 * TypeScript type inferred from Zod schema
 * No duplication needed!
 */
export type Config = z.infer<typeof configSchema>;

/**
 * Check if TURN server is configured
 */
export function isTurnConfigured(): boolean {
  return !!(
    config.turnUsername &&
    config.turnPassword &&
    config.turnRealm &&
    config.externalIp
  );
}
