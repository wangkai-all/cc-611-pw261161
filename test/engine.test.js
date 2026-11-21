'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  EngineError,
  attributePerson,
  computeReport,
  unionIntervals,
  weightsFor,
} = require('../src/engine');
const sampleData = require('../src/sampleData');

const ZHANG_CHECKINS = [
  { personId: 'zhang', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T12:00:00.000Z' },
];

function zhangOrders() {
  return sampleData().workOrders.filter((o) => o.personId === 'zhang');
}

function orderMinutes(report, personId, workOrderId) {
  const person = report.persons.find((p) => p.personId === personId);
  const order = person.orders.find((o) => o.workOrderId === workOrderId);
  return order.minutes;
}

test('正常：按完成任务比例拆分重叠区，总时长不因重叠增加', () => {
  const report = computeReport(sampleData(), 'completed-ratio', { id: 'T1', createdAt: '2026-11-21T13:00:00.000Z' });

  // 张三：09:00-11:00 主责(0.6) 与 10:00-12:00 支援(0.4) 重叠 10:00-11:00
  // WO-1 = 60 + 60*0.6 = 96；WO-2 = 60*0.4 + 60 = 84；WO-6 完全在签到外 = 0
  assert.equal(orderMinutes(report, 'zhang', 'WO-1'), 96);
  assert.equal(orderMinutes(report, 'zhang', 'WO-2'), 84);
  assert.equal(orderMinutes(report, 'zhang', 'WO-6'), 0);

  // 王五：09:30-10:30 与 10:00-11:30 重叠 30 分钟，0.5/0.5 各分 15
  assert.equal(orderMinutes(report, 'wang', 'WO-4'), 45);
  assert.equal(orderMinutes(report, 'wang', 'WO-5'), 75);

  // 总时长 = 区间并集，而不是工单长度之和（张三两张工单共 240 分钟，归属后只有 180）
  const zhang = report.persons.find((p) => p.personId === 'zhang');
  assert.equal(zhang.totalMinutes, 180);
  assert.equal(zhang.checkInMinutes, 180);
  const wang = report.persons.find((p) => p.personId === 'wang');
  assert.equal(wang.totalMinutes, 120);

  assert.equal(report.totals.totalMinutes, 480); // 180 + 180 + 120
});

test('正常：按主责时间归属，重叠区全部归主责工单', () => {
  const report = computeReport(sampleData(), 'primary', { id: 'T2', createdAt: '2026-11-21T13:00:00.000Z' });

  assert.equal(orderMinutes(report, 'zhang', 'WO-1'), 120); // 独占 60 + 重叠 60 全归主责
  assert.equal(orderMinutes(report, 'zhang', 'WO-2'), 60);  // 只剩独占的 11:00-12:00
  assert.equal(orderMinutes(report, 'wang', 'WO-4'), 60);
  assert.equal(orderMinutes(report, 'wang', 'WO-5'), 60);

  // 方法不同但总时长不变：重叠不会膨胀总量
  assert.equal(report.persons.find((p) => p.personId === 'zhang').totalMinutes, 180);
  assert.equal(report.persons.find((p) => p.personId === 'wang').totalMinutes, 120);
  assert.equal(report.totals.totalMinutes, 480);
});

test('不变量：每个拆分段各份之和等于段时长，个人总时长等于并集长度', () => {
  for (const method of ['completed-ratio', 'primary']) {
    const report = computeReport(sampleData(), method, { id: 'T3', createdAt: '2026-11-21T13:00:00.000Z' });
    for (const seg of report.segments) {
      const sum = seg.parts.reduce((acc, p) => acc + p.minutes, 0);
      assert.ok(Math.abs(sum - seg.minutes) < 1e-9, `${method} 段 ${seg.start} 拆分不守恒`);
      const wSum = seg.parts.reduce((acc, p) => acc + p.weight, 0);
      assert.ok(Math.abs(wSum - 1) < 1e-6, `${method} 段 ${seg.start} 权重和不为 1`);
    }
    for (const person of report.persons) {
      const segs = report.segments.filter((s) => s.personId === person.personId);
      const segTotal = segs.reduce((acc, s) => acc + s.minutes, 0);
      assert.ok(Math.abs(segTotal - person.totalMinutes) < 1e-9);
      assert.ok(person.totalMinutes <= person.checkInMinutes, '归属总时长不能超过签到时长');
    }
  }
});

test('正常：重叠拆分段的边界与内容正确', () => {
  const person = { id: 'zhang', name: '张三' };
  const { segments } = attributePerson(person, ZHANG_CHECKINS, zhangOrders(), 'completed-ratio');
  // 张三：09-10 独占 WO-1，10-11 重叠，11-12 独占 WO-2（WO-6 在签到外被裁掉）
  assert.deepEqual(segments.map((s) => [s.start.slice(11, 16), s.end.slice(11, 16)]), [
    ['09:00', '10:00'],
    ['10:00', '11:00'],
    ['11:00', '12:00'],
  ]);
  const overlap = segments[1];
  assert.equal(overlap.overlap, true);
  assert.equal(overlap.parts.length, 2);
  assert.equal(overlap.parts[0].minutes, 36); // 60 * 0.6
  assert.equal(overlap.parts[1].minutes, 24); // 60 * 0.4
});

test('正常：完成比例全为 0 时重叠区均分', () => {
  const person = { id: 'p', name: '测试' };
  const checkIns = [{ personId: 'p', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T11:00:00.000Z' }];
  const orders = [
    { id: 'A', personId: 'p', activity: '甲', role: 'support', progress: 0, start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T10:00:00.000Z', status: 'active' },
    { id: 'B', personId: 'p', activity: '乙', role: 'support', progress: 0, start: '2026-11-21T09:30:00.000Z', end: '2026-11-21T10:30:00.000Z', status: 'active' },
  ];
  const { segments } = attributePerson(person, checkIns, orders, 'completed-ratio');
  const overlap = segments.find((s) => s.overlap);
  assert.equal(overlap.minutes, 30);
  assert.deepEqual(overlap.parts.map((p) => p.minutes), [15, 15]);
});

test('正常：工单超出签到时段被裁剪并记录异常', () => {
  const report = computeReport(sampleData(), 'completed-ratio', { id: 'T4', createdAt: '2026-11-21T13:00:00.000Z' });
  const anomaly = report.anomalies.find((a) => a.workOrderId === 'WO-6');
  assert.ok(anomaly, '应记录 WO-6 超出签到的异常');
  assert.equal(anomaly.type, 'ORDER_OUTSIDE_CHECKIN');
  assert.equal(anomaly.clippedMinutes, 30);
  assert.equal(orderMinutes(report, 'zhang', 'WO-6'), 0);
});

test('正常：部分超出签到的工单只算签到内的时长', () => {
  const person = { id: 'p', name: '测试' };
  const checkIns = [{ personId: 'p', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T12:00:00.000Z' }];
  const orders = [
    { id: 'A', personId: 'p', activity: '甲', role: 'primary', progress: 1, start: '2026-11-21T11:30:00.000Z', end: '2026-11-21T12:30:00.000Z', status: 'active' },
  ];
  const { segments, anomalies } = attributePerson(person, checkIns, orders, 'completed-ratio');
  assert.equal(segments.length, 1);
  assert.equal(segments[0].minutes, 30);
  assert.equal(anomalies.length, 1);
  assert.equal(anomalies[0].clippedMinutes, 30);
});

test('正常：已撤销的工单不参与归属计算', () => {
  const data = sampleData();
  data.workOrders.find((o) => o.id === 'WO-2').status = 'revoked';
  const report = computeReport(data, 'completed-ratio', { id: 'T5', createdAt: '2026-11-21T13:00:00.000Z' });
  const zhang = report.persons.find((p) => p.personId === 'zhang');
  assert.equal(zhang.totalMinutes, 120); // 只剩 WO-1 的 09:00-11:00
  assert.equal(orderMinutes(report, 'zhang', 'WO-1'), 120); // 重叠区全部回到 WO-1
  assert.equal(report.totals.revokedOrders, 1);
  assert.equal(report.totals.activeOrders, 5);
});

test('异常：结束时间不晚于开始时间的工单被拒绝', () => {
  const person = { id: 'p', name: '测试' };
  const checkIns = [{ personId: 'p', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T11:00:00.000Z' }];
  const bad = [
    { id: 'A', personId: 'p', activity: '甲', role: 'primary', progress: 1, start: '2026-11-21T10:00:00.000Z', end: '2026-11-21T09:00:00.000Z', status: 'active' },
  ];
  assert.throws(() => attributePerson(person, checkIns, bad, 'completed-ratio'), (err) => {
    assert.ok(err instanceof EngineError);
    assert.equal(err.code, 'INVALID_RANGE');
    return true;
  });
});

test('异常：非法完成比例、非法角色、未知归属方法、非法时间都被拒绝', () => {
  const person = { id: 'p', name: '测试' };
  const checkIns = [{ personId: 'p', start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T11:00:00.000Z' }];
  const base = { id: 'A', personId: 'p', activity: '甲', role: 'primary', progress: 1, start: '2026-11-21T09:00:00.000Z', end: '2026-11-21T10:00:00.000Z', status: 'active' };

  assert.throws(() => attributePerson(person, checkIns, [{ ...base, progress: 1.5 }], 'completed-ratio'), /完成比例非法/);
  assert.throws(() => attributePerson(person, checkIns, [{ ...base, progress: -0.1 }], 'completed-ratio'), /完成比例非法/);
  assert.throws(() => attributePerson(person, checkIns, [{ ...base, role: 'boss' }], 'completed-ratio'), /角色非法/);
  assert.throws(() => attributePerson(person, checkIns, [{ ...base, start: 'not-a-time' }], 'completed-ratio'), /无法解析/);
  assert.throws(() => attributePerson(person, checkIns, [base], 'random-method'), /未知归属方法/);
  assert.throws(
    () => attributePerson(person, [{ personId: 'p', start: '2026-11-21T10:00:00.000Z', end: '2026-11-21T09:00:00.000Z' }], [base], 'completed-ratio'),
    /结束时间必须晚于开始时间/
  );
});

test('工具：区间并集合并重叠与相邻区间', () => {
  const u = unionIntervals([
    { start: 0, end: 10 },
    { start: 5, end: 15 },
    { start: 15, end: 20 },
    { start: 30, end: 40 },
  ]);
  assert.deepEqual(u, [{ start: 0, end: 20 }, { start: 30, end: 40 }]);
});

test('工具：权重分配（比例 / 主责 / 退化均分）', () => {
  const a = { id: 'a', role: 'primary', progress: 0.75 };
  const b = { id: 'b', role: 'support', progress: 0.25 };
  assert.deepEqual(weightsFor([a, b], 'completed-ratio'), [0.75, 0.25]);
  assert.deepEqual(weightsFor([a, b], 'primary'), [1, 0]);
  const c = { id: 'c', role: 'support', progress: 0 };
  const d = { id: 'd', role: 'support', progress: 0 };
  assert.deepEqual(weightsFor([c, d], 'completed-ratio'), [0.5, 0.5]);
  assert.deepEqual(weightsFor([c, d], 'primary'), [0.5, 0.5]); // 没有主责时均分
  assert.throws(() => weightsFor([a, b], 'nope'), /未知归属方法/);
});
