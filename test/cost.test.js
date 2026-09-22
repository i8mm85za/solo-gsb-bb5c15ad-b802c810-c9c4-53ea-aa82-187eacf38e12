'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layoutCostBatch } = require('../src/cost');

const EPS = 1e-6;

/** 单张布局不变量（与 smoke.test.js 同口径）：成品在纸面内、互不重叠 */
function assertLayoutValid(sh, paperW, paperH) {
  assert.strictEqual(sh.layout.paper.width, paperW);
  assert.strictEqual(sh.layout.paper.height, paperH);
  for (const it of sh.layout.items) {
    assert.ok(it.x >= -EPS && it.y >= -EPS);
    assert.ok(it.x + it.w <= paperW + EPS && it.y + it.h <= paperH + EPS);
  }
  for (let i = 0; i < sh.layout.items.length; i++) {
    for (let j = i + 1; j < sh.layout.items.length; j++) {
      const a = sh.layout.items[i];
      const b = sh.layout.items[j];
      const overlap = !(
        a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS ||
        a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS
      );
      assert.ok(!overlap, '成品间不应重叠');
    }
  }
}

test('成本：单位面积成本低的纸型胜出（即便单价更高）', () => {
  // 大纸 300×300 单价 10 元，每张恰好排满 9 件 → 每件面积 10000mm²，
  //   单位成本 = 10 / 90000 mm²
  // 小纸 100×100 单价 2 元，每张排 1 件，
  //   单位成本 = 2 / 10000 mm² = 18 / 90000 mm²，比大纸贵
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '大纸', width: 300, height: 300, price: 10, stock: 5 },
      { name: '小纸', width: 100, height: 100, price: 2, stock: 50 },
    ],
    products: [{ name: '卡片', width: 100, height: 100, quantity: 9 }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 1);
  assert.strictEqual(r.sheets[0].paperId, 'S1');
  assert.strictEqual(r.sheets[0].piecesPlaced, 9);
  assert.ok(r.sheets[0].costPerM2 < r.sheets[0].selection.ranked[1].costPerM2);
  assert.strictEqual(r.summary.totalCost, 10);
  assert.strictEqual(r.remaining.length, 0);
});

test('成本：单位面积成本同分（恰好排满且同面积单价）时已排件数多者胜', () => {
  // 两种纸单位面积单价相同（都被 100×100 件恰好铺满），
  // 大纸每张 6 件，小纸每张 1 件 → 第一轮选大纸
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '大纸', width: 300, height: 200, price: 6, stock: 2 },
      { name: '小纸', width: 100, height: 100, price: 1, stock: 20 },
    ],
    products: [{ width: 100, height: 100, quantity: 13 }],
  });
  // 前两轮单位成本同分，大纸 6 件 > 小纸 1 件，各选大纸（6+6=12）
  assert.strictEqual(r.sheets[0].paperId, 'S1');
  assert.strictEqual(r.sheets[0].piecesPlaced, 6);
  assert.strictEqual(r.sheets[1].paperId, 'S1');
  assert.strictEqual(r.sheets[1].piecesPlaced, 6);
  // 大纸库存耗尽，最后 1 件只能用小纸
  assert.strictEqual(r.sheets[2].paperId, 'S2');
  assert.strictEqual(r.sheets[2].piecesPlaced, 1);
  assert.strictEqual(r.summary.piecesPlaced, 13);
  assert.strictEqual(r.stopReason, 'completed');
});

test('成本：单价与面积同比例、件数也同分时按录入顺序选前者', () => {
  // 两张同样 100×100、单价 1，每张都只能排 4 件 → 全部指标相同
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '先录入', width: 100, height: 100, price: 1, stock: 3 },
      { name: '后录入', width: 100, height: 100, price: 1, stock: 3 },
    ],
    products: [{ width: 50, height: 50, quantity: 5 }],
  });
  assert.strictEqual(r.sheets[0].paperId, 'S1');
  assert.strictEqual(r.sheets[1].paperId, 'S1');
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.usage[0].used, 2);
  assert.strictEqual(r.usage[1].used, 0);
  assert.strictEqual(r.usage[1].remainingStock, 3);
});

test('成本：逐轮扣库存与需求，库存耗尽即停并给出剩余件数', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '大纸', width: 300, height: 200, price: 6, stock: 2 },
      { name: '小纸', width: 100, height: 100, price: 10, stock: 1 },
    ],
    products: [{ width: 100, height: 100, quantity: 20 }],
  });
  // 大纸单位成本低，先用 2 张（各 6 件）；小纸贵 10 倍，但大纸耗尽后仍可用 1 张
  assert.strictEqual(r.sheets.length, 3);
  assert.deepStrictEqual(r.sheets.map((s) => s.paperId), ['S1', 'S1', 'S2']);
  assert.strictEqual(r.stopReason, 'stock-exhausted');
  assert.strictEqual(r.summary.piecesPlaced, 13);
  assert.strictEqual(r.remaining.length, 1);
  assert.strictEqual(r.remaining[0].quantity, 7);
  assert.strictEqual(r.remaining[0].total, 20);
  assert.strictEqual(r.remaining[0].placed, 13);
  // 库存与用量
  assert.strictEqual(r.usage[0].used, 2);
  assert.strictEqual(r.usage[0].remainingStock, 0);
  assert.strictEqual(r.usage[1].used, 1);
  assert.strictEqual(r.usage[1].remainingStock, 0);
  // 总成本 = 2×6 + 1×10
  assert.strictEqual(r.summary.totalCost, 22);
});

test('成本：所有有库存纸型都排不进时无进展止损，且不产生空白纸', () => {
  const r = layoutCostBatch({
    kerf: 2,
    papers: [
      { name: '小纸A', width: 200, height: 200, price: 1, stock: 3 },
      { name: '小纸B', width: 150, height: 150, price: 0.5, stock: 3 },
    ],
    products: [{ width: 500, height: 500, quantity: 2 }],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.remaining[0].quantity, 2);
  // 空白纸不扣库存
  assert.strictEqual(r.usage[0].remainingStock, 3);
  assert.strictEqual(r.usage[1].remainingStock, 3);
});

test('成本：先排小件后剩余大件全部放不下时无进展，已排纸张保留', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '纸A', width: 300, height: 300, price: 1, stock: 5 },
      { name: '纸B', width: 250, height: 250, price: 1, stock: 5 },
    ],
    products: [
      { name: '小件', width: 80, height: 80, quantity: 4 },
      { name: '大件', width: 400, height: 400, quantity: 1 },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.ok(r.sheets.length >= 1);
  for (const sh of r.sheets) assert.ok(sh.piecesPlaced > 0, '不应有空白纸');
  const big = r.remaining.find((u) => u.name === '大件');
  assert.strictEqual(big.quantity, 1);
});

test('成本：零库存纸型不可选，其余纸型正常完成', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '便宜但无货', width: 300, height: 200, price: 0.1, stock: 0 },
      { name: '有货', width: 100, height: 100, price: 1, stock: 10 },
    ],
    products: [{ width: 100, height: 100, quantity: 3 }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.ok(r.sheets.every((s) => s.paperId === 'S2'));
  assert.strictEqual(r.usage[0].used, 0);
  assert.strictEqual(r.usage[0].remainingStock, 0);
  assert.strictEqual(r.usage[1].used, 3);
});

test('成本：所有纸型库存均为 0 且有需求时按库存耗尽停止，不出纸', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '无货A', width: 300, height: 200, price: 1, stock: 0 },
      { name: '无货B', width: 100, height: 100, price: 1, stock: 0 },
    ],
    products: [{ width: 100, height: 100, quantity: 3 }],
  });
  assert.strictEqual(r.stopReason, 'stock-exhausted');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.summary.piecesPlaced, 0);
  assert.strictEqual(r.remaining[0].quantity, 3);
});

test('成本：每张入选纸均为胜者指标（selected），且指标确为该轮最小', () => {
  const r = layoutCostBatch({
    kerf: 2,
    papers: [
      { name: 'A', width: 400, height: 300, price: 5, stock: 4 },
      { name: 'B', width: 300, height: 300, price: 3, stock: 4 },
      { name: 'C', width: 200, height: 200, price: 1.2, stock: 4 },
    ],
    products: [
      { name: '封面', width: 150, height: 120, quantity: 9 },
      { name: '名片', width: 90, height: 60, quantity: 40 },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  for (const sh of r.sheets) {
    const ranked = sh.selection.ranked;
    const winner = ranked.find((c) => c.selected);
    assert.ok(winner, '每轮必须有一个入选纸型');
    assert.strictEqual(winner.paperId, sh.paperId);
    // 舍入到 4 位后展示，单值舍入误差 ≤ 5e-5 元/m²，留 1e-4 容差
    for (const c of ranked) {
      if (c === winner) continue;
      assert.ok(
        winner.costPerM2 <= c.costPerM2 + 0.0001,
        '入选纸型单位面积成本不应明显高于其他候选'
      );
    }
    // 指标与顶层一致
    assert.strictEqual(winner.piecesPlaced, sh.piecesPlaced);
    assert.strictEqual(winner.costPerM2, sh.costPerM2);
    assert.strictEqual(winner.placedArea, sh.placedArea);
    assertLayoutValid(sh, sh.paperWidth, sh.paperHeight);
  }
});

test('成本：各张用量、总成本与完成率汇总守恒', () => {
  const r = layoutCostBatch({
    kerf: 1,
    papers: [
      { name: 'A', width: 400, height: 300, price: 4.5, stock: 3 },
      { name: 'B', width: 250, height: 250, price: 2.25, stock: 5 },
    ],
    products: [
      { name: 'A件', width: 120, height: 90, quantity: 12 },
      { name: 'B件', width: 60, height: 60, quantity: 30 },
    ],
  });
  const placedSum = r.sheets.reduce((s, sh) => s + sh.piecesPlaced, 0);
  const remainSum = r.remaining.reduce((s, u) => s + u.quantity, 0);
  assert.strictEqual(placedSum, r.summary.piecesPlaced);
  assert.strictEqual(placedSum + remainSum, 42);
  const usedSum = r.usage.reduce((s, u) => s + u.used, 0);
  assert.strictEqual(usedSum, r.sheets.length);
  const costByUsage = r.usage.reduce((s, u) => s + u.cost, 0);
  assert.ok(Math.abs(costByUsage - r.summary.totalCost) < 0.011);
  assert.ok(r.summary.completionRate > 0 && r.summary.completionRate <= 1);
  assert.strictEqual(
    r.summary.cutsTotal,
    r.sheets.reduce((s, sh) => s + sh.layout.stats.cutsTotal, 0)
  );
});

test('成本：空需求直接完成、不用纸、成本为 0', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: 'A', width: 100, height: 100, price: 1, stock: 2 },
      { name: 'B', width: 200, height: 200, price: 2, stock: 2 },
    ],
    products: [],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.summary.effectiveCostPerM2, null);
  assert.strictEqual(r.summary.completionRate, 1);
});

test('成本：纸型与字段校验', () => {
  const base = {
    kerf: 0,
    products: [{ width: 10, height: 10, quantity: 1 }],
  };
  const mk = (papers) => layoutCostBatch({ ...base, papers });

  // 少于 2 种 / 多于 8 种
  assert.throws(() => mk([{ name: 'A', width: 100, height: 100, price: 1, stock: 1 }]),
    /至少需要录入 2 种/);
  assert.throws(() => mk(Array.from({ length: 9 }, (_, i) =>
    ({ name: `P${i}`, width: 100, height: 100, price: 1, stock: 1 }))),
    /最多为 8 种/);

  const pair = (patch) => [
    { name: 'A', width: 100, height: 100, price: 1, stock: 1 },
    { name: 'B', width: 100, height: 100, price: 1, stock: 1, ...patch },
  ];

  assert.throws(() => mk(pair({ width: 0 })), /宽必须大于 0/);
  assert.throws(() => mk(pair({ height: -1 })), /高必须大于 0/);
  assert.throws(() => mk(pair({ price: 0 })), /单价必须大于 0/);
  assert.throws(() => mk(pair({ price: -2 })), /单价必须大于 0/);
  assert.throws(() => mk(pair({ stock: -1 })), /可用张数/);
  assert.throws(() => mk(pair({ stock: 501 })), /可用张数/);
  assert.throws(() => mk(pair({ stock: 1.5 })), /可用张数/);
  assert.throws(() => mk(pair({ stock: 'x' })), /可用张数/);
  assert.throws(() => mk(undefined), /候选纸张/);
  assert.throws(() => layoutCostBatch({ kerf: -1, papers: pair({}), products: [] }),
    /刀缝/);
  // 成品校验沿用单张规则
  assert.throws(() => layoutCostBatch({
    kerf: 0,
    papers: pair({}),
    products: [{ width: -5, height: 10, quantity: 1 }],
  }), /宽高/);
});

test('成本：未命名纸型自动命名，返回结构含完整字段', () => {
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { width: 100, height: 100, price: 1, stock: 2 },
      { width: 200, height: 200, price: 3, stock: 2 },
    ],
    products: [{ width: 50, height: 50, quantity: 2 }],
  });
  assert.strictEqual(r.papers[0].name, '纸型1');
  assert.strictEqual(r.papers[1].name, '纸型2');
  for (const sh of r.sheets) {
    for (const k of ['round', 'paperId', 'paperName', 'paperWidth', 'paperHeight',
      'price', 'piecesPlaced', 'placedArea', 'costPerM2', 'selection', 'layout']) {
      assert.ok(k in sh, `sheets 元素缺少字段 ${k}`);
    }
  }
  for (const u of r.usage) {
    for (const k of ['id', 'name', 'width', 'height', 'price', 'stock',
      'used', 'remainingStock', 'cost', 'placedArea']) {
      assert.ok(k in u, `usage 元素缺少字段 ${k}`);
    }
  }
});
