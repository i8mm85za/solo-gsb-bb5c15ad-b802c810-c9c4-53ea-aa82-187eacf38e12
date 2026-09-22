'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch } = require('../src/packer');
const { stackSchedule } = require('../src/stack');
const { workOrder, workOrderCsv } = require('../src/workorder');

const EPS = 1e-6;

/** 构造真实排程结果（带 dependencies） */
function realSchedule(opts = {}) {
  const r = layoutBatch({
    paperW: 420, paperH: 300, kerf: 2, maxSheets: 6,
    products: [
      { width: 150, height: 120, quantity: 24 },
      { width: 80, height: 60, quantity: 30 },
    ],
  });
  assert.ok(r.sheets.length >= 2, '夹具需要多张纸');
  return stackSchedule({
    stackLimit: opts.stackLimit || 2,
    sheets: r.sheets,
  });
}

/** 一把刀（批次）的精简构造 */
function batchNode(no, members, extra = {}) {
  return {
    batchNo: no,
    orient: 'h', kerf: 0, position: 1,
    region: { w: 100, h: 100 }, cutLength: 100,
    totalLength: 100 * members.length, sheetCount: members.length,
    capped: false,
    members: members.map(([si, cn]) => ({ sheetIndex: si, cutNo: cn })),
    ...extra,
  };
}

/** 结果中定位某来源批次所在的班次与执行刀次 */
function locate(wo, batchNo) {
  for (const shift of wo.shifts) {
    for (const c of shift.cuts) {
      if (c.batchNo === batchNo) {
        return { shiftNo: shift.shiftNo, cutInShift: c.cutInShift, cutNo: c.cutNo, cut: c };
      }
    }
  }
  return null;
}

/* ---------------- 基本结构与分班 ---------------- */

test('执行工单：全部刀次分配、班容量守恒、班内刀次连续', () => {
  const sched = realSchedule();
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 5 });

  assert.strictEqual(wo.dependencySource, 'dependencies');
  assert.strictEqual(wo.maxCutsPerShift, 5);
  assert.strictEqual(wo.maxSheetsPerBatch, 2); // 缺省沿用排程 stackLimit
  assert.strictEqual(wo.summary.batchesAssigned, sched.batches.length);
  assert.strictEqual(wo.summary.batchesUnassigned, 0);
  assert.strictEqual(wo.summary.unassignedCuts, 0);

  wo.shifts.forEach((shift) => assert.ok(shift.cutsTotal <= 5));
  assert.deepStrictEqual(
    wo.summary.cutsPerShift,
    wo.shifts.map((s) => s.cuts.length)
  );
  // 全局刀次连续 1..N，班内刀次从 1 起
  let g = 0;
  wo.shifts.forEach((shift) => {
    shift.cuts.forEach((c, i) => {
      g += 1;
      assert.strictEqual(c.cutNo, g);
      assert.strictEqual(c.cutInShift, i + 1);
      assert.strictEqual(c.shiftNo, shift.shiftNo);
    });
  });
  assert.strictEqual(g, sched.batches.length);
  assert.ok(wo.shifts.length >= Math.ceil(sched.batches.length / 5));
});

test('执行工单：不拆散批次、不打乱批次内纸张顺序', () => {
  const sched = realSchedule();
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 4 });

  // 全局刀次数 = 批次数（一批一刀），每把刀的 members 与原批次逐位一致
  const totalCuts = wo.shifts.reduce((n, s) => n + s.cuts.length, 0);
  assert.strictEqual(totalCuts, sched.batches.length);
  for (const b of sched.batches) {
    const hit = locate(wo, b.batchNo);
    assert.ok(hit, `批次 ${b.batchNo} 必须出现`);
    assert.deepStrictEqual(
      hit.cut.members.map((m) => [m.sheetIndex, m.cutNo]),
      b.members.map((m) => [m.sheetIndex, m.cutNo]),
      `批次 ${b.batchNo} 成员顺序必须与排程一致`
    );
    assert.strictEqual(hit.cut.sheetCount, b.sheetCount);
  }
});

/* ---------------- 父刀依赖 / 稳定拓扑 ---------------- */

test('执行工单：任何子刀班次不早于父刀班次；跨班依赖逐条标出', () => {
  const sched = realSchedule();
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 3 });

  // 刀 → 班次/全局刀次
  const at = new Map();
  wo.shifts.forEach((shift) => shift.cuts.forEach((c) =>
    c.members.forEach((m) => at.set(`${m.sheetIndex}:${m.cutNo}`, c))));

  let expectCross = 0;
  sched.dependencies.forEach((list, si) => {
    list.forEach(([child, parent]) => {
      const cc = at.get(`${si + 1}:${child}`);
      const pc = at.get(`${si + 1}:${parent}`);
      assert.ok(cc && pc);
      assert.ok(cc.shiftNo >= pc.shiftNo, '子刀班次不早于父刀班次');
      if (cc.shiftNo > pc.shiftNo) expectCross += 1;
    });
  });
  assert.ok(expectCross > 0, '每班 3 刀时应产生跨班次依赖');
  assert.strictEqual(wo.crossShiftDeps.length, expectCross);

  // 每条跨班依赖可回溯到真实父子边，且严格 toShift > fromShift
  const crossSet = new Set(sched.dependencies.flatMap((list, si) =>
    list.filter(([c, p]) => {
      const cc = at.get(`${si + 1}:${c}`);
      const pc = at.get(`${si + 1}:${p}`);
      return cc.shiftNo > pc.shiftNo;
    }).map(([c, p]) => `${si + 1}:${c}>${p}`)));
  for (const d of wo.crossShiftDeps) {
    assert.ok(d.toShift > d.fromShift);
    assert.ok(crossSet.has(`${d.sheetIndex}:${d.cutNo}>${d.parentCutNo}`));
    const cc = at.get(`${d.sheetIndex}:${d.cutNo}`);
    const pc = at.get(`${d.sheetIndex}:${d.parentCutNo}`);
    assert.strictEqual(d.toCutNo, cc.cutNo);
    assert.strictEqual(d.fromCutNo, pc.cutNo);
  }
  // 跨班依赖按 toShift、toCutNo 排序
  const keys = wo.crossShiftDeps.map((d) => d.toShift * 1e6 + d.toCutNo);
  assert.deepStrictEqual(keys, [...keys].sort((a, b) => a - b));
});

test('执行工单：容量不产生跨班时 crossShiftDeps 为空', () => {
  const sched = realSchedule();
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10000 });
  assert.strictEqual(wo.summary.shiftsTotal, 1);
  assert.strictEqual(wo.crossShiftDeps.length, 0);
});

test('执行工单：拓扑顺序稳定（同输入两次一致，且就绪刀按来源批次先后）', () => {
  const sched = realSchedule();
  const a = workOrder({ schedule: sched, maxCutsPerShift: 4 });
  const b = workOrder({ schedule: sched, maxCutsPerShift: 4 });
  assert.deepStrictEqual(JSON.stringify(a.shifts), JSON.stringify(b.shifts));
  assert.deepStrictEqual(JSON.stringify(a.crossShiftDeps), JSON.stringify(b.crossShiftDeps));

  // 两把互不依赖的根刀：来源批次号小者先执行
  const mini = {
    stackLimit: 2,
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[2, 1]]),
    ],
    dependencies: [[], []],
  };
  const wo = workOrder({ schedule: mini, maxCutsPerShift: 1 });
  assert.strictEqual(locate(wo, 1).shiftNo, 1);
  assert.strictEqual(locate(wo, 2).shiftNo, 2);
});

/* ---------------- 每批最多纸张（未分配） ---------------- */

test('执行工单：超过每批最多纸张的整批标记 over-capacity，不参与分班', () => {
  const sched = {
    stackLimit: 3,
    dependencies: [[], [], []],
    batches: [
      batchNode(1, [[1, 1], [2, 1], [3, 1]]), // 3 张
      batchNode(2, [[1, 2]]),
    ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 2 });
  assert.strictEqual(wo.summary.batchesAssigned, 1);
  assert.strictEqual(wo.summary.batchesUnassigned, 1);
  assert.ok(!locate(wo, 1));
  assert.ok(locate(wo, 2));
  const reasons = wo.unassigned.map((u) => `${u.sheetIndex}:${u.cutNo}:${u.reason}`);
  for (const si of [1, 2, 3]) {
    assert.ok(reasons.includes(`${si}:1:over-capacity`));
  }
  assert.ok(wo.unassigned.every((u) => u.batchNo === 1));
  assert.ok(/超过每批最多/.test(wo.unassigned[0].detail));
});

test('执行工单：缺省每批容量沿用排程 stackLimit（正常排程无超容量项）', () => {
  const sched = realSchedule({ stackLimit: 3 });
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 100 });
  assert.strictEqual(wo.maxSheetsPerBatch, 3);
  assert.strictEqual(wo.unassigned.length, 0);
});

/* ---------------- 父刀缺失与阻断传播 ---------------- */

test('执行工单：父刀不在批次内 → missing-parent，并沿依赖向下阻断', () => {
  // 纸1：刀 2（父 1，父刀在批次中）、刀 3（父 9，父刀缺失）、刀 4（父 3，应被阻断）
  const sched = {
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[1, 2]]),
      batchNode(3, [[1, 3]]),
      batchNode(4, [[1, 4]]),
    ],
    dependencies: [ [[2, 1], [3, 9], [4, 3]] ],
  };
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10 });
  const byCut = new Map(wo.unassigned.map((u) => [u.cutNo, u]));
  assert.strictEqual(byCut.get(3).reason, 'missing-parent');
  assert.ok(/第 1 张纸第 9 号刀/.test(byCut.get(3).detail));
  assert.strictEqual(byCut.get(4).reason, 'blocked');
  assert.ok(/父刀/.test(byCut.get(4).detail));
  // 批次 3、4 不参与分班（批次内唯一刀未分配）
  assert.ok(locate(wo, 1));
  assert.ok(locate(wo, 2));
  assert.ok(!locate(wo, 3));
  assert.ok(!locate(wo, 4));
  assert.strictEqual(wo.summary.batchesAssigned, 2);
});

/* ---------------- 环依赖 ---------------- */

test('执行工单：父刀依赖成环（含自环）时抛出错误', () => {
  const mk = (no) => batchNode(no, [[1, no]]);
  const cyc = {
    batches: [mk(1), mk(2), mk(3)],
    // 1 父 2（2→1），2 父 3（3→2），3 父 1（1→3）：3→1→2→3
    dependencies: [ [[1, 2], [2, 3], [3, 1]] ],
  };
  assert.throws(() => workOrder({ schedule: cyc, maxCutsPerShift: 10 }), /环/);

  const self = { batches: [mk(1)], dependencies: [ [[1, 1]] ] };
  assert.throws(() => workOrder({ schedule: self, maxCutsPerShift: 10 }), /自环|环/);
});

/* ---------------- 直接传 sheets（服务端先排程）与推断依赖 ---------------- */

test('执行工单：未带 schedule 时以 sheets+stackLimit 先运行排程', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 3, maxSheets: 4,
    products: [{ width: 100, height: 80, quantity: 24 }],
  });
  const wo = workOrder({ sheets: r.sheets, stackLimit: 3, maxCutsPerShift: 4 });
  const sched = stackSchedule({ stackLimit: 3, sheets: r.sheets });
  assert.strictEqual(wo.summary.batchesAssigned, sched.batches.length);
  assert.strictEqual(wo.dependencySource, 'dependencies');
  assert.strictEqual(wo.source, 'batch');
});

test('执行工单：精简 schedule（无 dependencies）按批次先后推断同纸链并标注 inferred', () => {
  const sched = realSchedule();
  delete sched.dependencies;
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 3 });
  assert.strictEqual(wo.dependencySource, 'inferred');
  // 推断链同样保证每张纸内父（早批）先于子（晚批）
  const at = new Map();
  wo.shifts.forEach((shift) => shift.cuts.forEach((c) =>
    c.members.forEach((m) => at.set(`${m.sheetIndex}:${m.cutNo}`, c))));
  sched.batches.forEach((b) => b.members.forEach((m) => assert.ok(at.get(`${m.sheetIndex}:${m.cutNo}`))));
  // 同一张纸：按来源批次，晚批的班次不早于早批
  const bySheet = new Map();
  sched.batches.forEach((b) => b.members.forEach((m) => {
    if (!bySheet.has(m.sheetIndex)) bySheet.set(m.sheetIndex, []);
    bySheet.get(m.sheetIndex).push({ batchNo: b.batchNo, cut: at.get(`${m.sheetIndex}:${m.cutNo}`) });
  }));
  for (const list of bySheet.values()) {
    list.sort((a, b) => a.batchNo - b.batchNo);
    for (let i = 1; i < list.length; i += 1) {
      assert.ok(list[i].cut.shiftNo >= list[i - 1].cut.shiftNo);
    }
  }
});

/* ---------------- CSV 导出 ---------------- */

test('执行工单：CSV 含表头、已分配逐纸行与未分配行，正确转义并带 BOM', () => {
  const sched = {
    stackLimit: 2,
    dependencies: [[[2, 1]], []],
    batches: [
      batchNode(1, [[1, 1]]),
      batchNode(2, [[1, 2], [2, 1]]),
    ],
  };
  // 每批限 1 张 → 批次 2 超容量未分配
  const wo = workOrder({ schedule: sched, maxCutsPerShift: 10, maxSheetsPerBatch: 1 });
  const csv = workOrderCsv(wo);
  assert.ok(csv.startsWith('﻿'), 'CSV 以 UTF-8 BOM 开头');
  const lines = csv.trim().split('\r\n');
  assert.strictEqual(lines[0].split(',').length, 16);
  assert.ok(lines[0].includes('班次'));
  // 批次 1 一把、成员 1 行
  const assignedRows = lines.slice(1).filter((l) => l.includes('已分配'));
  assert.strictEqual(assignedRows.length, 1);
  const cols = assignedRows[0].split(',');
  assert.strictEqual(cols[14], '已分配');
  // 批次 2 两把成员各一行未分配
  const unassignedRows = lines.slice(1).filter((l) => l.includes('未分配'));
  assert.strictEqual(unassignedRows.length, 2);
  unassignedRows.forEach((row) => {
    assert.ok(row.includes('超每批') || row.includes('超过每批'));
  });

  // 含逗号/引号/换行的字段被引号包裹
  const quoted = workOrderCsv({
    maxCutsPerShift: 1, maxSheetsPerBatch: 1, dependencySource: 'dependencies',
    source: 'batch', stackLimit: 1,
    summary: { sheetsTotal: 1, batchesTotal: 1, batchesAssigned: 1, batchesUnassigned: 0,
      cutsPerShift: [1], shiftsTotal: 1, crossShiftDeps: 0, unassignedCuts: 0, totalLength: 0 },
    shifts: [{
      shiftNo: 1, cutsTotal: 1,
      cuts: [{
        shiftNo: 1, cutInShift: 1, cutNo: 1, batchNo: 1,
        orient: 'h', kerf: 0, position: 0, region: { w: 1, h: 1 },
        cutLength: 1, totalLength: 1, sheetCount: 1, capped: false,
        members: [{ sheetIndex: 1, cutNo: 1 }],
      }],
    }],
    crossShiftDeps: [],
    unassigned: [{ sheetIndex: 2, cutNo: 3, reason: 'blocked', detail: '含,逗号与"引号', batchNo: 2 }],
  });
  assert.ok(quoted.includes('"含,逗号与""引号"'));
});

/* ---------------- 校验 ---------------- */

test('执行工单：非法容量与非法排程抛出错误', () => {
  const sched = realSchedule();

  assert.throws(() => workOrder({}), /排程结果/);
  assert.throws(() => workOrder(null), /工单输入/);
  assert.throws(() => workOrder({ schedule: sched }), /每班最多刀次/);
  for (const v of [0, -3, 1.5, 'x', NaN, 10001]) {
    assert.throws(() => workOrder({ schedule: sched, maxCutsPerShift: v }), /每班最多刀次/);
  }
  for (const v of [0, -1, 2.2, 501]) {
    assert.throws(() => workOrder({ schedule: sched, maxCutsPerShift: 5, maxSheetsPerBatch: v }), /每批最多纸张/);
  }
  assert.throws(() => workOrder({ schedule: {}, maxCutsPerShift: 5 }), /刀次批次/);
  assert.throws(() => workOrder({ schedule: { batches: [] }, maxCutsPerShift: 5 }), /刀次批次/);
  assert.throws(
    () => workOrder({ schedule: { batches: [{ batchNo: 1, members: [] }] }, maxCutsPerShift: 5 }),
    /成员/
  );
  assert.throws(
    () => workOrder({
      schedule: { batches: [batchNode(1, [[1, 1]]), batchNode(1, [[2, 1]])] },
      maxCutsPerShift: 5,
    }),
    /批次号重复/
  );
  assert.throws(
    () => workOrder({
      schedule: { batches: [batchNode(1, [[1, 1]]), batchNode(2, [[1, 1]])] },
      maxCutsPerShift: 5,
    }),
    /多个批次/
  );
  assert.throws(
    () => workOrder({ schedule: { batches: [batchNode(1, [[1, 1]])], dependencies: 'x' }, maxCutsPerShift: 5 }),
    /dependencies/
  );
  assert.throws(
    () => workOrder({ schedule: { batches: [batchNode(1, [[1, 1]])], dependencies: [[[2, 1]]] }, maxCutsPerShift: 5 }),
    /不在任何排程批次/
  );
});

test('执行工单：同构输入两次运行结果完全一致（确定性）', () => {
  const sched = realSchedule();
  const a = workOrder({ schedule: sched, maxCutsPerShift: 3, maxSheetsPerBatch: 2 });
  const b = workOrder({ schedule: sched, maxCutsPerShift: 3, maxSheetsPerBatch: 2 });
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
});
