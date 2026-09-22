'use strict';

/**
 * 执行工单（work order）
 *
 * 在叠纸裁切排程（stackSchedule）结果之上，按操作者指定的**班次容量**
 *（每班最多刀次 maxCutsPerShift、每批最多纸张 maxSheetsPerBatch），
 * 依据父刀依赖做**稳定拓扑拆分**，生成可直接下发车间的班次 / 刀次清单：
 *
 *  - 拓扑：每把刀（排程中的“批”）是一个节点；同一张纸上“子刀 → 父刀”
 *    构成有向边（父刀必须先切）。父刀边来自排程结果的 dependencies，
 *    缺少该字段时退化为按批次先后推断的同纸链（dependencySource: 'inferred'）。
 *  - 稳定：拓扑排序就绪集合中的多把刀按**来源批次先后**决胜（批序号即
 *    stackSchedule 的确定选批顺序），同一批内 members 的纸张顺序原样保留，
 *    拆分绝不会打乱批次内纸张顺序，也不会重排/拆散任何批次。
 *  - 分班：按拓扑顺序贪心装班，每班至多 maxCutsPerShift 把刀；
 *    父刀落在前一班、子刀落在后一班时在 crossShiftDeps 中标出跨班次依赖。
 *  - 未分配：单批叠纸张数超过 maxSheetsPerBatch（over-capacity）、
 *    依赖中的父刀不在任何批次内（missing-parent）或因上游未分配而被阻断
 *    （blocked）的刀列入 unassigned 并给出原因；依赖存在环时无法排产，抛错。
 *
 * 所有输入最终都归一为排程结果：
 *   ① 直接带 `schedule`（/api/layout/stack 的完整/精简返回）；
 *   ② 带 `sheets` 与 `stackLimit` 时先在服务端运行 stackSchedule。
 */

const MAX_CUTS_PER_SHIFT = 10000; // 单班刀次上限（排程总批数本身不超过 500 张纸 × 切割树刀数）
const MAX_SHEETS_PER_BATCH = 500; // 与叠纸上限同一量级

/** 容量规范化：1～max 的正整数 */
function normalizeCapacity(value, field, max) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`${field}必须是正整数`);
  }
  if (n > max) {
    throw new Error(`${field}不能超过 ${max}`);
  }
  return n;
}

/** 就绪节点的最小堆：keyOf 给出稳定决胜键（来源批次先后） */
class MinHeap {
  constructor(keyOf) {
    this.a = [];
    this.keyOf = keyOf;
  }

  get size() {
    return this.a.length;
  }

  push(item) {
    const a = this.a;
    a.push(item);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (this.keyOf(a[p]) <= this.keyOf(a[i])) break;
      [a[p], a[i]] = [a[i], a[p]];
      i = p;
    }
  }

  pop() {
    const a = this.a;
    const top = a[0];
    const last = a.pop();
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.keyOf(a[l]) < this.keyOf(a[m])) m = l;
        if (r < a.length && this.keyOf(a[r]) < this.keyOf(a[m])) m = r;
        if (m === i) break;
        [a[m], a[i]] = [a[i], a[m]];
        i = m;
      }
    }
    return top;
  }
}

const REASON_TEXT = {
  'over-capacity': (detail) =>
    `该刀需一次叠切 ${detail.sheetCount} 张纸，超过每批最多 ${detail.maxSheets} 张的容量，请调整容量或重新合批`,
  'missing-parent': (detail) =>
    `父刀（第 ${detail.parentSheet} 张纸第 ${detail.parentCut} 号刀）未出现在排程批次中，本刀缺少前置裁切`,
  blocked: (detail) =>
    `父刀（第 ${detail.parentSheet} 张纸第 ${detail.parentCut} 号刀）未分配（${detail.parentReason}），本刀被阻断`,
};

const REASON_RANK = { 'over-capacity': 0, 'missing-parent': 1, blocked: 2 };

/**
 * 执行工单主入口。
 *
 * @param {object} input
 *   - schedule?：叠纸排程结果（含 batches；可带 dependencies/sheets/source/stackLimit）；
 *   - maxCutsPerShift：每班最多刀次（1～10000 正整数，必填）；
 *   - maxSheetsPerBatch?：每批最多纸张（1～500 正整数，缺省取排程 stackLimit 或 500）；
 *   - 未提供 schedule 时，其余字段原样交给 stackSchedule（需 sheets/stackLimit）。
 */
function workOrder(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('缺少工单输入');
  }

  // 延迟引入避免与 stack.js 的潜在循环依赖
  let schedule = input.schedule;
  if (!schedule || typeof schedule !== 'object') {
    if (!Array.isArray(input.sheets)) {
      throw new Error('缺少排程结果（schedule 或 sheets）——请先生成叠纸裁切排程');
    }
    // eslint-disable-next-line global-require
    schedule = require('./stack').stackSchedule(input);
  }
  if (!Array.isArray(schedule.batches) || schedule.batches.length === 0) {
    throw new Error('排程结果中没有任何刀次批次，无法生成执行工单');
  }

  const maxCutsPerShift = normalizeCapacity(
    input.maxCutsPerShift, '每班最多刀次', MAX_CUTS_PER_SHIFT
  );

  const maxSheetsPerBatch = normalizeCapacity(
    input.maxSheetsPerBatch != null ? input.maxSheetsPerBatch : (schedule.stackLimit || MAX_SHEETS_PER_BATCH),
    '每批最多纸张',
    MAX_SHEETS_PER_BATCH
  );

  /* ---------------- 节点：排程批次即一把刀 ---------------- */

  const nodes = [];
  const cutNode = new Map(); // "sheetIndex:cutNo" → node
  const batchNos = new Set();

  schedule.batches.forEach((b, i) => {
    if (!b || typeof b !== 'object' || !Array.isArray(b.members) || b.members.length === 0) {
      throw new Error(`排程第 ${i + 1} 批缺少成员（members）`);
    }
    const sourceBatchNo = Number.isInteger(b.batchNo) && b.batchNo >= 1 ? b.batchNo : i + 1;
    if (batchNos.has(sourceBatchNo)) {
      throw new Error(`排程批次号重复：${sourceBatchNo}`);
    }
    batchNos.add(sourceBatchNo);

    const members = b.members.map((m, j) => {
      if (!m || !(Number.isInteger(m.sheetIndex) && m.sheetIndex >= 1)
        || !(Number.isInteger(m.cutNo) && m.cutNo >= 1)) {
        throw new Error(`排程第 ${sourceBatchNo} 批第 ${j + 1} 个成员不是有效的 {sheetIndex, cutNo}`);
      }
      return { sheetIndex: m.sheetIndex, cutNo: m.cutNo };
    });
    members.forEach((m) => {
      const token = `${m.sheetIndex}:${m.cutNo}`;
      if (cutNode.has(token)) {
        throw new Error(`第 ${m.sheetIndex} 张纸第 ${m.cutNo} 号刀出现在多个批次中，排程结果不合法`);
      }
      cutNode.set(token, null); // 先占位，节点建好后回填下标
    });

    const node = {
      order: i, // 来源批次先后（稳定决胜键）
      sourceBatchNo,
      orient: b.orient || null,
      kerf: b.kerf != null ? b.kerf : null,
      position: b.position != null ? b.position : null,
      region: b.region && typeof b.region === 'object'
        ? { w: b.region.w != null ? b.region.w : null, h: b.region.h != null ? b.region.h : null }
        : { w: null, h: null },
      cutLength: b.cutLength != null ? b.cutLength : null,
      totalLength: b.totalLength != null ? b.totalLength : null,
      capped: !!b.capped,
      members,
      excluded: false, // 整批超容量时不参与分班
    };
    nodes.push(node);
  });
  nodes.forEach((node, ni) => {
    node.members.forEach((m) => cutNode.set(`${m.sheetIndex}:${m.cutNo}`, ni));
  });

  /* ---------------- 父刀边：dependencies 或按批次先后推断 ---------------- */

  const edges = []; // {from, to, sheetIndex, childCut, parentCut}（node 下标，方向 父→子）
  const unassigned = new Map(); // token → { reason, detail, batchNo }
  const childCuts = new Map(); // parent token → [child token...]
  let dependencySource = 'dependencies';

  const reasonShort = (reason) => {
    if (reason === 'over-capacity') return '超每批容量';
    if (reason === 'missing-parent') return '父刀缺失';
    return '上游被阻断';
  };

  const note = (sheetIndex, cutNo, reason, detail, batchNo) => {
    const token = `${sheetIndex}:${cutNo}`;
    const prev = unassigned.get(token);
    if (prev && REASON_RANK[prev.reason] <= REASON_RANK[reason]) return;
    unassigned.set(token, { sheetIndex, cutNo, reason, detail: REASON_TEXT[reason](detail), batchNo });
  };

  const registerEdge = (sheetIndex, childCut, parentCut, childNi, parentNi) => {
    edges.push({ from: parentNi, to: childNi, sheetIndex, childCut, parentCut });
    const pt = `${sheetIndex}:${parentCut}`;
    if (!childCuts.has(pt)) childCuts.set(pt, []);
    childCuts.get(pt).push(`${sheetIndex}:${childCut}`);
  };

  const addPair = (sheetIndex, childCut, parentCut) => {
    if (!(Number.isInteger(childCut) && childCut >= 1)
      || !(Number.isInteger(parentCut) && parentCut >= 1)) {
      throw new Error(`第 ${sheetIndex} 张纸的父刀依赖记录不是有效的 [子刀号, 父刀号]`);
    }
    const ct = `${sheetIndex}:${childCut}`;
    const pt = `${sheetIndex}:${parentCut}`;
    const childNi = cutNode.get(ct);
    if (childNi == null) {
      throw new Error(`第 ${sheetIndex} 张纸第 ${childCut} 号刀在依赖中出现，但不在任何排程批次内`);
    }
    const parentNi = cutNode.get(pt);
    if (parentNi == null) {
      // 父刀缺失：记下该刀未分配，不加边
      note(sheetIndex, childCut, 'missing-parent',
        { parentSheet: sheetIndex, parentCut }, nodes[childNi].sourceBatchNo);
      return;
    }
    registerEdge(sheetIndex, childCut, parentCut, childNi, parentNi);
  };

  if (schedule.dependencies !== undefined && !Array.isArray(schedule.dependencies)) {
    throw new Error('排程 dependencies 必须是按纸张排列的依赖数组');
  }

  if (Array.isArray(schedule.dependencies)) {
    schedule.dependencies.forEach((list, si) => {
      if (!Array.isArray(list)) {
        throw new Error(`排程 dependencies 第 ${si + 1} 张纸不是数组`);
      }
      list.forEach((pair) => {
        if (!Array.isArray(pair) || pair.length !== 2) {
          throw new Error(`排程 dependencies 第 ${si + 1} 张纸存在非法依赖记录`);
        }
        addPair(si + 1, pair[0], pair[1]);
      });
    });
  } else {
    // 推断：同一张纸上按来源批次先后把相邻刀连成链（近似父刀约束，保证父先于子）
    dependencySource = 'inferred';
    const bySheet = new Map();
    nodes.forEach((node, ni) => {
      node.members.forEach((m) => {
        if (!bySheet.has(m.sheetIndex)) bySheet.set(m.sheetIndex, []);
        bySheet.get(m.sheetIndex).push({ order: node.order, ni, cutNo: m.cutNo });
      });
    });
    for (const [sheetIndex, list] of bySheet) {
      list.sort((a, b) => a.order - b.order || a.cutNo - b.cutNo);
      for (let k = 1; k < list.length; k += 1) {
        registerEdge(sheetIndex, list[k].cutNo, list[k - 1].cutNo, list[k].ni, list[k - 1].ni);
      }
    }
  }

  /* ---------------- 超容量整批剔除 ---------------- */

  nodes.forEach((node) => {
    if (node.members.length > maxSheetsPerBatch) {
      node.excluded = true;
      node.members.forEach((m) => {
        note(m.sheetIndex, m.cutNo, 'over-capacity',
          { sheetCount: node.members.length, maxSheets: maxSheetsPerBatch },
          node.sourceBatchNo);
      });
    }
  });

  /* ---------------- 未分配沿父刀边向下传播（刀级） ---------------- */

  // 以已登记的未分配刀为种子，沿“父→子”扩散：上游刀未分配，子刀必被阻断
  const queue = [...unassigned.keys()];
  const seen = new Set(queue);
  while (queue.length) {
    const token = queue.shift();
    const [, cutStr] = token.split(':');
    const parentInfo = unassigned.get(token);
    for (const childToken of childCuts.get(token) || []) {
      const [childSheetStr, childCutStr] = childToken.split(':');
      const childNi = cutNode.get(childToken);
      if (childNi == null || nodes[childNi].excluded) continue; // 已按超容量登记
      note(
        Number(childSheetStr),
        Number(childCutStr),
        'blocked',
        {
          parentSheet: parentInfo.sheetIndex,
          parentCut: Number(cutStr),
          parentReason: reasonShort(parentInfo.reason),
        },
        nodes[childNi].sourceBatchNo
      );
      if (!seen.has(childToken)) {
        seen.add(childToken);
        queue.push(childToken);
      }
    }
  }

  /* ---------------- 活跃节点上的稳定拓扑排序 ---------------- */

  // 一个节点参与排班，当且仅当它未被整批剔除且至少有一把成员刀仍可执行
  const blockedTokens = new Set(unassigned.keys());
  const active = nodes.map((node) => {
    if (node.excluded) return false;
    return node.members.some((m) => !blockedTokens.has(`${m.sheetIndex}:${m.cutNo}`));
  });

  const indeg = new Array(nodes.length).fill(0);
  const adj = nodes.map(() => []);
  const activeEdges = [];
  for (const e of edges) {
    if (!active[e.from] || !active[e.to]) continue;
    if (e.from === e.to) {
      throw new Error('父刀依赖存在自环，无法生成执行工单');
    }
    adj[e.from].push(e.to);
    indeg[e.to] += 1;
    activeEdges.push(e);
  }

  const heap = new MinHeap((ni) => nodes[ni].order);
  nodes.forEach((node, ni) => {
    if (active[ni] && indeg[ni] === 0) heap.push(ni);
  });

  const order = [];
  while (heap.size) {
    const ni = heap.pop();
    order.push(ni);
    for (const to of adj[ni]) {
      indeg[to] -= 1;
      if (indeg[to] === 0) heap.push(to);
    }
  }

  if (order.length < active.filter(Boolean).length) {
    const inCycle = nodes
      .filter((node, ni) => active[ni] && !order.includes(ni))
      .map((node) => node.sourceBatchNo)
      .sort((a, b) => a - b);
    throw new Error(`父刀依赖存在环，无法拆分执行工单，涉及来源批次：${inCycle.join('、')}`);
  }

  /* ---------------- 按班容量贪心分班 ---------------- */

  const shifts = [];
  const shiftOf = new Map(); // node → shiftNo
  const execOf = new Map(); // node → global cut no
  let globalCut = 0;
  for (const ni of order) {
    let shift = shifts[shifts.length - 1];
    if (!shift || shift.cuts.length >= maxCutsPerShift) {
      shift = { shiftNo: shifts.length + 1, cuts: [] };
      shifts.push(shift);
    }
    globalCut += 1;
    const node = nodes[ni];
    shiftOf.set(ni, shift.shiftNo);
    execOf.set(ni, globalCut);
    shift.cuts.push({
      shiftNo: shift.shiftNo,
      cutInShift: shift.cuts.length + 1,
      cutNo: globalCut,
      batchNo: node.sourceBatchNo,
      orient: node.orient,
      kerf: node.kerf,
      position: node.position,
      region: node.region,
      cutLength: node.cutLength,
      totalLength: node.totalLength,
      sheetCount: node.members.length,
      capped: node.capped,
      // 批次内纸张顺序与排程结果完全一致（不打乱）
      members: node.members.map((m) => ({ sheetIndex: m.sheetIndex, cutNo: m.cutNo })),
    });
  }

  /* ---------------- 跨班次依赖 ---------------- */

  const crossShiftDeps = [];
  for (const e of activeEdges) {
    const fromShift = shiftOf.get(e.from);
    const toShift = shiftOf.get(e.to);
    if (toShift > fromShift) {
      crossShiftDeps.push({
        sheetIndex: e.sheetIndex,
        cutNo: e.childCut,
        parentCutNo: e.parentCut,
        fromShift,
        toShift,
        fromCutNo: execOf.get(e.from),
        toCutNo: execOf.get(e.to),
      });
    }
  }
  crossShiftDeps.sort((a, b) =>
    (a.toShift - b.toShift)
    || (a.toCutNo - b.toCutNo)
    || (a.sheetIndex - b.sheetIndex)
    || (a.cutNo - b.cutNo));

  /* ---------------- 输出组装 ---------------- */

  const unassignedOut = [...unassigned.values()].map((u) => ({
    sheetIndex: u.sheetIndex,
    cutNo: u.cutNo,
    reason: u.reason,
    detail: u.detail,
    batchNo: u.batchNo == null ? null : u.batchNo,
  }));
  unassignedOut.sort((a, b) =>
    (a.sheetIndex - b.sheetIndex)
    || (a.cutNo - b.cutNo)
    || String(a.reason).localeCompare(String(b.reason)));

  const shiftOut = shifts.map((shift) => ({
    shiftNo: shift.shiftNo,
    cutsTotal: shift.cuts.length,
    sheetsCut: shift.cuts.reduce((s, c) => s + c.sheetCount, 0),
    cuts: shift.cuts,
  }));

  const sheetIndexSet = new Set();
  if (Array.isArray(schedule.sheets)) {
    schedule.sheets.forEach((sh) => sheetIndexSet.add(Number.isInteger(sh && sh.index) ? sh.index : null));
  }
  nodes.forEach((node) => node.members.forEach((m) => sheetIndexSet.add(m.sheetIndex)));
  sheetIndexSet.delete(null);

  const cutsAssigned = order.length;
  return {
    source: schedule.source != null ? schedule.source : null,
    stackLimit: schedule.stackLimit != null ? schedule.stackLimit : null,
    dependencySource,
    maxCutsPerShift,
    maxSheetsPerBatch,
    summary: {
      sheetsTotal: sheetIndexSet.size,
      batchesTotal: nodes.length,
      batchesAssigned: cutsAssigned,
      batchesUnassigned: nodes.length - cutsAssigned,
      cutsPerShift: shiftOut.map((s) => s.cutsTotal),
      shiftsTotal: shifts.length,
      crossShiftDeps: crossShiftDeps.length,
      unassignedCuts: unassignedOut.length,
      totalLength: round3(
        shiftOut.reduce(
          (sum, s) => sum + s.cuts.reduce((x, c) => x + (Number(c.totalLength) || 0), 0),
          0
        )
      ),
    },
    shifts: shiftOut,
    crossShiftDeps,
    unassigned: unassignedOut,
  };
}

const round3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- CSV 导出 ---------------- */

function csvEscape(v) {
  const s = v == null ? '' : String(v);
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const CSV_HEADER = [
  '班次', '班内刀次', '全局刀次', '来源批次', '纸张序号', '原刀号',
  '刀向', '区域宽(mm)', '区域高(mm)', '刀位(mm)', '刀缝(mm)',
  '切线长(mm)', '批切线总长(mm)', '叠纸张数', '状态', '原因说明',
];

/** 把工单结果转成带 BOM 的 CSV（UTF-8，Excel 可直接打开） */
function workOrderCsv(result) {
  if (!result || !Array.isArray(result.shifts)) {
    throw new Error('缺少工单结果，无法导出 CSV');
  }
  const lines = [CSV_HEADER.map(csvEscape).join(',')];

  const orientText = (o) => (o === 'v' ? '竖切' : o === 'h' ? '横切' : '');

  result.shifts.forEach((shift) => {
    shift.cuts.forEach((c) => {
      c.members.forEach((m) => {
        lines.push([
          shift.shiftNo,
          c.cutInShift,
          c.cutNo,
          c.batchNo,
          m.sheetIndex,
          m.cutNo,
          orientText(c.orient),
          c.region ? c.region.w : '',
          c.region ? c.region.h : '',
          c.position,
          c.kerf,
          c.cutLength,
          c.totalLength,
          c.sheetCount,
          '已分配',
          '',
        ].map(csvEscape).join(','));
      });
    });
  });

  (result.unassigned || []).forEach((u) => {
    lines.push([
      '', '', '', u.batchNo == null ? '' : u.batchNo,
      u.sheetIndex, u.cutNo,
      '', '', '', '', '', '', '', '',
      '未分配', u.detail,
    ].map(csvEscape).join(','));
  });

  return `﻿${lines.join('\r\n')}\r\n`;
}

module.exports = { workOrder, workOrderCsv, normalizeCapacity };
