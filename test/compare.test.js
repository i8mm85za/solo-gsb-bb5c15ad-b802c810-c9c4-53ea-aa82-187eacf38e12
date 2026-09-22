'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const {
  layout,
  layoutCompare,
  normalizeObjective,
  selectBestCandidate,
  COMPARE_STRATEGIES,
} = require('../src/packer');

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

/** 校验单个候选布局仍遵守断头台 / 刀缝 / 纹向不变量 */
function assertLayoutInvariants(result, paperW, paperH, kerf) {
  for (const it of result.items) {
    assert.ok(it.x >= -EPS && it.y >= -EPS, '成品不应越出纸面左上界');
    assert.ok(it.x + it.w <= paperW + EPS && it.y + it.h <= paperH + EPS, '成品不应越出纸面');
    assert.strictEqual(it.grainOk, true, '已排成品纹向必须满足要求');
    // 旋转件的放置尺寸与规格互换
    if (it.rotated) {
      assert.strictEqual(it.w, it.specH);
      assert.strictEqual(it.h, it.specW);
    } else {
      assert.strictEqual(it.w, it.specW);
      assert.strictEqual(it.h, it.specH);
    }
  }
  for (let i = 0; i < result.items.length; i++) {
    for (let j = i + 1; j < result.items.length; j++) {
      assert.ok(!rectsOverlap(result.items[i], result.items[j]), '成品间不应重叠');
    }
  }
  for (const c of result.cuts) {
    // 刀缝带宽度/高度等于 kerf 且贯穿被切区域
    if (c.orient === 'v') {
      assert.ok(Math.abs(c.band.w - kerf) < EPS, '竖切刀缝宽度应为 kerf');
      assert.ok(Math.abs(c.band.h - c.region.h) < EPS, '竖切应贯穿区域');
    } else {
      assert.ok(Math.abs(c.band.h - kerf) < EPS, '横切刀缝高度应为 kerf');
      assert.ok(Math.abs(c.band.w - c.region.w) < EPS, '横切应贯穿区域');
    }
    for (const it of result.items) {
      assert.ok(!rectsOverlapOpen(c.band, it), '切割带与成品必须分离');
    }
  }
  // 面积守恒（成品 + 刀缝 + 余料 = 纸面，允许微小舍入）
  const sum = result.stats.placedArea + result.stats.kerfArea + result.stats.freeArea;
  assert.ok(Math.abs(sum - result.stats.paperArea) < 1, '面积应守恒');
}

/* ---------------- 输入校验 ---------------- */

test('比选：objective 规范化与非法取值', () => {
  assert.strictEqual(normalizeObjective(null), 'more-pieces');
  assert.strictEqual(normalizeObjective(''), 'more-pieces');
  assert.strictEqual(normalizeObjective(undefined), 'more-pieces');
  assert.strictEqual(normalizeObjective('more-pieces'), 'more-pieces');
  assert.strictEqual(normalizeObjective('fewer-cuts'), 'fewer-cuts');
  assert.throws(() => normalizeObjective('xxx'), /more-pieces/);
  assert.throws(() =>
    layoutCompare({ paperW: 100, paperH: 100, kerf: 0, objective: 'xxx', products: [] })
  );
});

test('比选：纸张 / 成品校验沿用单张规则', () => {
  assert.throws(() => layoutCompare({ paperW: 0, paperH: 100, kerf: 1, products: [] }));
  assert.throws(() => layoutCompare({ paperW: 100, paperH: 100, kerf: -1, products: [] }));
  assert.throws(() => layoutCompare({ paperW: 100, paperH: 100, kerf: 1 }));
  assert.throws(() =>
    layoutCompare({ paperW: 100, paperH: 100, kerf: 1, products: [{ width: -5, height: 10, quantity: 1 }] })
  );
  assert.throws(() =>
    layout({ paperW: 100, paperH: 100, kerf: 1, products: [] }, { sortStrategy: 'xxx' })
  );
});

/* ---------------- 候选结构与确定性 ---------------- */

test('比选：返回三种策略候选，顺序固定，指标与各自布局一致', () => {
  const input = {
    paperW: 500, paperH: 300, kerf: 5,
    products: [
      { id: 'P1', width: 53, height: 160, quantity: 4 },
      { id: 'P2', width: 189, height: 173, quantity: 2 },
    ],
  };
  const r = layoutCompare(input);
  assert.strictEqual(r.objective, 'more-pieces'); // 缺省目标
  assert.deepStrictEqual(Object.keys(r.paper).sort(), ['grain', 'height', 'kerf', 'width'].sort());
  assert.strictEqual(r.candidates.length, 3);
  assert.deepStrictEqual(
    r.candidates.map((c) => c.strategy),
    COMPARE_STRATEGIES.map((s) => s.key)
  );
  assert.deepStrictEqual(
    r.candidates.map((c) => c.strategy),
    ['area-desc', 'longest-side-desc', 'aspect-diff-desc']
  );
  for (const c of r.candidates) {
    assert.strictEqual(c.metrics.piecesPlaced, c.layout.stats.piecesPlaced);
    assert.strictEqual(c.metrics.piecesTotal, c.layout.stats.piecesTotal);
    assert.strictEqual(c.metrics.placedArea, c.layout.stats.placedArea);
    assert.strictEqual(c.metrics.cutsTotal, c.layout.stats.cutsTotal);
    assert.strictEqual(c.metrics.areaRatio, c.layout.stats.areaRatio);
  }
  // 恰有一个候选被选中，且与 best 一致
  const selected = r.candidates.filter((c) => c.selected);
  assert.strictEqual(selected.length, 1);
  assert.strictEqual(r.best.strategy, selected[0].strategy);
  assert.deepStrictEqual(r.best.metrics, selected[0].metrics);
  assert.strictEqual(r.best.layout, selected[0].layout);
  // 逐项选择依据非空且最后收敛到唯一方案
  assert.ok(Array.isArray(r.decision) && r.decision.length >= 1);
  const last = r.decision[r.decision.length - 1];
  assert.strictEqual(last.survivors.length, 1);
  assert.strictEqual(last.survivors[0], r.best.strategy);
});

test('比选：同一输入两次运行结果完全一致（确定性）', () => {
  const input = {
    paperW: 500, paperH: 300, kerf: 5,
    products: [
      { id: 'P1', width: 53, height: 160, quantity: 4 },
      { id: 'P2', width: 189, height: 173, quantity: 2 },
    ],
  };
  assert.deepStrictEqual(layoutCompare(input), layoutCompare(input));
  assert.deepStrictEqual(
    layoutCompare({ ...input, objective: 'fewer-cuts' }),
    layoutCompare({ ...input, objective: 'fewer-cuts' })
  );
});

test('比选：各候选布局仍遵守断头台 / 刀缝 / 旋转 / 纹向规则', () => {
  const r = layoutCompare({
    paperW: 500, paperH: 300, kerf: 5,
    products: [
      { id: 'P1', width: 53, height: 160, quantity: 4 },
      { id: 'P2', width: 189, height: 173, quantity: 2 },
    ],
  });
  for (const c of r.candidates) assertLayoutInvariants(c.layout, 500, 300, 5);

  // 带纹向约束的输入：三种策略均只采用纹向平行的朝向
  const g = layoutCompare({
    paperW: 200, paperH: 200, kerf: 2, paperGrain: 'along-width',
    products: [
      { width: 150, height: 50, quantity: 2, grain: 'along-height' }, // 只能旋转
      { width: 60, height: 60, quantity: 3, grain: 'any' },
    ],
  });
  for (const c of g.candidates) {
    assertLayoutInvariants(c.layout, 200, 200, 2);
    for (const it of c.layout.items) {
      if (it.grain === 'along-height') assert.strictEqual(it.rotated, true, '沿自身高须旋转放置');
    }
  }
});

/* ---------------- 决胜规则（真实排样） ---------------- */

test('比选：优先多排按已排件数 → 已排面积 → 刀数 → 策略顺序决胜', () => {
  // 三种策略在该输入下产生不同件数（面积降序 5，其余 6）
  const r = layoutCompare({
    paperW: 1000, paperH: 1000, kerf: 0,
    products: [
      { id: 'A', width: 500, height: 500, quantity: 1 },
      { id: 'B', width: 900, height: 100, quantity: 2 },
      { id: 'C', width: 400, height: 400, quantity: 4 },
    ],
  });
  const byKey = Object.fromEntries(r.candidates.map((c) => [c.strategy, c.metrics]));
  assert.strictEqual(byKey['area-desc'].piecesPlaced, 5);
  assert.strictEqual(byKey['longest-side-desc'].piecesPlaced, 6);
  assert.strictEqual(byKey['aspect-diff-desc'].piecesPlaced, 6);

  // 最佳者已排件数必为候选中最多
  const maxPieces = Math.max(...r.candidates.map((c) => c.metrics.piecesPlaced));
  assert.strictEqual(r.best.metrics.piecesPlaced, maxPieces);
  assert.strictEqual(r.best.strategy, 'longest-side-desc');

  // 逐项依据：第一步按件数淘汰面积降序；件数并列的两项一路持平，最终按策略顺序
  assert.strictEqual(r.decision[0].criterion, 'piecesPlaced');
  assert.deepStrictEqual(r.decision[0].survivors, ['longest-side-desc', 'aspect-diff-desc']);
  assert.strictEqual(r.decision[r.decision.length - 1].criterion, 'strategy-order');
});

test('比选：优先省刀排除空方案后按刀数 → 已排面积 → 已排件数 → 策略顺序决胜', () => {
  const input = {
    paperW: 500, paperH: 300, kerf: 5,
    products: [
      { id: 'P1', width: 53, height: 160, quantity: 4 },
      { id: 'P2', width: 189, height: 173, quantity: 2 },
    ],
  };
  const fc = layoutCompare({ ...input, objective: 'fewer-cuts' });
  assert.strictEqual(fc.objective, 'fewer-cuts');
  // 最佳者刀数必为候选中最少
  const minCuts = Math.min(...fc.candidates.map((c) => c.metrics.cutsTotal));
  assert.strictEqual(fc.best.metrics.cutsTotal, minCuts);
  assert.strictEqual(fc.best.strategy, 'aspect-diff-desc'); // 6 刀（其余 10 刀）
  // 逐项依据：首步为排除空方案，随后按刀数
  assert.strictEqual(fc.decision[0].criterion, 'non-empty');
  assert.strictEqual(fc.decision[1].criterion, 'cutsTotal');
  assert.deepStrictEqual(fc.decision[1].survivors, ['aspect-diff-desc']);

  // 同一输入下两种目标选出不同方案：多排选面积降序（6 件），省刀选宽高差降序（6 刀）
  const mp = layoutCompare({ ...input, objective: 'more-pieces' });
  assert.strictEqual(mp.best.strategy, 'area-desc');
  assert.strictEqual(mp.best.metrics.piecesPlaced, 6);
  assert.notStrictEqual(mp.best.strategy, fc.best.strategy);
});

test('比选：全部排不进时不指定最佳项，并沿用现有未排原因', () => {
  const r = layoutCompare({
    paperW: 200, paperH: 200, kerf: 2,
    products: [{ width: 500, height: 500, quantity: 3 }],
  });
  assert.strictEqual(r.best, null);
  assert.ok(r.candidates.every((c) => !c.selected));
  assert.strictEqual(r.decision[0].criterion, 'all-empty');
  assert.deepStrictEqual(r.decision[0].survivors, []);
  // 未排原因沿用现有结构（尺寸不足）
  for (const c of r.candidates) {
    assert.strictEqual(c.layout.unplaced.length, 1);
    assert.strictEqual(c.layout.unplaced[0].quantity, 3);
    assert.strictEqual(c.layout.unplaced[0].total, 3);
    assert.strictEqual(c.layout.unplaced[0].placed, 0);
    assert.strictEqual(c.layout.unplaced[0].grainBlocked, false);
  }

  // 纹向受阻情形：grainBlocked 标记沿用
  const g = layoutCompare({
    paperW: 100, paperH: 300, kerf: 0, paperGrain: 'along-width',
    products: [{ width: 120, height: 40, quantity: 1, grain: 'along-width' }],
  });
  assert.strictEqual(g.best, null);
  for (const c of g.candidates) {
    assert.strictEqual(c.layout.unplaced[0].grainBlocked, true);
  }
});

/* ---------------- 决胜规则（合成候选，精确链式验证） ---------------- */

function cand(strategy, order, m) {
  return { strategy, label: strategy, order, metrics: m };
}

test('决胜：优先多排在件数 / 面积持平时按刀数少者，再持平按策略顺序', () => {
  // 件数持平 → 面积持平 → 刀数少者胜
  const { best, decision } = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 6, placedArea: 900, cutsTotal: 8 }),
    cand('longest-side-desc', 1, { piecesPlaced: 6, placedArea: 900, cutsTotal: 5 }),
    cand('aspect-diff-desc', 2, { piecesPlaced: 6, placedArea: 900, cutsTotal: 7 }),
  ], 'more-pieces');
  assert.strictEqual(best.strategy, 'longest-side-desc');
  assert.deepStrictEqual(decision.map((d) => d.criterion), ['piecesPlaced', 'placedArea', 'cutsTotal']);

  // 全部持平 → 策略顺序（order 最小者）
  const tie = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 6, placedArea: 900, cutsTotal: 5 }),
    cand('longest-side-desc', 1, { piecesPlaced: 6, placedArea: 900, cutsTotal: 5 }),
    cand('aspect-diff-desc', 2, { piecesPlaced: 6, placedArea: 900, cutsTotal: 5 }),
  ], 'more-pieces');
  assert.strictEqual(tie.best.strategy, 'area-desc');
  assert.strictEqual(tie.decision[tie.decision.length - 1].criterion, 'strategy-order');

  // 件数不同 → 直接按件数，不看刀数
  const byPieces = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 4, placedArea: 999, cutsTotal: 1 }),
    cand('longest-side-desc', 1, { piecesPlaced: 6, placedArea: 100, cutsTotal: 30 }),
    cand('aspect-diff-desc', 2, { piecesPlaced: 5, placedArea: 500, cutsTotal: 2 }),
  ], 'more-pieces');
  assert.strictEqual(byPieces.best.strategy, 'longest-side-desc');
});

test('决胜：优先省刀排除空方案，刀数 → 面积 → 件数 → 策略顺序', () => {
  // 空方案刀数为 0 也被排除；非空中刀数最少者胜
  const r = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 0, placedArea: 0, cutsTotal: 0 }),
    cand('longest-side-desc', 1, { piecesPlaced: 3, placedArea: 500, cutsTotal: 4 }),
    cand('aspect-diff-desc', 2, { piecesPlaced: 5, placedArea: 800, cutsTotal: 6 }),
  ], 'fewer-cuts');
  assert.strictEqual(r.best.strategy, 'longest-side-desc');
  assert.strictEqual(r.decision[0].criterion, 'non-empty');
  assert.deepStrictEqual(r.decision[0].survivors, ['longest-side-desc', 'aspect-diff-desc']);

  // 刀数持平 → 面积大者；再持平 → 件数多者；再持平 → 策略顺序
  const tieCuts = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 3, placedArea: 500, cutsTotal: 4 }),
    cand('longest-side-desc', 1, { piecesPlaced: 3, placedArea: 700, cutsTotal: 4 }),
    cand('aspect-diff-desc', 2, { piecesPlaced: 9, placedArea: 100, cutsTotal: 4 }),
  ], 'fewer-cuts');
  assert.strictEqual(tieCuts.best.strategy, 'longest-side-desc'); // 面积 700 最大

  const tieArea = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 3, placedArea: 700, cutsTotal: 4 }),
    cand('longest-side-desc', 1, { piecesPlaced: 5, placedArea: 700, cutsTotal: 4 }),
    cand('aspect-diff-desc', 2, { piecesPlaced: 5, placedArea: 700, cutsTotal: 4 }),
  ], 'fewer-cuts');
  assert.strictEqual(tieArea.best.strategy, 'longest-side-desc'); // 件数 5 最多且顺序靠前

  // 全部为空 → 不指定最佳
  const none = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 0, placedArea: 0, cutsTotal: 0 }),
    cand('longest-side-desc', 1, { piecesPlaced: 0, placedArea: 0, cutsTotal: 0 }),
  ], 'fewer-cuts');
  assert.strictEqual(none.best, null);
  assert.strictEqual(none.decision[0].criterion, 'all-empty');

  // 优先多排不排除空方案：全部为空时同样不指定最佳
  const noneMp = selectBestCandidate([
    cand('area-desc', 0, { piecesPlaced: 0, placedArea: 0, cutsTotal: 0 }),
  ], 'more-pieces');
  assert.strictEqual(noneMp.best, null);
});

/* ---------------- 旧行为保持不变 ---------------- */

test('比选：layout() 默认行为与旧版一致（全局 BSSF、最长边降序件序）', () => {
  const input = {
    paperW: 300, paperH: 200, kerf: 3,
    products: [
      { width: 100, height: 80, quantity: 4 },
      { width: 60, height: 50, quantity: 6 },
    ],
  };
  // 显式传入默认策略（不开启顺序放置）与无参调用完全一致
  assert.deepStrictEqual(
    layout(input),
    layout(input, { sortStrategy: 'longest-side-desc' })
  );
});
