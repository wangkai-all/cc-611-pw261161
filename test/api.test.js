'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const { createServer } = require('../server');
const { Store } = require('../src/store');
const sampleData = require('../src/sampleData');

/** 每个用例起独立服务实例（端口 0 = 随机空闲端口，仍绑 127.0.0.1）。 */
async function withServer(fn) {
  const store = new Store(sampleData);
  const server = createServer(store);
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
}

async function postJson(base, path, body, raw) {
  const res = await fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body === undefined ? {} : body),
  });
  const data = await res.json().catch(() => null);
  return { status: res.status, data };
}

test('页面：GET / 返回页面且业务结果区带 data-evidence-result 属性', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    const html = await res.text();
    assert.match(html, /data-evidence-result="idle"/);
    assert.match(html, /分析原投入量/);
    assert.match(html, /撤回一张工单/);
    assert.match(html, /查看重叠拆分/);
  });
});

test('正常：分析原投入量，总时长不因重叠增加', async () => {
  await withServer(async (base) => {
    const { status, data } = await postJson(base, '/api/analyze', { method: 'completed-ratio' });
    assert.equal(status, 200);
    assert.equal(data.id, 'R1');
    assert.equal(data.totals.totalMinutes, 480);
    const zhang = data.persons.find((p) => p.personId === 'zhang');
    assert.equal(zhang.totalMinutes, 180); // 不是 240：重叠的 60 分钟只算一次
    const wo1 = zhang.orders.find((o) => o.workOrderId === 'WO-1');
    const wo2 = zhang.orders.find((o) => o.workOrderId === 'WO-2');
    assert.equal(wo1.minutes, 96);
    assert.equal(wo2.minutes, 84);
    assert.equal(data.anomalies.length, 1); // WO-6 超出签到
  });
});

test('正常：主责时间归属方法', async () => {
  await withServer(async (base) => {
    const { status, data } = await postJson(base, '/api/analyze', { method: 'primary' });
    assert.equal(status, 200);
    const zhang = data.persons.find((p) => p.personId === 'zhang');
    assert.equal(zhang.orders.find((o) => o.workOrderId === 'WO-1').minutes, 120);
    assert.equal(zhang.orders.find((o) => o.workOrderId === 'WO-2').minutes, 60);
    assert.equal(zhang.totalMinutes, 180);
  });
});

test('正常：撤回一张工单后旧报告保留，受影响范围正确', async () => {
  await withServer(async (base) => {
    await postJson(base, '/api/analyze', { method: 'completed-ratio' }); // R1
    const { status, data } = await postJson(base, '/api/revoke', { workOrderId: 'WO-2' });
    assert.equal(status, 200);
    assert.equal(data.oldReportKept, true);
    assert.equal(data.oldReportId, 'R1');
    assert.equal(data.newReportId, 'R2');

    // 受影响范围：张三 180 → 120；WO-1 96 → 120（重叠区回归主责）；WO-2 84 → 0
    const person = data.affected.persons.find((p) => p.personId === 'zhang');
    assert.equal(person.beforeMinutes, 180);
    assert.equal(person.afterMinutes, 120);
    const wo1 = data.affected.orders.find((o) => o.workOrderId === 'WO-1');
    assert.equal(wo1.beforeMinutes, 96);
    assert.equal(wo1.afterMinutes, 120);
    assert.equal(wo1.deltaMinutes, 24);
    const wo2 = data.affected.orders.find((o) => o.workOrderId === 'WO-2');
    assert.equal(wo2.status, 'revoked');
    assert.equal(wo2.afterMinutes, 0);
    assert.ok(data.affected.changedSegments.length >= 2); // 重叠段 + 独占段都变化
    // 旧重叠段 10:00-11:00 → 新报告中落入 09:00-11:00 的独占段（WO-1 全量 120）
    const overlapChange = data.affected.changedSegments.find((s) => s.start === '2026-11-21T10:00:00.000Z');
    assert.equal(overlapChange.after.length, 1);
    assert.equal(overlapChange.after[0].start, '2026-11-21T09:00:00.000Z');
    assert.equal(overlapChange.after[0].parts[0].workOrderId, 'WO-1');
    assert.equal(overlapChange.after[0].parts[0].minutes, 120);
    // 旧 WO-2 独占段 11:00-12:00 → 撤回后释放，无归属
    const released = data.affected.changedSegments.find((s) => s.start === '2026-11-21T11:00:00.000Z');
    assert.deepEqual(released.after, []);

    // 旧报告保留：历史里有两份，R1 内容仍是撤回前的数字
    const list = await (await fetch(`${base}/api/reports`)).json();
    assert.equal(list.length, 2);
    const old = await (await fetch(`${base}/api/reports/R1`)).json();
    const oldZhang = old.persons.find((p) => p.personId === 'zhang');
    assert.equal(oldZhang.totalMinutes, 180);
    assert.equal(oldZhang.orders.find((o) => o.workOrderId === 'WO-2').minutes, 84);

    // 新报告里被撤工单不再参与
    const now = await (await fetch(`${base}/api/reports/R2`)).json();
    const nowZhang = now.persons.find((p) => p.personId === 'zhang');
    assert.equal(nowZhang.totalMinutes, 120);
    assert.equal(now.totals.revokedOrders, 1);
  });
});

test('正常：未分析就直接撤回时，服务端先补一份原报告再撤销', async () => {
  await withServer(async (base) => {
    const { status, data } = await postJson(base, '/api/revoke', { workOrderId: 'WO-4' });
    assert.equal(status, 200);
    assert.equal(data.oldReportId, 'R1');
    assert.equal(data.newReportId, 'R2');
    const wang = data.affected.persons.find((p) => p.personId === 'wang');
    assert.equal(wang.beforeMinutes, 120);
    assert.equal(wang.afterMinutes, 90); // 只剩 WO-5 的 10:00-11:30
  });
});

test('正常：查看重叠拆分返回最小不可再分时段', async () => {
  await withServer(async (base) => {
    await postJson(base, '/api/analyze', { method: 'completed-ratio' });
    const res = await fetch(`${base}/api/overlap`);
    assert.equal(res.status, 200);
    const data = await res.json();
    assert.equal(data.reportId, 'R1');
    const zhangSegs = data.segments.filter((s) => s.personId === 'zhang');
    assert.equal(zhangSegs.length, 3);
    const overlap = zhangSegs.find((s) => s.overlap);
    assert.equal(overlap.start, '2026-11-21T10:00:00.000Z');
    assert.equal(overlap.end, '2026-11-21T11:00:00.000Z');
    assert.equal(overlap.parts.length, 2);
    assert.equal(overlap.parts[0].minutes + overlap.parts[1].minutes, overlap.minutes);
  });
});

test('正常：重置后数据与报告历史复原', async () => {
  await withServer(async (base) => {
    await postJson(base, '/api/revoke', { workOrderId: 'WO-2' });
    const { status } = await postJson(base, '/api/reset');
    assert.equal(status, 200);
    const state = await (await fetch(`${base}/api/state`)).json();
    assert.equal(state.reports.length, 0);
    assert.equal(state.workOrders.find((o) => o.id === 'WO-2').status, 'active');
  });
});

test('异常：未知归属方法返回 400', async () => {
  await withServer(async (base) => {
    const { status, data } = await postJson(base, '/api/analyze', { method: 'nope' });
    assert.equal(status, 400);
    assert.match(data.error, /未知归属方法/);
  });
});

test('异常：撤回不存在的工单返回 404，重复撤回返回 409', async () => {
  await withServer(async (base) => {
    const missing = await postJson(base, '/api/revoke', { workOrderId: 'WO-99' });
    assert.equal(missing.status, 404);
    assert.match(missing.data.error, /工单不存在/);

    await postJson(base, '/api/revoke', { workOrderId: 'WO-3' });
    const again = await postJson(base, '/api/revoke', { workOrderId: 'WO-3' });
    assert.equal(again.status, 409);
    assert.match(again.data.error, /已撤回/);
  });
});

test('异常：撤回请求缺少 workOrderId 返回 400', async () => {
  await withServer(async (base) => {
    const { status, data } = await postJson(base, '/api/revoke', {});
    assert.equal(status, 400);
    assert.match(data.error, /workOrderId/);
  });
});

test('异常：请求体不是合法 JSON 返回 400', async () => {
  await withServer(async (base) => {
    const { status, data } = await postJson(base, '/api/analyze', undefined, '{bad json');
    assert.equal(status, 400);
    assert.match(data.error, /JSON/);
  });
});

test('异常：不存在的接口与报告返回 404', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/api/nope`);
    assert.equal(res.status, 404);
    const report = await fetch(`${base}/api/reports/R999`);
    assert.equal(report.status, 404);
  });
});
