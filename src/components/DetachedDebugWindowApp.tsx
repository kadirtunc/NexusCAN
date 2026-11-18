import React, { useEffect } from 'react';
import { DebugConsolePanel } from './DebugConsolePanel';
import { initDebugConsoleSubscription } from '../store/debugConsoleStore';
import { readActiveSessionMetaSync } from '../utils/workspaceDb';

const THEME_KEY = 'nexuscan:theme';

function resolveTheme(): 'dark' | 'light' {
  try {
    const v = window.localStorage.getItem(THEME_KEY);
    if (v === 'dark' || v === 'light') return v;
    const meta = readActiveSessionMetaSync();
    if (meta && (meta.theme === 'dark' || meta.theme === 'light')) return meta.theme;
  } catch {
    // ignore
  }
  return 'dark';
}

export const DetachedDebugWindowApp: React.FC = () => {
  useEffect(() => {
    const apply = (): void => {
      document.documentElement.setAttribute('data-theme', resolveTheme());
    };
    apply();

    // Main window writes the theme to localStorage; `storage` fires here live.
    const onStorage = (e: StorageEvent): void => {
      if (e.key === null || e.key === THEME_KEY) apply();
    };
    window.addEventListener('storage', onStorage);

    const unsub = initDebugConsoleSubscription();
    return () => {
      window.removeEventListener('storage', onStorage);
      unsub();
    };
  }, []);

  return (
    <div
      className="h-screen w-screen flex flex-col overflow-hidden"
      style={{ backgroundColor: 'var(--bg-app)', color: 'var(--text-primary)' }}
    >
      <DebugConsolePanel mode="detached" />
    </div>
  );
};
