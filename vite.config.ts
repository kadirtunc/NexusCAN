import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  clearScreen: false,
  server: {
    host: '0.0.0.0',
    port: 5173,
    strictPort: true,
    watch: {
      ignored: [
        '**/src-tauri/**',
        '**/crates/**',
        '**/target/**',
        '**/node_modules/**',
        '**/projects/**',
        '**/*.nexusproj.json',
        '**/.agents/**',
        '**/recordings/**',
        '**/logs/**',
        '**/traces/**',
        '**/test/**',
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
