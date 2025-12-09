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
