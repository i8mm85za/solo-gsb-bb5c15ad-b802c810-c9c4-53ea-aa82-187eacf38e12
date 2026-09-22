'use strict';

/**
 * 单张纸断头台式（guillotine）二分排样
 *
 * 规则：
 *  - 每次切割把当前矩形区域一分为二（刀缝宽 kerf 居中于切口带）
 *  - 成品允许旋转 90°，但受纹向约束：纸张纹向（沿宽/沿高）与成品要求
 *    （不限/沿自身宽/沿自身高）平行时才允许该朝向
 *  - 切割带与成品互不重叠，即切割不侵占成品
 *  - 排不下的成品保留在 unplaced 列表中（注明尺寸/纹向受阻原因）
 */

const EPS = 1e-6;

const round3 = (v) => Math.round(v * 1000) / 1000;

/* ---------------- 纹向（grain direction） ---------------- */

const PAPER_GRAINS = ['along-width', 'along-height'];
const PRODUCT_GRAINS = ['any', 'along-width', 'along-height'];

/** 规范化纸张纹向：缺省沿宽（对“不限”成品无影响，保持旧行为） */
function normalizePaperGrain(value, subject = '纸张') {
  if (value == null || value === '') return 'along-width';
  const s = String(value);
  if (!PAPER_GRAINS.includes(s)) {
    throw new Error(`${subject}纹向必须是 along-width（沿宽）或 along-height（沿高）`);
  }
  return s;
}

/** 规范化成品纹向要求：缺省不限 */
function normalizeProductGrain(value, pos) {
  if (value == null || value === '') return 'any';
  const s = String(value);
  if (!PRODUCT_GRAINS.includes(s)) {
    throw new Error(
      `第 ${pos} 种成品的纹向要求必须是 any（不限）、along-width（沿自身宽）或 along-height（沿自身高）`
    );
  }
  return s;
}

/* ---------------- 订单隔离（order isolation） ---------------- */

/**
 * 规范化成品行填写的订单号：缺省（null/空串）表示未填写订单号，
 * 不参与订单隔离；填写后去空白，长度 ≤ 64。
 */
function normalizeOrderNo(value, pos) {
  if (value == null) return null;
  const s = String(value).trim();
  if (!s) return null;
  if (s.length > 64) {
    throw new Error(`第 ${pos} 种成品的订单号长度不能超过 64 个字符`);
  }
  return s;
}

/** 规范化顶层 isolateOrders 开关：必须是布尔值（缺省 false，保持旧行为） */
function normalizeIsolateOrders(value) {
  if (value == null) return false;
  if (typeof value !== 'boolean') {
    throw new Error('isolateOrders（每张纸仅排一个订单）必须是布尔值');
  }
  return value;
}

/* ---------------- 成套生产（kit / set production） ---------------- */

const KIT_MAX_SETS = 100000; // 计划套数上限
const KIT_MAX_PER_SET = 100000; // 单品种每套用量上限
// 单次试排展开件数安全阀：仅在极小成品（数毫米级）等极端输入下触及，
// 正常印刷成品（名片级以上）的整纸张数远低于此值
const KIT_MAX_TRIAL_PIECES = 50000;

/**
 * 规范化顶层 kit（成套生产）开关：
 * 缺省 / false 表示不启用（旧行为）；启用时必须为
 *   { plannedSets: 正整数（≤100000） }
 * 成套生产与订单隔离互斥（不允许同时开启）。
 */
function normalizeKit(value, { isolateOrders = false } = {}) {
  if (value == null || value === false) return null;
  if (typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('kit（成套生产）必须是包含 plannedSets 的对象');
  }
  if (isolateOrders) {
    throw new Error('成套生产模式不能与订单隔离（isolateOrders）同时开启');
  }
  const plannedSets = Number(value.plannedSets);
  if (!Number.isInteger(plannedSets) || plannedSets < 1) {
    throw new Error('计划套数（plannedSets）必须是正整数');
  }
  if (plannedSets > KIT_MAX_SETS) {
    throw new Error(`计划套数不能超过 ${KIT_MAX_SETS}`);
  }
  return { plannedSets };
}

/**
 * 规范化成品的“每套用量”：成套模式下每个品种必填正整数。
 */
function normalizePerSet(value, pos) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error(`第 ${pos} 种成品的每套用量必须是正整数`);
  }
  if (n > KIT_MAX_PER_SET) {
    throw new Error(`第 ${pos} 种成品的每套用量不能超过 ${KIT_MAX_PER_SET}`);
  }
  return n;
}

/**
 * 成套模式下按原始成品行规范化品种清单（批量/成本共用）：
 * 每行以 perSet（正整数）× plannedSets 作为该品种总需求。
 * @returns [{ id, name, width, height, grain, orderNo, perSet,
 *            quantity(=perSet×plannedSets), seq }]
 */
function normalizeKitProducts(rawProducts, plannedSets) {
  if (!Array.isArray(rawProducts)) throw new Error('缺少成品列表');
  const rows = [];
  rawProducts.forEach((raw, idx) => {
    const pos = idx + 1;
    if (!raw || typeof raw !== 'object') {
      throw new Error(`第 ${pos} 种成品不是有效记录`);
    }
    const w = Number(raw.width);
    const h = Number(raw.height);
    if (![w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
      throw new Error(`第 ${pos} 种成品的宽高必须为正数`);
    }
    const perSetVal = normalizePerSet(raw.perSet, pos);
    const grain = normalizeProductGrain(raw.grain, pos);
    const orderNo = normalizeOrderNo(raw.orderNo, pos);
    const id = raw.id != null ? String(raw.id) : `P${pos}`;
    const name = raw.name && String(raw.name).trim() ? String(raw.name).trim() : '';
    rows.push({
      id, name, width: w, height: h, grain, orderNo,
      perSet: perSetVal, quantity: perSetVal * plannedSets, seq: idx,
    });
  });
  if (rows.length === 0) throw new Error('成套生产至少需要一种成品（填写每套用量）');
  return rows;
}

/**
 * 校验并规范化成品清单（排产驱动共用，保证跨张 id/纹向/订单号稳定）。
 * @returns 规范化后的成品行（quantity > 0）：
 *   { id, name, width, height, grain, orderNo, quantity, seq }
 *   seq 为该行在原始请求中的下标（录入顺序决胜依据）
 */
function normalizeProducts(rawProducts) {
  if (!Array.isArray(rawProducts)) throw new Error('缺少成品列表');
  const out = [];
  rawProducts.forEach((p, idx) => {
    const pos = idx + 1;
    if (!p || typeof p !== 'object') {
      throw new Error(`第 ${pos} 种成品不是有效记录`);
    }
    const w = Number(p.width);
    const h = Number(p.height);
    const q = Math.floor(Number(p.quantity));
    if (![w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
      throw new Error(`第 ${pos} 种成品的宽高必须为正数`);
    }
    if (!Number.isFinite(q) || q < 0) {
      throw new Error(`第 ${pos} 种成品的数量无效`);
    }
    const grain = normalizeProductGrain(p.grain, pos);
    const orderNo = normalizeOrderNo(p.orderNo, pos);
    const id = p.id != null ? String(p.id) : `P${pos}`;
    const name = p.name && String(p.name).trim() ? String(p.name).trim() : '';
    if (q > 0) out.push({ id, name, width: w, height: h, grain, orderNo, quantity: q, seq: idx });
  });
  return out;
}

/**
 * 纹向是否允许某放置朝向（两者纹向平行才可采用）：
 *  - 不限（any）：两种朝向均可；
 *  - 未旋转：成品宽 ∥ 纸张宽，要求须与纸张纹向一致；
 *  - 旋转 90°：成品宽 ∥ 纸张高，要求须与纸张纹向相反。
 */
function grainAllows(productGrain, paperGrain, rotated) {
  if (productGrain === 'any') return true;
  return rotated ? productGrain !== paperGrain : productGrain === paperGrain;
}

/** 数组字典序比较：a < b（元素均为数字） */
function lexLess(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (Math.abs(a[i] - b[i]) > EPS) return a[i] < b[i];
  }
  return false;
}

/* ---------------- 件序策略（sort strategies） ---------------- */

// 件序比较子：均按降序（大者先排）；键相同的件由稳定排序保持录入相对顺序
const byAreaDesc = (a, b) => b.w * b.h - a.w * a.h;
const byLongestSideDesc = (a, b) => Math.max(b.w, b.h) - Math.max(a.w, a.h);
const byShortestSideDesc = (a, b) => Math.min(b.w, b.h) - Math.min(a.w, a.h);
const byAspectDiffDesc = (a, b) => Math.abs(b.w - b.h) - Math.abs(a.w - a.h);

/** 依次按键比较，全部相同返回 0（交由稳定排序保持录入顺序，保证确定性） */
function chainCompare(...fns) {
  return (a, b) => {
    for (const fn of fns) {
      const d = fn(a, b);
      if (d !== 0) return d;
    }
    return 0;
  };
}

/**
 * 三种确定性排样策略（仅件序不同，放置评分 / 切分 / 纹向规则完全一致）：
 *  - area-desc         面积降序：面积 → 最长边 → 最短边
 *  - longest-side-desc 最长边降序（单张默认，保持旧行为）：最长边 → 面积 → 最短边
 *  - aspect-diff-desc  宽高差降序：|宽−高| → 面积 → 最长边 → 最短边
 */
const PIECE_SORTS = {
  'area-desc': chainCompare(byAreaDesc, byLongestSideDesc, byShortestSideDesc),
  'longest-side-desc': chainCompare(byLongestSideDesc, byAreaDesc, byShortestSideDesc),
  'aspect-diff-desc': chainCompare(byAspectDiffDesc, byAreaDesc, byLongestSideDesc, byShortestSideDesc),
};

const DEFAULT_SORT_STRATEGY = 'longest-side-desc';

/**
 * 在 W×H 区域左上角放置 w×h 后，计算切分方案（纯几何）。
 * 规则：
 *  - 只在余料够一条刀缝时下刀（kerf=0 时余料大于 EPS 才切）
 *  - 两侧都有余料时，沿较短余料方向先切第一刀（切掉窄条、
 *    保留一条完整宽料带）；平局横切优先
 *
 * @returns { orient:'none'|'v'|'h'|'vv'|'hh', frees:[{x,y,w,h}相对区域] }
 *   'v' 仅竖切一刀；'h' 仅横切一刀；
 *   'vv' 先竖后横两刀；'hh' 先横后竖两刀
 */
function splitPlan(W, H, w, h, kerf) {
  const remW = W - w;
  const remH = H - h;
  const canV = remW > EPS && remW >= kerf - EPS;
  const canH = remH > EPS && remH >= kerf - EPS;

  if (!canV && !canH) return { orient: 'none', frees: [] };

  if (canV && !canH) {
    return {
      orient: 'v',
      frees: [{ x: w + kerf, y: 0, w: W - w - kerf, h: H }],
    };
  }
  if (!canV && canH) {
    return {
      orient: 'h',
      frees: [{ x: 0, y: h + kerf, w: W, h: H - h - kerf }],
    };
  }

  // 两侧都有余料：沿较短余料方向先切
  if (remW < remH) {
    // 先竖切：右侧整带 + 左下块
    return {
      orient: 'vv',
      frees: [
        { x: w + kerf, y: 0, w: W - w - kerf, h: H },
        { x: 0, y: h + kerf, w, h: H - h - kerf },
      ],
    };
  }

  // 先横切（平局也走这里）：底部整带 + 右上块
  return {
    orient: 'hh',
    frees: [
      { x: 0, y: h + kerf, w: W, h: H - h - kerf },
      { x: w + kerf, y: 0, w: W - w - kerf, h },
    ],
  };
}

/**
 * 在自由矩形 leaf 内左上角占据 w×h，按 splitPlan 建树。
 */
function occupy(leaf, w, h, kerf, piece) {
  const { x, y } = leaf;
  const W = leaf.w;
  const H = leaf.h;
  const plan = splitPlan(W, H, w, h, kerf);

  const itemNode = { type: 'item', x, y, w, h, piece };
  if (plan.orient === 'none') return itemNode;

  if (plan.orient === 'v') {
    return {
      type: 'cut', x, y, w: W, h: H, orient: 'v',
      bx: x + w, by: y, bw: kerf, bh: H,
      children: [
        itemNode,
        { type: 'free', x: x + w + kerf, y, w: W - w - kerf, h: H },
      ],
    };
  }

  if (plan.orient === 'h') {
    return {
      type: 'cut', x, y, w: W, h: H, orient: 'h',
      bx: x, by: y + h, bw: W, bh: kerf,
      children: [
        itemNode,
        { type: 'free', x, y: y + h + kerf, w: W, h: H - h - kerf },
      ],
    };
  }

  if (plan.orient === 'vv') {
    // 第一刀竖切（贯穿），第二刀在左侧块内横切
    return {
      type: 'cut', x, y, w: W, h: H, orient: 'v',
      bx: x + w, by: y, bw: kerf, bh: H,
      children: [
        {
          type: 'cut', x, y, w, h: H, orient: 'h',
          bx: x, by: y + h, bw: w, bh: kerf,
          children: [
            itemNode,
            { type: 'free', x, y: y + h + kerf, w, h: H - h - kerf },
          ],
        },
        { type: 'free', x: x + w + kerf, y, w: W - w - kerf, h: H },
      ],
    };
  }

  // hh：第一刀横切（贯穿），第二刀在上侧块内竖切
  return {
    type: 'cut', x, y, w: W, h: H, orient: 'h',
    bx: x, by: y + h, bw: W, bh: kerf,
    children: [
      {
        type: 'cut', x, y, w: W, h, orient: 'v',
        bx: x + w, by: y, bw: kerf, bh: h,
        children: [
          itemNode,
          { type: 'free', x: x + w + kerf, y, w: W - w - kerf, h },
        ],
      },
      { type: 'free', x, y: y + h + kerf, w: W, h: H - h - kerf },
    ],
  };
}

function collectFreeLeaves(node, out) {
  if (node.type === 'free') {
    if (node.w > EPS && node.h > EPS) out.push(node);
    return;
  }
  if (node.type === 'item') return;
  for (const child of node.children) collectFreeLeaves(child, out);
}

/**
 * 主入口
 * @param {object} input
 *   paperW, paperH, kerf: number(mm)
 *   paperGrain: 'along-width' | 'along-height'（纸张纹向，缺省沿宽）
 *   products: [{ id?, name?, width, height, quantity,
 *                grain?: 'any' | 'along-width' | 'along-height' }]（纹向要求，缺省不限）
 * @param {object} [opts]
 *   sortStrategy: 件序策略（缺省 longest-side-desc，保持旧行为；
 *                 方案比选依次传入三种策略，见 PIECE_SORTS）
 *   sequential:   true 时按件序逐件取最优叶放置（方案比选用）；
 *                 缺省 false 为全局 BSSF（每轮全候选择优，保持旧行为）
 * @returns 布局结果（坐标单位均为 mm，原点在左上角）
 */
function layout(input, opts = {}) {
  const sortStrategy = (opts && opts.sortStrategy) || DEFAULT_SORT_STRATEGY;
  const pieceSort = PIECE_SORTS[sortStrategy];
  if (!pieceSort) throw new Error(`未知的排样策略：${sortStrategy}`);
  const sequential = !!(opts && opts.sequential);
  const paperW = Number(input.paperW);
  const paperH = Number(input.paperH);
  const kerf = Number(input.kerf);
  if (![paperW, paperH, kerf].every((n) => Number.isFinite(n))) {
    throw new Error('纸张尺寸或刀缝宽度不是有效数字');
  }
  if (paperW <= 0 || paperH <= 0) throw new Error('纸张宽高必须大于 0');
  if (kerf < 0) throw new Error('刀缝宽度不能为负');
  const paperGrain = normalizePaperGrain(input.paperGrain);
  if (!Array.isArray(input.products)) throw new Error('缺少成品列表');

  // 展开为单件列表
  let pieces = [];
  const unplaced = [];
  let totalPieces = 0;
  input.products.forEach((p, idx) => {
    const w = Number(p.width);
    const h = Number(p.height);
    const q = Math.floor(Number(p.quantity));
    if (![w, h].every((n) => Number.isFinite(n)) || w <= 0 || h <= 0) {
      throw new Error(`第 ${idx + 1} 种成品的宽高必须为正数`);
    }
    if (!Number.isFinite(q) || q < 0) {
      throw new Error(`第 ${idx + 1} 种成品的数量无效`);
    }
    const grain = normalizeProductGrain(p.grain, idx + 1);
    const orderNo = normalizeOrderNo(p.orderNo, idx + 1);
    const id = p.id != null ? String(p.id) : `P${idx + 1}`;
    const name = p.name && String(p.name).trim() ? String(p.name).trim() : '';
    for (let n = 1; n <= q; n++) {
      pieces.push({ id, name, w, h, grain, orderNo, pieceNo: n });
    }
    totalPieces += q;
    if (q > 0) unplaced.push({ id, name, width: w, height: h, grain, orderNo, quantity: q });
  });

  // 大件优先：按所选件序策略排序（默认最长边降序 → 面积 → 最短边）
  pieces.sort(pieceSort);

  // 初始整张纸为一个自由区域
  let root = { type: 'free', x: 0, y: 0, w: paperW, h: paperH };
  let freeLeaves = [root];

  const remaining = new Map(pieces.map((p) => [p, p]));
  let placedCount = 0;

  // BSSF 评分（与原“取余料数组排序”完全等价，但不分配数组）：
  // 余料总面积 → 最大余料块短边 → 长边 → 是否旋转
  function score(leaf, piece, rotated) {
    const w = rotated ? piece.h : piece.w;
    const h = rotated ? piece.w : piece.h;
    const W = leaf.w;
    const H = leaf.h;
    // 与 splitPlan 完全一致的可切判定
    const remW = W - w;
    const remH = H - h;
    const canV = remW > EPS && remW >= kerf - EPS;
    const canH = remH > EPS && remH >= kerf - EPS;
    // 注意：恰好填满（两侧都不可切）时 splitPlan 为 'none'，
    // 原算法仍以零余料的满分（0,0,0,...）登记该候选，故不能提前跳过。

    let leftover = 0;
    let bigArea = -1;
    let bigMin = 0;
    let bigMax = 0;
    const addFree = (fw, fh) => {
      if (fw > EPS && fh > EPS) {
        const a = fw * fh;
        leftover += a;
        if (a > bigArea) {
          bigArea = a;
          bigMin = fw < fh ? fw : fh;
          bigMax = fw < fh ? fh : fw;
        }
      }
    };
    if (canV && !canH) {
      addFree(remW - kerf, H);
    } else if (!canV && canH) {
      addFree(W, remH - kerf);
    } else if (remW < remH) {
      // vv：右侧整带 + 左下块
      addFree(remW - kerf, H);
      addFree(w, remH - kerf);
    } else {
      // hh（平局也走这里）：底部整带 + 右上块
      addFree(W, remH - kerf);
      addFree(remW - kerf, h);
    }

    return { leaf, piece, rotated, w, h, s0: leftover, s1: bigMin, s2: bigMax, s3: rotated ? 1 : 0 };
  }

  // 候选 c 是否优于当前 best（评分字典序，严格更小才替换，平局保持先到者）
  function better(c, best) {
    return Math.abs(c.s0 - best.s0) > EPS ? c.s0 < best.s0
      : Math.abs(c.s1 - best.s1) > EPS ? c.s1 < best.s1
      : Math.abs(c.s2 - best.s2) > EPS ? c.s2 < best.s2
      : c.s3 < best.s3;
  }

  // 在 leaf 内为 piece 收集两种朝向的候选（纹向平行且几何放得下才考虑）
  function considerPiece(best, leaf, piece) {
    // 不旋转（成品宽 ∥ 纸张宽）：纹向平行才考虑
    if (
      grainAllows(piece.grain, paperGrain, false) &&
      piece.w <= leaf.w + EPS && piece.h <= leaf.h + EPS
    ) {
      const c = score(leaf, piece, false);
      if (!best || better(c, best)) best = c;
    }
    // 旋转 90°（成品宽 ∥ 纸张高）：纹向平行才考虑
    if (
      grainAllows(piece.grain, paperGrain, true) &&
      piece.h <= leaf.w + EPS && piece.w <= leaf.h + EPS
    ) {
      const c = score(leaf, piece, true);
      if (!best || better(c, best)) best = c;
    }
    return best;
  }

  // 提交一次放置：占据叶节点、建树、增量维护自由叶列表
  function place(best) {
    const { leaf, piece, rotated, w, h } = best;
    piece.rotated = rotated;
    piece.x = leaf.x;
    piece.y = leaf.y;
    piece.placedW = w;
    piece.placedH = h;

    const oldLeaf = leaf;
    const node = occupy(leaf, w, h, kerf, piece);
    if (leaf === root) {
      root = node;
    } else {
      // 用新子树原地替换自由叶节点
      Object.assign(leaf, node);
    }

    remaining.delete(piece);
    placedCount += 1;

    // 增量维护自由叶列表：新子树恰好在旧叶的 DFS 位置展开为其自由叶，
    // splice 替换后顺序与全树 DFS 收集完全一致（保证平分平局时行为不变）
    const added = [];
    collectFreeLeaves(node, added);
    const idx = freeLeaves.indexOf(oldLeaf);
    if (idx >= 0) freeLeaves.splice(idx, 1, ...added);
  }

  if (sequential) {
    // 顺序放置（方案比选用）：按件序逐件在当前自由区域中取 BSSF 最优位置，
    // 排不进的件留作未排并继续下一件。自由区域只会被越切越小
    // （后续自由矩形必为当前某自由矩形的子区域），当前放不下的件
    // 之后也不可能放下，故单趟遍历即可，必然终止。
    for (const piece of pieces) {
      let best = null;
      for (const leaf of freeLeaves) best = considerPiece(best, leaf, piece);
      if (best) place(best);
    }
  } else {
    // 全局 BSSF（默认，保持旧行为）：每轮在全部自由区域 × 全部余件中取最优
    while (remaining.size > 0) {
      let best = null;
      for (const leaf of freeLeaves) {
        for (const piece of remaining.keys()) {
          best = considerPiece(best, leaf, piece);
        }
      }

      if (!best) break; // 现存任何自由区域都放不下任何余件
      place(best);
    }
  }

  // 统计未排件
  for (const piece of remaining.keys()) {
    const row = unplaced.find((u) => u.id === piece.id);
    // 初始 quantity = 总数，已排数量稍后扣减
    row._unplaced = (row._unplaced || 0) + 1;
  }
  const placedById = {};
  const items = [];
  const cuts = [];
  const frees = [];
  walk(root, 0);

  function walk(node, depth) {
    if (node.type === 'item') {
      const p = node.piece;
      placedById[p.id] = (placedById[p.id] || 0) + 1;
      items.push({
        x: round3(node.x),
        y: round3(node.y),
        w: round3(node.w),
        h: round3(node.h),
        id: p.id,
        name: p.name,
        specW: p.w,
        specH: p.h,
        rotated: !!p.rotated,
        pieceNo: p.pieceNo,
        grain: p.grain, // 成品的纹向要求
        orderNo: p.orderNo, // 成品所属订单号（未填写为 null）
        // 排样只采用纹向平行的朝向，已排成品必然满足其纹向要求
        grainOk: grainAllows(p.grain, paperGrain, !!p.rotated),
      });
      return;
    }
    if (node.type === 'free') {
      frees.push({
        x: round3(node.x),
        y: round3(node.y),
        w: round3(node.w),
        h: round3(node.h),
        area: round3(node.w * node.h),
      });
      return;
    }
    // cut：前序编号即实际下刀顺序
    cuts.push({
      n: cuts.length + 1,
      depth,
      orient: node.orient,
      region: {
        x: round3(node.x),
        y: round3(node.y),
        w: round3(node.w),
        h: round3(node.h),
      },
      band: {
        x: round3(node.bx),
        y: round3(node.by),
        w: round3(node.bw),
        h: round3(node.bh),
      },
      length: round3(node.orient === 'v' ? node.bh : node.bw),
    });
    node.children.forEach((c) => walk(c, depth + 1));
  }

  frees.sort((a, b) => b.area - a.area);

  // 未排件受阻原因：忽略纹向时某自由区域几何上能放下（任一朝向），
  // 但纹向允许的朝向放不下 → 纹向受阻；否则为尺寸不足
  const fitsAnyOrientation = (u) => freeLeaves.some((leaf) => (
    (u.width <= leaf.w + EPS && u.height <= leaf.h + EPS) ||
    (u.height <= leaf.w + EPS && u.width <= leaf.h + EPS)
  ));

  const unplacedList = unplaced
    .map((u) => ({
      id: u.id,
      name: u.name,
      width: u.width,
      height: u.height,
      grain: u.grain,
      orderNo: u.orderNo,
      total: u.quantity,
      placed: placedById[u.id] || 0,
      quantity: u._unplaced || 0,
    }))
    .filter((u) => u.quantity > 0)
    .map((u) => ({
      ...u,
      grainBlocked: u.grain !== 'any' && fitsAnyOrientation(u),
    }));

  const paperArea = paperW * paperH;
  const placedArea = items.reduce((s, it) => s + it.w * it.h, 0);
  const kerfArea = cuts.reduce((s, c) => s + c.band.w * c.band.h, 0);
  const ratio = paperArea > 0 ? placedArea / paperArea : 0;

  return {
    paper: { width: round3(paperW), height: round3(paperH), kerf: round3(kerf), grain: paperGrain },
    stats: {
      paperArea: round3(paperArea),
      placedArea: round3(placedArea),
      kerfArea: round3(kerfArea),
      freeArea: round3(paperArea - placedArea - kerfArea),
      areaRatio: round3(ratio * 1000) / 1000, // 0..1
      piecesPlaced: placedCount,
      piecesTotal: totalPieces,
      cutsTotal: cuts.length,
    },
    items,
    cuts,
    frees,
    unplaced: unplacedList,
  };
}

/* ---------------- 批量 / 订单隔离共用 ---------------- */

/**
 * 按订单号把规范化后的成品行分组。
 * 订单号为 null（未填写）的行归入同一 null 组：隔离开启时它们之间仍可混排
 * （保持“未填写订单号 = 现有行为”），但不会与任何具名订单同纸。
 * @returns [{ key, orderNo, seq, rows }]，seq 为组内最早录入行的下标
 */
function buildOrderGroups(products) {
  const byKey = new Map();
  const order = [];
  for (const p of products) {
    const key = p.orderNo === null ? '\0' : p.orderNo;
    let g = byKey.get(key);
    if (!g) {
      g = { key, orderNo: p.orderNo, seq: p.seq, rows: [] };
      byKey.set(key, g);
      order.push(g);
    }
    g.rows.push(p);
    if (p.seq < g.seq) g.seq = p.seq;
  }
  order.sort((a, b) => a.seq - b.seq);
  return order;
}

/** 仍有剩余需求的订单组（按录入顺序） */
function activeGroups(groups, demandByKey) {
  return groups.filter((g) => sumDemand(demandByKey.get(g.key)) > 0);
}

function sumDemand(rows) {
  return (rows || []).reduce((s, r) => s + r.quantity, 0);
}

/** 以某张布局的 unplaced 构造下一轮需求（纹向/订单号随件保留） */
function demandFromUnplaced(unplaced) {
  return unplaced.map((u) => ({
    id: u.id,
    name: u.name,
    width: u.width,
    height: u.height,
    grain: u.grain,
    orderNo: u.orderNo,
    quantity: u.quantity,
  }));
}

/** id → 原始需求件数（同 id 行合并） */
function totalsById(products) {
  const m = new Map();
  for (const p of products) m.set(p.id, (m.get(p.id) || 0) + p.quantity);
  return m;
}

/**
 * 按订单汇总需求 / 已排 / 剩余 / 完成率（隔离排产结果用）。
 * @param totals Map(key → 总需求件数)
 * @param remaining Map(key → 剩余行 [{quantity}])
 */
function buildOrderSummary(groups, totals, remainingByKey) {
  return groups.map((g) => {
    const total = totals.get(g.key) || 0;
    const quantity = sumDemand(remainingByKey.get(g.key));
    const placed = total - quantity;
    return {
      orderNo: g.orderNo,
      seq: g.seq,
      total,
      placed,
      quantity,
      completionRate: total > 0 ? round3((placed / total) * 1000) / 1000 : 1,
    };
  });
}

/**
 * 批量排产：按与 layout() 完全相同的断头台规则（含纹向约束）逐张排样。
 * 每张纸排完后，从剩余需求中扣除该张已排数量（直接以该张的
 * unplaced 作为下一张的需求清单，纹向要求随件保留），直到满足任一终止条件：
 *  - 全部成品排完           → stopReason: 'completed'
 *  - 已用纸张达到 maxSheets → stopReason: 'max-sheets'
 *  - 某张纸一件成品都排不进 → stopReason: 'no-progress'
 *    （尺寸或纹向限制均可能导致；该空白纸不计入结果并立即停止，
 *      绝不输出空白纸；循环上界为 maxSheets 且每张至少排入一件，必然终止）
 *
 * 订单隔离（input.isolateOrders === true 且至少一行填写订单号时）：
 * 每张纸仅排一个订单——每轮分别对各未完成订单试排，按
 * 本张已排面积（大者优先）、已排件数、订单录入顺序选出本张订单；
 * 选中后只扣减该订单需求。若任一剩余订单在当前纸型上无进展，
 * 返回 no-progress 与 blockedOrders，不生成空白纸。
 *
 * @param {object} input  同 layout()，另需 maxSheets：正整数（≤500），
 *   可选 isolateOrders: boolean
 * @returns {{
 *   paper: object, stopReason: string,
 *   summary: { maxSheets, sheetsUsed, piecesPlaced, piecesTotal, completionRate, cutsTotal },
 *   sheets: Array,   // 每张纸各自完整的 layout() 结果
 *   remaining: Array, // 仍未排入的成品（结构同 layout() 的 unplaced）
 *   orderSummary?: Array, blockedOrders?: Array, isolated?: boolean
 * }}
 */
function layoutBatch(input) {
  const maxSheets = Number(input.maxSheets);
  if (!Number.isInteger(maxSheets) || maxSheets < 1) {
    throw new Error('最多用纸张数必须是正整数');
  }
  if (maxSheets > 500) throw new Error('最多用纸张数不能超过 500');
  const isolateOrders = normalizeIsolateOrders(input.isolateOrders);
  const kit = normalizeKit(input.kit, { isolateOrders });

  // 先做一次空纸探路：复用单张纸张/刀缝校验
  const probe = layout({
    paperW: input.paperW,
    paperH: input.paperH,
    paperGrain: input.paperGrain,
    kerf: input.kerf,
    products: [],
  });
  const paperInfo = probe.paper;
  // 成套模式以每行 perSet（正整数）× plannedSets 作为该品种总需求，
  // 不使用 quantity，因此跳过要求 quantity 的通用成品规范化。
  const products = kit ? [] : normalizeProducts(input.products);

  // 成套生产：规范化每种成品的每套用量并展开总需求。
  // 成套模式下以每行的 perSet（正整数）× plannedSets 作为该品种总需求，
  // 因此不沿用 quantity（可为空）。
  let kitSpec = null;
  if (kit) {
    const specRows = normalizeKitProducts(input.products, kit.plannedSets);
    kitSpec = { plannedSets: kit.plannedSets, products: specRows };
  }

  const driveProducts = kitSpec ? kitSpec.products : products;
  const totalPieces = driveProducts.reduce((s, p) => s + p.quantity, 0);
  const idTotals = totalsById(driveProducts);

  if (totalPieces === 0) {
    return {
      paper: paperInfo,
      stopReason: 'completed',
      summary: {
        maxSheets,
        sheetsUsed: 0,
        piecesPlaced: 0,
        piecesTotal: 0,
        completionRate: 1,
        cutsTotal: 0,
      },
      sheets: [],
      remaining: [],
      ...(isolateOrders
        ? { isolated: true, orderSummary: [], blockedOrders: [] }
        : {}),
    };
  }

  if (kitSpec) {
    return layoutBatchKit(input, paperInfo, maxSheets, kitSpec, totalPieces);
  }
  if (!isolateOrders) {
    return layoutBatchPlain(input, paperInfo, maxSheets, products, totalPieces, idTotals);
  }
  return layoutBatchIsolated(
    input, paperInfo, maxSheets, products, totalPieces, idTotals
  );
}

/** 非隔离批量排产：原有逐张混排行为 */
function layoutBatchPlain(input, paperInfo, maxSheets, products, totalPieces, idTotals) {
  let demand = products;
  const sheets = [];
  let paper = paperInfo;
  let lastUnplaced = [];
  let placedTotal = 0;
  let cutsTotal = 0;
  let stopReason = 'max-sheets';

  for (let n = 0; n < maxSheets; n++) {
    const result = layout({
      paperW: input.paperW,
      paperH: input.paperH,
      paperGrain: input.paperGrain,
      kerf: input.kerf,
      products: demand,
    });
    paper = result.paper;
    lastUnplaced = result.unplaced;

    if (result.stats.piecesPlaced === 0) {
      // 空白纸：不计入结果，立即止损
      stopReason = placedTotal >= totalPieces ? 'completed' : 'no-progress';
      break;
    }

    sheets.push(result);
    placedTotal += result.stats.piecesPlaced;
    cutsTotal += result.stats.cutsTotal;

    if (placedTotal >= totalPieces) {
      stopReason = 'completed';
      break;
    }

    // 扣除本张已排数量，剩余需求（含纹向要求）进入下一张纸
    demand = demandFromUnplaced(result.unplaced);
  }

  const remaining = lastUnplaced.map((u) => {
    const total = idTotals.has(u.id) ? idTotals.get(u.id) : u.total;
    return {
      id: u.id,
      name: u.name,
      width: u.width,
      height: u.height,
      grain: u.grain,
      orderNo: u.orderNo,
      grainBlocked: !!u.grainBlocked,
      total,
      placed: total - u.quantity,
      quantity: u.quantity,
    };
  });

  const completionRate = totalPieces > 0 ? placedTotal / totalPieces : 1;

  return {
    paper,
    stopReason,
    summary: {
      maxSheets,
      sheetsUsed: sheets.length,
      piecesPlaced: placedTotal,
      piecesTotal: totalPieces,
      completionRate: round3(completionRate * 1000) / 1000, // 0..1
      cutsTotal,
    },
    sheets,
    remaining,
  };
}

/**
 * 隔离批量排产：每轮分别试排各未完成订单，按
 * 本张已排面积 ↓、已排件数 ↓、订单录入顺序 ↑ 选出本张订单。
 */
function layoutBatchIsolated(input, paperInfo, maxSheets, products, totalPieces, idTotals) {
  const groups = buildOrderGroups(products);
  const totals = new Map(groups.map((g) => [g.key, sumDemand(g.rows)]));
  // 各订单内 id → 原始需求件数（同一 id 在不同订单中分别统计）
  const idTotalsByGroup = new Map(groups.map((g) => {
    const m = new Map();
    for (const p of g.rows) m.set(p.id, (m.get(p.id) || 0) + p.quantity);
    return [g.key, m];
  }));
  // 各订单当前剩余需求
  const demandByKey = new Map(groups.map((g) => [g.key, g.rows.map((p) => ({ ...p }))]));

  const sheets = [];
  let paper = paperInfo;
  let placedTotal = 0;
  let cutsTotal = 0;
  let stopReason = 'max-sheets';
  let blockedGroups = [];
  let grainBlocked = null;

  // 每张至少排入一件，循环上界 maxSheets，必然终止
  for (let round = 0; round < maxSheets; round++) {
    const active = activeGroups(groups, demandByKey);
    if (active.length === 0) {
      stopReason = 'completed';
      break;
    }

    // 每轮分别试排各未完成订单
    const trials = [];
    for (const g of active) {
      const result = layout({
        paperW: input.paperW,
        paperH: input.paperH,
        paperGrain: input.paperGrain,
        kerf: input.kerf,
        products: demandByKey.get(g.key),
      });
      paper = result.paper;
      trials.push({ group: g, result });
    }

    // 任一剩余订单在当前纸型上无进展（一件都排不进）→ 立即止损：
    // 本轮不提交任何纸张，不生成空白纸
    const blocked = trials.filter((t) => t.result.stats.piecesPlaced === 0);
    if (blocked.length > 0) {
      stopReason = 'no-progress';
      blockedGroups = blocked.map((t) => t.group);
      // 受阻诊断取自各受阻订单本轮试排的 unplaced
      grainBlocked = new Map();
      for (const t of blocked) {
        demandByKey.set(t.group.key, demandFromUnplaced(t.result.unplaced));
        for (const u of t.result.unplaced) {
          if (u.grainBlocked) grainBlocked.set(u.id, true);
        }
      }
      break;
    }

    // 已排面积 ↓、已排件数 ↓、录入顺序 ↑
    trials.sort((a, b) => {
      const da = b.result.stats.placedArea - a.result.stats.placedArea;
      if (Math.abs(da) > EPS) return da;
      const dp = b.result.stats.piecesPlaced - a.result.stats.piecesPlaced;
      if (dp !== 0) return dp;
      return a.group.seq - b.group.seq;
    });
    const winner = trials[0];
    const result = winner.result;

    sheets.push(Object.assign(result, { orderNo: winner.group.orderNo }));
    placedTotal += result.stats.piecesPlaced;
    cutsTotal += result.stats.cutsTotal;
    // 只扣减选中订单的需求（其余订单原样保留）
    demandByKey.set(winner.group.key, demandFromUnplaced(result.unplaced));

    if (placedTotal >= totalPieces) {
      stopReason = 'completed';
      break;
    }
  }

  const remaining = flattenRemaining(groups, demandByKey, idTotalsByGroup, grainBlocked);
  const completionRate = totalPieces > 0 ? placedTotal / totalPieces : 1;
  const remainingByKey = new Map();
  for (const g of groups) {
    remainingByKey.set(g.key, remaining.filter((r) => groupKeyOf(r) === g.key));
  }

  return {
    paper,
    isolated: true,
    stopReason,
    summary: {
      maxSheets,
      sheetsUsed: sheets.length,
      piecesPlaced: placedTotal,
      piecesTotal: totalPieces,
      completionRate: round3(completionRate * 1000) / 1000,
      cutsTotal,
    },
    sheets,
    remaining,
    orderSummary: buildOrderSummary(groups, totals, remainingByKey),
    blockedOrders: blockedGroups.map((g) => ({
      orderNo: g.orderNo,
      total: totals.get(g.key) || 0,
      quantity: sumDemand(demandByKey.get(g.key)),
    })),
  };
}

/* ---------------- 成套生产（kit production） ---------------- */

/**
 * 某品种在 W×H 纸面上“同朝向规整排列”的最大件数（断头台规则的宽松上界）。
 * 仅用于把富供给试排的展开件数限制在合理范围，不参与候选套数决胜。
 */
function gridCapacity(W, H, w, h, kerf) {
  const f = (a, b) => Math.max(0, Math.floor((a + kerf) / (b + kerf)));
  const n1 = f(W, w) * f(H, h);
  const n2 = f(W, h) * f(H, w);
  return Math.max(n1, n2);
}

/**
 * 单张纸成套试排：在一张纸内只允许提交“完整套”布局——
 * 每个品种恰好 s × perSet 件，绝不留某种件的富余半套。
 *
 * 方法（严格保证返回的是“已被试排证实可行”的最大套数）：
 *  1. 面积上界 sArea = floor(纸面面积 / 每套成品面积) 是完整套数的
 *     绝对几何上界（忽略刀缝，只会偏大）；
 *  2. 富供给试排一次（各品种给足，但封顶在该品种纸面面积/网格容量
 *     之内以免无谓展开数万件），贪心实际产出的完整套数 g 是一个
 *     保证可行的下界（其中 g 套件确实都在纸上）；
 *  3. 从 sArea 向下逐档做“精确供给”试排（每品种恰好 s×perSet 件），
 *     首个全部件都排入者即已证实的最大套数（其布局天然无富余件）；
 *     因完整套可行性对套数非严格单调（贪心 BSSF 启发式所致），不能
 *     二分，只能自顶向下；
 *  4. 高套数档（s>g，供给大、单次较贵）只试有限预算；随后用“精确
 *     g 套”等小供给（单次便宜）取得一份干净无富余的提交布局；
 *  若预算内未能在 g 之上证实更大套数，则提交 g 套（保证可交付）。
 *
 * 单品种特殊情形：已排件数关于供给单调（fuzz 8 万例 0 反例），
 * 富供给一次即最优，无需多档扫描。
 *
 * @returns { sets:number, layout:object|null, trials:number, truncated:boolean }
 *   sets=0 表示一张完整套都组不出（layout 为 null）。
 */
const KIT_TRIAL_BUDGET = 20; // 单张纸高套数档试排次数上限（启发式预算）

function planKitSheet(paperSpec, kerf, kitProducts, demandQty) {
  const { paperW, paperH, paperGrain } = paperSpec;
  const paperArea = paperW * paperH;
  const perSetArea = kitProducts.reduce((s, p) => s + p.perSet * p.width * p.height, 0);
  const piecesPerSet = kitProducts.reduce((s, p) => s + p.perSet, 0);
  const sArea = Math.max(0, Math.floor(paperArea / perSetArea));
  // 受剩余需求约束的最大套数
  const sDemand = Math.min(
    ...kitProducts.map((p, i) => Math.floor(demandQty[i] / p.perSet))
  );
  const sMax = Math.min(sArea, sDemand);
  if (sMax < 1) return { sets: 0, layout: null, trials: 0, truncated: false };

  // 各品种“富供给”数量：给到纸面容量即可（多给的件排不进，只会徒增展开），
  // 同时不超过剩余需求；并保证不少于 sMax 套所需（sMax 已不超过面积上界）。
  const richQty = kitProducts.map((p, i) => {
    const areaCap = Math.floor(paperArea / (p.width * p.height));
    const gridCap = gridCapacity(paperW, paperH, p.width, p.height, kerf);
    const cap = Math.max(1, Math.min(areaCap, gridCap + p.perSet));
    return Math.min(Math.max(cap, sMax * p.perSet), demandQty[i]);
  });

  const runLayout = (quantities) => layout({
    paperW, paperH, paperGrain, kerf,
    products: kitProducts.map((p, i) => ({
      id: p.id, name: p.name, width: p.width, height: p.height,
      grain: p.grain, orderNo: p.orderNo, quantity: quantities[i],
    })),
  });

  const setsInLayout = (result) => {
    const counts = new Map();
    for (const it of result.items) counts.set(it.id, (counts.get(it.id) || 0) + 1);
    let m = Infinity;
    kitProducts.forEach((p, i) => {
      m = Math.min(m, Math.floor((counts.get(p.id) || 0) / p.perSet));
    });
    return m;
  };

  let trials = 0;

  // 单品种：富供给（按几何容量封顶）一次即最优，再做一次精确供给取干净布局
  if (kitProducts.length === 1) {
    const p = kitProducts[0];
    const rich = runLayout([richQty[0]]);
    trials++;
    let sets = setsInLayout(rich);
    sets = Math.min(sets, sMax);
    while (sets >= 1) {
      const exact = runLayout([Math.min(sets * p.perSet, demandQty[0])]);
      trials++;
      if (exact.stats.piecesPlaced === sets * p.perSet) {
        return { sets, layout: exact, trials, truncated: false };
      }
      sets -= 1; // 极端情况下精确供给未铺满则降档重试
    }
    return { sets: 0, layout: null, trials, truncated: false };
  }

  // 多品种：富供给取得保证可行下界 g
  const rich = runLayout(richQty);
  trials++;
  let g = Math.min(setsInLayout(rich), sMax);

  // 高套数档自顶向下精确试排（预算有限）
  let truncated = false;
  for (let s = sMax; s > g; s--) {
    if (trials >= KIT_TRIAL_BUDGET) { truncated = true; break; }
    const quantities = kitProducts.map((p, i) => Math.min(s * p.perSet, demandQty[i]));
    const result = runLayout(quantities);
    trials++;
    if (result.stats.piecesPlaced === s * piecesPerSet) {
      return { sets: s, layout: result, trials, truncated: false };
    }
  }

  // 未在 g 之上证实更大套数：提交“精确 g 套”的干净布局（无富余件）。
  // 若精确 g 因需求已被高段试排影响之外的原因未铺满（理论上富供给里
  // g 套件确实在纸上），逐档下降直到取得一份完整套布局。
  for (let s = g; s >= 1; s--) {
    const quantities = kitProducts.map((p, i) => Math.min(s * p.perSet, demandQty[i]));
    const result = runLayout(quantities);
    trials++;
    if (result.stats.piecesPlaced === s * piecesPerSet) {
      return { sets: s, layout: result, trials, truncated };
    }
    if (trials >= KIT_TRIAL_BUDGET + 8) { truncated = true; break; }
  }
  return { sets: 0, layout: null, trials, truncated };
}

/**
 * 成套批量排产：每张纸只提交完整套布局，按 planKitSheet 逐张扣减。
 * 终止原因：completed（套数做满）/ max-sheets / no-progress（剩余材料
 * 连一整套都组不出；本轮不扣库存/需求，不出空白纸）。
 */
function layoutBatchKit(input, paperInfo, maxSheets, kitSpec, totalPieces) {
  const kerf = Number(input.kerf);
  const kitProducts = kitSpec.products.map((p, i) => ({ ...p, seqIndex: i }));
  const demandQty = kitProducts.map((p) => p.quantity); // 剩余件数（按品种）
  const plannedSets = kitSpec.plannedSets;

  const sheets = [];
  let placedById = new Map(kitProducts.map((p) => [p.id, 0]));
  let cutsTotal = 0;
  let stopReason = 'max-sheets';
  let setsCompleted = 0;
  let truncated = false;

  for (let round = 0; round < maxSheets; round++) {
    const plan = planKitSheet(
      {
        paperW: input.paperW,
        paperH: input.paperH,
        paperGrain: input.paperGrain,
      },
      kerf,
      kitProducts,
      demandQty
    );
    truncated = truncated || plan.truncated;

    if (plan.sets < 1) {
      stopReason = setsCompleted >= plannedSets ? 'completed' : 'no-progress';
      break;
    }

    const result = plan.layout;
    // 扣减各品种已排件数（布局只含完整套，无富余件）
    const counts = new Map();
    for (const it of result.items) counts.set(it.id, (counts.get(it.id) || 0) + 1);
    kitProducts.forEach((p) => {
      const n = counts.get(p.id) || 0;
      demandQty[p.seqIndex] -= n;
      placedById.set(p.id, placedById.get(p.id) + n);
    });
    setsCompleted += plan.sets;
    cutsTotal += result.stats.cutsTotal;

    sheets.push(Object.assign(result, { round: round + 1, sets: plan.sets }));

    if (setsCompleted >= plannedSets) {
      stopReason = 'completed';
      break;
    }
  }

  const placedPieces = [...placedById.values()].reduce((s, n) => s + n, 0);

  return {
    paper: paperInfo,
    kit: {
      mode: 'sets',
      plannedSets,
      setsCompleted,
      setsRemaining: Math.max(0, plannedSets - setsCompleted),
      perSet: kitProducts.map((p) => ({
        id: p.id, name: p.name, width: p.width, height: p.height,
        grain: p.grain, perSet: p.perSet,
      })),
    },
    stopReason,
    summary: {
      maxSheets,
      sheetsUsed: sheets.length,
      piecesPlaced: placedPieces,
      piecesTotal: totalPieces,
      completionRate: round3(setsCompleted / plannedSets),
      cutsTotal,
      setsPlanned: plannedSets,
      setsCompleted,
      truncated,
    },
    sheets,
    remaining: buildKitRemaining(kitProducts, demandQty, placedById, plannedSets),
  };
}

/** 构造成套模式的套内需求 / 已排 / 欠数明细（按品种） */
function buildKitRemaining(kitProducts, demandQty, placedById, plannedSets) {
  return kitProducts.map((p) => {
    const need = p.perSet * plannedSets; // 套内总需求
    const placed = placedById.get(p.id) || 0;
    const quantity = Math.max(0, demandQty[p.seqIndex]); // 欠数
    return {
      id: p.id,
      name: p.name,
      width: p.width,
      height: p.height,
      grain: p.grain,
      orderNo: p.orderNo,
      perSet: p.perSet, // 每套用量
      needPerSet: p.perSet,
      setsPlanned: plannedSets,
      total: need, // 套内需求
      placed, // 已排
      quantity, // 欠数
    };
  });
}

/** 把行的订单号映射回内部组 key（null 行共享 '\0' 组） */
function groupKeyOf(row) {
  return row.orderNo === null || row.orderNo === undefined ? '\0' : row.orderNo;
}

/* ---------------- 方案比选（strategy compare） ---------------- */

/**
 * 三种确定性排样策略的固定比选顺序（“策略顺序”决胜即按此顺序）：
 * 面积降序 → 最长边降序 → 宽高差降序。
 */
const COMPARE_STRATEGIES = [
  { key: 'area-desc', label: '面积降序' },
  { key: 'longest-side-desc', label: '最长边降序' },
  { key: 'aspect-diff-desc', label: '宽高差降序' },
];

const COMPARE_OBJECTIVES = ['more-pieces', 'fewer-cuts'];

/** 规范化比选目标：缺省 more-pieces（优先多排） */
function normalizeObjective(value) {
  if (value == null || value === '') return 'more-pieces';
  const s = String(value);
  if (!COMPARE_OBJECTIVES.includes(s)) {
    throw new Error('比选目标（objective）必须是 more-pieces（优先多排）或 fewer-cuts（优先省刀）');
  }
  return s;
}

/**
 * 按比选目标从候选中选出最佳方案，并记录逐项选择依据。
 *
 * 决胜规则：
 *  - more-pieces（优先多排）：已排件数 ↓ → 已排面积 ↓ → 刀数 ↑ → 策略顺序；
 *  - fewer-cuts（优先省刀）：先排除空方案（一件都排不进），再按
 *    刀数 ↑ → 已排面积 ↓ → 已排件数 ↓ → 策略顺序。
 *  - 若全部候选均未排入任何成品，两种目标都不指定最佳方案（best 为 null）。
 *
 * @param candidates [{ strategy, label, order, metrics:{...} }]
 * @param objective  'more-pieces' | 'fewer-cuts'
 * @returns { best, decision } decision 为逐项选择依据（每步含各候选取值、
 *   存活候选与中文小结），供接口与前端直接展示
 */
function selectBestCandidate(candidates, objective) {
  const decision = [];
  const names = (list) => list.map((c) => c.label).join('、');
  const valuesOf = (pool, keyFn) => pool.map((c) => ({
    strategy: c.strategy,
    label: c.label,
    value: keyFn(c),
  }));

  // 全部为空：两种目标都不指定最佳方案（未排原因沿用各候选 unplaced）
  const nonEmpty = candidates.filter((c) => c.metrics.piecesPlaced > 0);
  if (nonEmpty.length === 0) {
    decision.push({
      criterion: 'all-empty',
      label: '全部候选均未排入成品',
      values: valuesOf(candidates, (c) => c.metrics.piecesPlaced),
      survivors: [],
      note: '三种策略均排不进任何成品，不指定最佳方案（未排原因沿用各候选的未排清单）',
    });
    return { best: null, decision };
  }

  let pool = candidates.slice();

  // 优先省刀：先排除空方案（空方案刀数恒为 0，不参与省刀比较）
  if (objective === 'fewer-cuts') {
    const empties = candidates.filter((c) => c.metrics.piecesPlaced === 0);
    pool = nonEmpty.slice();
    decision.push({
      criterion: 'non-empty',
      label: '排除空方案',
      values: valuesOf(candidates, (c) => c.metrics.piecesPlaced),
      survivors: pool.map((c) => c.strategy),
      note: empties.length === 0
        ? '三种策略均有排入成品，无需排除'
        : `${names(empties)} 未排入任何成品，排除出比较`,
    });
  }

  const criteria = objective === 'fewer-cuts'
    ? [
      ['cutsTotal', '刀数（少者优先）', (c) => c.metrics.cutsTotal, 'asc'],
      ['placedArea', '已排面积（大者优先）', (c) => c.metrics.placedArea, 'desc'],
      ['piecesPlaced', '已排件数（多者优先）', (c) => c.metrics.piecesPlaced, 'desc'],
    ]
    : [
      ['piecesPlaced', '已排件数（多者优先）', (c) => c.metrics.piecesPlaced, 'desc'],
      ['placedArea', '已排面积（大者优先）', (c) => c.metrics.placedArea, 'desc'],
      ['cutsTotal', '刀数（少者优先）', (c) => c.metrics.cutsTotal, 'asc'],
    ];

  for (const [criterion, label, keyFn, dir] of criteria) {
    if (pool.length === 1) break;
    const vals = pool.map(keyFn);
    const bestVal = dir === 'asc' ? Math.min(...vals) : Math.max(...vals);
    const survivors = pool.filter((c) => keyFn(c) === bestVal);
    const eliminated = pool.filter((c) => keyFn(c) !== bestVal);
    decision.push({
      criterion,
      label,
      values: valuesOf(pool, keyFn),
      survivors: survivors.map((c) => c.strategy),
      note: eliminated.length === 0
        ? `${names(survivors)} 该项持平（均为 ${bestVal}）`
        : `${names(survivors)} 该项最优（${bestVal}）；${names(eliminated)} 出局`,
    });
    pool = survivors;
  }

  // 策略顺序决胜：候选生成顺序即固定策略顺序
  if (pool.length > 1) {
    const winner = pool.reduce((m, c) => (c.order < m.order ? c : m), pool[0]);
    decision.push({
      criterion: 'strategy-order',
      label: '策略顺序',
      values: valuesOf(pool, (c) => c.order + 1),
      survivors: [winner.strategy],
      note: `各项指标均持平，按固定策略顺序（${names(COMPARE_STRATEGIES)}）取「${winner.label}」`,
    });
    pool = [winner];
  }

  return { best: pool[0], decision };
}

/**
 * 方案比选主入口：对同一输入分别按三种确定性策略（面积降序 / 最长边降序 /
 * 宽高差降序）运行单张排样（断头台、刀缝、旋转与纹向规则完全一致），
 * 再按比选目标选出最佳方案。
 *
 * @param {object} input  同 layout()，另可含 objective：
 *   'more-pieces'（优先多排，缺省） | 'fewer-cuts'（优先省刀）
 * @returns {{
 *   objective: string,
 *   paper: object,
 *   candidates: Array,  // 全部候选：策略标识、指标与完整布局（含未排原因）
 *   best: object|null,  // 最佳方案（全部排不进时为 null）
 *   decision: Array,    // 逐项选择依据
 * }}
 */
function layoutCompare(input) {
  const objective = normalizeObjective(input && input.objective);

  const candidates = COMPARE_STRATEGIES.map((s, idx) => {
    const result = layout(input, { sortStrategy: s.key, sequential: true });
    return {
      strategy: s.key,
      label: s.label,
      order: idx,
      selected: false,
      metrics: {
        piecesPlaced: result.stats.piecesPlaced,
        piecesTotal: result.stats.piecesTotal,
        placedArea: result.stats.placedArea,
        cutsTotal: result.stats.cutsTotal,
        areaRatio: result.stats.areaRatio,
      },
      layout: result,
    };
  });

  const { best, decision } = selectBestCandidate(candidates, objective);
  if (best) best.selected = true;

  return {
    objective,
    paper: candidates[0].layout.paper,
    candidates,
    best: best
      ? {
          strategy: best.strategy,
          label: best.label,
          metrics: { ...best.metrics },
          layout: best.layout,
        }
      : null,
    decision,
  };
}

/** 按组顺序（录入顺序）摊平各订单剩余需求为 remaining 行 */
function flattenRemaining(groups, demandByKey, idTotalsByGroup, grainBlockedById) {
  const out = [];
  for (const g of groups) {
    for (const r of demandByKey.get(g.key) || []) {
      if (r.quantity <= 0) continue;
      const m = idTotalsByGroup.get(g.key);
      const total = m && m.has(r.id) ? m.get(r.id) : r.quantity;
      out.push({
        id: r.id,
        name: r.name,
        width: r.width,
        height: r.height,
        grain: r.grain,
        orderNo: r.orderNo,
        grainBlocked: !!(grainBlockedById && grainBlockedById.get(r.id)),
        total,
        placed: total - r.quantity,
        quantity: r.quantity,
      });
    }
  }
  return out;
}

module.exports = {
  layout,
  layoutBatch,
  layoutCompare,
  grainAllows,
  normalizePaperGrain,
  normalizeProductGrain,
  normalizeOrderNo,
  normalizeIsolateOrders,
  normalizeProducts,
  normalizeKit,
  normalizePerSet,
  normalizeKitProducts,
  normalizeObjective,
  planKitSheet,
  buildOrderGroups,
  selectBestCandidate,
  COMPARE_STRATEGIES,
};
