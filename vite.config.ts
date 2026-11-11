import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Repo-root-anchored glob. Watcher ignore globs are matched against ABSOLUTE paths, so a bare
 * `**\/projects/**` also matched the checkout itself when it lives under `~/projects/…` and
 * silently disabled every file watch (no HMR at all). Folder-type ignores must be anchored here.
 */
// Vite's config loader injects `__dirname` (the config file's directory); declared here because the
// node tsconfig has no @types/node.
declare const __dirname: string;
const ROOT = __dirname.replace(/[\\/]$/, '').replace(/\\/g, '/');
const rootDir = (dir: string): string => `${ROOT}/${dir}/**`;

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        rootDir('src-tauri'),
        rootDir('crates'),
        rootDir('target'),
        '**/node_modules/**',
        rootDir('projects'),
        '**/*.nexusproj.json',
        rootDir('.agents'),
        rootDir('recordings'),
        rootDir('logs'),
        rootDir('traces'),
        rootDir('test'),
        '**/*.trc',
        '**/*.asc',
        '**/*.blf',
        '**/*.log',
        '**/*.csv',
        '**/*.dbc',
        '**/*.kcd',
        '**/*.nexuspanel.json',
      ],
    },
  },
  build: {
    target: 'es2022',
    sourcemap: false,
  },
});
