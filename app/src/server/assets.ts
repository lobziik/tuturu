/**
 * Static asset loading and caching
 *
 * Handles embedded assets (compiled into executable) and ETag-based caching.
 * In dev mode: imports return string paths
 * In compiled mode: imports return BunFile objects
 */

import type { BunFile } from 'bun';

// Embedded static assets (bundled at compile time)
import indexHtml from '../../public/index.html' with { type: 'text' };
import styles from '../../public/styles.css' with { type: 'text' };
import clientJs from '../../public/index.js' with { type: 'text' };

// Favicon assets - embedded as BunFile in compiled mode, string path in dev mode
import webmanifest from '../../public/site.webmanifest' with { type: 'text' };
import faviconIcoFile from '../../public/favicon.ico' with { type: 'file' };
import favicon16File from '../../public/favicon-16x16.png' with { type: 'file' };
import favicon32File from '../../public/favicon-32x32.png' with { type: 'file' };
import appleTouchIconFile from '../../public/apple-touch-icon.png' with { type: 'file' };
import androidChrome192File from '../../public/android-chrome-192x192.png' with { type: 'file' };
import androidChrome512File from '../../public/android-chrome-512x512.png' with { type: 'file' };

/**
 * Helper to read file content - handles both dev mode (string path) and compiled mode (BunFile)
 * In dev mode: import with { type: 'file' } returns a string path
 * In compiled mode: import with { type: 'file' } returns a BunFile object
 * TypeScript declares these as Blob (global.d.ts), but runtime behavior differs
 */
async function readFileContent(file: string | BunFile | Blob): Promise<ArrayBuffer> {
  if (typeof file === 'string') {
    return await Bun.file(file).arrayBuffer();
  }
  return await file.arrayBuffer();
}

/** Text assets with string content */
export interface TextAssets {
  indexHtml: string;
  styles: string;
  clientJs: string;
  webmanifest: string;
}

/** Binary assets as ArrayBuffers */
export interface BinaryAssets {
  faviconIco: ArrayBuffer;
  favicon16: ArrayBuffer;
  favicon32: ArrayBuffer;
  appleTouchIcon: ArrayBuffer;
  androidChrome192: ArrayBuffer;
  androidChrome512: ArrayBuffer;
}

/** ETags for cache validation */
export interface AssetEtags {
  html: string;
  css: string;
  js: string;
  manifest: string;
}

/** All loaded assets */
export interface LoadedAssets {
  text: TextAssets;
  binary: BinaryAssets;
  etags: AssetEtags;
}

/**
 * Load all static assets at startup.
 * Text assets are type-asserted from imports.
 * Binary assets are read into ArrayBuffers.
 * ETags are computed from content hashes.
 */
export async function loadAssets(): Promise<LoadedAssets> {
  // Read binary content
  const [faviconIco, favicon16, favicon32, appleTouchIcon, androidChrome192, androidChrome512] =
    await Promise.all([
      readFileContent(faviconIcoFile),
      readFileContent(favicon16File),
      readFileContent(favicon32File),
      readFileContent(appleTouchIconFile),
      readFileContent(androidChrome192File),
      readFileContent(androidChrome512File),
    ]);

  // Type assertions for text assets
  const indexHtmlStr = indexHtml as unknown as string;
  const stylesStr = styles as unknown as string;
  const clientJsStr = clientJs as unknown as string;
  const webmanifestStr = webmanifest as unknown as string;

  // Compute ETags from content hashes
  const etags: AssetEtags = {
    html: `"${Bun.hash(indexHtmlStr).toString(16)}"`,
    css: `"${Bun.hash(stylesStr).toString(16)}"`,
    js: `"${Bun.hash(clientJsStr).toString(16)}"`,
    manifest: `"${Bun.hash(webmanifestStr).toString(16)}"`,
  };

  return {
    text: {
      indexHtml: indexHtmlStr,
      styles: stylesStr,
      clientJs: clientJsStr,
      webmanifest: webmanifestStr,
    },
    binary: {
      faviconIco,
      favicon16,
      favicon32,
      appleTouchIcon,
      androidChrome192,
      androidChrome512,
    },
    etags,
  };
}
