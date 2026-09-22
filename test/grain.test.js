'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch, grainAllows } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');

/* ---------------- 朝向规则 ---------------- */

test('纹向：朝向允许规则（平行才可采用）', () => {
  // 不限：两种朝向均可
  assert.strictEqual(grainAllows('any', 'along-width', false), true);
  assert.strictEqual(grainAllows('any', 'along-width', true), true);
  assert.strictEqual(grainAllows('any', 'along-height', false), true);
  assert.strictEqual(grainAllows('any', 'along-height', true), true);
  // 未旋转：成品宽 ∥ 纸张宽，要求须与纸张纹向一致
  assert.strictEqual(grainAllows('along-width', 'along-width', false), true);
  assert.strictEqual(grainAllows('along-height', 'along-width', false), false);
  // 旋转 90°：成品宽 ∥ 纸张高，要求须与纸张纹向相反
  assert.strictEqual(grainAllows('along-width', 'along-width', true), false);
  assert.strictEqual(grainAllows('along-height', 'along-width', true), true);
  assert.strictEqual(grainAllows('along-width', 'along-height', true), true);
  assert.strictEqual(grainAllows('along-height', 'along-height', false), true);
});

/* ---------------- 单张排样 ---------------- */

test('纹向：两种朝向几何都可行时，只采用纹向平行的朝向', () => {
  // 纸 200×200 纹向沿宽，成品 150×50 要求沿自身宽 → 只能不旋转
  const r1 = layout({
    paperW: 200, paperH: 200, kerf: 0, paperGrain: 'along-width',
    products: [{ width: 150, height: 50, quantity: 1, grain: 'along-width' }],
  });
  assert.strictEqual(r1.stats.piecesPlaced, 1);
  assert.strictEqual(r1.items[0].rotated, false);
  assert.strictEqual(r1.items[0].grain, 'along-width');
  assert.strictEqual(r1.items[0].grainOk, true);
  assert.strictEqual(r1.paper.grain, 'along-width');

  // 同一成品要求沿自身高 → 只能旋转 90°（成品宽 ∥ 纸张高，与沿宽纹向平行）
  const r2 = layout({
    paperW: 200, paperH: 200, kerf: 0, paperGrain: 'along-width',
    products: [{ width: 150, height: 50, quantity: 1, grain: 'along-height' }],
  });
  assert.strictEqual(r2.stats.piecesPlaced, 1);
  assert.strictEqual(r2.items[0].rotated, true);
  assert.strictEqual(r2.items[0].w, 50);
  assert.strictEqual(r2.items[0].h, 150);
  assert.strictEqual(r2.items[0].grainOk, true);

  // 纸张纹向沿高 + 成品要求沿自身宽 → 也只能旋转 90°
  const r3 = layout({
    paperW: 200, paperH: 200, kerf: 0, paperGrain: 'along-height',
    products: [{ width: 150, height: 50, quantity: 1, grain: 'along-width' }],
  });
  assert.strictEqual(r3.stats.piecesPlaced, 1);
  assert.strictEqual(r3.items[0].rotated, true);
  assert.strictEqual(r3.items[0].grainOk, true);
});

test('纹向：几何上只能旋转放入但纹向不允许时，成品排不进并标记纹向受阻', () => {
  // 纸 100×300 纹向沿宽；成品 120×40 要求沿自身宽：
  // 不旋转 120>100 放不下；旋转 40×120 几何可行但纹向不平行 → 排不进
  const r = layout({
    paperW: 100, paperH: 300, kerf: 0, paperGrain: 'along-width',
    products: [{ width: 120, height: 40, quantity: 1, grain: 'along-width' }],
  });
  assert.strictEqual(r.stats.piecesPlaced, 0);
  assert.strictEqual(r.unplaced.length, 1);
  assert.strictEqual(r.unplaced[0].grain, 'along-width');
  assert.strictEqual(r.unplaced[0].grainBlocked, true); // 纹向受阻而非尺寸不足

  // 同样的尺寸改为“不限”即可旋转排入
  const ok = layout({
    paperW: 100, paperH: 300, kerf: 0, paperGrain: 'along-width',
    products: [{ width: 120, height: 40, quantity: 1, grain: 'any' }],
  });
  assert.strictEqual(ok.stats.piecesPlaced, 1);
  assert.strictEqual(ok.items[0].rotated, true);
  assert.strictEqual(ok.items[0].grain, 'any');
  assert.strictEqual(ok.items[0].grainOk, true);
});

test('纹向：纯尺寸不足时 grainBlocked 为 false', () => {
  const r = layout({
    paperW: 200, paperH: 200, kerf: 0, paperGrain: 'along-width',
    products: [{ width: 500, height: 500, quantity: 1, grain: 'along-width' }],
  });
  assert.strictEqual(r.stats.piecesPlaced, 0);
  assert.strictEqual(r.unplaced[0].grainBlocked, false); // 任何朝向都放不下
});

test('纹向：缺省值保持旧行为（纸沿宽、成品不限）', () => {
  const r = layout({
    paperW: 100, paperH: 300, kerf: 0,
    products: [{ width: 120, height: 40, quantity: 1 }],
  });
  assert.strictEqual(r.paper.grain, 'along-width');
  assert.strictEqual(r.items[0].grain, 'any');
  assert.strictEqual(r.items[0].grainOk, true);
  assert.strictEqual(r.items[0].rotated, true); // 不限时仍可旋转
});

test('纹向：非法纹向值抛出错误', () => {
  const base = { paperW: 100, paperH: 100, kerf: 0 };
  assert.throws(() => layout({ ...base, paperGrain: 'diagonal', products: [] }), /纹向/);
  assert.throws(
    () => layout({ ...base, products: [{ width: 10, height: 10, quantity: 1, grain: 'along-diagonal' }] }),
    /纹向/
  );
  // 合法值（含缺省）不抛
  assert.doesNotThrow(() => layout({ ...base, paperGrain: 'along-height', products: [] }));
  assert.doesNotThrow(() =>
    layout({ ...base, products: [{ width: 10, height: 10, quantity: 1, grain: 'along-height' }] })
  );
});

/* ---------------- 批量排产 ---------------- */

test('批量：纹向约束逐张生效，结果标明每件朝向与纹向匹配', () => {
  // 纸 100×300 纹向沿宽；成品 120×40 要求沿自身高 → 旋转后纹向平行，可排
  const r = layoutBatch({
    paperW: 100, paperH: 300, kerf: 0, paperGrain: 'along-width', maxSheets: 5,
    products: [{ width: 120, height: 40, quantity: 4, grain: 'along-height' }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.paper.grain, 'along-width');
  for (const sh of r.sheets) {
    for (const it of sh.items) {
      assert.strictEqual(it.rotated, true); // 只能旋转放入
      assert.strictEqual(it.grain, 'along-height');
      assert.strictEqual(it.grainOk, true);
    }
  }
});

test('批量：余件因纹向排不进时 no-progress 止损，剩余标明纹向受阻', () => {
  const r = layoutBatch({
    paperW: 100, paperH: 300, kerf: 0, paperGrain: 'along-width', maxSheets: 5,
    products: [
      { name: '不限件', width: 90, height: 50, quantity: 1 }, // 第一张可排
      { name: '纹向件', width: 120, height: 40, quantity: 2, grain: 'along-width' }, // 永远排不进
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.summary.sheetsUsed, 1); // 空白纸不计入
  assert.strictEqual(r.summary.piecesPlaced, 1);
  const blocked = r.remaining.find((u) => u.name === '纹向件');
  assert.strictEqual(blocked.quantity, 2);
  assert.strictEqual(blocked.placed, 0);
  assert.strictEqual(blocked.grain, 'along-width');
  assert.strictEqual(blocked.grainBlocked, true);
});

test('批量：纹向要求随逐张扣减保留（不会中途丢失约束）', () => {
  // 纸 100×300 纹向沿宽；成品 120×40 要求沿自身高 → 只能旋转为 40×120，
  // 每张最多 4 件（2 列 × 2 行）；若扣减时纹向丢失，余件 120>100 将永远排不进
  const r = layoutBatch({
    paperW: 100, paperH: 300, kerf: 0, paperGrain: 'along-width', maxSheets: 10,
    products: [{ width: 120, height: 40, quantity: 5, grain: 'along-height' }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.summary.piecesPlaced, 5);
  assert.strictEqual(r.summary.sheetsUsed, 2); // 4 + 1
  assert.strictEqual(r.remaining.length, 0);
  for (const sh of r.sheets) {
    for (const it of sh.items) {
      assert.strictEqual(it.rotated, true);
      assert.strictEqual(it.grain, 'along-height');
      assert.strictEqual(it.grainOk, true);
    }
  }
});

/* ---------------- 多纸型成本排产 ---------------- */

test('成本：纹向不可行的纸型被排除出可行候选排名', () => {
  // 成品 120×40 要求沿自身宽；纸A 100×300 只能旋转放入（纹向不平行）→ 不可行；
  // 纸B 310×130 可不旋转放入 → 唯一可行候选
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '窄纸', width: 100, height: 300, grain: 'along-width', price: 0.1, stock: 5 },
      { name: '宽纸', width: 310, height: 130, grain: 'along-width', price: 5, stock: 5 },
    ],
    products: [{ width: 120, height: 40, quantity: 2, grain: 'along-width' }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.ok(r.sheets.every((s) => s.paperId === 'S2'), '纹向不可行的纸A不应入选');
  assert.strictEqual(r.sheets[0].paperGrain, 'along-width');
  // 可行候选排名里只有纸B
  assert.strictEqual(r.sheets[0].selection.ranked.length, 1);
  assert.strictEqual(r.sheets[0].selection.ranked[0].paperId, 'S2');
  // 纸A一张未用、库存未扣
  assert.strictEqual(r.usage[0].used, 0);
  assert.strictEqual(r.usage[0].remainingStock, 5);
  assert.strictEqual(r.usage[0].grain, 'along-width');
  for (const sh of r.sheets) {
    for (const it of sh.layout.items) {
      assert.strictEqual(it.rotated, false);
      assert.strictEqual(it.grainOk, true);
    }
  }
});

test('成本：所有有库存纸型都因纹向放不下时 no-progress 且不扣库存', () => {
  // 成品 120×40 要求沿自身宽：
  // 纸A 100×300 纹向沿宽：只允许不旋转，但 120>100 → 纹向受阻；
  // 纸B 200×100 纹向沿高：只允许旋转 40×120，但 120>100 → 纹向受阻
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '纸A', width: 100, height: 300, grain: 'along-width', price: 1, stock: 3 },
      { name: '纸B', width: 200, height: 100, grain: 'along-height', price: 2, stock: 3 },
    ],
    products: [{ width: 120, height: 40, quantity: 2, grain: 'along-width' }],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.usage[0].remainingStock, 3);
  assert.strictEqual(r.usage[1].remainingStock, 3);
  assert.strictEqual(r.remaining[0].quantity, 2);
  assert.strictEqual(r.remaining[0].grain, 'along-width');
  assert.strictEqual(r.remaining[0].grainBlocked, true); // 至少一种纸型因纹向受阻
});

test('成本：不同纹向纸型混合用纸，各张按各自纹向约束排样', () => {
  // 成品 150×50 要求沿自身宽，数量 8；纸B（沿宽）仅 1 张库存
  // 纸B 不旋转每张 4 件；纸A（沿高）旋转 90° 每张 4 件
  const r = layoutCostBatch({
    kerf: 0,
    papers: [
      { name: '纹高纸', width: 200, height: 200, grain: 'along-height', price: 3, stock: 2 },
      { name: '纹宽纸', width: 200, height: 200, grain: 'along-width', price: 1, stock: 1 },
    ],
    products: [{ width: 150, height: 50, quantity: 8, grain: 'along-width' }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 2);
  // 纸B 便宜先用完（不旋转），纸A 补足（旋转 90°）
  assert.strictEqual(r.sheets[0].paperId, 'S2');
  assert.strictEqual(r.sheets[0].piecesPlaced, 4);
  assert.ok(r.sheets[0].layout.items.every((it) => it.rotated === false && it.grainOk));
  assert.strictEqual(r.sheets[1].paperId, 'S1');
  assert.strictEqual(r.sheets[1].piecesPlaced, 4);
  assert.ok(r.sheets[1].layout.items.every((it) => it.rotated === true && it.grainOk));
  assert.strictEqual(r.summary.piecesPlaced, 8);
});

test('成本：纸张与成品的纹向校验', () => {
  const pair = (patch) => [
    { name: 'A', width: 100, height: 100, price: 1, stock: 1 },
    { name: 'B', width: 100, height: 100, price: 1, stock: 1, ...patch },
  ];
  assert.throws(
    () => layoutCostBatch({
      kerf: 0,
      papers: pair({ grain: 'vertical' }),
      products: [{ width: 10, height: 10, quantity: 1 }],
    }),
    /第 2 种纸张纹向/
  );
  assert.throws(
    () => layoutCostBatch({
      kerf: 0,
      papers: pair({}),
      products: [{ width: 10, height: 10, quantity: 1, grain: 'along-length' }],
    }),
    /纹向要求/
  );
  // 合法纹向不抛
  assert.doesNotThrow(() => layoutCostBatch({
    kerf: 0,
    papers: pair({ grain: 'along-height' }),
    products: [{ width: 10, height: 10, quantity: 1, grain: 'along-height' }],
  }));
});
