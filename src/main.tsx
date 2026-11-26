import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DetachedTraceWindow } from './components/DetachedTraceWindow';
import { DetachedDebugWindowApp } from './components/DetachedDebugWindowApp';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Fatal: #root mount container missing in index.html');
}

const windowParams = new URLSearchParams(window.location.search);
const windowKind = windowParams.get('window');
const traceKey = windowParams.get('key') ?? '';

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {windowKind === 'debug-console'
      ? <DetachedDebugWindowApp />
      : windowKind === 'trace' && /^[a-f0-9]{32}$/.test(traceKey)
        ? <DetachedTraceWindow channelKey={traceKey} />
        : <App />}
  </React.StrictMode>,
);
