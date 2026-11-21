import type { GuidePageDef } from '../types';

// Owned by the 'trace' page agent. Anchors: data-tour="trace.*" in components/TraceView.tsx.
export const guideTrace: GuidePageDef = {
  id: 'trace',
  tab: 'trace',
  titleKey: 'onb.trace.title',
  tour: [
    { anchor: 'trace.toolbar-left', titleKey: 'onb.trace.tour.rec.title', bodyKey: 'onb.trace.tour.rec.body', side: 'bottom', align: 'start' },
    { anchor: 'trace.filter', titleKey: 'onb.trace.tour.filter.title', bodyKey: 'onb.trace.tour.filter.body', side: 'bottom', align: 'center' },
    { anchor: 'trace.table', titleKey: 'onb.trace.tour.table.title', bodyKey: 'onb.trace.tour.table.body', side: 'bottom', align: 'center' },
    { anchor: 'trace.status', titleKey: 'onb.trace.tour.status.title', bodyKey: 'onb.trace.tour.status.body', side: 'top', align: 'end' },
    { anchor: 'trace.export', titleKey: 'onb.trace.tour.export.title', bodyKey: 'onb.trace.tour.export.body', side: 'bottom', align: 'end' },
    { anchor: 'topbar.panic', titleKey: 'onb.trace.tour.panic.title', bodyKey: 'onb.trace.tour.panic.body', side: 'bottom', align: 'end' },
    { anchor: 'trace.info', titleKey: 'onb.trace.tour.info.title', bodyKey: 'onb.trace.tour.info.body', side: 'bottom', align: 'end' },
  ],
  info: [
    { id: 'about', headingKey: 'onb.trace.info.about.h', bodyKeys: ['onb.trace.info.about.b1', 'onb.trace.info.about.b2'] },
    { id: 'recording', headingKey: 'onb.trace.info.recording.h', bodyKeys: ['onb.trace.info.recording.b1', 'onb.trace.info.recording.b2'] },
    { id: 'sessions', headingKey: 'onb.trace.info.sessions.h', bodyKeys: ['onb.trace.info.sessions.b1', 'onb.trace.info.sessions.b2'] },
    { id: 'files', headingKey: 'onb.trace.info.files.h', bodyKeys: ['onb.trace.info.files.b1', 'onb.trace.info.files.b2'] },
    { id: 'perf', headingKey: 'onb.trace.info.perf.h', bodyKeys: ['onb.trace.info.perf.b1', 'onb.trace.info.perf.b2'] },
    { id: 'trouble', headingKey: 'onb.trace.info.trouble.h', bodyKeys: ['onb.trace.info.trouble.b1'] },
  ],
  tips: ['onb.trace.tip.1', 'onb.trace.tip.2', 'onb.trace.tip.3'],
  keepInteractive: ['topbar.panic'],
};
