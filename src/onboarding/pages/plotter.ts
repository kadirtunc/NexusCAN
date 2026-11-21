import type { GuidePageDef } from '../types';

export const guidePlotter: GuidePageDef = {
  id: 'plotter',
  tab: 'plotter',
  titleKey: 'onb.plotter.title',
  tour: [
    { anchor: 'plotter.signals', titleKey: 'onb.plotter.tour.signals.title', bodyKey: 'onb.plotter.tour.signals.body', side: 'bottom', align: 'start' },
    { anchor: 'plotter.layout', titleKey: 'onb.plotter.tour.layout.title', bodyKey: 'onb.plotter.tour.layout.body', side: 'bottom', align: 'start' },
    { anchor: 'plotter.canvas', titleKey: 'onb.plotter.tour.canvas.title', bodyKey: 'onb.plotter.tour.canvas.body', side: 'top', align: 'center' },
    { anchor: 'plotter.live', titleKey: 'onb.plotter.tour.live.title', bodyKey: 'onb.plotter.tour.live.body', side: 'bottom', align: 'end' },
    { anchor: 'plotter.cursors', titleKey: 'onb.plotter.tour.cursors.title', bodyKey: 'onb.plotter.tour.cursors.body', side: 'bottom', align: 'end' },
    { anchor: 'topbar.panic', titleKey: 'onb.plotter.tour.panic.title', bodyKey: 'onb.plotter.tour.panic.body', side: 'bottom', align: 'end' },
    { anchor: 'plotter.info', titleKey: 'onb.plotter.tour.info.title', bodyKey: 'onb.plotter.tour.info.body', side: 'bottom', align: 'end' },
  ],
  info: [
    { id: 'about', headingKey: 'onb.plotter.info.about.h', bodyKeys: ['onb.plotter.info.about.b1', 'onb.plotter.info.about.b2'] },
    { id: 'dbc', headingKey: 'onb.plotter.info.dbc.h', bodyKeys: ['onb.plotter.info.dbc.b1', 'onb.plotter.info.dbc.b2'] },
    { id: 'signals', headingKey: 'onb.plotter.info.signals.h', bodyKeys: ['onb.plotter.info.signals.b1', 'onb.plotter.info.signals.b2', 'onb.plotter.info.signals.b3'] },
    { id: 'nav', headingKey: 'onb.plotter.info.nav.h', bodyKeys: ['onb.plotter.info.nav.b1', 'onb.plotter.info.nav.b2', 'onb.plotter.info.nav.b3'] },
    { id: 'measure', headingKey: 'onb.plotter.info.measure.h', bodyKeys: ['onb.plotter.info.measure.b1', 'onb.plotter.info.measure.b2'] },
    { id: 'perf', headingKey: 'onb.plotter.info.perf.h', bodyKeys: ['onb.plotter.info.perf.b1', 'onb.plotter.info.perf.b2'] },
    { id: 'trouble', headingKey: 'onb.plotter.info.trouble.h', bodyKeys: ['onb.plotter.info.trouble.b1', 'onb.plotter.info.trouble.b2'] },
  ],
  tips: ['onb.plotter.tip.1', 'onb.plotter.tip.2', 'onb.plotter.tip.3'],
  keepInteractive: ['topbar.panic'],
};
