'use strict';

const assert = require('node:assert');
const { test } = require('node:test');
const { layout, layoutBatch } = require('../src/packer');
const { layoutCostBatch } = require('../src/cost');

const EPS = 1e-6;

function rectsOverlap(a, b) {
  return !(
    a.x + a.w <= b.x + EPS || b.x + b.w <= a.x + EPS ||
    a.y + a.h <= b.y + EPS || b.y + b.h <= a.y + EPS
  );
}

/** 隔离开启时，每张纸上的已排成品必须同属一个订单 */
function assertSheetsSingleOrder(sheets) {
  for (const sh of sheets) {
    const orders = new Set(sh.items.map((it) => it.orderNo));
    assert.strictEqual(orders.size, 1, '隔离开启时每张纸只能出现一个订单');
    assert.strictEqual(sh.orderNo, [...orders][0], '纸面订单号与已排件一致');
  }
}

/* ---------------- 兼容性：未开启隔离 / 未填写订单号 ---------------- */

test('订单：未开启隔离时订单号不影响现有行为（混排、结果结构）', () => {
  const base = {
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 5,
    products: [
      { width: 100, height: 100, quantity: 5, orderNo: 'A' },
      { width: 100, height: 100, quantity: 5, orderNo: 'B' },
    ],
  };
  const iso = layoutBatch({ ...base, isolateOrders: true });
  const mix = layoutBatch({ ...base, isolateOrders: false });
  // 混排 10 件恰好 2 张；隔离每张纸仍只放一个订单，但单订单需求也跨张
  // 关键：非隔离结果不带隔离字段
  assert.strictEqual('isolated' in mix, false);
  assert.strictEqual('orderSummary' in mix, false);
  assert.strictEqual('blockedOrders' in mix, false);
  // 非隔离第一张可同时排入两个订单（布局按面积贪心，100×100 可混排）
  const firstOrders = new Set(mix.sheets[0].items.map((it) => it.orderNo));
  assert.ok(firstOrders.size >= 1);
  // 隔离每张仅一个订单，总用纸数 ≥ 非隔离（隔离更保守）
  assert.ok(iso.sheets.length >= mix.sheets.length);
  assertSheetsSingleOrder(iso.sheets);
});

test('订单：开启隔离但所有行均未填订单号时行为同非隔离', () => {
  const args = {
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [{ width: 100, height: 100, quantity: 20 }],
  };
  const r = layoutBatch(args);
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.summary.piecesPlaced, 20);
  assert.strictEqual(r.orderSummary.length, 1);
  assert.strictEqual(r.orderSummary[0].orderNo, null);
  assert.strictEqual(r.blockedOrders.length, 0);
});

test('订单：isolateOrders 非法值与订单号超长校验', () => {
  assert.throws(() => layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 2, isolateOrders: 'yes',
    products: [{ width: 10, height: 10, quantity: 1 }],
  }), /isolateOrders/);
  assert.throws(() => layoutBatch({
    paperW: 100, paperH: 100, kerf: 0, maxSheets: 2, isolateOrders: true,
    products: [{ width: 10, height: 10, quantity: 1, orderNo: 'x'.repeat(65) }],
  }), /订单号/);
  assert.throws(() => layoutCostBatch({
    kerf: 0,
    papers: [
      { name: 'A', width: 100, height: 100, price: 1, stock: 2 },
      { name: 'B', width: 200, height: 200, price: 2, stock: 2 },
    ],
    isolateOrders: 1,
    products: [{ width: 10, height: 10, quantity: 1 }],
  }), /isolateOrders/);
});

/* ---------------- 批量隔离 ---------------- */

test('批量隔离：每张纸仅一个订单，逐张标明订单号并按订单汇总', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { name: 'A件', width: 100, height: 100, quantity: 4, orderNo: 'OA' },
      { name: 'B件', width: 100, height: 100, quantity: 4, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.isolated, true);
  assert.strictEqual(r.sheets.length, 2);
  assertSheetsSingleOrder(r.sheets);
  assert.deepStrictEqual(r.sheets.map((s) => s.orderNo), ['OA', 'OB']);
  const oa = r.orderSummary.find((o) => o.orderNo === 'OA');
  const ob = r.orderSummary.find((o) => o.orderNo === 'OB');
  assert.deepStrictEqual([oa.total, oa.placed, oa.quantity, oa.completionRate], [4, 4, 0, 1]);
  assert.deepStrictEqual([ob.total, ob.placed, ob.quantity, ob.completionRate], [4, 4, 0, 1]);
  // 录入顺序：OA 在前
  assert.ok(r.orderSummary[0].orderNo === 'OA' && r.orderSummary[1].orderNo === 'OB');
  assert.strictEqual(r.blockedOrders.length, 0);
});

test('批量隔离：每轮按本张已排面积大、件数多、录入顺序选订单', () => {
  // 100×100 每件面积相同：每张排得下多少取决于订单剩余件数；
  // 两件数相同的订单决胜按录入顺序。OA、OB 各 4 件，300×300 每张 9 格 →
  // 各订单每张可排 4 件，同分 → 录入顺序 OA 先排
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { width: 100, height: 100, quantity: 4, orderNo: 'OB' },
      { width: 100, height: 100, quantity: 4, orderNo: 'OA' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  // 两个订单各自一张，订单排序按“首次出现的成品行”——OB 行录入在前
  assert.strictEqual(r.orderSummary[0].orderNo, 'OB');
  assert.strictEqual(r.sheets[0].orderNo, 'OB');
  assert.strictEqual(r.sheets[1].orderNo, 'OA');
});

test('批量隔离：件数相同但面积不同，本张已排面积大者先排', () => {
  // 大件订单：150×150×2 = 45000mm²/张；小件订单：80×80×2，每张可排多件但
  // 仅 2 件需求 = 12800mm²。两件数相同（各排 2）时面积大的订单先排。
  const r = layoutBatch({
    paperW: 320, paperH: 320, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { width: 80, height: 80, quantity: 2, orderNo: 'SMALL' },
      { width: 150, height: 150, quantity: 2, orderNo: 'BIG' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  // 第一轮两订单都只能各排自己的 2 件，面积 BIG 更大 → BIG 先
  assert.strictEqual(r.sheets[0].orderNo, 'BIG');
  assert.strictEqual(r.sheets[0].stats.piecesPlaced, 2);
});

test('批量隔离：任一订单在纸型上无进展立即止损，不生成空白纸', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { width: 100, height: 100, quantity: 4, orderNo: 'OA' },
      { width: 500, height: 500, quantity: 1, orderNo: 'OB' }, // 任何纸都放不下
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0); // 本轮不提交任何纸张
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.strictEqual(r.blockedOrders.length, 1);
  assert.strictEqual(r.blockedOrders[0].orderNo, 'OB');
  assert.strictEqual(r.blockedOrders[0].quantity, 1);
  // 未提交纸张，OA 需求原封不动
  const oa = r.orderSummary.find((o) => o.orderNo === 'OA');
  assert.strictEqual(oa.placed, 0);
  assert.strictEqual(oa.quantity, 4);
});

test('批量隔离：已排若干张后出现永久受阻订单，保留已排、止损且不出空白纸', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { name: '小件', width: 80, height: 80, quantity: 4, orderNo: 'OA' },
      { name: '大件', width: 400, height: 400, quantity: 1, orderNo: 'OA' },
      { name: 'B件', width: 100, height: 100, quantity: 2, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  for (const sh of r.sheets) assert.ok(sh.stats.piecesPlaced > 0, '不应有空白纸');
  assert.ok(r.sheets.length >= 1);
  assert.strictEqual(r.blockedOrders.length, 1);
  assert.strictEqual(r.blockedOrders[0].orderNo, 'OA');
  const big = r.remaining.find((u) => u.name === '大件');
  assert.strictEqual(big.quantity, 1);
  // 已排数 + 剩余数 = 总需求（按订单口径核对）
  const total = r.orderSummary.reduce((s, o) => s + o.total, 0);
  const placed = r.orderSummary.reduce((s, o) => s + o.placed, 0);
  const remain = r.orderSummary.reduce((s, o) => s + o.quantity, 0);
  assert.strictEqual(placed + remain, total);
  assert.strictEqual(placed, r.summary.piecesPlaced);
});

test('批量隔离：未填写订单号的行同组混排，但不与具名订单同纸', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 300, kerf: 0, maxSheets: 10, isolateOrders: true,
    products: [
      { width: 100, height: 100, quantity: 2 }, // 未填订单号
      { width: 100, height: 100, quantity: 2, orderNo: 'OA' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assertSheetsSingleOrder(r.sheets);
  // 未填组的纸面 orderNo 为 null，OA 的纸面为 'OA'
  const nullSheet = r.sheets.find((s) => s.orderNo === null);
  const oaSheet = r.sheets.find((s) => s.orderNo === 'OA');
  assert.ok(nullSheet && oaSheet);
  assert.ok(nullSheet.items.every((it) => it.orderNo === null));
  const nullOrder = r.orderSummary.find((o) => o.orderNo === null);
  assert.strictEqual(nullOrder.total, 2);
});

test('批量隔离：达到用纸上限即停，订单汇总正确反映部分完成', () => {
  const r = layoutBatch({
    paperW: 300, paperH: 200, kerf: 0, maxSheets: 1, isolateOrders: true,
    products: [
      { width: 100, height: 100, quantity: 20, orderNo: 'OA' },
      { width: 100, height: 100, quantity: 20, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'max-sheets');
  assert.strictEqual(r.sheets.length, 1);
  const sums = r.orderSummary.map((o) => [o.placed, o.quantity]);
  // 一张纸只属于一个订单：一个订单 6/20，另一个 0/20
  const totals = sums.map(([p, q]) => p + q);
  assert.deepStrictEqual(totals, [20, 20]);
  assert.ok(sums.some(([p]) => p === 6));
  assert.ok(sums.some(([p]) => p === 0));
});

/* ---------------- 多纸型成本隔离 ---------------- */

test('成本隔离：联合比较“订单 × 纸型”候选，逐张只含一个订单', () => {
  const r = layoutCostBatch({
    kerf: 0,
    isolateOrders: true,
    papers: [
      { name: '大纸', width: 300, height: 300, price: 10, stock: 5 },
      { name: '小纸', width: 100, height: 100, price: 2, stock: 20 },
    ],
    products: [
      { width: 100, height: 100, quantity: 3, orderNo: 'OA' },
      { width: 100, height: 100, quantity: 1, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.isolated, true);
  assertSheetsSingleOrder(r.sheets.map((s) => s.layout));
  for (const sh of r.sheets) {
    assert.ok('orderNo' in sh, '逐张结果标明订单号');
    // 排名列出本轮全部“订单 × 纸型”可行候选
    for (const c of sh.selection.ranked) {
      assert.ok('orderNo' in c, '候选须带订单号');
      assert.ok(c.orderNo != null, '候选必须属于某个订单');
    }
    const winner = sh.selection.ranked.find((c) => c.selected);
    assert.strictEqual(winner.orderNo, sh.orderNo);
    assert.strictEqual(winner.paperId, sh.paperId);
  }
  // 小件单张单位面积成本一样；大纸 9 件但该订单只有个位数需求 → 小纸更优
  assert.ok(r.sheets.every((s) => s.paperId === 'S2'));
});

test('成本隔离：选中后只扣减该订单需求与该纸型库存（守恒）', () => {
  const r = layoutCostBatch({
    kerf: 0,
    isolateOrders: true,
    papers: [
      { name: '纸A', width: 250, height: 250, price: 1, stock: 3 },
      { name: '纸B', width: 200, height: 200, price: 2, stock: 3 },
    ],
    products: [
      { name: '甲', width: 100, height: 100, quantity: 4, orderNo: 'OA' },
      { name: '乙', width: 60, height: 60, quantity: 8, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  // 库存守恒：已用之和 = 用纸数
  const usedSum = r.usage.reduce((s, u) => s + u.used, 0);
  assert.strictEqual(usedSum, r.sheets.length);
  for (const u of r.usage) assert.strictEqual(u.remainingStock, u.stock - u.used);
  // 每张只扣其所属订单：各订单汇总需求守恒
  for (const o of r.orderSummary) {
    assert.strictEqual(o.placed + o.quantity, o.total);
  }
  // 每张布局合法且成品互不重叠、在对应纸面内
  for (const sh of r.sheets) {
    const W = sh.paperWidth;
    const H = sh.paperHeight;
    for (const it of sh.layout.items) {
      assert.ok(it.x + it.w <= W + EPS && it.y + it.h <= H + EPS);
    }
    const items = sh.layout.items;
    for (let i = 0; i < items.length; i++) {
      for (let j = i + 1; j < items.length; j++) {
        assert.ok(!rectsOverlap(items[i], items[j]), '同张成品不应重叠');
      }
    }
  }
});

test('成本隔离：某订单仅特定纸型可行时，只能由该纸型排该订单', () => {
  // OA 成品 120×40 要求沿自身宽：窄纸 100×300（沿宽）纹向不可行；
  // OB 100×100 两种纸都可行。OA 的候选里只能出现宽纸 S2。
  const r = layoutCostBatch({
    kerf: 0,
    isolateOrders: true,
    papers: [
      { name: '窄纸', width: 100, height: 300, grain: 'along-width', price: 0.1, stock: 5 },
      { name: '宽纸', width: 310, height: 130, grain: 'along-width', price: 5, stock: 5 },
    ],
    products: [
      { width: 120, height: 40, quantity: 2, grain: 'along-width', orderNo: 'OA' },
      { width: 90, height: 90, quantity: 4, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'completed');
  const oaSheets = r.sheets.filter((s) => s.orderNo === 'OA');
  assert.ok(oaSheets.length > 0);
  assert.ok(oaSheets.every((s) => s.paperId === 'S2'), '纹向不可行的窄纸不能排 OA');
  for (const sh of oaSheets) {
    assert.ok(
      sh.selection.ranked.filter((c) => c.orderNo === 'OA').every((c) => c.paperId === 'S2'),
      'OA 候选中不应出现纹向不可行纸型'
    );
  }
  // 窄纸库存未被 OA 误扣
  const narrow = r.usage.find((u) => u.name === '窄纸');
  assert.ok(r.sheets
    .filter((s) => s.paperId === 'S1')
    .every((s) => s.orderNo === 'OB'));
  assert.strictEqual(narrow.remainingStock, narrow.stock - narrow.used);
});

test('成本隔离：任一订单在所有可用纸型均无进展时止损，不扣库存不出空白纸', () => {
  const r = layoutCostBatch({
    kerf: 2,
    isolateOrders: true,
    papers: [
      { name: '小纸A', width: 200, height: 200, price: 1, stock: 3 },
      { name: '小纸B', width: 150, height: 150, price: 0.5, stock: 3 },
    ],
    products: [
      { width: 100, height: 100, quantity: 2, orderNo: 'OA' },
      { width: 500, height: 500, quantity: 1, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.strictEqual(r.sheets.length, 0);
  assert.strictEqual(r.summary.totalCost, 0);
  assert.strictEqual(r.summary.sheetsUsed, 0);
  assert.deepStrictEqual(r.usage.map((u) => u.remainingStock), [3, 3]);
  assert.strictEqual(r.blockedOrders.length, 1);
  assert.strictEqual(r.blockedOrders[0].orderNo, 'OB');
  assert.strictEqual(r.blockedOrders[0].quantity, 1);
  // OA 未被误扣
  const oa = r.orderSummary.find((o) => o.orderNo === 'OA');
  assert.strictEqual(oa.placed, 0);
  assert.strictEqual(oa.quantity, 2);
});

test('成本隔离：部分订单完成后出现受阻订单，已排纸张保留、库存只扣已提交', () => {
  const r = layoutCostBatch({
    kerf: 0,
    isolateOrders: true,
    papers: [
      { name: '纸A', width: 300, height: 300, price: 1, stock: 5 },
      { name: '纸B', width: 250, height: 250, price: 1, stock: 5 },
    ],
    products: [
      { name: '小件', width: 80, height: 80, quantity: 4, orderNo: 'OA' },
      { name: '大件', width: 400, height: 400, quantity: 1, orderNo: 'OA' },
      { name: 'B件', width: 100, height: 100, quantity: 2, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'no-progress');
  assert.ok(r.sheets.length >= 1);
  for (const sh of r.sheets) {
    assert.ok(sh.piecesPlaced > 0, '不应有空白纸');
    assert.ok(sh.orderNo === 'OA' || sh.orderNo === 'OB');
  }
  // 库存只按已提交张数扣减
  const usedSum = r.usage.reduce((s, u) => s + u.used, 0);
  assert.strictEqual(usedSum, r.sheets.length);
  assert.strictEqual(r.blockedOrders[0].orderNo, 'OA');
  // 件数守恒
  const placedSum = r.sheets.reduce((s, sh) => s + sh.piecesPlaced, 0);
  const remainSum = r.remaining.reduce((s, u) => s + u.quantity, 0);
  assert.strictEqual(placedSum + remainSum, 7);
  assert.strictEqual(placedSum, r.summary.piecesPlaced);
});

test('成本隔离：库存耗尽终止时各订单汇总与剩余正确', () => {
  const r = layoutCostBatch({
    kerf: 0,
    isolateOrders: true,
    papers: [
      { name: '纸A', width: 100, height: 100, price: 1, stock: 1 },
      { name: '纸B', width: 100, height: 100, price: 1, stock: 1 },
    ],
    products: [
      { width: 100, height: 100, quantity: 3, orderNo: 'OA' },
      { width: 100, height: 100, quantity: 2, orderNo: 'OB' },
    ],
  });
  assert.strictEqual(r.stopReason, 'stock-exhausted');
  assert.strictEqual(r.sheets.length, 2);
  assertSheetsSingleOrder(r.sheets.map((s) => s.layout));
  assert.strictEqual(r.summary.piecesPlaced, 2);
  // 每张归一个订单，两个订单各至少 0；总剩余 = 3
  const remain = r.orderSummary.reduce((s, o) => s + o.quantity, 0);
  assert.strictEqual(remain, 3);
});

test('成本隔离：空需求直接完成，返回空订单汇总且不用纸', () => {
  const r = layoutCostBatch({
    kerf: 0,
    isolateOrders: true,
    papers: [
      { name: 'A', width: 100, height: 100, price: 1, stock: 2 },
      { name: 'B', width: 200, height: 200, price: 2, stock: 2 },
    ],
    products: [],
  });
  assert.strictEqual(r.stopReason, 'completed');
  assert.strictEqual(r.sheets.length, 0);
  assert.deepStrictEqual(r.orderSummary, []);
  assert.deepStrictEqual(r.blockedOrders, []);
});

/* ---------------- 单张：订单号透传 ---------------- */

test('单张：items 与 unplaced 透传订单号（不影响布局）', () => {
  const withOrder = layout({
    paperW: 200, paperH: 200, kerf: 0,
    products: [
      { width: 100, height: 100, quantity: 3, orderNo: 'X1' },
      { width: 150, height: 150, quantity: 1, orderNo: 'X2' },
    ],
  });
  const plain = layout({
    paperW: 200, paperH: 200, kerf: 0,
    products: [
      { width: 100, height: 100, quantity: 3 },
      { width: 150, height: 150, quantity: 1 },
    ],
  });
  assert.strictEqual(withOrder.stats.piecesPlaced, plain.stats.piecesPlaced);
  assert.ok(withOrder.items.every((it) => typeof it.orderNo === 'string'));
  assert.strictEqual(withOrder.items[0].orderNo === 'X1'
    || withOrder.items[0].orderNo === 'X2', true);
  assert.ok(plain.items.every((it) => it.orderNo === null));
});
