'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutBatch, planKitSheet } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');

const EPS = 1e-6;

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS ||
    a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS
  );
}

/** 校验一张成套布局：每件在纸面内、互不重叠，且每品种件数恰为 sets×perSet */
function assertKitSheet(layout, paperW, paperH, kitProducts, sets) {
  for (const it of layout.items) {
    assert.ok(it.x + it.w <= paperW + EPS && it.y + it.h <= paperH + EPS);
  }
  const items = layout.items;
  for (let i = 0; i < items.length; i++) {
    for (let j = i + 1; j < items.length; j++) {
      assert.ok(!rectsOverlap(items[i], items[j]), '同张成品不应重叠');
    }
  }
  const countsByName = new Map();
  for (const it of items) countsByName.set(it.name, (countsByName.get(it.name) || 0) + 1);
  for (const p of kitProducts) {
    assert.strictEqual(
      countsByName.get(p.name) || 0,
      sets * p.perSet,
      `品种 ${p.name} 件数必须恰为 sets×perSet（完整套、无富余半套）`
    );
  }
}

/* ---------------- 批量成套 ---------------- */

test('成套批量：每张只提交完整套（无富余件），完成全部计划套数', () => {
  const kitProducts = [
    { name: 'A', width: 100, height: 100, perSet: 1 },
    { name: 'B', width: 50, height: 50, perSet: 2 },
  ];
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 20,
    kit: { plannedSets: 5 },
    products: kitProducts,
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.kit.plannedSets, 5);
  assert.strictEqual(r.kit.setsCompleted, 5);
  assert.strictEqual(r.kit.setsRemaining, 0);
  for (const sh of r.sheets) {
    assert.ok(sh.sets >= 1);
    assertKitSheet(sh, 300, 200, kitProducts, sh.sets);
  }
  // 套数守恒
  assert.strictEqual(r.sheets.reduce((s, sh) => s + sh.sets, 0), 5);
  // 欠数为 0
  for (const u of r.remaining) assert.strictEqual(u.quantity, 0);
});

test('成套批量：返回各品种套内需求、已排、欠数', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 1, // 只给一张，做不满 10 套
    kit: { plannedSets: 10 },
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'B', width: 50, height: 50, perSet: 2 },
    ],
  });
  assert.strictEqual(r.stopReason, 'max-sheets');
  assert.ok(r.kit.setsCompleted < 10);
  const a = r.remaining.find((u) => u.name === 'A');
  const b = r.remaining.find((u) => u.name === 'B');
  assert.strictEqual(a.total, 10); // 套内需求 perSet×计划
  assert.strictEqual(b.total, 20);
  assert.strictEqual(a.placed + a.quantity, a.total);
  assert.strictEqual(b.placed + b.quantity, b.total);
  assert.strictEqual(a.perSet, 1);
  assert.strictEqual(b.perSet, 2);
});

test('成套批量：剩余材料组不成一整套 → no-progress，本轮不扣库存/需求、无空白纸', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 2, maxSheets: 5,
    kit: { plannedSets: 3 },
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'BIG', width: 500, height: 500, perSet: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.kit.setsCompleted, 0);
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.summary.piecesPlaced, 0);
  // 本轮不扣需求
  for (const u of r.remaining) assert.strictEqual(u.placed, 0);
});

test('成套批量：达到用纸上限即停，已排各张均为完整套', () => {
  const kitProducts = [{ name: 'A', width: 100, height: 100, perSet: 1 }];
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 2,
    kit: { plannedSets: 20 },
    products: kitProducts,
  });
  assert.strictEqual(r.stopReason, 'max-sheets');
  assert.strictEqual(r.sheets.length, 2);
  for (const sh of r.sheets) assertKitSheet(sh, 300, 200, kitProducts, sh.sets);
  assert.strictEqual(r.summary.piecesPlaced, 12); // 每张 6 套
});

test('成套批量：禁止贪心多排某品种形成半套（每张各品种成比例）', () => {
  const kitProducts = [
    { name: '封面', width: 210, height: 285, perSet: 1 },
    { name: '名片', width: 90, height: 54, perSet: 4 },
  ];
  const r = layoutBatch({
    paperW: 889, paperH: 1194, kerf: 3, maxSheets: 6,
    kit: { plannedSets: 12 },
    products: kitProducts,
  });
  for (const sh of r.sheets) {
    assertKitSheet(sh, 889, 1194, kitProducts, sh.sets);
  }
  // 逐张套数之和 = 完成套数
  assert.strictEqual(
    r.sheets.reduce((s, sh) => s + sh.sets, 0),
    r.kit.setsCompleted
  );
  // 件数按比例：名片总数恒为封面总数的 4 倍
  const cover = r.remaining.find((u) => u.name === '封面');
  const card = r.remaining.find((u) => u.name === '名片');
  assert.strictEqual(card.placed, cover.placed * 4);
});

test('成套批量：纹向约束仍生效，布局件纹向恒满足', () => {
  const r = layoutBatch({
    paperW: 889, paperH: 1194, paperGrain: 'along-height', kerf: 3, maxSheets: 6,
    kit: { plannedSets: 6 },
    products: [
      { name: '封面', width: 210, height: 285, grain: 'along-height', perSet: 1 },
      { name: '卡片', width: 100, height: 60, grain: 'along-width', perSet: 2 },
    ],
  });
  for (const sh of r.sheets) {
    for (const it of sh.items) assert.strictEqual(it.grainOk, true);
  }
});

test('成套批量：与订单隔离互斥，且校验计划套数/每套用量', () => {
  const base = {
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 2,
    isolateOrders: true, kit: { plannedSets: 2 },
    products: [{ width: 10, height: 10, perSet: 1 }],
  };
  assert.throws(() => layoutBatch(base), /不能与订单隔离/);
  assert.throws(() => layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 2,
    kit: { plannedSets: 0 }, products: [{ width: 10, height: 10, perSet: 1 }],
  }), /计划套数/);
  assert.throws(() => layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 2,
    kit: { plannedSets: 2 }, products: [{ width: 10, height: 10 }],
  }), /每套用量/);
  assert.throws(() => layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 2,
    kit: { plannedSets: 2 }, products: [{ width: 10, height: 10, perSet: 1.5 }],
  }), /正整数/);
});

/* ---------------- 多纸型成套 ---------------- */

test('成套成本：每张只含完整套，逐张标明套数，套数优先于单价', () => {
  const kitProducts = [
    { name: 'A', width: 100, height: 100, perSet: 1 },
    { name: 'B', width: 50, height: 50, perSet: 1 },
  ];
  const r = layoutCostBatch({
    kerf: 0,
    kit: { plannedSets: 5 },
    papers: [
      { name: '便宜小纸', width: 150, height: 100, price: 0.1, stock: 10 },
      { name: '贵大纸', width: 300, height: 200, price: 100, stock: 5 },
    ],
    products: kitProducts,
  });
  assert.strictEqual(r.stopReason, 'completed');
  for (const sh of r.sheets) {
    assert.ok(sh.sets >= 1);
    assertKitSheet(sh.layout, sh.paperWidth, sh.paperHeight, kitProducts, sh.sets);
    // 候选表均带套数列，且入选者套数不小于任何同轮候选
    for (const c of sh.selection.ranked) {
      const winner = sh.selection.ranked.find((x) => x.selected);
      assert.ok(winner.sets >= c.sets);
    }
  }
  // 第一轮贵大纸套数多，应优先（即便单位成本高）
  assert.strictEqual(r.sheets[0].sets, 4);
  assert.strictEqual(r.sheets[0].paperName, '贵大纸');
});

test('成套成本：同套数下按单位面积成本、件数、录入顺序决胜', () => {
  // 两种 100×100 纸，每轮成套数相同；单价低者单位成本更低 → 先选 S1
  const r = layoutCostBatch({
    kerf: 0,
    kit: { plannedSets: 2 },
    papers: [
      { name: '低价', width: 100, height: 100, price: 1, stock: 3 },
      { name: '高价', width: 100, height: 100, price: 2, stock: 3 },
    ],
    products: [{ name: 'A', width: 50, height: 50, perSet: 1 }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.ok(r.sheets.every((s) => s.paperId === 'S1'));
});

test('成套成本：所有有库存纸型组不成一整套 → no-progress，不扣库存', () => {
  const r = layoutCostBatch({
    kerf: 2,
    kit: { plannedSets: 3 },
    papers: [
      { name: 'A', width: 200, height: 200, price: 1, stock: 3 },
      { name: 'B', width: 150, height: 150, price: 0.5, stock: 3 },
    ],
    products: [
      { name: 'A', width: 100, height: 100, perSet: 1 },
      { name: 'BIG', width: 500, height: 500, perSet: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.deepStrictEqual(r.usage.map((u) => u.remainingStock), [3, 3]);
  assert.strictEqual(r.kit.setsCompleted, 0);
});

test('成套成本：库存耗尽终止且逐张/汇总守恒', () => {
  const kitProducts = [{ name: 'A', width: 100, height: 100, perSet: 1 }];
  const r = layoutCostBatch({
    kerf: 0,
    kit: { plannedSets: 50 },
    papers: [
      { name: '纸A', width: 100, height: 100, price: 1, stock: 1 },
      { name: '纸B', width: 100, height: 100, price: 1, stock: 1 },
    ],
    products: kitProducts,
  });
  assert.strictEqual(r.stopReason, 'stock-exhausted');
  assert.strictEqual(r.sheets.length, 2);
  for (const sh of r.sheets) assertKitSheet(sh.layout, 100, 100, kitProducts, sh.sets);
  // 库存只扣已提交张数
  const usedSum = r.usage.reduce((s, u) => s + u.used, 0);
  assert.strictEqual(usedSum, 2);
  const remain = r.remaining.reduce((s, u) => s + u.quantity, 0);
  const placed = r.remaining.reduce((s, u) => s + u.placed, 0);
  assert.strictEqual(remain + placed, 50);
});

test('成套成本：候选纸型纹向不可行时不入选，仍可完成', () => {
  const r = layoutCostBatch({
    kerf: 0,
    kit: { plannedSets: 2 },
    papers: [
      { name: '窄纸', width: 100, height: 300, grain: 'along-width', price: 0.1, stock: 5 },
      { name: '宽纸', width: 310, height: 130, grain: 'along-width', price: 5, stock: 5 },
    ],
    products: [
      { name: 'X', width: 120, height: 40, grain: 'along-width', perSet: 1 },
      { name: 'Y', width: 30, height: 30, perSet: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.ok(r.sheets.every((s) => s.paperId === 'S2'));
});

/* ---------------- 单张试排器（直接） ---------------- */

test('planKitSheet：返回已证实可行的最大完整套数且布局无富余', () => {
  const kitProducts = [
    { id: 'P1', name: 'A', width: 100, height: 100, grain: 'any', perSet: 1, seqIndex: 0 },
    { id: 'P2', name: 'B', width: 50, height: 50, grain: 'any', perSet: 2, seqIndex: 1 },
  ];
  const plan = planKitSheet(
    { paperW: 300, paperH: 200, paperGrain: 'along-width' },
    0, kitProducts, [100, 200]
  );
  assert.ok(plan.sets >= 4);
  assertKitSheet(plan.layout, 300, 200, kitProducts, plan.sets);
});

test('planKitSheet：单品种富供给即最优且为完整套', () => {
  const kitProducts = [
    { id: 'P1', name: 'A', width: 100, height: 100, grain: 'any', perSet: 1, seqIndex: 0 },
  ];
  const plan = planKitSheet(
    { paperW: 300, paperH: 200, paperGrain: 'along-width' },
    0, kitProducts, [100]
  );
  assert.strictEqual(plan.sets, 6);
  assert.strictEqual(plan.layout.stats.piecesPlaced, 6);
});

test('planKitSheet：剩余需求不足一套时返回 0', () => {
  const kitProducts = [
    { id: 'P1', name: 'A', width: 100, height: 100, grain: 'any', perSet: 2, seqIndex: 0 },
  ];
  const plan = planKitSheet(
    { paperW: 300, paperH: 200, paperGrain: 'along-width' },
    0, kitProducts, [1]
  );
  assert.strictEqual(plan.sets, 0);
  assert.strictEqual(plan.layout, null);
});
