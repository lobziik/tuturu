/**
 * Type declarations for static asset imports
 * Required for TypeScript to allow importing HTML/CSS/JS files as strings
 *
 * These declarations enable Bun's import attributes syntax:
 * ```typescript
 * import html from './file.html' with { type: 'text' };
 * import css from './file.css' with { type: 'text' };
 * import js from './file.js' with { type: 'text' };
 * ```
 */

declare module '*.html' {
  const content: string;
  export default content;
}

declare module '*.css' {
  const content: string;
  export default content;
}

declare module '*.js' {
  const content: string;
  export default content;
}

/**
 * Type declarations for favicon and image assets
 * Bun imports binary files as Blob by default
 */
declare module '*.ico' {
  const content: Blob;
  export default content;
}

declare module '*.png' {
  const content: Blob;
  export default content;
}

declare module '*.webmanifest' {
  const content: string;
  export default content;
}

/**
 * Type declaration for the embedded mediasoup-worker binary.
 * Imported via `with { type: 'file' }`:
 * - Dev mode: returns string path to the file on disk
 * - Compiled mode: returns path to Bun's auto-extracted temp file (/$bunfs/...)
 *
 * Uses wildcard because TS doesn't support relative paths in ambient module declarations.
 * Only consumed by `src/server/worker-bin.ts`. No npm package matches this name.
 */
declare module '*/mediasoup-worker' {
  const path: string;
  export default path;
}

/**
 * Cache-busting hash for the E2EE worker, injected into HTML by assets.ts.
 * Read by e2ee-transform.ts to load the worker with a versioned URL.
 */
interface Window {
  __E2EE_WORKER_HASH__?: string;
}
