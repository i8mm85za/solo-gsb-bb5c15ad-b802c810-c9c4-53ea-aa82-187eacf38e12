'use strict';

/**
 * 多纸型成本排产
 *
 * 在 2～8 种候选纸张（名称、宽高、纹向、单价、可用张数）之间逐轮择优：
 * 每轮对“仍有库存且能放入余件”的每种纸型调用现有单张排样 layout()
 * （纹向约束与单张一致：只采用纸张纹向与成品要求平行的朝向），
 * 按以下顺序选出下一张纸：
 *   1. 单位已排成品面积成本（元 / m²）最低；
 *   2. 同分时本张已排件数多；
 *   3. 再同分按录入顺序靠前者。
 * 选中后扣减该纸库存与剩余需求，进入下一轮，直到：
 *   - 全部完成            → stopReason: 'completed'
 *   - 库存全部耗尽        → stopReason: 'stock-exhausted'
 *   - 有库存纸型均无进展  → stopReason: 'no-progress'
 * 因尺寸或纹向限制排不进任何余件的纸型不参与当轮选择（即可行候选排名
 * 已排除纹向不可行的纸型）；空白纸（排不进任何余件）绝不计入结果：
 * 不扣库存、不入选。
 *
 * 订单隔离（input.isolateOrders === true 且至少一行填写订单号时）：
 * 每张纸仅排一个订单——每轮联合比较“订单 × 纸型”候选（对各未完成订单、
 * 各有库存纸型分别试排），仍以单位已排面积成本 ↓、本张已排件数 ↓、
 * 订单录入顺序 ↑、纸型录入顺序 ↑ 决胜；选中后只扣减该订单需求与该纸型库存。
 * 若任一剩余订单在所有可用纸型上均无进展，返回 no-progress 与
 * blockedOrders：本轮不提交任何纸张、不扣任何库存、不生成空白纸。
 */

const {
  layout,
  normalizePaperGrain,
  normalizeIsolateOrders,
  normalizeProducts,
  normalizeKit,
  normalizeKitProducts,
  planKitSheet,
  buildOrderGroups,
} = require('./packer');

const MM2_PER_M2 = 1_000_000;
const MAX_SHEETS = 500;

const round3 = (v) => Math.round(v * 1000) / 1000;
const round4 = (v) => Math.round(v * 10000) / 10000;
const round2 = (v) => Math.round(v * 100) / 100;

const sumDemand = (rows) => (rows || []).reduce((s, r) => s + r.quantity, 0);

/**
 * 校验并规范化候选纸型列表。
 * @returns 规范化后的纸型：{ id, name, width, height, grain, price, stock, seq }
 */
function normalizePapers(rawPapers) {
  if (!Array.isArray(rawPapers)) throw new Error('缺少候选纸张列表（papers）');
  if (rawPapers.length < 2) throw new Error('至少需要录入 2 种候选纸张');
  if (rawPapers.length > 8) throw new Error('候选纸张最多为 8 种');

  return rawPapers.map((p, idx) => {
    const pos = idx + 1;
    if (!p || typeof p !== 'object') {
      throw new Error(`第 ${pos} 种纸张不是有效记录`);
    }
    const width = Number(p.width);
    const height = Number(p.height);
    const price = Number(p.price);
    const stock = Number(p.stock);
    const grain = normalizePaperGrain(p.grain, `第 ${pos} 种纸张`);

    if (!Number.isFinite(width) || width <= 0) {
      throw new Error(`第 ${pos} 种纸张的宽必须大于 0`);
    }
    if (!Number.isFinite(height) || height <= 0) {
      throw new Error(`第 ${pos} 种纸张的高必须大于 0`);
    }
    if (!Number.isFinite(price) || price <= 0) {
      throw new Error(`第 ${pos} 种纸张的单价必须大于 0`);
    }
    if (!Number.isInteger(stock) || stock < 0 || stock > MAX_SHEETS) {
      throw new Error(`第 ${pos} 种纸张的可用张数必须是 0～${MAX_SHEETS} 的整数`);
    }

    const trimmed = p.name != null ? String(p.name).trim() : '';
    return {
      id: `S${pos}`,
      name: trimmed || `纸型${pos}`,
      width,
      height,
      grain,
      price,
      stock,
      seq: idx,
    };
  });
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

/**
 * 主入口
 * @param {object} input
 *   kerf: number(mm)
 *   papers: [{ name?, width, height, grain?, price, stock }]（2～8 种，
 *     grain 为 'along-width' | 'along-height'，缺省沿宽）
 *   products: [{ id?, name?, width, height, quantity, grain?, orderNo? }]
 *   isolateOrders?: boolean（每张纸仅排一个订单，缺省 false）
 * @returns 逐张纸型、布局、选择指标、各纸型用量、总成本、剩余件数与终止原因；
 *   隔离开启时另含 isolated、orderSummary、blockedOrders，逐张含 orderNo
 */
function layoutCostBatch(input) {
  const kerf = Number(input.kerf);
  if (!Number.isFinite(kerf) || kerf < 0) {
    throw new Error('刀缝宽度必须是非负数字');
  }
  const papers = normalizePapers(input.papers);
  const isolateOrders = normalizeIsolateOrders(input.isolateOrders);
  const kit = normalizeKit(input.kit, { isolateOrders });
  const products = kit
    ? normalizeKitProducts(input.products, kit.plannedSets)
    : normalizeProducts(input.products);
  const totalPieces = products.reduce((s, p) => s + p.quantity, 0);

  const usageEmpty = papers.map((p) => ({
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    grain: p.grain,
    price: p.price,
    stock: p.stock,
    used: 0,
    remainingStock: p.stock,
    cost: 0,
    placedArea: 0,
  }));

  // 空需求：直接完成，不用任何纸
  if (totalPieces === 0) {
    return {
      kerf: round3(kerf),
      papers: papers.map((p) => ({ ...p })),
      stopReason: 'completed',
      summary: {
        rounds: 0,
        sheetsUsed: 0,
        paperKindsUsed: 0,
        piecesPlaced: 0,
        piecesTotal: 0,
        completionRate: 1,
        cutsTotal: 0,
        totalCost: 0,
        totalPlacedArea: 0,
        totalPlacedAreaM2: 0,
        effectiveCostPerM2: null,
      },
      sheets: [],
      usage: usageEmpty,
      remaining: [],
      ...(isolateOrders
        ? { isolated: true, orderSummary: [], blockedOrders: [] }
        : {}),
      ...(kit
        ? {
            kit: {
              mode: 'sets',
              plannedSets: kit.plannedSets,
              setsCompleted: 0,
              setsRemaining: kit.plannedSets,
              perSet: products.map((p) => ({
                id: p.id, name: p.name, width: p.width, height: p.height,
                grain: p.grain, perSet: p.perSet,
              })),
            },
          }
        : {}),
    };
  }

  if (kit) {
    const run = runKit(kerf, papers, products, totalPieces, kit.plannedSets);
    return assembleResult(kerf, papers, false, run, { kit, products });
  }

  const run = isolateOrders
    ? runIsolated(kerf, papers, products, totalPieces)
    : runPlain(kerf, papers, products, totalPieces);

  return assembleResult(kerf, papers, isolateOrders, run);
}

/**
 * 汇总两种模式的公共结果。
 * @param {object} run
 *   stopReason, sheets, remaining, placedTotal, cutsTotal
 */
function assembleResult(kerf, papers, isolateOrders, run, kitExtra = null) {
  const { stopReason, sheets, remaining, placedTotal, cutsTotal, orderExtras } = run;

  const usedCount = new Map(papers.map((p) => [p.id, 0]));
  const costSum = new Map(papers.map((p) => [p.id, 0]));
  const placedAreaSum = new Map(papers.map((p) => [p.id, 0]));
  for (const sh of sheets) {
    usedCount.set(sh.paperId, usedCount.get(sh.paperId) + 1);
    costSum.set(sh.paperId, costSum.get(sh.paperId) + sh.price);
    placedAreaSum.set(sh.paperId, placedAreaSum.get(sh.paperId) + sh.placedArea);
  }

  const totalPieces = run.totalPieces;
  const usage = papers.map((p) => {
    const used = usedCount.get(p.id);
    const cost = round2(costSum.get(p.id));
    return {
      id: p.id,
      name: p.name,
      width: p.width,
      height: p.height,
      grain: p.grain,
      price: p.price,
      stock: p.stock,
      used,
      remainingStock: p.stock - used,
      cost,
      placedArea: round3(placedAreaSum.get(p.id)),
    };
  });

  const totalCost = round2(sheets.reduce((s, sh) => s + sh.price, 0));
  const totalPlacedArea = round3(
    sheets.reduce((s, sh) => s + sh.placedArea, 0)
  );
  const completionRate = totalPieces > 0 ? placedTotal / totalPieces : 1;

  const kitBlock = kitExtra
    ? {
        kit: {
          mode: 'sets',
          plannedSets: kitExtra.kit.plannedSets,
          setsCompleted: run.setsCompleted || 0,
          setsRemaining: Math.max(0, kitExtra.kit.plannedSets - (run.setsCompleted || 0)),
          perSet: kitExtra.products.map((p) => ({
            id: p.id, name: p.name, width: p.width, height: p.height,
            grain: p.grain, perSet: p.perSet,
          })),
        },
      }
    : {};

  return {
    kerf: round3(kerf),
    papers: papers.map((p) => ({ ...p })),
    stopReason,
    summary: {
      rounds: sheets.length,
      sheetsUsed: sheets.length,
      paperKindsUsed: papers.filter((p) => usedCount.get(p.id) > 0).length,
      piecesPlaced: placedTotal,
      piecesTotal: totalPieces,
      completionRate: round3(completionRate * 1000) / 1000,
      cutsTotal,
      totalCost,
      totalPlacedArea,
      totalPlacedAreaM2: round4(totalPlacedArea / MM2_PER_M2),
      effectiveCostPerM2: totalPlacedArea > 0
        ? round4((totalCost / totalPlacedArea) * MM2_PER_M2)
        : null,
      ...(kitExtra
        ? {
            setsPlanned: kitExtra.kit.plannedSets,
            setsCompleted: run.setsCompleted || 0,
            truncated: !!run.truncated,
          }
        : {}),
    },
    sheets,
    usage,
    remaining,
    ...(isolateOrders
      ? {
          isolated: true,
          orderSummary: orderExtras.orderSummary,
          blockedOrders: orderExtras.blockedOrders,
        }
      : {}),
    ...kitBlock,
  };
}

/* ---------------- 非隔离（原有行为） ---------------- */

function runPlain(kerf, papers, products, totalPieces) {
  // id → 原始需求件数
  const originalTotal = new Map();
  for (const p of products) {
    originalTotal.set(p.id, (originalTotal.get(p.id) || 0) + p.quantity);
  }

  const stock = new Map(papers.map((p) => [p.id, p.stock]));

  let demand = products.map((p) => ({ ...p }));
  const sheets = [];
  // 首轮即库存耗尽/异常止损时据此回填全部剩余需求
  let lastUnplaced = products.map((p) => ({
    id: p.id,
    name: p.name,
    width: p.width,
    height: p.height,
    grain: p.grain,
    orderNo: p.orderNo,
    quantity: p.quantity,
  }));
  let placedTotal = 0;
  let cutsTotal = 0;
  let stopReason = null;
  // 安全上界：各纸库存之和且不超过 8×500，每张必排至少一件，必然终止
  const roundLimit = papers.reduce((s, p) => s + p.stock, 0);

  for (let round = 0; round < roundLimit; round++) {
    if (papers.every((p) => stock.get(p.id) <= 0)) {
      stopReason = 'stock-exhausted';
      break;
    }

    // 对每种仍有库存的纸型调用现有单张排样（含各自纹向约束）
    const candidates = [];
    const blockedResults = []; // 有库存但零件的排样结果（用于诊断尺寸/纹向受阻）
    for (const p of papers) {
      if (stock.get(p.id) <= 0) continue;
      const result = layout({
        paperW: p.width,
        paperH: p.height,
        paperGrain: p.grain,
        kerf,
        products: demand,
      });
      const piecesPlaced = result.stats.piecesPlaced;
      if (piecesPlaced === 0) {
        blockedResults.push(result); // 空白纸：不可选、不计入
        continue;
      }
      // 选择指标：单位已排成品面积成本（元 / m²）
      const placedArea = round3(result.stats.placedArea);
      const rawCostPerM2 = (p.price / placedArea) * MM2_PER_M2;
      const costPerM2 = placedArea > 0 ? round4(rawCostPerM2) : null;
      candidates.push({
        paper: p,
        result,
        feasible: true,
        piecesPlaced,
        placedArea,
        rawCostPerM2,
        costPerM2,
      });
    }

    if (candidates.length === 0) {
      // 有库存的纸型全部排不进任何余件（尺寸或纹向限制）：无进展止损。
      // 本轮未排任何纸、不扣库存，剩余即当前需求（首轮时据此回填全部需求）。
      // 受阻原因取各有库存纸型排样结果的并集：任一纸型因纹向受阻即标记。
      const grainBlockedById = new Map();
      for (const res of blockedResults) {
        for (const u of res.unplaced) {
          if (u.grainBlocked) grainBlockedById.set(u.id, true);
        }
      }
      lastUnplaced = demand.map((d) => ({
        id: d.id,
        name: d.name,
        width: d.width,
        height: d.height,
        grain: d.grain,
        orderNo: d.orderNo,
        grainBlocked: grainBlockedById.get(d.id) || false,
        quantity: d.quantity,
      }));
      stopReason = 'no-progress';
      break;
    }

    // 单位面积成本最低 → 已排件数多 → 录入顺序靠前。
    // 同分按未舍入的真实值判定（相对容差 1e-9），避免把微小差异误并列
    candidates.sort((a, b) => {
      const da = a.rawCostPerM2 - b.rawCostPerM2;
      if (Math.abs(da) > 1e-9 * Math.max(1, Math.abs(a.rawCostPerM2), Math.abs(b.rawCostPerM2))) {
        return da;
      }
      if (b.piecesPlaced !== a.piecesPlaced) return b.piecesPlaced - a.piecesPlaced;
      return a.paper.seq - b.paper.seq;
    });
    const best = candidates[0];

    // 提交本张：扣库存、扣需求
    const p = best.paper;
    stock.set(p.id, stock.get(p.id) - 1);
    placedTotal += best.piecesPlaced;
    cutsTotal += best.result.stats.cutsTotal;
    lastUnplaced = best.result.unplaced;

    sheets.push({
      round: round + 1,
      paperId: p.id,
      paperName: p.name,
      paperWidth: p.width,
      paperHeight: p.height,
      paperGrain: p.grain,
      price: p.price,
      piecesPlaced: best.piecesPlaced,
      placedArea: best.placedArea,
      costPerM2: best.costPerM2,
      selection: {
        ranked: candidates.map((c) => ({
          paperId: c.paper.id,
          paperName: c.paper.name,
          feasible: true,
          piecesPlaced: c.piecesPlaced,
          placedArea: c.placedArea,
          costPerM2: c.costPerM2,
          selected: c === best,
        })),
      },
      layout: best.result,
    });

    if (placedTotal >= totalPieces) {
      stopReason = 'completed';
      break;
    }

    demand = demandFromUnplaced(best.result.unplaced);
  }

  if (stopReason === null) {
    // 理论上不可达：达到库存上界仍未完成
    stopReason = 'stock-exhausted';
  }

  const remaining = lastUnplaced.map((u) => {
    const total = originalTotal.has(u.id) ? originalTotal.get(u.id) : u.total;
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

  return { stopReason, sheets, remaining, placedTotal, cutsTotal, totalPieces };
}

/* ---------------- 订单隔离 ---------------- */

/**
 * 隔离成本排产：每轮联合比较“订单 × 纸型”候选。
 * 决胜顺序：单位已排面积成本 ↓ → 本张已排件数 ↓ → 订单录入顺序 ↑
 *           → 纸型录入顺序 ↑。
 * 任一剩余订单在所有有库存纸型上均排不进时立即止损（不扣库存）。
 */
function runIsolated(kerf, papers, products, totalPieces) {
  const groups = buildOrderGroups(products);
  const orderTotals = new Map(groups.map((g) => [g.key, sumDemand(g.rows)]));
  // 各订单内 id → 原始需求件数
  const idTotalsByGroup = new Map(groups.map((g) => {
    const m = new Map();
    for (const p of g.rows) m.set(p.id, (m.get(p.id) || 0) + p.quantity);
    return [g.key, m];
  }));
  const demandByKey = new Map(
    groups.map((g) => [g.key, g.rows.map((p) => ({ ...p }))])
  );

  const stock = new Map(papers.map((p) => [p.id, p.stock]));

  const sheets = [];
  let placedTotal = 0;
  let cutsTotal = 0;
  let stopReason = null;
  let blockedGroups = [];
  let grainBlockedById = null;
  const roundLimit = papers.reduce((s, p) => s + p.stock, 0);

  for (let round = 0; round < roundLimit; round++) {
    const active = groups.filter((g) => sumDemand(demandByKey.get(g.key)) > 0);
    if (active.length === 0) {
      stopReason = 'completed';
      break;
    }
    if (papers.every((p) => stock.get(p.id) <= 0)) {
      stopReason = 'stock-exhausted';
      break;
    }

    // 联合试排：每个“未完成订单 × 有库存纸型”各排一张
    const candidates = [];
    const blockedByGroup = new Map(); // group.key → 该订单在各纸型的受阻试排
    for (const g of active) {
      const blockedTrials = [];
      for (const p of papers) {
        if (stock.get(p.id) <= 0) continue;
        const result = layout({
          paperW: p.width,
          paperH: p.height,
          paperGrain: p.grain,
          kerf,
          products: demandByKey.get(g.key),
        });
        if (result.stats.piecesPlaced === 0) {
          blockedTrials.push({ paper: p, result });
          continue;
        }
        const placedArea = round3(result.stats.placedArea);
        const rawCostPerM2 = (p.price / placedArea) * MM2_PER_M2;
        candidates.push({
          group: g,
          paper: p,
          result,
          piecesPlaced: result.stats.piecesPlaced,
          placedArea,
          rawCostPerM2,
          costPerM2: round4(rawCostPerM2),
        });
      }
      blockedByGroup.set(g.key, blockedTrials);
    }

    // 任一剩余订单在所有可用纸型上均无进展 → 立即止损：
    // 本轮不提交任何纸张、不扣任何库存、不生成空白纸
    const blocked = active.filter((g) => blockedByGroup.get(g.key).length > 0
      && !candidates.some((c) => c.group === g));
    if (blocked.length > 0) {
      stopReason = 'no-progress';
      blockedGroups = blocked;
      grainBlockedById = new Map();
      for (const g of blocked) {
        // 以该订单任一可用纸型的试排结果回填剩余与受阻诊断
        const trial = blockedByGroup.get(g.key)[0];
        demandByKey.set(g.key, demandFromUnplaced(trial.result.unplaced));
        for (const t of blockedByGroup.get(g.key)) {
          for (const u of t.result.unplaced) {
            if (u.grainBlocked) grainBlockedById.set(u.id, true);
          }
        }
      }
      break;
    }

    // 单位已排面积成本 ↓ → 件数 ↓ → 订单录入顺序 ↑ → 纸型录入顺序 ↑
    candidates.sort((a, b) => {
      const da = a.rawCostPerM2 - b.rawCostPerM2;
      if (Math.abs(da) > 1e-9 * Math.max(1, Math.abs(a.rawCostPerM2), Math.abs(b.rawCostPerM2))) {
        return da;
      }
      if (b.piecesPlaced !== a.piecesPlaced) return b.piecesPlaced - a.piecesPlaced;
      if (a.group.seq !== b.group.seq) return a.group.seq - b.group.seq;
      return a.paper.seq - b.paper.seq;
    });
    const best = candidates[0];

    // 提交：只扣该纸型库存与该订单需求
    const p = best.paper;
    const g = best.group;
    stock.set(p.id, stock.get(p.id) - 1);
    placedTotal += best.piecesPlaced;
    cutsTotal += best.result.stats.cutsTotal;
    demandByKey.set(g.key, demandFromUnplaced(best.result.unplaced));

    sheets.push({
      round: round + 1,
      orderNo: g.orderNo,
      paperId: p.id,
      paperName: p.name,
      paperWidth: p.width,
      paperHeight: p.height,
      paperGrain: p.grain,
      price: p.price,
      piecesPlaced: best.piecesPlaced,
      placedArea: best.placedArea,
      costPerM2: best.costPerM2,
      selection: {
        ranked: candidates.map((c) => ({
          orderNo: c.group.orderNo,
          paperId: c.paper.id,
          paperName: c.paper.name,
          feasible: true,
          piecesPlaced: c.piecesPlaced,
          placedArea: c.placedArea,
          costPerM2: c.costPerM2,
          selected: c === best,
        })),
      },
      layout: Object.assign(best.result, { orderNo: g.orderNo }),
    });

    if (placedTotal >= totalPieces) {
      stopReason = 'completed';
      break;
    }
  }

  if (stopReason === null) stopReason = 'stock-exhausted';

  // 摊平剩余（按订单录入顺序、订单内录入顺序）
  const remaining = [];
  for (const g of groups) {
    const idm = idTotalsByGroup.get(g.key);
    for (const r of demandByKey.get(g.key) || []) {
      if (r.quantity <= 0) continue;
      const total = idm.has(r.id) ? idm.get(r.id) : r.quantity;
      remaining.push({
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

  const remainingByKey = new Map();
  for (const g of groups) {
    remainingByKey.set(
      g.key,
      remaining.filter((r) => (r.orderNo === null ? '\0' : r.orderNo) === g.key)
    );
  }
  const orderSummary = groups.map((g) => {
    const total = orderTotals.get(g.key) || 0;
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
  const blockedOrders = blockedGroups.map((g) => ({
    orderNo: g.orderNo,
    total: orderTotals.get(g.key) || 0,
    quantity: sumDemand(demandByKey.get(g.key)),
  }));

  return {
    stopReason,
    sheets,
    remaining,
    placedTotal,
    cutsTotal,
    totalPieces,
    orderExtras: { orderSummary, blockedOrders },
  };
}

/* ---------------- 成套生产（kit production） ---------------- */

/**
 * 成套成本排产：每轮对每种有库存纸型调用 planKitSheet 试排“一张完整套纸”，
 * 选择规则（同套数下沿用普通成本排产决胜）：
 *   1. 本张完整套数最多；
 *   2. 单位已排成品面积成本（元/m²）最低；
 *   3. 本张已排件数多；
 *   4. 纸型录入顺序靠前。
 * 只提交完整套布局（无任何品种富余半套）。若所有有库存纸型本轮一套都
 * 组不出 → no-progress，本轮不扣库存/需求、不出空白纸。
 */
function runKit(kerf, papers, kitProducts, totalPieces, plannedSets) {
  const kitSpecProducts = kitProducts;
  const stock = new Map(papers.map((p) => [p.id, p.stock]));
  // 各品种当前剩余件数（按数组下标对应）
  const demandQty = kitSpecProducts.map((p) => p.quantity);

  // 跨轮缓存：同一纸型在“剩余需求仍足以支撑缓存布局”时复用其成套试排，
  // 因为成套布局只取决于纸型与品种规格，与还剩多少需求无关（只要够用）。
  const cache = new Map(); // paperId → { sets, result, requiredQty:[...] }

  const sheets = [];
  let placedTotal = 0;
  let cutsTotal = 0;
  let setsCompleted = 0;
  let truncated = false;
  let stopReason = null;
  let grainBlockedById = new Map();
  const roundLimit = papers.reduce((s, p) => s + p.stock, 0);

  const remainingNow = () => {
    const out = [];
    kitSpecProducts.forEach((p, i) => {
      const need = p.perSet * plannedSets;
      const quantity = Math.max(0, demandQty[i]);
      out.push({
        id: p.id, name: p.name, width: p.width, height: p.height,
        grain: p.grain, orderNo: p.orderNo,
        grainBlocked: grainBlockedById.get(p.id) || false,
        perSet: p.perSet,
        total: need, placed: need - quantity, quantity,
      });
    });
    return out;
  };

  for (let round = 0; round < roundLimit; round++) {
    if (papers.every((p) => stock.get(p.id) <= 0)) {
      stopReason = 'stock-exhausted';
      break;
    }

    const candidates = [];
    for (const p of papers) {
      if (stock.get(p.id) <= 0) continue;

      // 复用缓存：缓存布局所需各品种件数仍不超过当前剩余
      let plan = cache.get(p.id);
      if (plan) {
        const reusable = plan.requiredQty.every((q, i) => demandQty[i] >= q);
        if (!reusable) plan = null;
      }
      if (!plan) {
        const trial = planKitSheet(
          { paperW: p.width, paperH: p.height, paperGrain: p.grain },
          kerf, kitSpecProducts, demandQty
        );
        truncated = truncated || trial.truncated;
        if (trial.sets >= 1) {
          // 该布局各品种实际占用件数
          const counts = new Map();
          for (const it of trial.layout.items) {
            counts.set(it.id, (counts.get(it.id) || 0) + 1);
          }
          const requiredQty = kitSpecProducts.map((kp) => counts.get(kp.id) || 0);
          plan = { sets: trial.sets, result: trial.layout, requiredQty };
          cache.set(p.id, plan);
        } else {
          // 一套都组不出：记录纹向受阻诊断
          for (const u of trial.layout ? trial.layout.unplaced || [] : []) {
            if (u.grainBlocked) grainBlockedById.set(u.id, true);
          }
        }
      }

      if (!plan) continue;

      const result = plan.result;
      const piecesPlaced = result.stats.piecesPlaced;
      const placedArea = round3(result.stats.placedArea);
      const rawCostPerM2 = (p.price / placedArea) * MM2_PER_M2;
      candidates.push({
        paper: p,
        result,
        sets: plan.sets,
        requiredQty: plan.requiredQty,
        piecesPlaced,
        placedArea,
        rawCostPerM2,
        costPerM2: placedArea > 0 ? round4(rawCostPerM2) : null,
      });
    }

    if (candidates.length === 0) {
      stopReason = 'no-progress';
      break;
    }

    // 完整套数 ↓ → 单位已排面积成本 ↓ → 已排件数 ↓ → 纸型录入顺序 ↑
    candidates.sort((a, b) => {
      if (b.sets !== a.sets) return b.sets - a.sets;
      const da = a.rawCostPerM2 - b.rawCostPerM2;
      if (Math.abs(da) > 1e-9 * Math.max(1, Math.abs(a.rawCostPerM2), Math.abs(b.rawCostPerM2))) {
        return da;
      }
      if (b.piecesPlaced !== a.piecesPlaced) return b.piecesPlaced - a.piecesPlaced;
      return a.paper.seq - b.paper.seq;
    });
    const best = candidates[0];
    const p = best.paper;

    // 提交本张：扣库存、按完整套扣减各品种需求
    stock.set(p.id, stock.get(p.id) - 1);
    best.requiredQty.forEach((q, i) => { demandQty[i] -= q; });
    placedTotal += best.piecesPlaced;
    cutsTotal += best.result.stats.cutsTotal;
    setsCompleted += best.sets;

    sheets.push({
      round: round + 1,
      sets: best.sets,
      paperId: p.id,
      paperName: p.name,
      paperWidth: p.width,
      paperHeight: p.height,
      paperGrain: p.grain,
      price: p.price,
      piecesPlaced: best.piecesPlaced,
      placedArea: best.placedArea,
      costPerM2: best.costPerM2,
      selection: {
        ranked: candidates.map((c) => ({
          paperId: c.paper.id,
          paperName: c.paper.name,
          feasible: true,
          sets: c.sets,
          piecesPlaced: c.piecesPlaced,
          placedArea: c.placedArea,
          costPerM2: c.costPerM2,
          selected: c === best,
        })),
      },
      layout: best.result,
    });

    if (setsCompleted >= plannedSets) {
      stopReason = 'completed';
      break;
    }
  }

  if (stopReason === null) stopReason = 'stock-exhausted';

  return {
    stopReason,
    sheets,
    remaining: remainingNow(),
    placedTotal,
    cutsTotal,
    totalPieces,
    setsCompleted,
    truncated,
  };
}

module.exports = { layoutCostBatch, normalizePapers };
