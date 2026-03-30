/**
 * Side effects system — public API
 *
 * @module state/effects
 */

export { runEffects } from './orchestrator';
export { cleanupResources } from './cleanup';
export type { EffectContext, EffectArgs, ResourceRefs } from './types';
