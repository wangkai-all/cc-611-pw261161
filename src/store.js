'use strict';

const { computeReport, round2 } = require('./engine');

const DEFAULT_METHOD = 'completed-ratio';

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'HttpError';
    this.status = status;
  }
}

/**
 * 内存数据存储：数据集 + 报告历史。
 * 撤销工单不会删除旧报告，历史报告始终可通过 getReport 取回。
 */
class Store {
  /** @param datasetFactory 返回全新数据集的工厂函数（用于重置） */
  constructor(datasetFactory) {
    this.datasetFactory = datasetFactory;
    this.dataset = datasetFactory();
    this.reports = [];
    this.seq = 0;
  }

  reset() {
    this.dataset = this.datasetFactory();
    this.reports = [];
    this.seq = 0;
  }

  state() {
    return {
      persons: this.dataset.persons,
      checkIns: this.dataset.checkIns,
      workOrders: this.dataset.workOrders,
      reports: this.reportList(),
    };
  }

  analyze(method) {
    const m = method || DEFAULT_METHOD;
    const report = computeReport(this.dataset, m, {
      id: `R${(this.seq += 1)}`,
      createdAt: new Date().toISOString(),
    });
    this.reports.push(report);
    return report;
  }

  latestReport() {
    return this.reports[this.reports.length - 1] || null;
  }

  reportList() {
    return this.reports.map((r) => ({
      id: r.id,
      method: r.method,
      createdAt: r.createdAt,
      totalMinutes: r.totals.totalMinutes,
      revokedOrdersAtRun: r.totals.revokedOrders,
    }));
  }

  getReport(id) {
    const report = this.reports.find((r) => r.id === id);
    if (!report) throw new HttpError(404, `报告不存在: ${id}`);
    return report;
  }

  /** 查看重叠拆分：没有匹配方法的报告时先跑一轮真实归属计算。 */
  overlap(method) {
    const latest = this.latestReport();
    const want = method || (latest && latest.method) || DEFAULT_METHOD;
    const report = latest && latest.method === want ? latest : this.analyze(want);
    return { reportId: report.id, method: report.method, segments: report.segments };
  }

  /**
   * 撤回一张工单：
   *  1. 若还没有报告，先按默认方法补一份「原报告」；
   *  2. 标记工单 revoked（数据保留，不删除）；
   *  3. 用同一方法重算新报告；
   *  4. 输出受影响范围（人员前后时长、工单重分配、变化的拆分时段）。
   */
  revoke(workOrderId) {
    const order = this.dataset.workOrders.find((o) => o.id === workOrderId);
    if (!order) throw new HttpError(404, `工单不存在: ${workOrderId}`);
    if (order.status === 'revoked') throw new HttpError(409, `工单 ${workOrderId} 已撤回，不能重复撤回`);

    if (this.reports.length === 0) this.analyze(DEFAULT_METHOD);
    const oldReport = this.latestReport();

    order.status = 'revoked';
    order.revokedAt = new Date().toISOString();

    const newReport = this.analyze(oldReport.method);
    const affected = diffReports(oldReport, newReport, order);
    return {
      revoked: workOrderId,
      oldReportId: oldReport.id,
      newReportId: newReport.id,
      oldReportKept: true,
      oldReport,
      newReport,
      affected,
    };
  }
}

/** 对比撤销前后两份报告，圈出受影响范围。 */
function diffReports(oldReport, newReport, revokedOrder) {
  const pid = revokedOrder.personId;
  const beforePerson = oldReport.persons.find((p) => p.personId === pid);
  const afterPerson = newReport.persons.find((p) => p.personId === pid);

  const orderIds = new Set();
  for (const p of [beforePerson, afterPerson]) {
    if (p) for (const o of p.orders) orderIds.add(o.workOrderId);
  }
  orderIds.add(revokedOrder.id);
  const orders = [...orderIds].sort().map((id) => {
    const before = beforePerson ? beforePerson.orders.find((o) => o.workOrderId === id) : null;
    const after = afterPerson ? afterPerson.orders.find((o) => o.workOrderId === id) : null;
    return {
      workOrderId: id,
      activity: (before && before.activity) || (after && after.activity) || revokedOrder.activity,
      beforeMinutes: before ? before.minutes : 0,
      afterMinutes: after ? after.minutes : 0,
      deltaMinutes: round2((after ? after.minutes : 0) - (before ? before.minutes : 0)),
      status: id === revokedOrder.id ? 'revoked' : 'active',
    };
  });

  // 旧报告中包含被撤工单的时段 → 新报告中与之时交的新拆分段（带各自时段，避免误读）
  const oldSegs = oldReport.segments.filter(
    (s) => s.personId === pid && s.parts.some((p) => p.workOrderId === revokedOrder.id)
  );
  const newSegs = newReport.segments.filter((s) => s.personId === pid);
  const changedSegments = oldSegs.map((os) => ({
    start: os.start,
    end: os.end,
    minutes: os.minutes,
    before: os.parts,
    after: newSegs
      .filter((ns) => ns.start < os.end && ns.end > os.start)
      .map((ns) => ({ start: ns.start, end: ns.end, minutes: ns.minutes, parts: ns.parts })),
  }));

  return {
    revokedOrder: {
      id: revokedOrder.id,
      personId: pid,
      activity: revokedOrder.activity,
      minutesBefore: beforePerson
        ? (beforePerson.orders.find((o) => o.workOrderId === revokedOrder.id) || { minutes: 0 }).minutes
        : 0,
    },
    persons: [
      {
        personId: pid,
        name: (beforePerson && beforePerson.name) || (afterPerson && afterPerson.name),
        beforeMinutes: beforePerson ? beforePerson.totalMinutes : 0,
        afterMinutes: afterPerson ? afterPerson.totalMinutes : 0,
      },
    ],
    orders,
    changedSegments,
  };
}

module.exports = { Store, HttpError, DEFAULT_METHOD };
