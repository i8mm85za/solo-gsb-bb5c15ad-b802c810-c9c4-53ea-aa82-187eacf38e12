'use strict';

/**
 * 叠纸裁切排程（stacked cutting schedule）
 *
 * 复用批量排产（layoutBatch）或多纸型成本排产（layoutCostBatch）的结果：
 * 各张纸的断头台切割树（layout 结果中的 cuts，前序 DFS、depth 即嵌套深度）
 * 被转换为可执行刀次，把多张纸上“同一刀”合并成一个批次（一叠纸一刀切完）。
 *
 * 合批规则（全部满足才可合并）：
 *  - 待切区域宽（region.w）一致；
 *  - 待切区域高（region.h）一致；
 *  - 刀向（orient：v 竖切 / h 横切）一致；
 *  - 刀位（切口中心在待切区域内的偏移：竖切为 x 偏移、横切为 y 偏移）一致；
 *  - 刀缝（kerf）一致。
 * 同一批次最多包含用户设置的叠纸上限（stackLimit）张纸，且每张纸每批至多一刀。
 *
 * 父刀约束：任何子刀必须等其所在纸张的父刀（切割树中的上层 cut）完成后才可入批。
 * 每轮在当前“可执行刀”（父刀均已完成的刀）中：
 *   1. 优先选择可合并纸张数最多者（按实际可合并张数比较，先于上限封顶）；
 *   2. 再按成批后的总切线长度长者优先；
 *   3. 再按种子刀所在纸张序号靠前者优先；
 *   4. 再按原刀序（该纸 cuts 的前序编号）靠前者稳定决胜。
 * 选出种子刀后，把其余纸张上同刀（合批键一致）且当前可执行的刀按
 * 纸张序号、原刀序纳入本批，至多 stackLimit 张（含种子纸）。
 *
 * 每批至少提交一刀、每张纸各批至多一刀，刀次总数有限，算法必然终止；
 * 所有刀最终都会被排入（无“永远未排”的刀）。`unmerged` 仅给出诊断说明：
 *  - 'solo'：该刀成批时没有任何可合并伙伴（单张独刀）；
 *  - 'stack-limit'：同刀纸张已达叠纸上限，该刀推迟到后续批次；
 *  - 'waiting-parent'：生成该批时该刀仍在等待所在纸张的父刀完成（随后已正常入批）；
 * 没有任何切割树的纸（如成品恰好铺满、零刀）列入 unmerged，原因 'no-cuts'。
 */

const EPS = 1e-6;

const STACK_LIMIT_MAX = 500; // 叠纸上限与批量用纸上限保持同一量级

const round3 = (v) => Math.round(v * 1000) / 1000;

/** 刀位：切口中心线在待切区域坐标系内的偏移（竖切看 x，横切看 y） */
function cutOffset(cut) {
  if (cut.orient === 'v') {
    return cut.band.x + cut.band.w / 2 - cut.region.x;
  }
  return cut.band.y + cut.band.h / 2 - cut.region.y;
}

/** 单刀切线长：竖切为区域高，横切为区域宽 */
function cutLength(cut) {
  return cut.orient === 'v' ? cut.region.h : cut.region.w;
}

/** 合批键：刀缝 | 刀向 | 区域宽 | 区域高 | 刀位（layout 坐标本身 round3） */
function cutKey(cut, kerf) {
  return [
    round3(kerf),
    cut.orient,
    round3(cut.region.w),
    round3(cut.region.h),
    round3(cutOffset(cut)),
  ].join('|');
}

/** 规范化叠纸上限：1～500 的正整数 */
function normalizeStackLimit(value) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) {
    throw new Error('叠纸上限必须是正整数');
  }
  if (n > STACK_LIMIT_MAX) {
    throw new Error(`叠纸上限不能超过 ${STACK_LIMIT_MAX}`);
  }
  return n;
}

/**
 * 从一张“纸”的多种可能形态抽取统一视图。支持：
 *  - 批量结果 sheets[i]（即完整 layout() 返回，可能带 orderNo/round/sets）；
 *  - 成本结果 sheets[i]（{ round, paperId, paperName, paperWidth, ..., layout }）；
 *  - 精简形态（{ paperName?, orderNo?, paper:{width,height,kerf}, cuts:[...] }）。
 */
function normalizeSheet(raw, idx, source) {
  if (!raw || typeof raw !== 'object') {
    throw new Error(`第 ${idx + 1} 张纸不是有效记录`);
  }

  let layout = raw;
  let meta = raw;
  if (raw.layout && typeof raw.layout === 'object' && Array.isArray(raw.layout.cuts)) {
    layout = raw.layout; // 成本结果逐张包装
  } else if (raw.paper && typeof raw.paper === 'object') {
    layout = { paper: raw.paper, cuts: Array.isArray(raw.cuts) ? raw.cuts : [] };
  }

  const paper = layout.paper;
  if (!paper || !(Number(paper.width) > 0) || !(Number(paper.height) > 0)) {
    throw new Error(`第 ${idx + 1} 张纸缺少有效的纸面宽高`);
  }
  const kerf = Number(paper.kerf);
  if (!Number.isFinite(kerf) || kerf < 0) {
    throw new Error(`第 ${idx + 1} 张纸的刀缝宽度无效`);
  }
  if (!Array.isArray(layout.cuts)) {
    throw new Error(`第 ${idx + 1} 张纸缺少切割树（cuts）`);
  }

  const cuts = layout.cuts.map((c, j) => {
    const pos = j + 1;
    if (!c || typeof c !== 'object') {
      throw new Error(`第 ${idx + 1} 张纸第 ${pos} 刀不是有效记录`);
    }
    if (c.orient !== 'v' && c.orient !== 'h') {
      throw new Error(`第 ${idx + 1} 张纸第 ${pos} 刀的刀向必须是 v（竖切）或 h（横切）`);
    }
    if (!c.region || ![c.region.w, c.region.h, c.region.x, c.region.y].every((n) => Number.isFinite(n))) {
      throw new Error(`第 ${idx + 1} 张纸第 ${pos} 刀的待切区域无效`);
    }
    if (c.region.w <= 0 || c.region.h <= 0) {
      throw new Error(`第 ${idx + 1} 张纸第 ${pos} 刀的待切区域宽高必须为正`);
    }
    if (!c.band || ![c.band.x, c.band.y, c.band.w, c.band.h].every((n) => Number.isFinite(n))) {
      throw new Error(`第 ${idx + 1} 张纸第 ${pos} 刀的刀缝带无效`);
    }
    let depth = c.depth;
    if (!Number.isInteger(depth) || depth < 0) depth = 0; // 缺省退化为无父刀约束
    const n = Number.isInteger(c.n) && c.n >= 1 ? c.n : pos;
    return {
      n,
      seq: j, // 原刀序（前序 DFS 下标），稳定决胜用
      depth,
      orient: c.orient,
      region: { x: c.region.x, y: c.region.y, w: c.region.w, h: c.region.h },
      band: { x: c.band.x, y: c.band.y, w: c.band.w, h: c.band.h },
      offset: cutOffset(c),
      length: cutLength(c),
    };
  });

  const orderNo = meta.orderNo !== undefined
    ? meta.orderNo
    : (layout.orderNo !== undefined ? layout.orderNo : null);
  const round = Number.isInteger(meta.round) ? meta.round : idx + 1;
  const paperId = meta.paperId != null ? String(meta.paperId) : null;
  const paperName = meta.paperName != null
    ? String(meta.paperName)
    : (paper.name != null ? String(paper.name) : '');
  const label = source === 'cost'
    ? `第 ${round} 张${paperName ? ` · ${paperName}` : ''}`
    : `第 ${idx + 1} 张${paperName ? ` · ${paperName}` : ''}`;

  return {
    index: idx + 1, // 纸张序号（1 基，稳定决胜用）
    round,
    paperId,
    paperName,
    label,
    orderNo: orderNo == null ? null : String(orderNo),
    paperWidth: Number(paper.width),
    paperHeight: Number(paper.height),
    kerf,
    cuts,
  };
}

/**
 * 按前序 DFS 的 depth 序列重建每刀的父刀（原刀序下标）。
 * 断头台切割树以前序输出、depth 即嵌套深度：
 * depth=0 为根（无父），depth=d 的父刀是其之前最近一个 depth=d-1 的刀。
 */
function buildParents(cuts) {
  const parent = new Array(cuts.length).fill(-1);
  const nearestAtDepth = new Map();
  cuts.forEach((c, i) => {
    if (c.depth > 0 && nearestAtDepth.has(c.depth - 1)) {
      parent[i] = nearestAtDepth.get(c.depth - 1);
    }
    nearestAtDepth.set(c.depth, i);
  });
  return parent;
}

const REASON_TEXT = {
  solo: '该刀成批时没有可合并的同刀纸张，按单张独刀排入',
  'stack-limit': '同刀纸张已达叠纸上限，本刀推迟到后续批次',
  'waiting-parent': '生成该批时本刀仍在等待所在纸张的父刀完成，随后已正常入批',
  'no-cuts': '该纸成品恰好铺满（或无需分割），切割树中没有刀次',
};

/**
 * 叠纸裁切排程主入口。
 *
 * @param {object} input
 *   - stackLimit：正整数（1～500），同批叠纸上限；
 *   - source?：'batch' | 'cost'（缺省自动识别）；
 *   - 以下三者之一：
 *       ① 批量排产接口的完整返回（含 sheets，元素即 layout() 结果）；
 *       ② 多纸型成本排产接口的完整返回（含 sheets[i].layout）；
 *       ③ { sheets: [精简纸 { paper, cuts, paperName?, orderNo?, round? } ] }。
 */
function stackSchedule(input) {
  if (!input || typeof input !== 'object') {
    throw new Error('缺少排程输入');
  }
  if (!Array.isArray(input.sheets)) {
    throw new Error('缺少可排程的纸张结果（sheets）——请先运行批量或多纸型成本排产');
  }
  if (input.sheets.length === 0) {
    throw new Error('排产结果中没有任何纸张，无法生成叠纸裁切排程');
  }
  const stackLimit = normalizeStackLimit(input.stackLimit);
  const source = input.source === 'batch' || input.source === 'cost'
    ? input.source
    : (input.sheets.some((s) => s && s.layout && Array.isArray(s.layout.cuts)) ? 'cost' : 'batch');

  const sheets = input.sheets.map((s, i) => normalizeSheet(s, i, source));

  // 每张纸：父刀下标、已入批集合、子刀表
  const parents = sheets.map((sh) => buildParents(sh.cuts));
  const children = sheets.map((sh, si) => {
    const list = sh.cuts.map(() => []);
    parents[si].forEach((p, ci) => { if (p >= 0) list[p].push(ci); });
    return list;
  });
  const done = sheets.map(() => new Set());

  // 全部刀按合批键登记（仅同键才能合并）
  const keyOf = sheets.map((sh) => sh.cuts.map((c) => cutKey(c, sh.kerf)));
  const keyIndex = new Map(); // key → [[si,ci]...]，按纸张序号/原刀序有序
  sheets.forEach((sh, si) => {
    sh.cuts.forEach((cut, ci) => {
      const key = keyOf[si][ci];
      if (!keyIndex.has(key)) keyIndex.set(key, []);
      keyIndex.get(key).push([si, ci]);
    });
  });

  // 当前可执行刀的增量索引：key → Map("si:ci" → [si,ci])
  // 初始可执行刀为各纸切割树根（无父刀）；每批提交后增量移除/解锁
  const readyByKey = new Map();
  const addReady = (si, ci) => {
    const key = keyOf[si][ci];
    if (!readyByKey.has(key)) readyByKey.set(key, new Map());
    readyByKey.get(key).set(`${si}:${ci}`, [si, ci]);
  };
  sheets.forEach((sh, si) => {
    sh.cuts.forEach((c, ci) => { if (parents[si][ci] < 0) addReady(si, ci); });
  });

  const batches = [];
  const batchOf = new Map(); // "si:ci" → batchNo
  const notes = []; // { sheetIndex, cutNo, reason, batchNo }
  let totalCuts = 0;
  let totalLength = 0;

  const bySheetThenCut = (a, b) => (a[0] - b[0]) || (a[1] - b[1]);

  while (readyByKey.size > 0) {
    // 在当前各合批键的可执行刀中选种子：
    // 可合并纸张数 ↓ → 封顶后张数 ↓ → 总切线长 ↓ → 种子纸张序号 ↑ → 原刀序 ↑
    let best = null;
    for (const [key, readyMap] of readyByKey) {
      if (readyMap.size === 0) continue;
      // 每张纸每批至多一刀：同纸多刀就绪时只取原刀序最前者
      const firstPerSheet = new Map();
      for (const [si, ci] of readyMap.values()) {
        if (!firstPerSheet.has(si) || ci < firstPerSheet.get(si)) firstPerSheet.set(si, ci);
      }
      const members = [...firstPerSheet.entries()]
        .map(([si, ci]) => [si, ci])
        .sort(bySheetThenCut);
      const rawSheets = members.length;
      const picked = members.slice(0, stackLimit);
      const [seedSi, seedCi] = picked[0];
      const seedCut = sheets[seedSi].cuts[seedCi];
      const batchLength = seedCut.length * picked.length;
      const cand = { key, members, picked, rawSheets, batchLength, seedSi, seedCi };
      if (!best) { best = cand; continue; }
      if (cand.rawSheets !== best.rawSheets) {
        if (cand.rawSheets > best.rawSheets) best = cand;
        continue;
      }
      if (cand.picked.length !== best.picked.length) {
        if (cand.picked.length > best.picked.length) best = cand;
        continue;
      }
      if (Math.abs(cand.batchLength - best.batchLength) > EPS) {
        if (cand.batchLength > best.batchLength) best = cand;
        continue;
      }
      if (cand.seedSi !== best.seedSi) {
        if (cand.seedSi < best.seedSi) best = cand;
        continue;
      }
      if (cand.seedCi < best.seedCi) best = cand;
    }

    const batchNo = batches.length + 1;
    const pickedSet = new Set(best.picked.map(([si, ci]) => `${si}:${ci}`));
    const pickedSheets = new Set(best.picked.map(([si]) => si));

    // 未入批诊断：同键刀中既未完成又未入选者——
    // 当前可执行 → 受叠纸上限推迟；否则 → 仍在等待父刀
    for (const [si, ci] of keyIndex.get(best.key)) {
      const token = `${si}:${ci}`;
      if (pickedSet.has(token) || done[si].has(ci)) continue;
      if (pickedSheets.has(si)) continue; // 该纸本批已出一刀（每纸每批至多一刀）
      const isReady = readyByKey.get(best.key) && readyByKey.get(best.key).has(token);
      notes.push({
        sheetIndex: sheets[si].index,
        cutNo: sheets[si].cuts[ci].n,
        reason: isReady ? 'stack-limit' : 'waiting-parent',
        batchNo,
      });
    }

    // 提交本批：移出可执行、标记完成、解锁直接子刀
    const memberOut = [];
    for (const [si, ci] of best.picked) {
      readyByKey.get(best.key).delete(`${si}:${ci}`);
      done[si].add(ci);
      batchOf.set(`${si}:${ci}`, batchNo);
      memberOut.push({ sheetIndex: sheets[si].index, cutNo: sheets[si].cuts[ci].n });
      totalCuts += 1;
      totalLength += sheets[si].cuts[ci].length;
      for (const child of children[si][ci]) addReady(si, child);
    }
    if (readyByKey.get(best.key).size === 0) readyByKey.delete(best.key);

    const seedCut = sheets[best.seedSi].cuts[best.seedCi];
    batches.push({
      batchNo,
      orient: seedCut.orient,
      kerf: round3(sheets[best.seedSi].kerf),
      position: round3(seedCut.offset),
      region: { w: round3(seedCut.region.w), h: round3(seedCut.region.h) },
      cutLength: round3(seedCut.length),
      totalLength: round3(seedCut.length * best.picked.length),
      sheetCount: best.picked.length,
      capped: best.rawSheets > best.picked.length,
      members: memberOut,
    });
  }

  /* ---------------- 输出组装 ---------------- */

  // 诊断去重：同一刀首次受阻原因（stack-limit 优先于 waiting-parent）
  const reasonRank = { 'stack-limit': 0, 'waiting-parent': 1 };
  const firstNote = new Map();
  for (const note of notes) {
    const k = `${note.sheetIndex}:${note.cutNo}`;
    const prev = firstNote.get(k);
    if (!prev || reasonRank[note.reason] < reasonRank[prev.reason]) firstNote.set(k, note);
  }
  const unmerged = [...firstNote.values()].map((note) => ({
    sheetIndex: note.sheetIndex,
    cutNo: note.cutNo,
    reason: note.reason,
    detail: REASON_TEXT[note.reason],
    batchNo: note.batchNo,
  }));

  // 单张独刀批次
  for (const b of batches) {
    if (b.sheetCount === 1) {
      const m = b.members[0];
      unmerged.push({
        sheetIndex: m.sheetIndex,
        cutNo: m.cutNo,
        reason: 'solo',
        detail: REASON_TEXT.solo,
        batchNo: b.batchNo,
      });
    }
  }

  // 每张纸进度
  const sheetOut = sheets.map((sh, si) => {
    const batchNos = sh.cuts.map((_, ci) => batchOf.get(`${si}:${ci}`)).filter((n) => n != null);
    const soloCutCount = batchNos.filter((n) => batches[n - 1].sheetCount === 1).length;
    return {
      index: sh.index,
      round: sh.round,
      paperId: sh.paperId,
      paperName: sh.paperName,
      label: sh.label,
      orderNo: sh.orderNo,
      paperWidth: round3(sh.paperWidth),
      paperHeight: round3(sh.paperHeight),
      kerf: round3(sh.kerf),
      cutsTotal: sh.cuts.length,
      cutsScheduled: done[si].size,
      batchNos,
      mergedCutCount: batchNos.length - soloCutCount,
      soloCutCount,
      hasCuts: sh.cuts.length > 0,
    };
  });

  // 零刀纸张（成品恰好铺满等）
  for (const sh of sheetOut) {
    if (!sh.hasCuts) {
      unmerged.push({ sheetIndex: sh.index, cutNo: null, reason: 'no-cuts', detail: REASON_TEXT['no-cuts'] });
    }
  }

  unmerged.sort((a, b) =>
    (a.sheetIndex - b.sheetIndex)
    || ((a.cutNo == null ? Infinity : a.cutNo) - (b.cutNo == null ? Infinity : b.cutNo))
    || String(a.reason).localeCompare(String(b.reason)));

  const mergedBatches = batches.filter((b) => b.sheetCount > 1).length;

  // 父刀依赖图：dependencies[i] 为第 i+1 张纸的 [子刀号, 父刀号] 列表（按原刀序），
  // 供执行工单（src/workorder.js）建立批次/刀次间的先后约束
  const dependencies = sheets.map((sh, si) => {
    const edges = [];
    parents[si].forEach((p, ci) => {
      if (p >= 0) edges.push([sh.cuts[ci].n, sh.cuts[p].n]);
    });
    return edges;
  });

  return {
    source,
    stackLimit,
    dependencies,
    summary: {
      sheetsTotal: sheets.length,
      sheetsWithCuts: sheets.filter((sh) => sh.cuts.length > 0).length,
      cutsTotal: totalCuts,
      batchesTotal: batches.length,
      mergedBatches,
      soloBatches: batches.length - mergedBatches,
      maxSheetsPerBatch: batches.reduce((m, b) => Math.max(m, b.sheetCount), 0),
      totalLength: round3(totalLength),
    },
    batches,
    sheets: sheetOut,
    unmerged,
  };
}

module.exports = { stackSchedule, normalizeStackLimit, cutKey };
