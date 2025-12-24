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
