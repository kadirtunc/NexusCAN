import type { GuidePageDef } from '../types';

export const guideSymbols: GuidePageDef = {
  id: 'symbols',
  tab: 'symbols',
  titleKey: 'onb.symbols.title',
  tour: [
    { anchor: 'symbols.actions', titleKey: 'onb.symbols.tour.load.title', bodyKey: 'onb.symbols.tour.load.body', side: 'bottom', align: 'end' },
    { anchor: 'symbols.catalog', titleKey: 'onb.symbols.tour.catalog.title', bodyKey: 'onb.symbols.tour.catalog.body', side: 'top', align: 'center' },
    { anchor: 'symbols.inspect-bar', titleKey: 'onb.symbols.tour.bind.title', bodyKey: 'onb.symbols.tour.bind.body', side: 'bottom', align: 'center' },
    { anchor: 'symbols.explorer', titleKey: 'onb.symbols.tour.explorer.title', bodyKey: 'onb.symbols.tour.explorer.body', side: 'right', align: 'start' },
    { anchor: 'symbols.bit-grid', titleKey: 'onb.symbols.tour.matrix.title', bodyKey: 'onb.symbols.tour.matrix.body', side: 'left', align: 'start' },
    { anchor: 'topbar.panic', titleKey: 'onb.symbols.tour.panic.title', bodyKey: 'onb.symbols.tour.panic.body', side: 'bottom', align: 'end' },
    { anchor: 'symbols.info', titleKey: 'onb.symbols.tour.info.title', bodyKey: 'onb.symbols.tour.info.body', side: 'bottom', align: 'end' },
  ],
  info: [
    { id: 'about', headingKey: 'onb.symbols.info.about.h', bodyKeys: ['onb.symbols.info.about.b1', 'onb.symbols.info.about.b2'] },
    { id: 'loading', headingKey: 'onb.symbols.info.loading.h', bodyKeys: ['onb.symbols.info.loading.b1', 'onb.symbols.info.loading.b2', 'onb.symbols.info.loading.b3'] },
    { id: 'binding', headingKey: 'onb.symbols.info.binding.h', bodyKeys: ['onb.symbols.info.binding.b1', 'onb.symbols.info.binding.b2', 'onb.symbols.info.binding.b3'] },
    { id: 'signals', headingKey: 'onb.symbols.info.signals.h', bodyKeys: ['onb.symbols.info.signals.b1', 'onb.symbols.info.signals.b2', 'onb.symbols.info.signals.b3', 'onb.symbols.info.signals.b4'] },
    { id: 'impact', headingKey: 'onb.symbols.info.impact.h', bodyKeys: ['onb.symbols.info.impact.b1', 'onb.symbols.info.impact.b2', 'onb.symbols.info.impact.b3'] },
    { id: 'troubleshoot', headingKey: 'onb.symbols.info.trouble.h', bodyKeys: ['onb.symbols.info.trouble.b1', 'onb.symbols.info.trouble.b2', 'onb.symbols.info.trouble.b3'] },
  ],
  tips: ['onb.symbols.tip.1', 'onb.symbols.tip.2', 'onb.symbols.tip.3'],
  keepInteractive: ['topbar.panic'],
};
