import type { GuidePageDef } from '../types';

// Simulation page (tab 'panels'). Anchors: data-tour="panels.*" in src/components/simulation/*.
// List view anchors (list/new/from-dbc) and editor anchors (mode/save/palette/signals/inspector/run-bar)
// are never in the DOM together; the tour engine skips whichever set is absent.
export const guidePanels: GuidePageDef = {
  id: 'panels',
  tab: 'panels',
  titleKey: 'onb.panels.title',
  tour: [
    { anchor: 'panels.list', titleKey: 'onb.panels.tour.list.title', bodyKey: 'onb.panels.tour.list.body', side: 'top', align: 'center' },
    { anchor: 'panels.new', titleKey: 'onb.panels.tour.new.title', bodyKey: 'onb.panels.tour.new.body', side: 'bottom', align: 'end' },
    { anchor: 'panels.from-dbc', titleKey: 'onb.panels.tour.fromDbc.title', bodyKey: 'onb.panels.tour.fromDbc.body', side: 'bottom', align: 'end' },
    { anchor: 'panels.mode', titleKey: 'onb.panels.tour.mode.title', bodyKey: 'onb.panels.tour.mode.body', side: 'bottom', align: 'end' },
    { anchor: 'panels.save', titleKey: 'onb.panels.tour.save.title', bodyKey: 'onb.panels.tour.save.body', side: 'bottom', align: 'start' },
    { anchor: 'panels.palette', titleKey: 'onb.panels.tour.palette.title', bodyKey: 'onb.panels.tour.palette.body', side: 'right', align: 'start' },
    { anchor: 'panels.signals', titleKey: 'onb.panels.tour.signals.title', bodyKey: 'onb.panels.tour.signals.body', side: 'right', align: 'center' },
    { anchor: 'panels.inspector', titleKey: 'onb.panels.tour.inspector.title', bodyKey: 'onb.panels.tour.inspector.body', side: 'left', align: 'start' },
    { anchor: 'panels.run-bar', titleKey: 'onb.panels.tour.runBar.title', bodyKey: 'onb.panels.tour.runBar.body', side: 'bottom', align: 'start' },
    { anchor: 'topbar.panic', titleKey: 'onb.panels.tour.panic.title', bodyKey: 'onb.panels.tour.panic.body', side: 'bottom', align: 'end' },
    { anchor: 'panels.info', titleKey: 'onb.panels.tour.info.title', bodyKey: 'onb.panels.tour.info.body', side: 'bottom', align: 'end' },
  ],
  info: [
    { id: 'about', headingKey: 'onb.panels.info.about.h', bodyKeys: ['onb.panels.info.about.b1', 'onb.panels.info.about.b2', 'onb.panels.info.about.b3'] },
    { id: 'build', headingKey: 'onb.panels.info.build.h', bodyKeys: ['onb.panels.info.build.b1', 'onb.panels.info.build.b2', 'onb.panels.info.build.b3'] },
    { id: 'bind', headingKey: 'onb.panels.info.bind.h', bodyKeys: ['onb.panels.info.bind.b1', 'onb.panels.info.bind.b2', 'onb.panels.info.bind.b3'] },
    { id: 'modes', headingKey: 'onb.panels.info.modes.h', bodyKeys: ['onb.panels.info.modes.b1', 'onb.panels.info.modes.b2', 'onb.panels.info.modes.b3'] },
    {
      id: 'safety',
      headingKey: 'onb.panels.info.safety.h',
      bodyKeys: ['onb.panels.info.safety.b1', 'onb.panels.info.safety.b2', 'onb.panels.info.safety.b3', 'onb.panels.info.safety.b4'],
    },
    { id: 'trouble', headingKey: 'onb.panels.info.trouble.h', bodyKeys: ['onb.panels.info.trouble.b1', 'onb.panels.info.trouble.b2', 'onb.panels.info.trouble.b3', 'onb.panels.info.trouble.b4'] },
  ],
  tips: ['onb.panels.tip.1', 'onb.panels.tip.2', 'onb.panels.tip.3', 'onb.panels.tip.4'],
  keepInteractive: ['topbar.panic'],
};
