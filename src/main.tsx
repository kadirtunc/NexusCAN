import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import { DetachedDebugWindowApp } from './components/DetachedDebugWindowApp';
import './index.css';

const rootEl = document.getElementById('root');
if (!rootEl) {
  throw new Error('Fatal: #root mount container missing in index.html');
}

const isDetachedDebug =
  typeof window !== 'undefined' &&
  new URLSearchParams(window.location.search).get('window') === 'debug-console';

ReactDOM.createRoot(rootEl).render(
  <React.StrictMode>
    {isDetachedDebug ? <DetachedDebugWindowApp /> : <App />}
  </React.StrictMode>,
);
