import { readFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

/**
 * Repo-root-anchored glob. Watcher ignore globs are matched against ABSOLUTE paths, so a bare
 * `**\/projects/**` also matched the checkout itself when it lives under `~/projects/…` and
 * silently disabled every file watch (no HMR at all). Folder-type ignores must be anchored here.
 */
const ROOT = path
  .dirname(fileURLToPath(import.meta.url))
  .replace(/[\\/]$/, '')
  .replace(/\\/g, '/');
const rootDir = (dir: string): string => `${ROOT}/${dir}/**`;

const DEV_PORT = 5173;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Bridge token file location. MUST match `nexus_bridge` exactly:
 * `NEXUS_BRIDGE_TOKEN_FILE`, else unix `$XDG_RUNTIME_DIR/nexuscan/bridge.token`,
 * else `<tmpdir>/nexuscan-<username>/bridge.token`; windows `%LOCALAPPDATA%\NexusCAN\bridge.token`.
 */
function bridgeTokenPath(): string {
  const override = process.env['NEXUS_BRIDGE_TOKEN_FILE'];
  if (override !== undefined && override.length > 0) return override;
  if (process.platform === 'win32') {
    const local = process.env['LOCALAPPDATA'];
    const base =
      local !== undefined && local.length > 0
        ? local
        : path.join(os.homedir(), 'AppData', 'Local');
    return path.join(base, 'NexusCAN', 'bridge.token');
  }
  const xdg = process.env['XDG_RUNTIME_DIR'];
  if (xdg !== undefined && xdg.length > 0) {
    return path.join(xdg, 'nexuscan', 'bridge.token');
  }
  let user = 'unknown';
  try {
    user = os.userInfo().username;
  } catch {
    user = process.env['USER'] ?? process.env['USERNAME'] ?? 'unknown';
  }
  return path.join(os.tmpdir(), `nexuscan-${user}`, 'bridge.token');
}

function hostnameOfHostHeader(host: string): string {
  // `[::1]:5173` -> `[::1]`, `localhost:5173` -> `localhost`
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    return end === -1 ? host : host.slice(0, end + 1);
  }
  const colon = host.lastIndexOf(':');
  return (colon === -1 ? host : host.slice(0, colon)).toLowerCase();
}

function isLocalRequest(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host;
  if (typeof host !== 'string' || !LOOPBACK_HOSTS.has(hostnameOfHostHeader(host))) return false;
  const origin = req.headers.origin;
  if (origin === undefined) return true;
  if (typeof origin !== 'string') return false;
  try {
    const u = new URL(origin);
    const originPort = u.port === '' ? '80' : u.port;
    return (
      u.protocol === 'http:' &&
      LOOPBACK_HOSTS.has(u.hostname.startsWith('[') ? u.hostname : u.hostname.toLowerCase()) &&
      originPort === String(port)
    );
  } catch {
    return false;
  }
}

function sendJson(res: ServerResponse, status: number, body: Record<string, string>): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Cache-Control', 'no-store');
  res.end(JSON.stringify(body));
}

/**
 * Dev-only: hands the browser-mode UI the local bridge bearer token (same-origin, loopback Host
 * and Origin only). The token is never logged and never put in a URL.
 */
function bridgeTokenPlugin(): Plugin {
  return {
    name: 'nexus-bridge-token',
    apply: 'serve',
    configureServer(server) {
      server.middlewares.use('/__nexus/bridge-token', (req, res) => {
        const port = server.config.server.port ?? DEV_PORT;
        if (!isLocalRequest(req, port)) {
          sendJson(res, 403, {});
          return;
        }
        if (req.method !== 'GET') {
          res.setHeader('Allow', 'GET');
          sendJson(res, 405, {});
          return;
        }
        readFile(bridgeTokenPath(), 'utf8')
          .then((raw) => {
            const token = raw.trim();
            if (token.length === 0) sendJson(res, 404, {});
            else sendJson(res, 200, { token });
          })
          .catch(() => sendJson(res, 404, {}));
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), tailwindcss(), bridgeTokenPlugin()],
  clearScreen: false,
  server: {
    host: '127.0.0.1',
    port: DEV_PORT,
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
