'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');
const { stackSchedule } = require('../src/stack');

const EPS = 1e-6;

/** 构造 N 张完全一致的批量结果（同纸型同需求 → 切割树相同） */
function identicalSheets(n, paper = { paperW: 300, paperH: 200, kerf: 3 }, products) {
  const prods = products || [{ width: 100, height: 80, quantity: 6 }];
  const one = layout({ ...paper, products: prods });
  assert.ok(one.cuts.length > 0, '夹具需要非零切割树');
  return Array.from({ length: n }, () => JSON.parse(JSON.stringify(one)));
}

/** 按前序 depth 重建父刀号（与 src/stack.js 同规则），返回 n → parentN 映射 */
function parentByCutNo(sheet) {
  const map = new Map();
  const nearest = new Map();
  sheet.cuts.forEach((c, i) => {
    if (c.depth > 0 && nearest.has(c.depth - 1)) map.set(c.n, nearest.get(c.depth - 1));
    nearest.set(c.depth, c.n);
    void i;
  });
  return map;
}

/** 由排程结果构造 (sheetIndex, cutNo) → batchNo 映射 */
function batchLookup(sched) {
  const m = new Map();
  sched.batches.forEach((b) => b.members.forEach((mem) => m.set(`${mem.sheetIndex}:${mem.cutNo}`, b.batchNo)));
  return m;
}

/* ---------------- 基本结构与守恒 ---------------- */

test('叠纸排程：同刀合并，批次内区域宽高/刀向/刀位/刀缝完全一致', () => {
  const sheets = identicalSheets(4);
  const sched = stackSchedule({ stackLimit: 4, sheets });
  assert.strictEqual(sched.source, 'batch');
  assert.strictEqual(sched.stackLimit, 4);
  // 4 张完全一致：每一种刀都合成一批
  const cutsPerSheet = sheets[0].cuts.length;
  assert.strictEqual(sched.summary.batchesTotal, cutsPerSheet);
  assert.strictEqual(sched.summary.cutsTotal, cutsPerSheet * 4);
  for (const b of sched.batches) {
    assert.strictEqual(b.sheetCount, 4);
    assert.strictEqual(b.members.length, 4);
    assert.strictEqual(b.capped, false);
    // 批内每张纸的原刀都具有相同几何签名
    for (const mem of b.members) {
      const cut = sheets[mem.sheetIndex - 1].cuts.find((c) => c.n === mem.cutNo);
      assert.strictEqual(cut.orient, b.orient);
      assert.ok(Math.abs(cut.region.w - b.region.w) < EPS);
      assert.ok(Math.abs(cut.region.h - b.region.h) < EPS);
      assert.ok(Math.abs(cut.length - b.cutLength) < EPS);
      assert.ok(Math.abs(sheets[mem.sheetIndex - 1].paper.kerf - b.kerf) < EPS);
    }
    // 每张纸每批至多一刀
    assert.strictEqual(new Set(b.members.map((m) => m.sheetIndex)).size, b.members.length);
  }
});

test('叠纸排程：所有刀恰好排入一次（守恒），且每张纸批次号为 1..k 的排列', () => {
  const r = layoutBatch({
    paperW: 400, paperH: 300, kerf: 3, maxSheets: 8,
    products: [
      { width: 120, height: 90, quantity: 30 },
      { width: 60, height: 50, quantity: 40 },
    ],
  });
  const sched = stackSchedule({ stackLimit: 3, sheets: r.sheets });
  const lookup = batchLookup(sched);
  let total = 0;
  r.sheets.forEach((sh, i) => {
    const nos = sh.cuts.map((c) => lookup.get(`${i + 1}:${c.n}`));
    assert.ok(nos.every((n) => Number.isInteger(n)), '每刀都必须排入某批');
    assert.strictEqual(new Set(nos).size, nos.length, '同一张纸的不同刀不会同批');
    total += nos.length;
  });
  assert.strictEqual(total, sched.summary.cutsTotal);
  assert.strictEqual(sched.batches.reduce((s, b) => s + b.sheetCount, 0), total);
});

/* ---------------- 父刀约束 ---------------- */

test('叠纸排程：任何子刀所在批次不早于其父刀批次', () => {
  const r = layoutBatch({
    paperW: 420, paperH: 300, kerf: 2, maxSheets: 6,
    products: [
      { width: 150, height: 120, quantity: 20 },
      { width: 80, height: 60, quantity: 24 },
    ],
  });
  assert.ok(r.sheets.length >= 2);
  const sched = stackSchedule({ stackLimit: 2, sheets: r.sheets });
  const lookup = batchLookup(sched);
  r.sheets.forEach((sh, i) => {
    const parents = parentByCutNo(sh);
    for (const c of sh.cuts) {
      if (!parents.has(c.n)) continue;
      const childBatch = lookup.get(`${i + 1}:${c.n}`);
      const parentBatch = lookup.get(`${i + 1}:${parents.get(c.n)}`);
      assert.ok(childBatch >= parentBatch, '子刀必须在父刀同批或之后');
      assert.notStrictEqual(childBatch, parentBatch, '同张纸的父子刀不能同批');
    }
  });
});

/* ---------------- 叠纸上限 ---------------- */

test('叠纸排程：同批不超过叠纸上限，超出的同刀纸张进入后续批次', () => {
  const sheets = identicalSheets(5);
  const sched = stackSchedule({ stackLimit: 2, sheets });
  for (const b of sched.batches) assert.ok(b.sheetCount <= 2);
  // 每种原刀在 5 张纸上 → 至少 ceil(5/2)=3 批；前两批满 2，最后一批 1
  const firstCut = sheets[0].cuts[0];
  const rootBatches = sched.batches.filter((b) =>
    b.orient === firstCut.orient && Math.abs(b.region.w - firstCut.region.w) < EPS
    && Math.abs(b.region.h - firstCut.region.h) < EPS);
  const counts = rootBatches.map((b) => b.sheetCount).sort((a, b) => b - a);
  assert.deepStrictEqual(counts, [2, 2, 1]);
  assert.ok(rootBatches.some((b) => b.capped));
  // 受上限推迟的刀有 stack-limit 诊断
  assert.ok(sched.unmerged.some((u) => u.reason === 'stack-limit'));
});

test('叠纸排程：上限为 1 时全部为单张独刀批次', () => {
  const sheets = identicalSheets(3);
  const sched = stackSchedule({ stackLimit: 1, sheets });
  assert.strictEqual(sched.summary.mergedBatches, 0);
  assert.strictEqual(sched.summary.soloBatches, sched.summary.batchesTotal);
  assert.ok(sched.batches.every((b) => b.sheetCount === 1));
  // 每张纸内部仍满足父刀先于子刀（前序刀序的批不乱序）
  const lookup = batchLookup(sched);
  sheets.forEach((sh, i) => {
    const parents = parentByCutNo(sh);
    for (const c of sh.cuts) {
      if (!parents.has(c.n)) continue;
      assert.ok(lookup.get(`${i + 1}:${c.n}`) > lookup.get(`${i + 1}:${parents.get(c.n)}`));
    }
  });
});

/* ---------------- 合批条件 ---------------- */

test('叠纸排程：仅宽高/刀向/刀位/刀缝一致才合并——任一差异即不合并', () => {
  // 同纸型、同刀缝、同刀向与刀位但区域宽不同的两棵树
  const a = layout({ paperW: 300, paperH: 200, kerf: 3, products: [{ width: 100, height: 80, quantity: 6 }] });
  const b = layout({ paperW: 300, paperH: 200, kerf: 3, products: [{ width: 120, height: 80, quantity: 6 }] });
  const sched = stackSchedule({ stackLimit: 5, sheets: [a, b] });
  // 根刀：刀向相同、区域同为整纸、刀位不同（101.5 vs 81.5）→ 不应合并
  const roots = sched.batches.filter((bb) => bb.members.length === 1 && bb.region.h === 200 && bb.region.w === 300);
  assert.strictEqual(roots.length, 2, '刀位不同的根刀必须各自成批');

  // 刀缝不同：整纸同宽高但 kerf 不一致 → 不合并
  const k1 = layout({ paperW: 300, paperH: 200, kerf: 3, products: [{ width: 100, height: 80, quantity: 6 }] });
  const k2 = layout({ paperW: 300, paperH: 200, kerf: 5, products: [{ width: 100, height: 80, quantity: 6 }] });
  const sk = stackSchedule({ stackLimit: 5, sheets: [k1, k2] });
  assert.ok(sk.batches.every((bb) => bb.sheetCount === 1), '刀缝不同不能合并');

  // 区域宽高不同：不同纸型的整纸根刀 → 不合并
  const p1 = layout({ paperW: 300, paperH: 200, kerf: 3, products: [{ width: 100, height: 80, quantity: 6 }] });
  const p2 = layout({ paperW: 320, paperH: 210, kerf: 3, products: [{ width: 100, height: 80, quantity: 6 }] });
  const sp = stackSchedule({ stackLimit: 5, sheets: [p1, p2] });
  assert.ok(sp.batches.every((bb) => bb.sheetCount === 1), '区域宽高不同不能合并');
});

/* ---------------- 决胜规则 ---------------- */

test('叠纸排程：每轮优先可合并张数最多者；同张数同长度时按纸张序号稳定决胜', () => {
  // 3 张 A 树相同（300×200 纸）+ 2 张 B 树相同（350×260 纸）：
  // 根刀区域宽高不同（刀位也不同）→ 两组互不合并；
  // 首轮根刀候选中 A 组可合并 3 张，应先于 B 组（2 张）。
  const treeA = layout({ paperW: 300, paperH: 200, kerf: 0, products: [{ width: 100, height: 80, quantity: 6 }] });
  const treeB = layout({ paperW: 350, paperH: 260, kerf: 0, products: [{ width: 100, height: 80, quantity: 6 }] });
  const sheets = [
    JSON.parse(JSON.stringify(treeA)),
    JSON.parse(JSON.stringify(treeB)),
    JSON.parse(JSON.stringify(treeA)),
    JSON.parse(JSON.stringify(treeB)),
    JSON.parse(JSON.stringify(treeA)),
  ];
  const sched = stackSchedule({ stackLimit: 5, sheets });
  const first = sched.batches[0];
  assert.strictEqual(first.sheetCount, 3, '可合并张数最多者先排');
  assert.strictEqual(first.region.w, 300);
  assert.deepStrictEqual(first.members.map((m) => m.sheetIndex), [1, 3, 5]);
  // B 组根刀（350×260 整纸区域）成批时恰为纸张 2、4
  const bRoot = sched.batches.find((b) => b.region.w === 350 && b.region.h === 260);
  assert.strictEqual(bRoot.sheetCount, 2);
  assert.deepStrictEqual(bRoot.members.map((m) => m.sheetIndex), [2, 4]);

  // 平局按纸张序号：两组都是单根刀、各 2 张、同长（300）、总长度相同（各 600），
  // 仅刀向/区域不同而互不合并 → 纸张 1 所在组先排
  const treeC = layout({ paperW: 300, paperH: 260, kerf: 0, products: [{ width: 300, height: 100, quantity: 1 }] });
  const treeD = layout({ paperW: 260, paperH: 300, kerf: 0, products: [{ width: 100, height: 300, quantity: 1 }] });
  const sheets2 = [treeC, treeD, treeC, treeD].map((x) => JSON.parse(JSON.stringify(x)));
  const sched2 = stackSchedule({ stackLimit: 5, sheets: sheets2 });
  assert.strictEqual(sched2.batches[0].region.w, 300);
  assert.deepStrictEqual(sched2.batches[0].members.map((m) => m.sheetIndex), [1, 3]);
});

test('叠纸排程：可合并张数相同时总切线长度长者优先', () => {
  // 两种纸型各 2 张，每棵树都只有一根刀且均为横切（切线长＝纸宽）：
  //  A 纸 400×300、件 400×120（整宽横条）→ 横切，长 400；
  //  B 纸 260×210、件 260×90（整宽横条） → 横切，长 260。
  // 区域宽高不同不会互相合并；各 2 张时 A 批总长度 800 > B 批 520，A 先排。
  const mk = (pw, ph, w, h) => layout({ paperW: pw, paperH: ph, kerf: 0, products: [{ width: w, height: h, quantity: 1 }] });
  const A = mk(400, 300, 400, 120);
  const B = mk(260, 210, 260, 90);
  assert.deepStrictEqual(A.cuts.map((c) => c.orient), ['h']);
  assert.deepStrictEqual(B.cuts.map((c) => c.orient), ['h']);
  const sheets = [A, B, A, B].map((x) => JSON.parse(JSON.stringify(x)));
  const sched = stackSchedule({ stackLimit: 4, sheets });
  assert.strictEqual(sched.batches[0].cutLength, 400, '总切线长者先排');
  assert.strictEqual(sched.batches[0].totalLength, 800);
  assert.strictEqual(sched.batches[1].cutLength, 260);
});

/* ---------------- 成本排产结果复用 ---------------- */

test('叠纸排程：自动识别成本结果（sheets[i].layout），保留轮次/纸型/订单信息', () => {
  const r = layoutCostBatch({
    kerf: 3,
    papers: [
      { name: '大纸', width: 300, height: 200, price: 2, stock: 4 },
      { name: '小纸', width: 200, height: 150, price: 1, stock: 4 },
    ],
    products: [{ width: 100, height: 80, quantity: 18 }],
  });
  assert.ok(r.sheets.length >= 2);
  const sched = stackSchedule({ stackLimit: 4, sheets: r.sheets });
  assert.strictEqual(sched.source, 'cost');
  assert.strictEqual(sched.sheets.length, r.sheets.length);
  sched.sheets.forEach((sh, i) => {
    assert.strictEqual(sh.round, r.sheets[i].round);
    assert.strictEqual(sh.paperName, r.sheets[i].paperName);
    assert.strictEqual(sh.paperId, r.sheets[i].paperId);
    assert.strictEqual(sh.paperWidth, r.sheets[i].paperWidth);
  });
});

test('叠纸排程：隔离成本结果的 orderNo 透传到每张纸', () => {
  const r = layoutCostBatch({
    kerf: 0, isolateOrders: true,
    papers: [
      { name: 'A', width: 250, height: 250, price: 1, stock: 3 },
      { name: 'B', width: 200, height: 200, price: 2, stock: 3 },
    ],
    products: [
      { name: '甲', width: 100, height: 100, quantity: 4, orderNo: 'OA' },
      { name: '乙', width: 60, height: 60, quantity: 8, orderNo: 'OB' },
    ],
  });
  const sched = stackSchedule({ stackLimit: 3, sheets: r.sheets });
  const costOrderByRound = new Map(r.sheets.map((sh) => [sh.round, sh.orderNo]));
  sched.sheets.forEach((sh) => assert.strictEqual(sh.orderNo, costOrderByRound.get(sh.round)));
});

/* ---------------- 每张纸进度与未排原因 ---------------- */

test('叠纸排程：每张纸进度给出总刀数/已排/批次序列；零刀纸张给出 no-cuts 原因', () => {
  const withCuts = layout({ paperW: 300, paperH: 200, kerf: 3, products: [{ width: 100, height: 80, quantity: 6 }] });
  const noCuts = layout({ paperW: 100, paperH: 100, kerf: 0, products: [{ width: 100, height: 100, quantity: 1 }] });
  const sched = stackSchedule({ stackLimit: 3, sheets: [withCuts, noCuts] });
  const [s1, s2] = sched.sheets;
  assert.strictEqual(s1.cutsTotal, withCuts.cuts.length);
  assert.strictEqual(s1.cutsScheduled, withCuts.cuts.length);
  assert.strictEqual(s1.batchNos.length, withCuts.cuts.length);
  assert.strictEqual(s2.cutsTotal, 0);
  assert.strictEqual(s2.cutsScheduled, 0);
  assert.strictEqual(s2.hasCuts, false);
  const noCutNotes = sched.unmerged.filter((u) => u.reason === 'no-cuts');
  assert.strictEqual(noCutNotes.length, 1);
  assert.strictEqual(noCutNotes[0].sheetIndex, 2);
  assert.ok(/没有刀次/.test(noCutNotes[0].detail));
});

test('叠纸排程：单张独刀批次进入 unmerged（solo），等待父刀有 waiting-parent 诊断', () => {
  const sheets = identicalSheets(4, { paperW: 300, paperH: 200, kerf: 3 });
  const sched = stackSchedule({ stackLimit: 3, sheets });
  // 第 4 张每个刀批都曾受上限推迟；最终多为单张独刀
  const solo = sched.unmerged.filter((u) => u.reason === 'solo');
  assert.ok(solo.length > 0);
  assert.ok(solo.every((u) => u.sheetIndex === 4));
  // 第 4 张的非根刀在前三张先行成批时尚未就绪（父刀未完成）
  const waiting = sched.unmerged.filter((u) => u.reason === 'waiting-parent');
  assert.ok(waiting.some((u) => u.cutNo >= 2 && u.sheetIndex === 4));
  // 每个诊断都指向已存在的批次
  for (const u of sched.unmerged) {
    if (u.batchNo != null) assert.ok(u.batchNo >= 1 && u.batchNo <= sched.batches.length);
  }
});

/* ---------------- 精简输入与确定性 ---------------- */

test('叠纸排程：接受精简 sheets 输入（paper + cuts），结果与完整输入一致', () => {
  const full = layoutBatch({
    paperW: 300, paperH: 200, kerf: 3, maxSheets: 4,
    products: [{ width: 100, height: 80, quantity: 20 }],
  });
  const compact = full.sheets.map((sh) => ({
    paper: sh.paper,
    cuts: sh.cuts.map((c) => ({
      n: c.n, depth: c.depth, orient: c.orient, region: c.region, band: c.band,
    })),
  }));
  const s1 = stackSchedule({ stackLimit: 2, sheets: full.sheets });
  const s2 = stackSchedule({ stackLimit: 2, sheets: compact });
  assert.deepStrictEqual(
    s1.batches.map((b) => [b.batchNo, b.sheetCount, b.members]),
    s2.batches.map((b) => [b.batchNo, b.sheetCount, b.members])
  );
});

test('叠纸排程：同一输入两次运行结果完全一致（确定性）', () => {
  const r = layoutBatch({
    paperW: 400, paperH: 300, kerf: 3, maxSheets: 6,
    products: [
      { width: 120, height: 90, quantity: 24 },
      { width: 70, height: 50, quantity: 30 },
    ],
  });
  const a = stackSchedule({ stackLimit: 2, sheets: r.sheets });
  const b = stackSchedule({ stackLimit: 2, sheets: r.sheets });
  assert.deepStrictEqual(JSON.stringify(a.batches), JSON.stringify(b.batches));
  assert.deepStrictEqual(JSON.stringify(a.sheets), JSON.stringify(b.sheets));
});

/* ---------------- 校验 ---------------- */

test('叠纸排程：非法输入抛出错误', () => {
  const sheets = identicalSheets(2);
  assert.throws(() => stackSchedule({}), /sheets/);
  assert.throws(() => stackSchedule({ stackLimit: 2, sheets: [] }), /没有任何纸张/);
  assert.throws(() => stackSchedule({ stackLimit: 0, sheets }), /叠纸上限/);
  assert.throws(() => stackSchedule({ stackLimit: -1, sheets }), /叠纸上限/);
  assert.throws(() => stackSchedule({ stackLimit: 2.5, sheets }), /叠纸上限/);
  assert.throws(() => stackSchedule({ stackLimit: 'x', sheets }), /叠纸上限/);
  assert.throws(() => stackSchedule({ stackLimit: 501, sheets }), /叠纸上限/);
  assert.throws(() => stackSchedule(null), /排程输入/);
  assert.throws(() => stackSchedule({ stackLimit: 2, sheets: [{}] }), /纸面宽高/);
  assert.throws(
    () => stackSchedule({
      stackLimit: 2,
      sheets: [{ paper: { width: 100, height: 100, kerf: 0 }, cuts: [{ orient: 'x' }] }],
    }),
    /刀向/
  );
  assert.throws(
    () => stackSchedule({
      stackLimit: 2,
      sheets: [{ paper: { width: 100, height: 100, kerf: -1 }, cuts: [] }],
    }),
    /刀缝/
  );
});
