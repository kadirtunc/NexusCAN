import { guideCloud } from './pages/cloud';
import { guideMcp } from './pages/mcp';
import { guideConnections } from './pages/connections';
import { guidePanels } from './pages/panels';
import { guidePlotter } from './pages/plotter';
import { guideSymbols } from './pages/symbols';
import { guideTrace } from './pages/trace';
import type { GuidePageDef, GuidePageId } from './types';

export const GUIDE_PAGES: Record<GuidePageId, GuidePageDef> = {
  rxtx: {
    id: 'rxtx',
    tab: 'rxtx',
    titleKey: 'onb.rxtx.title',
    tour: [
      { anchor: 'rxtx.rx-table', titleKey: 'onb.rxtx.tour.rx.title', bodyKey: 'onb.rxtx.tour.rx.body', side: 'top', align: 'center' },
      { anchor: 'rxtx.rx-toolbar', titleKey: 'onb.rxtx.tour.filter.title', bodyKey: 'onb.rxtx.tour.filter.body', side: 'bottom', align: 'start' },
      { anchor: 'rxtx.tx-new', titleKey: 'onb.rxtx.tour.tx.title', bodyKey: 'onb.rxtx.tour.tx.body', side: 'top', align: 'start' },
      { anchor: 'rxtx.tx-mode', titleKey: 'onb.rxtx.tour.mode.title', bodyKey: 'onb.rxtx.tour.mode.body', side: 'top', align: 'end' },
      { anchor: 'topbar.txmode', titleKey: 'onb.rxtx.tour.topTx.title', bodyKey: 'onb.rxtx.tour.topTx.body', side: 'bottom', align: 'end' },
      { anchor: 'topbar.panic', titleKey: 'onb.rxtx.tour.panic.title', bodyKey: 'onb.rxtx.tour.panic.body', side: 'bottom', align: 'end' },
      { anchor: 'rxtx.info', titleKey: 'onb.rxtx.tour.info.title', bodyKey: 'onb.rxtx.tour.info.body', side: 'bottom', align: 'end' },
    ],
    info: [
      { id: 'about', headingKey: 'onb.rxtx.info.about.h', bodyKeys: ['onb.rxtx.info.about.b1', 'onb.rxtx.info.about.b2'] },
      {
        id: 'txSafety',
        headingKey: 'onb.rxtx.info.txSafety.h',
        bodyKeys: [
          'onb.rxtx.info.txSafety.b1',
          'onb.rxtx.info.txSafety.b2',
          'onb.rxtx.info.txSafety.b3',
          'onb.rxtx.info.txSafety.b4',
          'onb.rxtx.info.txSafety.b5',
        ],
      },
      { id: 'dbc', headingKey: 'onb.rxtx.info.dbc.h', bodyKeys: ['onb.rxtx.info.dbc.b1', 'onb.rxtx.info.dbc.b2'] },
    ],
    tips: ['onb.rxtx.tip.1', 'onb.rxtx.tip.2', 'onb.rxtx.tip.3'],
    keepInteractive: ['topbar.panic'],
  },
  start: {
    id: 'start',
    tab: 'start',
    titleKey: 'onb.start.title',
    tour: [
      { anchor: 'start.panel', titleKey: 'onb.start.tour.panel.title', bodyKey: 'onb.start.tour.panel.body', side: 'bottom', align: 'center' },
      { anchor: 'start.new-project', titleKey: 'onb.start.tour.project.title', bodyKey: 'onb.start.tour.project.body', side: 'top', align: 'start' },
      { anchor: 'start.step.2', titleKey: 'onb.start.tour.connection.title', bodyKey: 'onb.start.tour.connection.body', side: 'bottom', align: 'start' },
      { anchor: 'start.step.3', titleKey: 'onb.start.tour.tx.title', bodyKey: 'onb.start.tour.tx.body', side: 'bottom', align: 'center' },
      { anchor: 'topbar.panic', titleKey: 'onb.start.tour.panic.title', bodyKey: 'onb.start.tour.panic.body', side: 'bottom', align: 'end' },
      { anchor: 'start.guide-buttons', titleKey: 'onb.start.tour.info.title', bodyKey: 'onb.start.tour.info.body', side: 'bottom', align: 'end' },
    ],
    info: [
      { id: 'step1', headingKey: 'onb.start.info.step1.h', bodyKeys: ['onb.start.info.step1.b1', 'onb.start.info.step1.b2'] },
      { id: 'step2', headingKey: 'onb.start.info.step2.h', bodyKeys: ['onb.start.info.step2.b1', 'onb.start.info.step2.b2', 'onb.start.info.step2.b3'] },
      {
        id: 'txSafety',
        headingKey: 'onb.rxtx.info.txSafety.h',
        bodyKeys: [
          'onb.rxtx.info.txSafety.b1',
          'onb.rxtx.info.txSafety.b2',
          'onb.rxtx.info.txSafety.b3',
          'onb.rxtx.info.txSafety.b4',
          'onb.rxtx.info.txSafety.b5',
        ],
      },
      { id: 'step4', headingKey: 'onb.start.info.step4.h', bodyKeys: ['onb.start.info.step4.b1', 'onb.start.info.step4.b2'] },
      { id: 'step5', headingKey: 'onb.start.info.step5.h', bodyKeys: ['onb.start.info.step5.b1', 'onb.start.info.step5.b2'] },
      { id: 'safety', headingKey: 'onb.start.info.safety.h', bodyKeys: ['onb.start.info.safety.b1', 'onb.start.info.safety.b2'] },
    ],
    tips: ['onb.start.tip.1', 'onb.start.tip.2', 'onb.start.tip.3', 'onb.start.tip.4'],
    keepInteractive: ['topbar.panic'],
  },
  connections: guideConnections,
  trace: guideTrace,
  plotter: guidePlotter,
  symbols: guideSymbols,
  panels: guidePanels,
  cloud: guideCloud,
  mcp: guideMcp,
};

export function guidePageForTab(tab: string): GuidePageDef | null {
  for (const def of Object.values(GUIDE_PAGES)) {
    if (def.tab !== null && def.tab === tab) return def;
  }
  return null;
}
