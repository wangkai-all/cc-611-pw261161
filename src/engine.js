'use strict';

/**
 * 归属器 + 统计端（纯函数，不依赖 HTTP 层）。
 *
 * 数据模型：
 *   签到 checkIn:   { personId, start, end }              —— ISO 时间串，只记录人在场
 *   工单 workOrder: { id, personId, activity, role, progress, start, end, status }
 *     role: 'primary'（主责） | 'support'（支援）
 *     progress: 0..1 完成任务比例
 *     status: 'active' | 'revoked'
 *
 * 归属方法 method：
 *   'completed-ratio' 按完成任务比例拆分重叠区
 *   'primary'         重叠区归主责工单（主责时间归属）
 */

const MINUTE_MS = 60 * 1000;
const METHODS = new Set(['completed-ratio', 'primary']);
const ROLES = new Set(['primary', 'support']);
const STATUSES = new Set(['active', 'revoked']);

class EngineError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EngineError';
    this.code = code || 'ENGINE_ERROR';
  }
}

function round2(n) {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

function round6(n) {
  return Math.round((n + Number.EPSILON) * 1e6) / 1e6;
}

function parseTime(value, field) {
  if (typeof value !== 'string' || value.length === 0) {
    throw new EngineError(`时间字段 ${field} 必须是 ISO 字符串，收到: ${value}`, 'INVALID_TIME');
  }
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) {
    throw new EngineError(`时间字段 ${field} 无法解析: ${value}`, 'INVALID_TIME');
  }
  return ms;
}

function iso(ms) {
  return new Date(ms).toISOString();
}

function validateCheckIn(c) {
  if (!c || typeof c !== 'object') throw new EngineError('签到记录必须是对象', 'INVALID_CHECKIN');
  if (typeof c.personId !== 'string' || c.personId === '') {
    throw new EngineError('签到记录缺少 personId', 'INVALID_CHECKIN');
  }
  const start = parseTime(c.start, 'checkIn.start');
  const end = parseTime(c.end, 'checkIn.end');
  if (end <= start) {
    throw new EngineError(`签到记录结束时间必须晚于开始时间: ${c.start} ~ ${c.end}`, 'INVALID_RANGE');
  }
}

function validateOrder(order) {
  if (!order || typeof order !== 'object') throw new EngineError('工单必须是对象', 'INVALID_ORDER');
  for (const f of ['id', 'personId', 'activity', 'role', 'start', 'end']) {
    if (typeof order[f] !== 'string' || order[f] === '') {
      throw new EngineError(`工单缺少字段 ${f}`, 'INVALID_ORDER');
    }
  }
  if (!ROLES.has(order.role)) {
    throw new EngineError(`工单 ${order.id} 角色非法: ${order.role}（应为 primary/support）`, 'INVALID_ROLE');
  }
  if (typeof order.progress !== 'number' || Number.isNaN(order.progress) || order.progress < 0 || order.progress > 1) {
    throw new EngineError(`工单 ${order.id} 完成比例非法: ${order.progress}（应在 0..1）`, 'INVALID_PROGRESS');
  }
  if (order.status !== undefined && !STATUSES.has(order.status)) {
    throw new EngineError(`工单 ${order.id} 状态非法: ${order.status}`, 'INVALID_STATUS');
  }
  const start = parseTime(order.start, 'start');
  const end = parseTime(order.end, 'end');
  if (end <= start) {
    throw new EngineError(`工单 ${order.id} 结束时间必须晚于开始时间: ${order.start} ~ ${order.end}`, 'INVALID_RANGE');
  }
}

/** 合并区间为不相交并集（毫秒）。 */
function unionIntervals(intervals) {
  const sorted = intervals
    .filter((iv) => iv.end > iv.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) {
      last.end = Math.max(last.end, iv.end);
    } else {
      out.push({ start: iv.start, end: iv.end });
    }
  }
  return out;
}

/** 把一张工单裁剪到签到并集内，返回若干 {start,end} 片段（毫秒）。 */
function clipToCheckIns(orderStart, orderEnd, checkInUnion) {
  const pieces = [];
  for (const ci of checkInUnion) {
    const s = Math.max(orderStart, ci.start);
    const e = Math.min(orderEnd, ci.end);
    if (e > s) pieces.push({ start: s, end: e });
  }
  return pieces;
}

/** 一组工单在某个重叠小段的权重，权重和恒为 1。 */
function weightsFor(orders, method) {
  if (orders.length === 1) return [1];
  if (method === 'completed-ratio') {
    const sum = orders.reduce((acc, o) => acc + o.progress, 0);
    if (sum <= 0) return orders.map(() => 1 / orders.length); // 都没有完成比例时均分
    return orders.map((o) => o.progress / sum);
  }
  if (method === 'primary') {
    const primaries = orders.filter((o) => o.role === 'primary');
    const pool = primaries.length > 0 ? primaries : orders; // 没有主责时均分
    return orders.map((o) => (pool.includes(o) ? 1 / pool.length : 0));
  }
  throw new EngineError(`未知归属方法: ${method}`, 'UNKNOWN_METHOD');
}

/**
 * 归属器：拆一个人的重叠区。
 * 返回 { checkInMinutes, segments, anomalies }。
 * segments 每段 parts 的 minutes 之和 === 该段 minutes（最后一份吸收舍入差），
 * 因此同一人总时长 = 各段之和 = 工单区间并集（裁剪后），重叠不会重复计数。
 */
function attributePerson(person, checkIns, orders, method) {
  if (!METHODS.has(method)) {
    throw new EngineError(`未知归属方法: ${method}（应为 completed-ratio/primary）`, 'UNKNOWN_METHOD');
  }
  const anomalies = [];
  for (const c of checkIns) validateCheckIn(c);
  const checkInUnion = unionIntervals(
    checkIns.map((c) => ({ start: parseTime(c.start, 'checkIn.start'), end: parseTime(c.end, 'checkIn.end') }))
  );
  const checkInMinutes = round2(checkInUnion.reduce((acc, iv) => acc + (iv.end - iv.start), 0) / MINUTE_MS);

  const pieces = [];
  for (const order of orders) {
    validateOrder(order);
    const s = parseTime(order.start, 'start');
    const e = parseTime(order.end, 'end');
    const clipped = clipToCheckIns(s, e, checkInUnion);
    const clippedMs = clipped.reduce((acc, p) => acc + (p.end - p.start), 0);
    const lostMs = e - s - clippedMs;
    if (lostMs > 0) {
      anomalies.push({
        type: 'ORDER_OUTSIDE_CHECKIN',
        personId: person.id,
        workOrderId: order.id,
        clippedMinutes: round2(lostMs / MINUTE_MS),
        message: `工单 ${order.id} 超出签到时段 ${round2(lostMs / MINUTE_MS)} 分钟，已按签到时间裁剪`,
      });
    }
    for (const p of clipped) pieces.push({ start: p.start, end: p.end, order });
  }

  const bounds = new Set();
  for (const p of pieces) {
    bounds.add(p.start);
    bounds.add(p.end);
  }
  const sorted = [...bounds].sort((a, b) => a - b);

  const segments = [];
  for (let i = 0; i < sorted.length - 1; i += 1) {
    const s = sorted[i];
    const e = sorted[i + 1];
    if (e <= s) continue;
    const covering = pieces.filter((p) => p.start <= s && p.end >= e);
    if (covering.length === 0) continue;
    const weights = weightsFor(covering.map((c) => c.order), method);
    const segMinutes = round2((e - s) / MINUTE_MS);
    let acc = 0;
    const parts = covering.map((c, idx) => {
      const isLast = idx === covering.length - 1;
      const minutes = isLast ? round2(segMinutes - acc) : round2(segMinutes * weights[idx]);
      acc = round2(acc + minutes);
      return {
        workOrderId: c.order.id,
        activity: c.order.activity,
        role: c.order.role,
        weight: round6(weights[idx]),
        minutes,
      };
    });
    segments.push({
      personId: person.id,
      start: iso(s),
      end: iso(e),
      minutes: segMinutes,
      overlap: covering.length > 1,
      parts,
    });
  }
  return { checkInMinutes, segments, anomalies };
}

/**
 * 统计端：对整份数据跑归属器并汇总总时长与投入。
 * 撤销（revoked）的工单不参与新一轮计算，但保留在原始数据里。
 */
function computeReport(dataset, method, meta) {
  if (!dataset || !Array.isArray(dataset.persons) || !Array.isArray(dataset.checkIns) || !Array.isArray(dataset.workOrders)) {
    throw new EngineError('数据集必须包含 persons/checkIns/workOrders 数组', 'INVALID_DATASET');
  }
  const activeOrders = dataset.workOrders.filter((o) => (o.status || 'active') !== 'revoked');
  const persons = [];
  const segments = [];
  const anomalies = [];

  for (const person of dataset.persons) {
    const pCheckIns = dataset.checkIns.filter((c) => c.personId === person.id);
    const pOrders = activeOrders.filter((o) => o.personId === person.id);
    const r = attributePerson(person, pCheckIns, pOrders, method);
    anomalies.push(...r.anomalies);
    segments.push(...r.segments);

    const orderMinutes = new Map(pOrders.map((o) => [o.id, 0]));
    let totalMinutes = 0;
    for (const seg of r.segments) {
      totalMinutes = round2(totalMinutes + seg.minutes);
      for (const part of seg.parts) {
        orderMinutes.set(part.workOrderId, round2((orderMinutes.get(part.workOrderId) || 0) + part.minutes));
      }
    }
    const activityMinutes = new Map();
    const orderRows = pOrders.map((o) => {
      const minutes = orderMinutes.get(o.id) || 0;
      activityMinutes.set(o.activity, round2((activityMinutes.get(o.activity) || 0) + minutes));
      return {
        workOrderId: o.id,
        activity: o.activity,
        role: o.role,
        progress: o.progress,
        minutes,
      };
    });
    persons.push({
      personId: person.id,
      name: person.name,
      checkInMinutes: r.checkInMinutes,
      totalMinutes,
      orders: orderRows,
      activities: [...activityMinutes.entries()].map(([activity, minutes]) => ({ activity, minutes })),
    });
  }

  return {
    id: meta.id,
    method,
    createdAt: meta.createdAt,
    persons,
    segments,
    anomalies,
    totals: {
      persons: persons.length,
      activeOrders: activeOrders.length,
      revokedOrders: dataset.workOrders.length - activeOrders.length,
      totalMinutes: round2(persons.reduce((acc, p) => acc + p.totalMinutes, 0)),
    },
  };
}

module.exports = {
  MINUTE_MS,
  METHODS,
  EngineError,
  round2,
  unionIntervals,
  weightsFor,
  attributePerson,
  computeReport,
};
