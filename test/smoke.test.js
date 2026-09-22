'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch } = require('../src/packer');

const EPS = 1e-6;

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS ||
    a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS
  );
}

function rectsOverlapOpen(a, b) {
  // 边界相接（共边）不算侵占；输出坐标已 round3，容差放宽
  const TOL = 1e-3;
  return !(
    a.x + a.w <= b.x + TOL || b.x + b.w <= a.x + TOL ||
    a.y + a.h <= b.y + TOL || b.y + b.h <= a.y + TOL
  );
}

function allCuts(result, kerf) {
  for (const c of result.cuts) {
    // 刀缝带宽度/高度等于 kerf
    if (c.orient === 'v') {
      assert.ok(Math.abs(c.band.w - kerf) < EPS, '竖切刀缝宽度应为 kerf');
      assert.ok(Math.abs(c.band.h - c.region.h) < EPS, '竖切应贯穿区域');
      // 区域被 band 分成左右两块
      const leftW = c.band.x - c.region.x;
      const rightX = c.band.x + c.band.w;
      const rightW = c.region.x + c.region.w - rightX;
      assert.ok(leftW >= -EPS && rightW >= -EPS);
      assert.ok(Math.abs(leftW + kerf + rightW - c.region.w) < EPS);
    } else {
      assert.ok(Math.abs(c.band.h - kerf) < EPS, '横切刀缝高度应为 kerf');
      assert.ok(Math.abs(c.band.w - c.region.w) < EPS, '横切应贯穿区域');
      const topH = c.band.y - c.region.y;
      const bottomY = c.band.y + c.band.h;
      const bottomH = c.region.y + c.region.h - bottomY;
      assert.ok(topH >= -EPS && bottomH >= -EPS);
      assert.ok(Math.abs(topH + kerf + bottomH - c.region.h) < EPS);
    }
  }
}

test('所有成品位于纸面内且互不重叠', () => {
  const r = layout({
    paperW: 300, paperH: 200, kerf: 3,
    products: [
      { width: 100, height: 80, quantity: 4 },
      { width: 60, height: 50, quantity: 6 },
    ],
  });
  for (const it of r.items) {
    assert.ok(it.x >= -EPS && it.y >= -EPS);
    assert.ok(it.x + it.w <= 300 + EPS && it.y + it.h <= 200 + EPS);
  }
  for (let i = 0; i < r.items.length; i++) {
    for (let j = i + 1; j < r.items.length; j++) {
      assert.ok(!rectsOverlap(r.items[i], r.items[j]), '成品间不应重叠');
    }
  }
  allCuts(r, 3);
});

test('刀缝不侵占任何成品', () => {
  const r = layout({
    paperW: 420, paperH: 297, kerf: 4,
    products: [
      { width: 120, height: 90, quantity: 8 },
      { width: 200, height: 50, quantity: 2 },
    ],
  });
  for (const band of r.cuts.map((c) => c.band)) {
    for (const it of r.items) {
      assert.ok(!rectsOverlapOpen(band, it), '切割带与成品必须分离');
    }
  }
});

test('旋转：宽于纸高但窄于纸宽的成品可旋转排入', () => {
  // 成品 120x40：不旋转(120 宽 x 40 高) 排一个后，
  // 关键校验旋转状态的成品其放置尺寸与规格互换
  const r = layout({
    paperW: 100, paperH: 300, kerf: 0,
    products: [{ width: 120, height: 40, quantity: 1 }],
  });
  assert.strictEqual(r.stats.piecesPlaced, 1);
  const it = r.items[0];
  assert.strictEqual(it.rotated, true);
  assert.strictEqual(it.w, 40);
  assert.strictEqual(it.h, 120);
  assert.strictEqual(it.specW, 120);
  assert.strictEqual(it.specH, 40);
});

test('放不下的件进入 unplaced，且确实没有任何自由区域能容纳', () => {
  const r = layout({
    paperW: 200, paperH: 200, kerf: 2,
    products: [
      { width: 150, height: 150, quantity: 1 },
      { width: 120, height: 120, quantity: 1 },
      { width: 300, height: 50, quantity: 2 }, // 根本进不了纸
    ],
  });
  assert.strictEqual(r.stats.piecesPlaced, 1);
  assert.strictEqual(r.unplaced.length, 2);
  const big = r.unplaced.find((u) => u.width === 300);
  assert.strictEqual(big.quantity, 2);
  // 每个未排件（两种朝向）都放不进任一自由区域
  for (const u of r.unplaced) {
    for (const f of r.frees) {
      const fitNormal = u.width <= f.w + EPS && u.height <= f.h + EPS;
      const fitRot = u.height <= f.w + EPS && u.width <= f.h + EPS;
      assert.ok(!fitNormal && !fitRot, '未排件不应能放进任何余料区');
    }
  }
});

test('零刀缝、整纸恰好排满', () => {
  const r = layout({
    paperW: 300, paperH: 200, kerf: 0,
    products: [
      { width: 150, height: 100, quantity: 4 },
    ],
  });
  assert.strictEqual(r.stats.piecesPlaced, 4);
  assert.strictEqual(r.unplaced.length, 0);
  assert.ok(Math.abs(r.stats.areaRatio - 1) < 1e-6);
  assert.ok(Math.abs(r.stats.freeArea) < 1e-6);
});

test('刀缝占位被计入面积且面积守恒（允许微小舍入）', () => {
  const r = layout({
    paperW: 500, paperH: 400, kerf: 3,
    products: [{ width: 100, height: 100, quantity: 30 }],
  });
  const sum = r.stats.placedArea + r.stats.kerfArea + r.stats.freeArea;
  assert.ok(Math.abs(sum - r.stats.paperArea) < 1, '面积应守恒');
  assert.ok(r.stats.kerfArea > 0, '应存在刀缝面积');
  assert.ok(r.stats.areaRatio > 0 && r.stats.areaRatio <= 1);
});

test('切刀按前序编号，且每刀都将当前区域一分为二', () => {
  const r = layout({
    paperW: 300, paperH: 300, kerf: 2,
    products: [{ width: 80, height: 60, quantity: 9 }],
  });
  r.cuts.forEach((c, i) => assert.strictEqual(c.n, i + 1));
  // 每一刀的两侧都必须有正面积子块（最后分割可能有一侧零余料，但至少有成品侧）
  for (const c of r.cuts) {
    const sides = c.orient === 'v'
      ? [c.band.x - c.region.x, c.region.x + c.region.w - (c.band.x + c.band.w)]
      : [c.band.y - c.region.y, c.region.y + c.region.h - (c.band.y + c.band.h)];
    assert.ok(sides.every((s) => s >= -EPS), '分割两侧不应为负');
  }
});

test('非法输入抛出错误', () => {
  assert.throws(() => layout({ paperW: 0, paperH: 100, kerf: 1, products: [] }));
  assert.throws(() => layout({ paperW: 100, paperH: 100, kerf: -1, products: [] }));
  assert.throws(() =>
    layout({ paperW: 100, paperH: 100, kerf: 1, products: [{ width: -5, height: 10, quantity: 1 }] })
  );
});

test('无成品时返回空版面', () => {
  const r = layout({ paperW: 100, paperH: 100, kerf: 1, products: [] });
  assert.strictEqual(r.items.length, 0);
  assert.strictEqual(r.cuts.length, 0);
  assert.strictEqual(r.frees.length, 1);
  assert.strictEqual(r.stats.piecesTotal, 0);
});

/* ---------------- 批量排产 ---------------- */

test('批量：需求在限额内全部完成，各张扣减一致', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 10,
    products: [{ width: 100, height: 100, quantity: 20 }],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.summary.piecesTotal, 20);
  assert.strictEqual(r.summary.piecesPlaced, 20);
  assert.strictEqual(r.summary.completionRate, 1);
  assert.ok(r.summary.sheetsUsed >= 4 && r.summary.sheetsUsed <= 10); // 每张最多 6 件
  assert.strictEqual(r.remaining.length, 0);
  // 各张已排之和 = 总需求；总刀数 = 各张刀数之和
  assert.strictEqual(r.sheets.reduce((s, sh) => s + sh.stats.piecesPlaced, 0), 20);
  assert.strictEqual(r.summary.cutsTotal, r.sheets.reduce((s, sh) => s + sh.stats.cutsTotal, 0));
  // 每张纸自身仍是合法的单张布局
  for (const sh of r.sheets) {
    assert.strictEqual(sh.paper.width, 300);
    assert.ok(sh.stats.piecesPlaced > 0, '不应出现空白纸');
  }
});

test('批量：达到用纸上限即停，剩余件数正确', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 2,
    products: [{ width: 100, height: 100, quantity: 20 }],
  });
  assert.strictEqual(r.stopReason, 'max-sheets');
  assert.strictEqual(r.summary.sheetsUsed, 2);
  assert.strictEqual(r.summary.piecesPlaced, 12); // 每张 3×2 = 6 件
  assert.strictEqual(r.remaining.length, 1);
  assert.strictEqual(r.remaining[0].quantity, 8);
  assert.strictEqual(r.remaining[0].total, 20);
  assert.strictEqual(r.remaining[0].placed, 12);
  assert.ok(r.summary.completionRate > 0 && r.summary.completionRate < 1);
});

test('批量：某张纸排不进任何成品时立即停止，且不产生空白纸', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 2, maxSheets: 5,
    products: [
      { width: 100, height: 100, quantity: 1 }, // 第一张能排
      { width: 500, height: 500, quantity: 2 }, // 永远排不进
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.summary.sheetsUsed, 1); // 空白的那张不计入
  assert.strictEqual(r.summary.piecesPlaced, 1);
  const big = r.remaining.find((u) => u.width === 500);
  assert.strictEqual(big.quantity, 2);
  assert.strictEqual(big.placed, 0);
});

test('批量：第一张就排不进时 sheets 为空、剩余为全部需求', () => {
  const r = layoutBatch({
    paperW: 200, paperH: 200, kerf: 2, maxSheets: 5,
    products: [{ width: 500, height: 500, quantity: 3 }],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.summary.piecesPlaced, 0);
  assert.strictEqual(r.summary.completionRate, 0);
  assert.strictEqual(r.remaining[0].quantity, 3);
  assert.strictEqual(r.remaining[0].total, 3);
});

test('批量：空需求直接完成，不用纸', () => {
  const r = layoutBatch({ paperW: 200, paperH: 200, kerf: 2, maxSheets: 5, products: [] });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.summary.completionRate, 1);
});

test('批量：逐张扣减单调收敛（多种规格混合）', () => {
  const r = layoutBatch({
    paperW: 400, paperH: 300, kerf: 3, maxSheets: 20,
    products: [
      { name: 'A', width: 150, height: 120, quantity: 9 },
      { name: 'B', width: 90, height: 60, quantity: 30 },
    ],
  });
  // 每张已排数之和 + 剩余 = 总需求
  const placedSum = r.sheets.reduce((s, sh) => s + sh.stats.piecesPlaced, 0);
  const remainSum = r.remaining.reduce((s, u) => s + u.quantity, 0);
  assert.strictEqual(placedSum, r.summary.piecesPlaced);
  assert.strictEqual(placedSum + remainSum, 39);
  // 逐张已排数单调无空白
  for (const sh of r.sheets) assert.ok(sh.stats.piecesPlaced > 0);
});

test('批量：maxSheets 与成品输入校验', () => {
  assert.throws(() => layoutBatch({ paperW: 100, paperH: 100, kerf: 1, maxSheets: 0, products: [] }));
  assert.throws(() => layoutBatch({ paperW: 100, paperH: 100, kerf: 1, maxSheets: 2.5, products: [] }));
  assert.throws(() => layoutBatch({ paperW: 100, paperH: 100, kerf: 1, maxSheets: 501, products: [] }));
  assert.throws(() => layoutBatch({ paperW: 100, paperH: 100, kerf: 1, products: [] })); // 缺 maxSheets
  // 成品校验沿用单张规则
  assert.throws(() =>
    layoutBatch({ paperW: 100, paperH: 100, kerf: 1, maxSheets: 3, products: [{ width: -1, height: 10, quantity: 1 }] })
  );
});
