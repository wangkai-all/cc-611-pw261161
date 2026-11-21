'use strict';

/* 页面只负责展示，所有业务结果都来自服务端真实处理流程。 */

const $ = (sel) => document.querySelector(sel);
const resultEl = $('#result');
const resultBody = $('#result-body');

const METHOD_LABELS = {
  'completed-ratio': '按完成任务比例',
  primary: '按主责时间归属',
};

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[c]));
}

/** ISO 串 → HH:MM（样例数据为 UTC，直接切片避免时区干扰）。 */
function hm(iso) {
  return String(iso).slice(11, 16);
}

async function api(path, options) {
  const res = await fetch(path, options);
  const data = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error((data && data.error) || `HTTP ${res.status}`);
  }
  return data;
}

function post(path, body) {
  return api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body || {}),
  });
}

/** 更新业务结果区，同时刷新 data-evidence-result 便于核对操作前后内容。 */
function setEvidence(value, html) {
  resultEl.setAttribute('data-evidence-result', value);
  resultBody.innerHTML = html;
}

function showError(err) {
  setEvidence('error', `<p class="error">操作失败：${esc(err.message)}</p>`);
}

function rawJson(obj) {
  return `<details class="raw"><summary>原始 JSON</summary><pre>${esc(JSON.stringify(obj, null, 2))}</pre></details>`;
}

/* ---------- 原始数据区 ---------- */

function renderState(state) {
  const personName = (id) => {
    const p = state.persons.find((x) => x.id === id);
    return p ? p.name : id;
  };
  const checkInRows = state.checkIns.map((c) => `
    <tr><td>${esc(personName(c.personId))}</td><td>${hm(c.start)} ~ ${hm(c.end)}</td></tr>`).join('');
  const orderRows = state.workOrders.map((o) => `
    <tr class="${o.status === 'revoked' ? 'revoked' : ''}">
      <td>${esc(o.id)}</td><td>${esc(personName(o.personId))}</td><td>${esc(o.activity)}</td>
      <td>${o.role === 'primary' ? '主责' : '支援'}</td>
      <td>${Math.round(o.progress * 100)}%</td>
      <td>${hm(o.start)} ~ ${hm(o.end)}</td>
      <td>${o.status === 'revoked' ? '已撤回' : '生效中'}</td>
    </tr>`).join('');
  $('#dataset-body').innerHTML = `
    <div class="cols">
      <div>
        <h3>签到记录</h3>
        <table><thead><tr><th>人员</th><th>在场时段</th></tr></thead><tbody>${checkInRows}</tbody></table>
      </div>
      <div>
        <h3>任务工单</h3>
        <table><thead><tr><th>工单</th><th>人员</th><th>活动</th><th>角色</th><th>完成比例</th><th>时段</th><th>状态</th></tr></thead>
        <tbody>${orderRows}</tbody></table>
      </div>
    </div>`;

  const select = $('#revoke-target');
  const active = state.workOrders.filter((o) => o.status !== 'revoked');
  select.innerHTML = active.map((o) => `<option value="${esc(o.id)}">${esc(o.id)}（${esc(personName(o.personId))} · ${esc(o.activity)}）</option>`).join('');
  $('#btn-revoke').disabled = active.length === 0;
}

/* ---------- 报告渲染 ---------- */

function reportHtml(report, title) {
  const personRows = report.persons.map((p) => `
    <tr>
      <td>${esc(p.name)}</td>
      <td>${p.checkInMinutes}</td>
      <td><strong>${p.totalMinutes}</strong></td>
      <td>${p.orders.map((o) => `${esc(o.workOrderId)} ${o.minutes}′`).join('，') || '—'}</td>
    </tr>`).join('');
  const orderRows = report.persons.flatMap((p) => p.orders.map((o) => `
    <tr>
      <td>${esc(o.workOrderId)}</td><td>${esc(p.name)}</td><td>${esc(o.activity)}</td>
      <td>${o.role === 'primary' ? '主责' : '支援'}</td>
      <td>${Math.round(o.progress * 100)}%</td><td>${o.minutes}</td>
    </tr>`)).join('');
  const anomalies = report.anomalies.length
    ? `<div class="anomalies"><h4>异常（已按签到裁剪）</h4><ul>${report.anomalies.map((a) => `<li>${esc(a.message)}</li>`).join('')}</ul></div>`
    : '';
  return `
    <h3>${esc(title)}：${esc(report.id)}（${esc(METHOD_LABELS[report.method] || report.method)}）</h3>
    <p class="total">全员总投入 <strong>${report.totals.totalMinutes}</strong> 分钟（重叠时段已拆分，不重复计数）</p>
    <h4>按人汇总</h4>
    <table><thead><tr><th>人员</th><th>签到时长(分)</th><th>归属总时长(分)</th><th>各工单投入</th></tr></thead>
    <tbody>${personRows}</tbody></table>
    <h4>按工单投入</h4>
    <table><thead><tr><th>工单</th><th>人员</th><th>活动</th><th>角色</th><th>完成比例</th><th>投入(分)</th></tr></thead>
    <tbody>${orderRows}</tbody></table>
    ${anomalies}`;
}

/* ---------- 三个操作 ---------- */

async function onAnalyze() {
  try {
    const report = await post('/api/analyze', { method: $('#method').value });
    setEvidence(`analyze:${report.id}`, reportHtml(report, '原投入量报告') + rawJson(report));
  } catch (err) {
    showError(err);
  }
}

async function onRevoke() {
  try {
    const workOrderId = $('#revoke-target').value;
    if (!workOrderId) throw new Error('没有可撤回的工单');
    const data = await post('/api/revoke', { workOrderId });
    const a = data.affected;
    const personRows = a.persons.map((p) => `
      <tr><td>${esc(p.name)}</td><td>${p.beforeMinutes}</td><td>${p.afterMinutes}</td></tr>`).join('');
    const orderRows = a.orders.map((o) => `
      <tr class="${o.status === 'revoked' ? 'revoked' : ''}">
        <td>${esc(o.workOrderId)}</td><td>${esc(o.activity)}</td>
        <td>${o.beforeMinutes}</td><td>${o.afterMinutes}</td>
        <td>${o.deltaMinutes > 0 ? '+' : ''}${o.deltaMinutes}</td>
        <td>${o.status === 'revoked' ? '已撤回' : '生效中'}</td>
      </tr>`).join('');
    const segRows = a.changedSegments.map((s) => {
      const fmtParts = (parts) => parts.map((p) => `${esc(p.workOrderId)}×${p.weight}=${p.minutes}′`).join('，');
      const after = s.after.length
        ? s.after.map((ns) => `${hm(ns.start)}~${hm(ns.end)}：${fmtParts(ns.parts)}`).join('<br>')
        : '（释放，无归属）';
      return `<tr><td>${hm(s.start)} ~ ${hm(s.end)}</td><td>${fmtParts(s.before)}</td><td>${after}</td></tr>`;
    }).join('');
    setEvidence(`revoke:${workOrderId}:${data.oldReportId}->${data.newReportId}`, `
      <h3>工单 ${esc(workOrderId)} 已撤回</h3>
      <p class="kept">旧报告 ${esc(data.oldReportId)} 已保留（可通过 GET /api/reports/${esc(data.oldReportId)} 查看），
      新报告为 ${esc(data.newReportId)}。</p>
      <h4>受影响范围 · 人员</h4>
      <table><thead><tr><th>人员</th><th>撤回前总时长(分)</th><th>撤回后总时长(分)</th></tr></thead>
      <tbody>${personRows}</tbody></table>
      <h4>受影响范围 · 工单重分配</h4>
      <table><thead><tr><th>工单</th><th>活动</th><th>撤回前(分)</th><th>撤回后(分)</th><th>变化</th><th>状态</th></tr></thead>
      <tbody>${orderRows}</tbody></table>
      <h4>受影响范围 · 时段拆分变化</h4>
      <table><thead><tr><th>时段</th><th>撤回前归属</th><th>撤回后归属</th></tr></thead>
      <tbody>${segRows}</tbody></table>
      ${reportHtml(data.newReport, '撤回后新报告')}
      ${rawJson(data)}`);
    const state = await api('/api/state');
    renderState(state);
  } catch (err) {
    showError(err);
  }
}

async function onOverlap() {
  try {
    const data = await api(`/api/overlap?method=${encodeURIComponent($('#method').value)}`);
    const rows = data.segments.map((s) => `
      <tr class="${s.overlap ? 'overlap' : ''}">
        <td>${esc(s.personId)}</td>
        <td>${hm(s.start)} ~ ${hm(s.end)}</td>
        <td>${s.minutes}</td>
        <td>${s.overlap ? '重叠（已拆分）' : '独占'}</td>
        <td>${s.parts.map((p) => `${esc(p.workOrderId)} × ${p.weight} = ${p.minutes}′`).join('<br>')}</td>
      </tr>`).join('');
    setEvidence(`overlap:${data.reportId}`, `
      <h3>重叠拆分（来自报告 ${esc(data.reportId)}，${esc(METHOD_LABELS[data.method] || data.method)}）</h3>
      <p>每行是归属器切出的最小不可再分时段；同一行各份之和等于该段时长，因此个人总时长不因重叠增加。</p>
      <table><thead><tr><th>人员</th><th>时段</th><th>时长(分)</th><th>类型</th><th>拆分归属</th></tr></thead>
      <tbody>${rows}</tbody></table>
      ${rawJson(data)}`);
  } catch (err) {
    showError(err);
  }
}

async function onReset() {
  try {
    await post('/api/reset');
    const state = await api('/api/state');
    renderState(state);
    setEvidence('reset', '<p>样例数据已重置，报告历史已清空。</p>');
  } catch (err) {
    showError(err);
  }
}

async function boot() {
  $('#btn-analyze').addEventListener('click', onAnalyze);
  $('#btn-revoke').addEventListener('click', onRevoke);
  $('#btn-overlap').addEventListener('click', onOverlap);
  $('#btn-reset').addEventListener('click', onReset);
  try {
    renderState(await api('/api/state'));
  } catch (err) {
    $('#dataset-body').innerHTML = `<p class="error">加载失败：${esc(err.message)}</p>`;
  }
}

boot();
