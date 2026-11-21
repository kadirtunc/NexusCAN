import type { GuidePageDef } from '../types';

// Owned by the 'cloud' page agent. Anchors live in CloudWorkspaceView.tsx (data-tour="cloud.*").
// Logged-out view exposes: cloud.login, cloud.info. Logged-in view: cloud.toolbar, cloud.projects,
// cloud.modules, cloud.pull, cloud.sync (Diff & Sync module only), cloud.info. Missing anchors are skipped.
export const guideCloud: GuidePageDef = {
  id: 'cloud',
  tab: 'cloud',
  titleKey: 'onb.cloud.title',
  tour: [
    { anchor: 'cloud.login', titleKey: 'onb.cloud.tour.login.title', bodyKey: 'onb.cloud.tour.login.body', side: 'right', align: 'center' },
    { anchor: 'cloud.toolbar', titleKey: 'onb.cloud.tour.toolbar.title', bodyKey: 'onb.cloud.tour.toolbar.body', side: 'bottom', align: 'start' },
    { anchor: 'cloud.projects', titleKey: 'onb.cloud.tour.projects.title', bodyKey: 'onb.cloud.tour.projects.body', side: 'right', align: 'start' },
    { anchor: 'cloud.modules', titleKey: 'onb.cloud.tour.modules.title', bodyKey: 'onb.cloud.tour.modules.body', side: 'bottom', align: 'start' },
    { anchor: 'cloud.pull', titleKey: 'onb.cloud.tour.pull.title', bodyKey: 'onb.cloud.tour.pull.body', side: 'bottom', align: 'end' },
    { anchor: 'cloud.sync', titleKey: 'onb.cloud.tour.sync.title', bodyKey: 'onb.cloud.tour.sync.body', side: 'top', align: 'end' },
    { anchor: 'topbar.panic', titleKey: 'onb.cloud.tour.panic.title', bodyKey: 'onb.cloud.tour.panic.body', side: 'bottom', align: 'end' },
    { anchor: 'cloud.info', titleKey: 'onb.cloud.tour.info.title', bodyKey: 'onb.cloud.tour.info.body', side: 'bottom', align: 'end' },
  ],
  info: [
    { id: 'about', headingKey: 'onb.cloud.info.about.h', bodyKeys: ['onb.cloud.info.about.b1', 'onb.cloud.info.about.b2'] },
    { id: 'enable', headingKey: 'onb.cloud.info.enable.h', bodyKeys: ['onb.cloud.info.enable.b1', 'onb.cloud.info.enable.b2'] },
    { id: 'sync', headingKey: 'onb.cloud.info.sync.h', bodyKeys: ['onb.cloud.info.sync.b1', 'onb.cloud.info.sync.b2', 'onb.cloud.info.sync.b3', 'onb.cloud.info.sync.b4'] },
    { id: 'live', headingKey: 'onb.cloud.info.live.h', bodyKeys: ['onb.cloud.info.live.b1', 'onb.cloud.info.live.b2'] },
    { id: 'privacy', headingKey: 'onb.cloud.info.privacy.h', bodyKeys: ['onb.cloud.info.privacy.b1', 'onb.cloud.info.privacy.b2'] },
    { id: 'trouble', headingKey: 'onb.cloud.info.trouble.h', bodyKeys: ['onb.cloud.info.trouble.b1', 'onb.cloud.info.trouble.b2'] },
  ],
  tips: ['onb.cloud.tip.1', 'onb.cloud.tip.2', 'onb.cloud.tip.3'],
  keepInteractive: ['topbar.panic'],
};
