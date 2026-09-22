'use strict';

const assert = require('node:assert');
const { test, before, after } = require('node:test');
const { layoutBatch } = require('../src/packer');
const { stackSchedule } = require('../src/stack');
const { workOrder, workOrderCsv } = require('../src/workorder');
const app = require('../server');

/** 生成一个真实的叠纸排程结果（含 dependsOn）作为工单输入 */
function realSchedule() {
  const r = layoutBatch({
    paperW: 400, paperH: 300, kerf: 3, maxSheets: 6,
    products: [
      { width: 120, height: 90, quantity: 24 },
      { width: 70, height: 50, quantity: 30 },
    ],
  });
  assert.ok(r.sheets.length >= 2);
  return stackSchedule({ stackLimit: 2, sheets: r.sheets });
}

/** 结果中批次 → 班次号映射 */
function shiftLookup(wo) {
  const m = new Map();
  wo.shifts.forEach((sh) => sh.batches.forEach((b) => m.set(b.batchNo, sh.shiftNo)));
  return m;
}

/* ---------------- 基本拆分与守恒 ---------------- */

test('执行工单：所有批次恰好分配一次，每班不超过每班最多刀次', () => {
  const schedule = realSchedule();
  const cap = { maxCutsPerShift: 3, maxSheetsPerBatch: 2 };
  const wo = workOrder({ schedule, capacity: cap });
  assert.strictEqual(wo.summary.batchesTotal, schedule.summary.batchesTotal);
  assert.strictEqual(wo.summary.cutsTotal, schedule.summary.cutsTotal);
  assert.ok(wo.summary.shiftsTotal >= 1);
  const seen = [];
  for (const sh of wo.shifts) {
    assert.ok(sh.batchCount <= cap.maxCutsPerShift, '每班批次数不得超过容量');
    assert.strictEqual(sh.batchCount, sh.batches.length);
    assert.strictEqual(sh.cutCount, sh.batches.reduce((s, b) => s + b.sheetCount, 0));
    for (const b of sh.batches) seen.push(b.batchNo);
  }
  // 无额外依赖时拓扑序即批次号升序，且连续切段
  assert.deepStrictEqual(seen, schedule.batches.map((b) => b.batchNo));
  assert.strictEqual(wo.summary.maxBatchesPerShift, Math.min(cap.maxCutsPerShift, schedule.summary.batchesTotal));
  assert.strictEqual(wo.summary.shiftsTotal, Math.ceil(schedule.summary.batchesTotal / cap.maxCutsPerShift));
});

test('执行工单：批次内纸张顺序与排程结果完全一致（不重排）', () => {
  const schedule = realSchedule();
  const wo = workOrder({ schedule, capacity: { maxCutsPerShift: 2, maxSheetsPerBatch: 2 } });
  const byNo = new Map(schedule.batches.map((b) => [b.batchNo, b]));
  for (const sh of wo.shifts) {
    for (const b of sh.batches) {
      assert.deepStrictEqual(b.members, byNo.get(b.batchNo).members);
      assert.strictEqual(b.sheetCount, byNo.get(b.batchNo).sheetCount);
    }
  }
});

/* ---------------- 父刀依赖与跨班次依赖 ---------------- */

test('执行工单：父刀派生依赖全部满足（依赖批次不晚于本批所在班次）', () => {
  const schedule = realSchedule();
  const wo = workOrder({ schedule, capacity: { maxCutsPerShift: 2, maxSheetsPerBatch: 2 } });
  const shiftOf = shiftLookup(wo);
  let edgeCount = 0;
  for (const b of schedule.batches) {
    for (const d of b.dependsOn) {
      edgeCount += 1;
      assert.ok(shiftOf.get(d) <= shiftOf.get(b.batchNo), '依赖批次必须在本批同班次或更早班次');
    }
  }
  assert.ok(edgeCount > 0, '夹具需要至少一条父刀依赖');
  assert.strictEqual(wo.dependencies.length, edgeCount);
});

test('执行工单：跨班次依赖标注准确且与汇总一致', () => {
  const schedule = realSchedule();
  const wo = workOrder({ schedule, capacity: { maxCutsPerShift: 2, maxSheetsPerBatch: 2 } });
  const shiftOf = shiftLookup(wo);
  let cross = 0;
  for (const e of wo.dependencies) {
    assert.strictEqual(e.batchShift, shiftOf.get(e.batch));
    assert.strictEqual(e.dependsOnShift, shiftOf.get(e.dependsOn));
    assert.strictEqual(e.crossShift, e.dependsOnShift < e.batchShift);
    if (e.crossShift) cross += 1;
  }
  assert.ok(cross > 0, '小班容量下应存在跨班次依赖');
  assert.strictEqual(wo.summary.crossShiftDependencies, cross);
  // 每个批次的 crossShiftDependsOn 与依赖边一致
  for (const sh of wo.shifts) {
    for (const b of sh.batches) {
      const expect = b.dependsOn.filter((d) => shiftOf.get(d) < sh.shiftNo);
      assert.deepStrictEqual(b.crossShiftDependsOn, expect);
    }
  }
});

test('执行工单：操作者追加依赖会改变拓扑顺序但仍稳定确定', () => {
  const schedule = {
    batches: [1, 2, 3, 4, 5].map((n) => ({ batchNo: n, members: [{ sheetIndex: n, cutNo: 1 }] })),
    sheets: [],
  };
  const capacity = { maxCutsPerShift: 10, maxSheetsPerBatch: 5 };
  const wo = workOrder({ schedule, capacity, dependencies: [{ batch: 2, dependsOn: 5 }] });
  // 批次 2 等批次 5：拓扑序 1,3,4,5,2
  assert.deepStrictEqual(wo.shifts[0].batches.map((b) => b.batchNo), [1, 3, 4, 5, 2]);
  const again = workOrder({ schedule, capacity, dependencies: [{ batch: 2, dependsOn: 5 }] });
  assert.deepStrictEqual(JSON.stringify(again), JSON.stringify(wo));
});

/* ---------------- 未分配刀及原因 ---------------- */

test('执行工单：无刀纸张与缺失刀分别给出 no-cuts / not-scheduled 原因', () => {
  const wo = workOrder({
    capacity: { maxCutsPerShift: 5, maxSheetsPerBatch: 5 },
    schedule: {
      batches: [{ batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }, { sheetIndex: 2, cutNo: 1 }] }],
      sheets: [
        { index: 1, cutsTotal: 2, hasCuts: true }, // 第 2 刀不在任何批次
        { index: 2, cutsTotal: 1, hasCuts: true },
        { index: 3, cutsTotal: 0, hasCuts: false },
      ],
    },
  });
  assert.strictEqual(wo.summary.unassignedTotal, 2);
  const missing = wo.unassigned.find((u) => u.reason === 'not-scheduled');
  assert.ok(missing);
  assert.strictEqual(missing.sheetIndex, 1);
  assert.strictEqual(missing.cutNo, 2);
  assert.ok(/未出现/.test(missing.detail));
  const noCuts = wo.unassigned.find((u) => u.reason === 'no-cuts');
  assert.ok(noCuts);
  assert.strictEqual(noCuts.sheetIndex, 3);
  assert.strictEqual(noCuts.cutNo, null);
});

test('执行工单：完整排程结果没有未分配刀（零刀纸张除外）', () => {
  const schedule = realSchedule();
  const wo = workOrder({ schedule, capacity: { maxCutsPerShift: 4, maxSheetsPerBatch: 2 } });
  const expectNoCuts = schedule.sheets.filter((s) => !s.hasCuts).length;
  assert.strictEqual(wo.unassigned.length, expectNoCuts);
  assert.ok(wo.unassigned.every((u) => u.reason === 'no-cuts'));
});

/* ---------------- 校验：容量 / 依赖 / 输入形态 ---------------- */

test('执行工单：容量非法抛出错误', () => {
  const schedule = realSchedule();
  const bad = [0, -1, 2.5, 'x', 501, null, undefined];
  for (const v of bad) {
    assert.throws(
      () => workOrder({ schedule, capacity: { maxCutsPerShift: v, maxSheetsPerBatch: 2 } }),
      /每班最多刀次/
    );
    assert.throws(
      () => workOrder({ schedule, capacity: { maxCutsPerShift: 3, maxSheetsPerBatch: v } }),
      /每批最多纸张/
    );
  }
  assert.throws(() => workOrder({ schedule }), /班次容量/);
  assert.throws(() => workOrder({ schedule, capacity: {} }), /每班最多刀次/);
});

test('执行工单：批次叠纸张数超过每批最多纸张时抛出错误', () => {
  const schedule = realSchedule(); // stackLimit 2 → 存在 2 张纸的批次
  assert.ok(schedule.batches.some((b) => b.sheetCount === 2));
  assert.throws(
    () => workOrder({ schedule, capacity: { maxCutsPerShift: 5, maxSheetsPerBatch: 1 } }),
    /超过每批最多纸张/
  );
  // 恰好等于上限时可用
  const wo = workOrder({ schedule, capacity: { maxCutsPerShift: 5, maxSheetsPerBatch: 2 } });
  assert.ok(wo.summary.batchesTotal > 0);
});

test('执行工单：环依赖（排程自带或额外追加）抛出错误', () => {
  const cycSchedule = {
    batches: [
      { batchNo: 1, dependsOn: [2], members: [{ sheetIndex: 1, cutNo: 1 }] },
      { batchNo: 2, dependsOn: [1], members: [{ sheetIndex: 2, cutNo: 1 }] },
    ],
    sheets: [],
  };
  const capacity = { maxCutsPerShift: 5, maxSheetsPerBatch: 5 };
  assert.throws(() => workOrder({ schedule: cycSchedule, capacity }), /环/);
  // 额外依赖构成环
  const okSchedule = {
    batches: [1, 2, 3].map((n) => ({ batchNo: n, members: [{ sheetIndex: n, cutNo: 1 }] })),
    sheets: [],
  };
  assert.throws(
    () => workOrder({
      schedule: okSchedule,
      capacity,
      dependencies: [{ batch: 1, dependsOn: 3 }, { batch: 3, dependsOn: 1 }],
    }),
    /环/
  );
  // 自依赖
  assert.throws(
    () => workOrder({ schedule: okSchedule, capacity, dependencies: [{ batch: 2, dependsOn: 2 }] }),
    /自身/
  );
});

test('执行工单：依赖不存在的批次、非法输入形态抛出错误', () => {
  const capacity = { maxCutsPerShift: 5, maxSheetsPerBatch: 5 };
  const schedule = {
    batches: [{ batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] }],
    sheets: [],
  };
  assert.throws(
    () => workOrder({ schedule, capacity, dependencies: [{ batch: 1, dependsOn: 9 }] }),
    /不存在/
  );
  assert.throws(
    () => workOrder({
      schedule: { batches: [{ batchNo: 1, dependsOn: [9], members: [{ sheetIndex: 1, cutNo: 1 }] }] },
      capacity,
    }),
    /不存在/
  );
  assert.throws(() => workOrder(null), /工单输入/);
  assert.throws(() => workOrder({ capacity }), /batches/);
  assert.throws(
    () => workOrder({ schedule: { batches: [{ batchNo: 1, members: [] }] }, capacity }),
    /members/
  );
  assert.throws(
    () => workOrder({
      schedule: { batches: [{ batchNo: 1, members: [{ sheetIndex: 0, cutNo: 1 }] }] },
      capacity,
    }),
    /成员无效/
  );
  // 批次号重复
  assert.throws(
    () => workOrder({
      schedule: {
        batches: [
          { batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] },
          { batchNo: 1, members: [{ sheetIndex: 2, cutNo: 1 }] },
        ],
      },
      capacity,
    }),
    /重复/
  );
});

test('执行工单：排程结果平铺在顶层（与 schedule 包装）两种形态等价', () => {
  const schedule = realSchedule();
  const capacity = { maxCutsPerShift: 3, maxSheetsPerBatch: 2 };
  const wrapped = workOrder({ schedule, capacity });
  const flat = workOrder({ ...schedule, capacity });
  assert.deepStrictEqual(JSON.stringify(flat.shifts), JSON.stringify(wrapped.shifts));
  assert.strictEqual(flat.source, 'batch');
  assert.strictEqual(flat.stackLimit, 2);
});

test('执行工单：同一输入两次运行结果完全一致（确定性）', () => {
  const schedule = realSchedule();
  const capacity = { maxCutsPerShift: 2, maxSheetsPerBatch: 2 };
  const a = workOrder({ schedule, capacity });
  const b = workOrder({ schedule, capacity });
  assert.deepStrictEqual(JSON.stringify(a), JSON.stringify(b));
});

/* ---------------- CSV 导出 ---------------- */

test('执行工单：CSV 含 BOM、表头、逐批行与未分配刀段，跨班次依赖可读', () => {
  const schedule = realSchedule();
  const wo = workOrder({ schedule, capacity: { maxCutsPerShift: 2, maxSheetsPerBatch: 2 } });
  const csv = workOrderCsv(wo);
  assert.ok(csv.charCodeAt(0) === 0xfeff, 'CSV 应以 BOM 开头');
  const lines = csv.slice(1).split('\r\n').filter((l) => l.length > 0);
  assert.ok(lines[0].startsWith('班次,批次,刀向'));
  // 每个批次一行
  const batchRows = lines.filter((l) => /^\d+,\d+,/.test(l));
  assert.strictEqual(batchRows.length, wo.summary.batchesTotal);
  // 跨班次依赖以「批次N(班次M)」标注
  if (wo.summary.crossShiftDependencies > 0) {
    assert.ok(/批次\d+\(班次\d+\)/.test(csv));
  }
  // 含未分配刀段时给出小标题
  const wo2 = workOrder({
    capacity: { maxCutsPerShift: 5, maxSheetsPerBatch: 5 },
    schedule: {
      batches: [{ batchNo: 1, members: [{ sheetIndex: 1, cutNo: 1 }] }],
      sheets: [{ index: 2, cutsTotal: 0, hasCuts: false }],
    },
  });
  const csv2 = workOrderCsv(wo2);
  assert.ok(csv2.includes('未分配刀'));
  assert.ok(csv2.includes('无需切割'));
});

/* ---------------- HTTP 接口 ---------------- */

let server;
let base;

before(async () => {
  await new Promise((resolve) => {
    server = app.listen(0, resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => server.close());

async function postWorkOrder(body, query = '') {
  const resp = await fetch(`${base}/api/layout/stack/work-order${query}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return resp;
}

test('HTTP：合法工单返回 200 与班次清单', async () => {
  const schedule = realSchedule();
  const resp = await postWorkOrder({
    schedule,
    capacity: { maxCutsPerShift: 3, maxSheetsPerBatch: 2 },
  });
  assert.strictEqual(resp.status, 200);
  const data = await resp.json();
  assert.ok(data.summary.shiftsTotal >= 1);
  assert.ok(Array.isArray(data.shifts));
  assert.ok(Array.isArray(data.dependencies));
  assert.ok(Array.isArray(data.unassigned));
});

test('HTTP：容量非法与环依赖返回 400', async () => {
  const schedule = realSchedule();
  let resp = await postWorkOrder({
    schedule,
    capacity: { maxCutsPerShift: 0, maxSheetsPerBatch: 2 },
  });
  assert.strictEqual(resp.status, 400);
  assert.ok(/每班最多刀次/.test((await resp.json()).error));

  resp = await postWorkOrder({
    schedule,
    capacity: { maxCutsPerShift: 3, maxSheetsPerBatch: 500 },
    dependencies: [{ batch: 2, dependsOn: 3 }, { batch: 3, dependsOn: 2 }],
  });
  assert.strictEqual(resp.status, 400);
  assert.ok(/环/.test((await resp.json()).error));

  resp = await postWorkOrder({
    schedule,
    capacity: { maxCutsPerShift: 3, maxSheetsPerBatch: 1 },
  });
  assert.strictEqual(resp.status, 400);
  assert.ok(/超过每批最多纸张/.test((await resp.json()).error));
});

test('HTTP：format=csv 返回可下载 CSV，非法 format 返回 400', async () => {
  const schedule = realSchedule();
  const body = {
    schedule,
    capacity: { maxCutsPerShift: 3, maxSheetsPerBatch: 2 },
  };
  const resp = await postWorkOrder(body, '?format=csv');
  assert.strictEqual(resp.status, 200);
  assert.ok((resp.headers.get('content-type') || '').includes('text/csv'));
  assert.ok((resp.headers.get('content-disposition') || '').includes('attachment'));
  // fetch 的 text() 会按 UTF-8 规范剥掉 BOM，直接校验原始字节
  const buf = new Uint8Array(await resp.arrayBuffer());
  assert.deepStrictEqual([...buf.slice(0, 3)], [0xef, 0xbb, 0xbf]);
  const text = new TextDecoder('utf-8', { ignoreBOM: true }).decode(buf);
  assert.strictEqual(text.charCodeAt(0), 0xfeff);
  assert.ok(text.includes('班次,批次,刀向'));

  const bad = await postWorkOrder({ ...body, format: 'xml' });
  assert.strictEqual(bad.status, 400);
});
