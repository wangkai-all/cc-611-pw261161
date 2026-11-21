'use strict';

/**
 * 合成样例数据（2026-11-21，UTC）。
 * 每次调用返回全新对象，便于重置与测试隔离。
 *
 * 场景设计：
 *  - 张三：主责「春季路演」09:00-11:00，同时段跨活动支援「社区支援」10:00-12:00（重叠 10:00-11:00）；
 *          另有一张「展厅讲解」工单 12:00-12:30 完全在签到之外（异常，应被裁剪并记录）。
 *  - 李四：单张主责工单，无重叠（正常基线）。
 *  - 王五：同一时段切换两个任务，09:30-10:30 与 10:00-11:30 重叠 10:00-10:30。
 */
function sampleData() {
  return {
    persons: [
      { id: 'zhang', name: '张三' },
      { id: 'li', name: '李四' },
      { id: 'wang', name: '王五' },
    ],
    checkIns: [
      { personId: 'zhang', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T12:00:00.000Z' },
      { personId: 'li', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T12:00:00.000Z' },
      { personId: 'wang', start: '2026-11-21T09:30:00.000Z', end: '2026-11-21T11:30:00.000Z' },
    ],
    workOrders: [
      {
        id: 'WO-1', personId: 'zhang', activity: '春季路演', role: 'primary', progress: 0.6,
        start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T11:00:00.000Z', status: 'active',
      },
      {
        id: 'WO-2', personId: 'zhang', activity: '社区支援', role: 'support', progress: 0.4,
        start: '2026-11-21T10:00:00.000Z', end: '2026-11-21T12:00:00.000Z', status: 'active',
      },
      {
        id: 'WO-3', personId: 'li', activity: '春季路演', role: 'primary', progress: 1,
        start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T12:00:00.000Z', status: 'active',
      },
      {
        id: 'WO-4', personId: 'wang', activity: '社区支援', role: 'primary', progress: 0.5,
        start: '2026-11-21T09:30:00.000Z', end: '2026-11-21T10:30:00.000Z', status: 'active',
      },
      {
        id: 'WO-5', personId: 'wang', activity: '展厅讲解', role: 'support', progress: 0.5,
        start: '2026-11-21T10:00:00.000Z', end: '2026-11-21T11:30:00.000Z', status: 'active',
      },
      {
        id: 'WO-6', personId: 'zhang', activity: '展厅讲解', role: 'support', progress: 1,
        start: '2026-11-21T12:00:00.000Z', end: '2026-11-21T12:30:00.000Z', status: 'active',
      },
    ],
  };
}

module.exports = sampleData;
