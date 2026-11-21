import type { GuidePageDef } from '../types';

export const guideConnections: GuidePageDef = {
  id: 'connections',
  tab: 'connections',
  titleKey: 'onb.connections.title',
  tour: [
    { anchor: 'connections.driver-strip', titleKey: 'onb.connections.tour.drivers.title', bodyKey: 'onb.connections.tour.drivers.body', side: 'bottom', align: 'start' },
    { anchor: 'connections.new', titleKey: 'onb.connections.tour.new.title', bodyKey: 'onb.connections.tour.new.body', side: 'bottom', align: 'start' },
    { anchor: 'connections.table', titleKey: 'onb.connections.tour.table.title', bodyKey: 'onb.connections.tour.table.body', side: 'top', align: 'center' },
    { anchor: 'connections.th-safety', titleKey: 'onb.connections.tour.safety.title', bodyKey: 'onb.connections.tour.safety.body', side: 'bottom', align: 'center' },
    { anchor: 'connections.dock', titleKey: 'onb.connections.tour.dock.title', bodyKey: 'onb.connections.tour.dock.body', side: 'top', align: 'start' },
    { anchor: 'topbar.panic', titleKey: 'onb.connections.tour.panic.title', bodyKey: 'onb.connections.tour.panic.body', side: 'bottom', align: 'end' },
    { anchor: 'connections.info', titleKey: 'onb.connections.tour.info.title', bodyKey: 'onb.connections.tour.info.body', side: 'bottom', align: 'end' },
  ],
  info: [
    { id: 'about', headingKey: 'onb.connections.info.about.h', bodyKeys: ['onb.connections.info.about.b1', 'onb.connections.info.about.b2'] },
    {
      id: 'newConnection',
      headingKey: 'onb.connections.info.new.h',
      bodyKeys: ['onb.connections.info.new.b1', 'onb.connections.info.new.b2', 'onb.connections.info.new.b3', 'onb.connections.info.new.b4'],
    },
    { id: 'drivers', headingKey: 'onb.connections.info.drivers.h', bodyKeys: ['onb.connections.info.drivers.b1', 'onb.connections.info.drivers.b2', 'onb.connections.info.drivers.b3'] },
    { id: 'listenOnly', headingKey: 'onb.connections.info.safety.h', bodyKeys: ['onb.connections.info.safety.b1', 'onb.connections.info.safety.b2', 'onb.connections.info.safety.b3'] },
    {
      id: 'troubleshoot',
      headingKey: 'onb.connections.info.trouble.h',
      bodyKeys: ['onb.connections.info.trouble.b1', 'onb.connections.info.trouble.b2', 'onb.connections.info.trouble.b3', 'onb.connections.info.trouble.b4'],
    },
  ],
  tips: ['onb.connections.tip.1', 'onb.connections.tip.2', 'onb.connections.tip.3'],
  keepInteractive: ['topbar.panic'],
};
