'use strict';

/**
 * 执行工单（work order）
 *
 * 在叠纸裁切排程（/api/layout/stack 的返回）基础上，按操作者指定的班次容量
 * 把刀次批次拆分成可下达的班次清单：
 *
 *  - 容量：每班最多刀次（maxCutsPerShift，一个批次即一次落刀）与
 *    每批最多纸张（maxSheetsPerBatch，不得小于排程中任何批次的叠纸张数）；
 *  - 依赖：批次级先后约束来自排程结果每批的 `dependsOn`（父刀所在批次），
 *    操作者还可用 `dependencies: [{ batch, dependsOn }]` 追加约束
 *    （如换刀、换纸、机台约束）；任何环依赖都会以错误抛出（接口返回 400）；
 *  - 拆分：对批次做**稳定拓扑排序**（就绪集中永远先取批次号最小者），
 *    再按拓扑序连续切段，每段不超过每班最多刀次，即为一个班次；
 *    批次内纸张（members）顺序原样保留，绝不重排；
 *  - 输出：逐班次的刀次清单、跨班次依赖（依赖批次位于前序班次）、
 *    未分配刀及原因（无刀纸张 no-cuts / 排程结果中缺失的刀 not-scheduled），
 *    并可由 workOrderCsv() 导出 CSV 文本。
 *
 * 拆分是纯确定性的：同一输入必然得到同一工单。
 */

const CAPACITY_MAX = 500; // 与叠纸上限 / 用纸上限保持同一量级

const REASON_TEXT = {
  'no-cuts': '该纸没有刀次（成品恰好铺满或无需分割），无需分配班次',
  'not-scheduled': '该刀未出现在排程结果的任何批次中，无法分配班次',
};

const REASON_LABEL = {
  'no-cuts': '无需切割',
  'not-scheduled': '未在批次中',
};

/** 规范化班次容量：每班最多刀次、每批最多纸张，均为 1～500 的正整数 */
function normalizeCapacity(value) {
  if (!value || typeof value !== 'object') {
    throw new Error('缺少班次容量（capacity）：需要每班最多刀次与每批最多纸张');
  }
  const maxCutsPerShift = Number(value.maxCutsPerShift);
  if (!Number.isInteger(maxCutsPerShift) || maxCutsPerShift < 1) {
    throw new Error('每班最多刀次必须是正整数');
  }
  if (maxCutsPerShift > CAPACITY_MAX) {
    throw new Error(`每班最多刀次不能超过 ${CAPACITY_MAX}`);
  }
  const maxSheetsPerBatch = Number(value.maxSheetsPerBatch);
  if (!Number.isInteger(maxSheetsPerBatch) || maxSheetsPerBatch < 1) {
    throw new Error('每批最多纸张必须是正整数');
  }
  if (maxSheetsPerBatch > CAPACITY_MAX) {
    throw new Error(`每批最多纸张不能超过 ${CAPACITY_MAX}`);
  }
  return { maxCutsPerShift, maxSheetsPerBatch };
}

const numOrNull = (v) => (Number.isFinite(v) ? v : null);

/** 规范化排程结果中的一个批次（展示字段原样透传，成员顺序绝不重排） */
function normalizeBatch(raw, idx) {
  const pos = idx + 1;
  if (!raw || typeof raw !== 'object') {
    throw new Error(`排程结果第 ${pos} 批不是有效记录`);
  }
  let batchNo = raw.batchNo;
  if (batchNo === undefined || batchNo === null) {
    batchNo = pos; // 缺省按顺序编号
  } else if (!Number.isInteger(batchNo) || batchNo < 1) {
    throw new Error(`排程结果第 ${pos} 批的批次号必须是正整数`);
  }
  if (!Array.isArray(raw.members) || raw.members.length === 0) {
    throw new Error(`批次 ${batchNo} 缺少成员刀（members）`);
  }
  const members = raw.members.map((m, j) => {
    const sheetIndex = Number(m && m.sheetIndex);
    const cutNo = Number(m && m.cutNo);
    if (!Number.isInteger(sheetIndex) || sheetIndex < 1
      || !Number.isInteger(cutNo) || cutNo < 1) {
      throw new Error(`批次 ${batchNo} 的第 ${j + 1} 个成员无效（需要正整数 sheetIndex 与 cutNo）`);
    }
    return { sheetIndex, cutNo };
  });
  let dependsOn = [];
  if (raw.dependsOn !== undefined && raw.dependsOn !== null) {
    if (!Array.isArray(raw.dependsOn)) {
      throw new Error(`批次 ${batchNo} 的 dependsOn 必须是批次号数组`);
    }
    dependsOn = raw.dependsOn.map((d) => {
      const n = Number(d);
      if (!Number.isInteger(n) || n < 1) {
        throw new Error(`批次 ${batchNo} 的 dependsOn 含有非法批次号`);
      }
      return n;
    });
  }
  const region = raw.region && Number.isFinite(raw.region.w) && Number.isFinite(raw.region.h)
    ? { w: raw.region.w, h: raw.region.h }
    : null;
  return {
    batchNo,
    orient: raw.orient === 'v' || raw.orient === 'h' ? raw.orient : null,
    region,
    position: numOrNull(raw.position),
    kerf: numOrNull(raw.kerf),
    cutLength: numOrNull(raw.cutLength),
    totalLength: numOrNull(raw.totalLength),
    capped: raw.capped === true,
    sheetCount: members.length,
    dependsOn,
    members,
  };
}

/** 规范化操作者追加的依赖约束：[{ batch, dependsOn }] */
function normalizeExtraDeps(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) {
    throw new Error('额外依赖（dependencies）必须是数组');
  }
  return value.map((d, i) => {
    if (!d || typeof d !== 'object') {
      throw new Error(`第 ${i + 1} 条额外依赖不是有效记录`);
    }
    const batch = Number(d.batch);
    const dependsOn = Number(d.dependsOn);
    if (!Number.isInteger(batch) || batch < 1 || !Number.isInteger(dependsOn) || dependsOn < 1) {
      throw new Error(`第 ${i + 1} 条额外依赖的 batch / dependsOn 必须是正整数批次号`);
    }
    return { batch, dependsOn };
  });
}

/**
 * 执行工单主入口。
 *
 * @param {object} input
 *   - schedule：叠纸裁切排程结果（/api/layout/stack 的返回，含 batches/sheets）；
 *     也可把排程结果字段直接放在顶层（此时 capacity 与之并列）；
 *   - capacity：{ maxCutsPerShift, maxSheetsPerBatch } 班次容量；
 *   - dependencies?：操作者追加的批次级约束 [{ batch, dependsOn }]。
 */
function workOrder(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('缺少工单输入');
  }
  const schedule = input.schedule && typeof input.schedule === 'object' ? input.schedule : input;
  const capacity = normalizeCapacity(input.capacity);

  if (!Array.isArray(schedule.batches)) {
    throw new Error('排程结果缺少批次表（batches）——请先生成叠纸裁切排程');
  }

  const batches = schedule.batches.map((b, i) => normalizeBatch(b, i));

  // 批次号唯一性
  const byNo = new Map();
  for (const b of batches) {
    if (byNo.has(b.batchNo)) throw new Error(`批次号 ${b.batchNo} 重复`);
    byNo.set(b.batchNo, b);
  }

  // 合并依赖：排程自带的 dependsOn（父刀约束）+ 操作者追加约束
  const extraDeps = normalizeExtraDeps(input.dependencies);
  const depsOf = new Map(batches.map((b) => [b.batchNo, new Set(b.dependsOn)]));
  for (const { batch, dependsOn } of extraDeps) {
    if (!byNo.has(batch)) throw new Error(`额外依赖引用了不存在的批次 ${batch}`);
    if (!byNo.has(dependsOn)) throw new Error(`额外依赖引用了不存在的批次 ${dependsOn}`);
    depsOf.get(batch).add(dependsOn);
  }
  for (const b of batches) {
    for (const d of depsOf.get(b.batchNo)) {
      if (!byNo.has(d)) throw new Error(`批次 ${b.batchNo} 依赖了不存在的批次 ${d}`);
      if (d === b.batchNo) throw new Error(`批次 ${b.batchNo} 不能依赖自身`);
    }
  }

  // 容量：任何批次的叠纸张数都不得超过每批最多纸张
  for (const b of batches) {
    if (b.sheetCount > capacity.maxSheetsPerBatch) {
      throw new Error(`批次 ${b.batchNo} 含 ${b.sheetCount} 张纸，超过每批最多纸张 ${capacity.maxSheetsPerBatch}——请降低叠纸上限后重新生成排程`);
    }
  }

  /* ---------------- 稳定拓扑排序（Kahn，就绪集按批次号升序） ---------------- */

  const indeg = new Map(batches.map((b) => [b.batchNo, depsOf.get(b.batchNo).size]));
  const dependents = new Map(); // 被依赖批次 → 依赖它的批次
  for (const b of batches) {
    for (const d of depsOf.get(b.batchNo)) {
      if (!dependents.has(d)) dependents.set(d, []);
      dependents.get(d).push(b.batchNo);
    }
  }
  const ready = batches.filter((b) => indeg.get(b.batchNo) === 0).map((b) => b.batchNo);
  ready.sort((a, b) => a - b);
  const order = [];
  const inOrder = new Set();
  while (ready.length > 0) {
    const n = ready.shift();
    order.push(n);
    inOrder.add(n);
    for (const m of dependents.get(n) || []) {
      const left = indeg.get(m) - 1;
      indeg.set(m, left);
      if (left === 0) {
        let k = ready.length;
        while (k > 0 && ready[k - 1] > m) k -= 1;
        ready.splice(k, 0, m); // 保持升序，保证稳定决胜
      }
    }
  }
  if (order.length !== batches.length) {
    const rest = batches.map((b) => b.batchNo).filter((n) => !inOrder.has(n)).sort((a, b) => a - b);
    throw new Error(`排程依赖存在环：批次 ${rest.join('、')} 无法确定先后顺序（请检查 dependsOn 与额外依赖）`);
  }

  /* ---------------- 按拓扑序连续切分成班次 ---------------- */

  const shiftOf = new Map();
  const shifts = [];
  for (const batchNo of order) {
    let cur = shifts[shifts.length - 1];
    if (!cur || cur.batches.length >= capacity.maxCutsPerShift) {
      cur = { shiftNo: shifts.length + 1, batches: [] };
      shifts.push(cur);
    }
    shiftOf.set(batchNo, cur.shiftNo);
    cur.batches.push(byNo.get(batchNo));
  }

  /* ---------------- 输出组装 ---------------- */

  const depEdges = []; // 全部依赖边（按拓扑序）
  const shiftsOut = shifts.map((sh) => {
    let cutCount = 0;
    const sheetSet = new Set();
    const batchesOut = sh.batches.map((b) => {
      cutCount += b.sheetCount;
      const dependsOn = [...depsOf.get(b.batchNo)].sort((x, y) => x - y);
      const crossShiftDependsOn = dependsOn.filter((d) => shiftOf.get(d) < sh.shiftNo);
      for (const m of b.members) sheetSet.add(m.sheetIndex);
      for (const d of dependsOn) {
        depEdges.push({
          batch: b.batchNo,
          dependsOn: d,
          batchShift: sh.shiftNo,
          dependsOnShift: shiftOf.get(d),
          crossShift: shiftOf.get(d) < sh.shiftNo,
        });
      }
      return {
        batchNo: b.batchNo,
        orient: b.orient,
        region: b.region,
        position: b.position,
        kerf: b.kerf,
        cutLength: b.cutLength,
        totalLength: b.totalLength,
        sheetCount: b.sheetCount,
        capped: b.capped,
        dependsOn,
        crossShiftDependsOn,
        members: b.members.map((m) => ({ ...m })), // 顺序与排程批次一致
      };
    });
    return {
      shiftNo: sh.shiftNo,
      batchCount: sh.batches.length,
      cutCount,
      sheetCount: sheetSet.size,
      batches: batchesOut,
    };
  });

  // 未分配刀：排程 sheets 中声明、却不在任何批次成员里的刀
  const assigned = new Map(); // sheetIndex → Set(cutNo)
  for (const b of batches) {
    for (const m of b.members) {
      if (!assigned.has(m.sheetIndex)) assigned.set(m.sheetIndex, new Set());
      assigned.get(m.sheetIndex).add(m.cutNo);
    }
  }
  const sheets = Array.isArray(schedule.sheets) ? schedule.sheets : [];
  const unassigned = [];
  sheets.forEach((sh, i) => {
    const sheetIndex = Number.isInteger(sh && sh.index) && sh.index >= 1 ? sh.index : i + 1;
    const cutsTotal = Number.isInteger(sh && sh.cutsTotal) && sh.cutsTotal >= 0
      ? sh.cutsTotal
      : (Array.isArray(sh && sh.batchNos) ? sh.batchNos.length : null);
    if (cutsTotal === null) return; // 无法判断该纸刀数，跳过
    if (cutsTotal === 0 || (sh && sh.hasCuts === false)) {
      unassigned.push({ sheetIndex, cutNo: null, reason: 'no-cuts', detail: REASON_TEXT['no-cuts'] });
      return;
    }
    const got = assigned.get(sheetIndex) || new Set();
    for (let cutNo = 1; cutNo <= cutsTotal; cutNo += 1) {
      if (!got.has(cutNo)) {
        unassigned.push({ sheetIndex, cutNo, reason: 'not-scheduled', detail: REASON_TEXT['not-scheduled'] });
      }
    }
  });
  unassigned.sort((a, b) =>
    (a.sheetIndex - b.sheetIndex)
    || ((a.cutNo == null ? Infinity : a.cutNo) - (b.cutNo == null ? Infinity : b.cutNo)));

  const cutsTotal = batches.reduce((s, b) => s + b.sheetCount, 0);
  const crossShiftDependencies = depEdges.filter((e) => e.crossShift).length;
  return {
    source: schedule.source === 'batch' || schedule.source === 'cost' ? schedule.source : null,
    stackLimit: Number.isInteger(schedule.stackLimit) ? schedule.stackLimit : null,
    capacity,
    summary: {
      sheetsTotal: sheets.length,
      batchesTotal: batches.length,
      cutsTotal,
      shiftsTotal: shifts.length,
      maxBatchesPerShift: shiftsOut.reduce((m, sh) => Math.max(m, sh.batchCount), 0),
      crossShiftDependencies,
      unassignedTotal: unassigned.length,
    },
    shifts: shiftsOut,
    dependencies: depEdges,
    unassigned,
  };
}

/* ---------------- CSV 导出 ---------------- */

function csvCell(v) {
  const s = v == null ? '' : String(v);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const orientText = (o) => (o === 'v' ? '竖切' : o === 'h' ? '横切' : '');

/** 把执行工单结果导出为 CSV 文本（含 BOM，Excel 可直接打开） */
function workOrderCsv(result) {
  const lines = [];
  lines.push([
    '班次', '批次', '刀向', '待切区域宽(mm)', '待切区域高(mm)', '刀位(mm)', '刀缝(mm)',
    '切线长(mm)', '叠纸张数', '所含纸张/原刀号(纸#刀)', '依赖批次', '跨班次依赖',
  ].map(csvCell).join(','));

  const shiftOf = new Map();
  for (const sh of result.shifts) {
    for (const b of sh.batches) shiftOf.set(b.batchNo, sh.shiftNo);
  }
  for (const sh of result.shifts) {
    for (const b of sh.batches) {
      const members = b.members.map((m) => `${m.sheetIndex}#${m.cutNo}`).join(';');
      const deps = b.dependsOn.join(';');
      const cross = b.crossShiftDependsOn
        .map((d) => `批次${d}(班次${shiftOf.get(d)})`)
        .join(';');
      lines.push([
        sh.shiftNo,
        b.batchNo,
        orientText(b.orient),
        b.region ? b.region.w : '',
        b.region ? b.region.h : '',
        b.position == null ? '' : b.position,
        b.kerf == null ? '' : b.kerf,
        b.cutLength == null ? '' : b.cutLength,
        b.sheetCount,
        members,
        deps,
        cross,
      ].map(csvCell).join(','));
    }
  }

  if (result.unassigned && result.unassigned.length) {
    lines.push('');
    lines.push(csvCell('未分配刀'));
    lines.push(['纸张', '原刀号', '原因', '说明'].map(csvCell).join(','));
    for (const u of result.unassigned) {
      lines.push([
        u.sheetIndex,
        u.cutNo == null ? '—' : `#${u.cutNo}`,
        REASON_LABEL[u.reason] || u.reason,
        u.detail,
      ].map(csvCell).join(','));
    }
  }

  return `\uFEFF${lines.join('\r\n')}\r\n`;
}

module.exports = { workOrder, workOrderCsv, normalizeCapacity, REASON_TEXT };
