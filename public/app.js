'use strict';

const PALETTE = [
  '#a5d8ff', '#b2f2bb', '#ffec99', '#ffc9c9', '#d0bfff',
  '#99e9f2', '#ffd8a8', '#c3fae8', '#eebefa', '#dee2e6',
];

const $ = (id) => document.getElementById(id);

function currentMode() {
  const el = document.querySelector('input[name="mode"]:checked');
  return el ? el.value : 'single';
}

function currentObjective() {
  const el = document.querySelector('input[name="objective"]:checked');
  return el ? el.value : 'more-pieces';
}

function colorFor(id) {
  let h = 0;
  for (const ch of String(id)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return PALETTE[h % PALETTE.length];
}

const GRAIN_REQ_OPTIONS = [
  ['any', '不限'],
  ['along-width', '沿自身宽'],
  ['along-height', '沿自身高'],
];

const PAPER_GRAIN_OPTIONS = [
  ['along-width', '沿宽 ↔'],
  ['along-height', '沿高 ↕'],
];

function grainReqLabel(g) {
  const hit = GRAIN_REQ_OPTIONS.find(([v]) => v === g);
  return hit ? hit[1] : '不限';
}

function paperGrainLabel(g) {
  return g === 'along-height' ? '沿高' : '沿宽';
}

function grainSelect(cls, options, value) {
  const opts = options.map(([v, label]) =>
    `<option value="${v}"${v === value ? ' selected' : ''}>${label}</option>`
  ).join('');
  return `<select class="${cls}">${opts}</select>`;
}

function addProductRow(name = '', orderNo = '', w = '', h = '', qty = '', grain = 'any', perSet = '') {
  const row = document.createElement('div');
  row.className = 'products-row';
  row.innerHTML = `
    <input type="text" class="p-name" placeholder="如：名片 / 封面" value="${name}" />
    <input type="text" class="p-order" placeholder="订单号（可选）" value="${orderNo}" maxlength="64" />
    <input type="number" class="p-w" min="0" step="0.1" placeholder="宽" value="${w}" />
    <input type="number" class="p-h" min="0" step="0.1" placeholder="高" value="${h}" />
    <input type="number" class="p-q" min="0" step="1" placeholder="数量" value="${qty}" />
    <input type="number" class="p-perset" min="1" step="1" placeholder="每套用量" value="${perSet}" hidden />
    ${grainSelect('p-grain', GRAIN_REQ_OPTIONS, grain)}
    <button type="button" class="del" title="删除该行">✕</button>
  `;
  row.querySelector('.del').addEventListener('click', () => {
    if ($('productRows').children.length > 1) row.remove();
  });
  $('productRows').appendChild(row);
}

/* ---------------- 成套生产模式切换 ---------------- */

let kitMode = false;

function applyKitColumns() {
  const on = kitMode;
  $('perSetHint').hidden = !on;
  // 表头
  document.querySelector('.qty-head').hidden = on;
  document.querySelector('.perset-head').hidden = !on;
  // 每行：数量列隐藏、每套用量列显示；网格列数 +1
  document.querySelectorAll('#productRows .products-row').forEach((row) => {
    row.querySelector('.p-q').hidden = on;
    row.querySelector('.p-perset').hidden = !on;
  });
  const cols = on
    ? '1.15fr 1.05fr 0.62fr 0.62fr 0fr 0.72fr 0.92fr 30px'
    : '1.15fr 1.05fr 0.62fr 0.62fr 0.58fr 0fr 0.92fr 30px';
  $('productsHead').style.gridTemplateColumns = cols;
  document.querySelectorAll('#productRows .products-row').forEach((row) => {
    row.style.gridTemplateColumns = cols;
  });
}

function setKitMode(on) {
  kitMode = !!on;
  $('kitMode').checked = kitMode;
  applyKitColumns();
  // 成套与订单隔离互斥
  if (kitMode) {
    $('isolateOrders').checked = false;
    $('isolateOrders').disabled = true;
  } else {
    $('isolateOrders').disabled = false;
  }
}

/* ---------------- 多纸型候选表格 ---------------- */

function addPaperRow(name = '', w = '', h = '', price = '', stock = '', grain = 'along-width') {
  const row = document.createElement('div');
  row.className = 'paper-row';
  row.innerHTML = `
    <input type="text" class="pp-name" placeholder="如：大度全张 / A3" value="${name}" />
    <input type="number" class="pp-w" min="0" step="0.1" placeholder="宽" value="${w}" />
    <input type="number" class="pp-h" min="0" step="0.1" placeholder="高" value="${h}" />
    ${grainSelect('pp-grain', PAPER_GRAIN_OPTIONS, grain)}
    <input type="number" class="pp-price" min="0" step="0.01" placeholder="单价" value="${price}" />
    <input type="number" class="pp-stock" min="0" max="500" step="1" placeholder="张数" value="${stock}" />
    <button type="button" class="del" title="删除该纸型">✕</button>
  `;
  row.querySelector('.del').addEventListener('click', () => {
    if ($('paperRows').children.length > 2) row.remove();
  });
  $('paperRows').appendChild(row);
}

function readProducts() {
  const products = [];
  [...$('productRows').querySelectorAll('.products-row')].forEach((row, i) => {
    const width = Number(row.querySelector('.p-w').value);
    const height = Number(row.querySelector('.p-h').value);
    const quantity = Number(row.querySelector('.p-q').value);
    const perSetRaw = row.querySelector('.p-perset').value;

    if (kitMode) {
      const perSet = Number(perSetRaw);
      if (!width && !height && !perSetRaw) return; // 空行跳过
      if (!(width > 0) || !(height > 0)) {
        throw new Error(`第 ${i + 1} 行成品：宽高须为正数。`);
      }
      if (!(Number.isInteger(perSet) && perSet >= 1)) {
        throw new Error(`第 ${i + 1} 行成品：成套生产时每套用量须为正整数。`);
      }
      const product = {
        name: row.querySelector('.p-name').value.trim(),
        width, height, perSet,
        grain: row.querySelector('.p-grain').value,
      };
      products.push(product);
      return;
    }

    if (!width && !height && !quantity) return; // 空行跳过
    if (!(width > 0) || !(height > 0) || !(Number.isInteger(quantity) && quantity >= 0)) {
      throw new Error(`第 ${i + 1} 行成品：宽高须为正数，数量须为非负整数。`);
    }
    if (quantity > 0) {
      const product = {
        name: row.querySelector('.p-name').value.trim(),
        width, height, quantity,
        grain: row.querySelector('.p-grain').value,
      };
      const orderNo = row.querySelector('.p-order').value.trim();
      if (orderNo) {
        if (orderNo.length > 64) {
          throw new Error(`第 ${i + 1} 行成品：订单号长度不能超过 64 个字符。`);
        }
        product.orderNo = orderNo;
      }
      products.push(product);
    }
  });
  return products;
}

function readPapers() {
  const papers = [];
  [...$('paperRows').querySelectorAll('.paper-row')].forEach((row, i) => {
    const name = row.querySelector('.pp-name').value.trim();
    const width = Number(row.querySelector('.pp-w').value);
    const height = Number(row.querySelector('.pp-h').value);
    const price = Number(row.querySelector('.pp-price').value);
    const stock = Number(row.querySelector('.pp-stock').value);
    const inputs = ['.pp-w', '.pp-h', '.pp-price', '.pp-stock'];
    const blank = !name && inputs.every((sel) => !row.querySelector(sel).value);
    if (blank) return; // 空行跳过
    const pos = i + 1;
    if (!(width > 0) || !(height > 0)) {
      throw new Error(`第 ${pos} 种纸张：宽高必须为正数。`);
    }
    if (!(price > 0)) {
      throw new Error(`第 ${pos} 种纸张：单价必须大于 0。`);
    }
    if (!(Number.isInteger(stock) && stock >= 0 && stock <= 500)) {
      throw new Error(`第 ${pos} 种纸张：可用张数必须是 0～500 的整数。`);
    }
    papers.push({ name, width, height, price, stock, grain: row.querySelector('.pp-grain').value });
  });
  if (papers.length < 2) throw new Error('多纸型成本排产至少需要 2 种候选纸张。');
  if (papers.length > 8) throw new Error('候选纸张最多为 8 种。');
  return papers;
}

function readForm() {
  const paperW = Number($('paperW').value);
  const paperH = Number($('paperH').value);
  const kerf = Number($('kerf').value);

  if (!(kerf >= 0)) throw new Error('刀缝宽度必须是非负数。');

  const mode = currentMode();
  // 订单隔离仅对批量 / 多纸型排产生效；成套模式与之互斥
  const isolateOrders = mode !== 'single' && !kitMode && $('isolateOrders').checked;
  const kit = mode !== 'single' && kitMode
    ? (() => {
        const plannedSets = Number($('plannedSets').value);
        if (!Number.isInteger(plannedSets) || plannedSets < 1 || plannedSets > 100000) {
          throw new Error('计划套数须为 1～100000 的整数。');
        }
        return { plannedSets };
      })()
    : null;
  if (mode === 'cost') {
    const payload = { kerf, papers: readPapers(), products: readProducts(), isolateOrders };
    if (kit) payload.kit = kit;
    return payload;
  }

  if (!(paperW > 0) || !(paperH > 0)) {
    throw new Error('纸张宽高必须为正数。');
  }

  const payload = {
    paperW, paperH, paperGrain: $('paperGrain').value, kerf,
    products: readProducts(), isolateOrders,
  };
  if (kit) payload.kit = kit;

  if (mode === 'batch') {
    const maxSheets = Number($('maxSheets').value);
    if (!Number.isInteger(maxSheets) || maxSheets < 1 || maxSheets > 500) {
      throw new Error('最多用纸张数须为 1～500 的整数。');
    }
    payload.maxSheets = maxSheets;
  } else if (mode === 'single') {
    // 单张试排：方案比选目标（优先多排 / 优先省刀）
    payload.objective = currentObjective();
  }

  return payload;
}

function fmt(n) {
  return (Math.round(n * 100) / 100).toLocaleString('zh-CN');
}

function renderStats(r) {
  const s = r.stats;
  const pct = (s.areaRatio * 100).toFixed(1);
  const low = s.areaRatio < 0.5 ? ' low' : '';
  $('stats').innerHTML = `
    <div class="stat">已排/总数：<b>${s.piecesPlaced}/${s.piecesTotal}</b> 件</div>
    <div class="stat">成品面积：<b>${fmt(s.placedArea)}</b> mm²</div>
    <div class="stat">刀缝面积：<b>${fmt(s.kerfArea)}</b> mm²</div>
    <div class="stat">余料面积：<b>${fmt(s.freeArea)}</b> mm²</div>
    <div class="stat">总刀数：<b>${s.cutsTotal}</b></div>
    <div class="stat" style="flex-basis:100%">已排面积占比：<b>${pct}%</b>
      <div class="ratio-bar${low}"><span style="width:${(s.areaRatio * 100).toFixed(2)}%"></span></div>
    </div>
  `;
}

function renderSvg(r) {
  const paper = r.paper;
  const margin = 46;
  const availW = Math.max(300, $('svgWrap').clientWidth - 30);
  const availH = 640;
  const scale = Math.min(
    (availW - margin * 2) / paper.width,
    (availH - margin * 2) / paper.height,
    3
  );
  const W = paper.width * scale;
  const H = paper.height * scale;
  const svgW = W + margin * 2;
  const svgH = H + margin * 2;

  const X = (x) => margin + x * scale;
  const Y = (y) => margin + y * scale;

  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('viewBox', `0 0 ${svgW} ${svgH}`);
  svg.setAttribute('width', svgW);
  svg.setAttribute('height', svgH);

  const add = (tag, attrs, parent = svg) => {
    const el = document.createElementNS(NS, tag);
    for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
    parent.appendChild(el);
    return el;
  };
  const text = (x, y, str, attrs) => {
    const t = add('text', { x, y, ...attrs });
    t.textContent = str;
    return t;
  };

  // 纸面
  add('rect', {
    x: margin, y: margin, width: W, height: H,
    fill: '#ffffff', stroke: '#1f2933', 'stroke-width': 1.5,
  });

  // 纸张尺寸标注（顶部同时标出纸张纹向）
  const grainNote = paper.grain ? ` · 纹向${paperGrainLabel(paper.grain)}` : '';
  text(svgW / 2, margin - 14, `${fmt(paper.width)} mm${grainNote}`, {
    'text-anchor': 'middle', 'font-size': 12, fill: '#1f2933',
  });
  text(margin - 12, svgH / 2, `${fmt(paper.height)} mm`, {
    'text-anchor': 'middle', 'font-size': 12, fill: '#1f2933',
    transform: `rotate(-90 ${margin - 12} ${svgH / 2})`,
  });

  // 余料区（淡灰网格感）
  for (const f of r.frees) {
    add('rect', {
      x: X(f.x), y: Y(f.y), width: f.w * scale, height: f.h * scale,
      fill: '#f1f3f5', stroke: '#ced4da', 'stroke-width': 0.6, 'stroke-dasharray': '3,2',
    });
  }

  // 刀缝带（可视化时按比例画，最窄也能看见）
  const bandMin = Math.max(1.2, paper.kerf * scale);
  for (const c of r.cuts) {
    const b = c.band;
    let bx, by, bw, bh;
    if (c.orient === 'v') {
      bw = Math.max(bandMin, b.w * scale);
      bh = b.h * scale;
      bx = X(b.x + b.w / 2) - bw / 2;
      by = Y(b.y);
    } else {
      bh = Math.max(bandMin, b.h * scale);
      bw = b.w * scale;
      bx = X(b.x);
      by = Y(b.y + b.h / 2) - bh / 2;
    }
    add('line', {
      x1: bx + (c.orient === 'v' ? bw / 2 : 0),
      y1: by + (c.orient === 'h' ? bh / 2 : 0),
      x2: bx + (c.orient === 'v' ? bw / 2 : bw),
      y2: by + (c.orient === 'h' ? bh / 2 : bh),
      stroke: '#e03131', 'stroke-width': 1.4, 'stroke-dasharray': '6,3',
    });
    const badgeR = 8;
    const cx = bx + (c.orient === 'v' ? bw / 2 : bw - badgeR - 2);
    const cy = by + (c.orient === 'h' ? bh / 2 : badgeR + 2);
    add('circle', { cx, cy, r: badgeR, fill: '#fff', stroke: '#e03131', 'stroke-width': 1.2 });
    text(cx, cy + 3.2, String(c.n), {
      'text-anchor': 'middle', 'font-size': 10, 'font-weight': 700, fill: '#e03131',
    });
  }

  // 成品
  for (const it of r.items) {
    const g = add('g', {});
    add('rect', {
      x: X(it.x), y: Y(it.y), width: it.w * scale, height: it.h * scale,
      fill: colorFor(it.id), 'fill-opacity': 0.55,
      stroke: '#495057', 'stroke-width': 0.9,
    }, g);

    const cx = X(it.x + it.w / 2);
    const cy = Y(it.y + it.h / 2);
    const fs = Math.min(12, Math.max(8, Math.min(it.w, it.h) * scale / 6));
    const label = it.name ? it.name : it.id;
    // 有纹向要求的成品标注匹配状态（排样保证平行，故恒为 ✓）
    const grainMark = it.grain && it.grain !== 'any' ? ` 纹${it.grainOk === false ? '✗' : '✓'}` : '';
    const lines = [
      label,
      `${fmt(it.specW)}×${fmt(it.specH)}${it.rotated ? ' ⟳90°' : ''}${grainMark}`,
    ];
    const pieceText = `#${it.pieceNo}`;
    const lineH = fs + 2;
    text(cx, cy - lineH + 3, lines[0], {
      'text-anchor': 'middle', 'font-size': fs, 'font-weight': 700, fill: '#212529',
    });
    text(cx, cy + 4, lines[1], {
      'text-anchor': 'middle', 'font-size': fs - 1.5, fill: '#343a40',
    });
    text(cx, cy + lineH + 4, pieceText, {
      'text-anchor': 'middle', 'font-size': fs - 2, fill: '#868e96',
    });
    // 隔离排产：逐件标明所属订单号（块面过小时省略以免溢出）
    if (it.orderNo && Math.min(it.w, it.h) * scale >= 34) {
      const orderLabel = it.orderNo.length > 12 ? `订单:${it.orderNo.slice(0, 11)}…` : `订单:${it.orderNo}`;
      const orderEl = text(cx, cy + lineH * 2 + 3, orderLabel, {
        'text-anchor': 'middle', 'font-size': fs - 2,
      });
      orderEl.setAttribute('class', 'order-tag');
    }
  }

  // 图例
  const legends = [...new Map(r.items.map((it) => [it.id, it])).values()];
  legends.forEach((it, i) => {
    const lx = margin + 6 + i * 150;
    const ly = svgH - 12;
    add('rect', { x: lx, y: ly - 9, width: 12, height: 12, fill: colorFor(it.id), stroke: '#495057', 'stroke-width': 0.6 });
    text(lx + 16, ly + 1, `${it.id} ${fmt(it.specW)}×${fmt(it.specH)}`, { 'font-size': 11, fill: '#343a40' });
  });

  $('svgWrap').innerHTML = '';
  $('svgWrap').appendChild(svg);
}

function orientLabel(o) {
  return o === 'v' ? '竖切（↑↓）' : '横切（←→）';
}

function renderCutList(r) {
  if (!r.cuts.length) {
    $('cutList').innerHTML = '';
    return;
  }
  const rows = r.cuts.map((c) => `
    <tr>
      <td><b style="color:var(--cut)">${c.n}</b></td>
      <td>${orientLabel(c.orient)}</td>
      <td>${fmt(c.region.w)}×${fmt(c.region.h)} @ (${fmt(c.region.x)}, ${fmt(c.region.y)})</td>
      <td>${fmt(c.length)} mm</td>
    </tr>
  `).join('');
  $('cutList').innerHTML = `
    <h3>下刀顺序（每刀将当前区域一分为二）</h3>
    <table>
      <thead><tr><th>序号</th><th>方向</th><th>被切区域 宽×高 @ 左上角</th><th>切线长</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

function renderUnplaced(r, heading = '排不下的成品') {
  // 隔离开启（或任意行带订单号）时增加订单列
  const showOrder = r.unplaced.some((u) => u.orderNo);
  if (!r.unplaced.length) {
    $('unplaced').innerHTML = r.stats.piecesTotal
      ? '<p class="badge-ok">✔ 全部成品均已排入。</p>'
      : '<p>未提供成品。</p>';
    return;
  }
  const orderCell = (u) => showOrder
    ? `<td>${u.orderNo
      ? `<b style="color:var(--brand)">${u.orderNo}</b>`
      : '<span class="ord-null">未填写</span>'}</td>`
    : '';
  const rows = r.unplaced.map((u) => `
    <tr>
      ${orderCell(u)}
      <td>${u.name ? `${u.name}（${u.id}）` : u.id}</td>
      <td>${fmt(u.width)}×${fmt(u.height)}</td>
      <td>${grainReqLabel(u.grain)}</td>
      <td>${u.placed} / ${u.total}</td>
      <td class="badge-bad">${u.quantity} 件排不下（${u.grainBlocked ? '纹向受限' : '尺寸不足'}）</td>
    </tr>
  `).join('');
  $('unplaced').innerHTML = `
    <h3>${heading}</h3>
    <table>
      <thead><tr>${showOrder ? '<th>订单号</th>' : ''}<th>名称</th><th>规格 宽×高 (mm)</th><th>纹向要求</th><th>已排/需求</th><th>剩余</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
}

/* ---------------- 方案比选（单张试排三策略择优） ---------------- */

let compareState = null; // 最近一次方案比选结果

const OBJECTIVE_LABELS = {
  'more-pieces': '优先多排（已排件数 → 已排面积 → 刀数少 → 策略顺序）',
  'fewer-cuts': '优先省刀（排除空方案后：刀数少 → 已排面积 → 已排件数 → 策略顺序）',
};

function renderCompare(data) {
  compareState = data;
  const best = data.best;

  // 候选指标对比表（最佳行高亮）
  const rows = data.candidates.map((c) => `
    <tr class="${c.selected ? 'winner' : ''}">
      <td>${c.label}${c.selected ? '<span class="best-badge">最佳</span>' : ''}</td>
      <td class="num">${c.metrics.piecesPlaced} / ${c.metrics.piecesTotal}</td>
      <td class="num">${fmt(c.metrics.placedArea)}</td>
      <td class="num">${(c.metrics.areaRatio * 100).toFixed(1)}%</td>
      <td class="num">${c.metrics.cutsTotal}</td>
    </tr>`).join('');

  // 逐项选择依据
  const steps = data.decision.map((d) => `<li><b>${d.label}</b>：${d.note}</li>`).join('');

  $('compareBar').innerHTML = `
    <div class="stop-reason ${best ? 'ok' : 'warn'}">${best
      ? `✔ 最佳方案：<b>${best.label}</b>（已排 ${best.metrics.piecesPlaced} 件 · ${fmt(best.metrics.placedArea)} mm² · ${best.metrics.cutsTotal} 刀）`
      : '⚠ 三种策略均未排入任何成品，不指定最佳方案（未排原因见下方清单）。'}</div>
    <div class="compare-obj">比选目标：${OBJECTIVE_LABELS[data.objective] || data.objective}</div>
    <table class="compare-table">
      <thead><tr>
        <th>策略</th><th class="num">已排/总件数</th><th class="num">已排面积 (mm²)</th>
        <th class="num">面积占比</th><th class="num">刀数</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
    <details class="decision" open>
      <summary>逐项选择依据</summary>
      <ol>${steps}</ol>
    </details>
  `;
  $('compareBar').hidden = false;

  // 候选标签页（突出最佳项）
  const tabs = $('sheetTabs');
  tabs.innerHTML = data.candidates.map((c, i) =>
    `<button type="button" data-i="${i}" class="${c.selected ? 'best' : ''}">${c.label}`
    + `（${c.metrics.piecesPlaced} 件 · ${c.metrics.cutsTotal} 刀）${c.selected ? ' ★最佳' : ''}</button>`
  ).join('');
  [...tabs.querySelectorAll('button')].forEach((b) =>
    b.addEventListener('click', () => showCompareSheet(Number(b.dataset.i)))
  );
  tabs.hidden = false;

  // 默认展示最佳方案；全部排不进时展示首个候选（其未排清单即现有未排原因）
  const bestIdx = data.candidates.findIndex((c) => c.selected);
  showCompareSheet(bestIdx >= 0 ? bestIdx : 0);
}

function showCompareSheet(i) {
  if (!compareState || !compareState.candidates[i]) return;
  setActiveTab(i);
  const sheet = compareState.candidates[i].layout;
  renderStats(sheet);
  renderSvg(sheet);
  renderCutList(sheet);
  renderUnplaced(sheet);
}

function clearCompareUi() {
  compareState = null;
  $('compareBar').hidden = true;
  $('compareBar').innerHTML = '';
  clearStackUi();
}

/* ---------------- 批量排产 ---------------- */

let batchState = null; // 最近一次批量排产结果

const STOP_REASONS = {
  completed: (s) => ['ok', `✔ 全部完成：${s.piecesTotal} 件成品共排入 ${s.sheetsUsed} 张纸。`],
  'max-sheets': (s) => ['warn', `⚠ 已达最多用纸张数（${s.maxSheets} 张），仍有 ${s.piecesTotal - s.piecesPlaced} 件未排，已停止。`],
  'no-progress': (s) => ['warn', `⚠ 第 ${s.sheetsUsed + 1} 张纸排不进任何剩余成品，已立即停止（未生成空白纸），剩余 ${s.piecesTotal - s.piecesPlaced} 件。`],
};

/* ---------------- 订单隔离汇总（批量/成本共用） ---------------- */

function orderLabel(o) {
  return o.orderNo
    ? `<b style="color:var(--brand)">${o.orderNo}</b>`
    : '<span class="ord-null">未填写订单号（同组混排）</span>';
}

function renderOrderSummary(data) {
  const box = $('orderSummary');
  if (!data.isolated || !data.orderSummary || !data.orderSummary.length) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const blockedKeys = new Set((data.blockedOrders || []).map((b) => b.orderNo));
  const rows = data.orderSummary.map((o) => {
    const blocked = blockedKeys.has(o.orderNo);
    const pct = (o.completionRate * 100).toFixed(1);
    return `
      <tr class="${blocked ? 'blocked' : o.quantity === 0 ? 'done' : ''}">
        <td>${orderLabel(o)}</td>
        <td class="num">${o.total}</td>
        <td class="num">${o.placed}</td>
        <td class="num">${o.quantity}</td>
        <td class="num">${pct}%</td>
        <td>${blocked ? '<span class="blocked-badge">受阻（所有可用纸型均无进展）</span>' : o.quantity === 0 ? '✔ 已完成' : '进行中'}</td>
      </tr>`;
  }).join('');
  box.innerHTML = `
    <h3>订单汇总（每张纸仅排一个订单）</h3>
    <table>
      <thead><tr><th>订单号</th><th class="num">需求件数</th><th class="num">已排</th><th class="num">剩余</th><th class="num">完成率</th><th>状态</th></tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  box.hidden = false;
}

function clearOrderSummary() {
  const box = $('orderSummary');
  box.hidden = true;
  box.innerHTML = '';
}

/* ---------------- 成套生产进度 ---------------- */

function renderKitProgress(data) {
  const box = $('kitProgress');
  if (!data.kit) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  const planned = data.kit.plannedSets;
  const done = data.kit.setsCompleted;
  const remaining = data.kit.setsRemaining;
  const pct = planned > 0 ? (done / planned) * 100 : 0;
  const perSetIds = new Map((data.kit.perSet || []).map((p) => [p.id, p.perSet]));

  const rows = data.remaining.map((u) => {
    const perSet = u.perSet != null ? u.perSet : perSetIds.get(u.id);
    const needSets = planned;
    const madeSets = perSet > 0 ? Math.floor(u.placed / perSet) : 0;
    const cls = u.quantity === 0 ? 'done' : remaining > 0 ? 'short' : '';
    return `
      <tr class="${cls}">
        <td>${u.name ? `${u.name}（${u.id}）` : u.id}</td>
        <td>${fmt(u.width)}×${fmt(u.height)}</td>
        <td>${grainReqLabel(u.grain)}</td>
        <td class="num">${perSet}</td>
        <td class="num">${u.total}</td>
        <td class="num">${u.placed}（约 ${madeSets} 套）</td>
        <td class="num">${u.quantity}</td>
      </tr>`;
  }).join('');

  box.innerHTML = `
    <h3>成套生产进度</h3>
    <div class="kit-head">
      <span>已完成套数：<b>${done}</b> / ${planned} 套</span>
      <span>还差：<b>${remaining}</b> 套</span>
      <span>用纸：<b>${(data.summary && data.summary.sheetsUsed) || 0}</b> 张</span>
      ${data.summary && data.summary.truncated
        ? '<span style="color:#e67700">（本方案在试排预算内择优，属快速试排、非全局最优）</span>'
        : ''}
    </div>
    <div class="kit-bar"><span style="width:${pct.toFixed(2)}%"></span></div>
    <table>
      <thead><tr>
        <th>品种</th><th>规格 宽×高 (mm)</th><th>纹向</th>
        <th class="num">每套用量</th><th class="num">套内需求</th>
        <th class="num">已排</th><th class="num">欠数</th>
      </tr></thead>
      <tbody>${rows}</tbody>
    </table>
  `;
  box.hidden = false;
}

function clearKitProgress() {
  const box = $('kitProgress');
  box.hidden = true;
  box.innerHTML = '';
}

function renderBatch(data) {
  batchState = data;
  const s = data.summary;
  const pct = (s.completionRate * 100).toFixed(1);
  const [cls, text] = (STOP_REASONS[data.stopReason] || (() => ['warn', data.stopReason]))(s);

  const blockedNote = data.isolated && data.blockedOrders && data.blockedOrders.length
    ? ` 受阻订单：${data.blockedOrders.map((b) => b.orderNo || '未填写订单号组').join('、')}（未生成空白纸、未误扣库存）。`
    : '';

  const kitNote = data.kit
    ? ` <span class="kit-sheet-badge">成套 ${data.kit.setsCompleted}/${data.kit.plannedSets} 套</span>`
    : '';

  $('batchBar').innerHTML = `
    <div class="stop-reason ${cls}">${text}${kitNote}${blockedNote}</div>
    <div class="stats">
      <div class="stat">用纸数：<b>${s.sheetsUsed}</b> / 上限 ${s.maxSheets} 张</div>
      <div class="stat">已排/总数：<b>${s.piecesPlaced}/${s.piecesTotal}</b> 件</div>
      <div class="stat">总刀数：<b>${s.cutsTotal}</b></div>
      <div class="stat" style="flex-basis:100%">${data.kit ? '套数完成率' : '完成率'}：<b>${pct}%</b>
        <div class="ratio-bar${s.completionRate < 1 ? ' low' : ''}"><span style="width:${(s.completionRate * 100).toFixed(2)}%"></span></div>
      </div>
    </div>
  `;
  $('batchBar').hidden = false;

  renderOrderSummary(data);
  renderKitProgress(data);
  if (data.sheets.length) showStackPanel(data); else clearStackUi();

  renderSheetTabs(data.sheets, (sh, i) => {
    const kitTag = data.kit ? ` · ${sh.sets} 套` : '';
    return data.isolated && sh.orderNo
      ? `第 ${i + 1} 张 · ${sh.orderNo}${kitTag}（${sh.stats.piecesPlaced} 件）`
      : `第 ${i + 1} 张${kitTag}（${sh.stats.piecesPlaced} 件）`;
  });

  if (data.sheets.length) {
    showBatchSheet(0);
  } else {
    $('stats').innerHTML = '';
    $('svgWrap').innerHTML = data.kit
      ? '<div class="placeholder">剩余材料组不成一整套（成套生产无进展，本轮不扣库存）</div>'
      : '<div class="placeholder">没有可用纸张布局（第一张纸就排不进任何成品）</div>';
    $('cutList').innerHTML = '';
  }

  // 批量剩余需求（结构同单张的 unplaced）；成套模式由套数进度表呈现
  if (data.kit) {
    $('unplaced').innerHTML = '';
  } else {
    renderUnplaced(
      { unplaced: data.remaining, stats: { piecesTotal: s.piecesTotal } },
      '未排完的成品（剩余需求）'
    );
  }
}

function showBatchSheet(i) {
  if (!batchState || !batchState.sheets[i]) return;
  setActiveTab(i);
  const sheet = batchState.sheets[i];
  renderStats(sheet);
  renderSvg(sheet);
  renderCutList(sheet);
}

function clearBatchUi() {
  batchState = null;
  $('batchBar').hidden = true;
  $('batchBar').innerHTML = '';
  clearOrderSummary();
  clearKitProgress();
  clearStackUi();
}

/* ---------------- 多纸型成本排产 ---------------- */

let costState = null;

function money(n) {
  return `¥${(Math.round(n * 10000) / 10000).toLocaleString('zh-CN', { maximumFractionDigits: 4 })}`;
}

const COST_STOP_REASONS = {
  completed: () => ['ok', '✔ 全部成品已排完。'],
  'stock-exhausted': (s) => ['warn', `⚠ 所有纸型库存均已耗尽，仍有 ${s.piecesTotal - s.piecesPlaced} 件未排。`],
  'no-progress': (s) => ['warn', `⚠ 仍有库存的纸型都排不进任何剩余成品，已立即停止（未生成空白纸、不扣库存），剩余 ${s.piecesTotal - s.piecesPlaced} 件。`],
};

function renderCost(data) {
  costState = data;
  const s = data.summary;
  const pct = (s.completionRate * 100).toFixed(1);
  const [cls, text] = (COST_STOP_REASONS[data.stopReason] || (() => ['warn', data.stopReason]))(s);

  const blockedNote = data.isolated && data.blockedOrders && data.blockedOrders.length
    ? ` 受阻订单：${data.blockedOrders.map((b) => b.orderNo || '未填写订单号组').join('、')}（未生成空白纸、不扣任何库存）。`
    : '';

  const usedKinds = data.usage.filter((u) => u.used > 0);
  const mixedTags = usedKinds.map((u) => `
    <span class="mixed-tag">
      <span class="dot" style="background:${colorFor(u.id)}"></span>
      ${u.name} <b>×${u.used}</b> 张
    </span>`).join('');

  const kitNote = data.kit
    ? ` <span class="kit-sheet-badge">成套 ${data.kit.setsCompleted}/${data.kit.plannedSets} 套</span>`
    : '';

  $('costBar').innerHTML = `
    <div class="stop-reason ${cls}">${text}${kitNote}${blockedNote}
      终止原因：<code>${data.stopReason}</code></div>
    <div class="stats">
      <div class="stat">用纸数：<b>${s.sheetsUsed}</b> 张（${s.paperKindsUsed} 种纸）</div>
      <div class="stat">已排/总数：<b>${s.piecesPlaced}/${s.piecesTotal}</b> 件</div>
      <div class="stat">总刀数：<b>${s.cutsTotal}</b></div>
      <div class="stat" style="flex-basis:100%">${data.kit ? '套数完成率' : '完成率'}：<b>${pct}%</b>
        <div class="ratio-bar${s.completionRate < 1 ? ' low' : ''}"><span style="width:${(s.completionRate * 100).toFixed(2)}%"></span></div>
      </div>
    </div>
  `;
  $('costBar').hidden = false;

  $('costMetrics').innerHTML = `
    <div class="stat">总成本：<b>${money(s.totalCost)}</b></div>
    <div class="stat">已排成品面积：<b>${fmt(s.totalPlacedAreaM2)}</b> m²</div>
    <div class="stat">综合单位成本：<b>${s.effectiveCostPerM2 == null ? '—' : money(s.effectiveCostPerM2)}/m²</b></div>
    <div class="mixed-tags"><span>混合用纸：</span>${mixedTags || '<span class="placeholder" style="padding:0">未用纸</span>'}</div>
  `;
  $('costMetrics').hidden = false;

  $('costUsage').innerHTML = `
    <h3 style="font-size:14px;margin:0 0 8px">各纸型用量与成本</h3>
    <table>
      <thead><tr>
        <th>纸型</th><th>规格 宽×高 (mm)</th><th>纹向</th><th class="num">单价（元/张）</th>
        <th class="num">库存</th><th class="num">已用</th><th class="num">剩余库存</th>
        <th class="num">已排面积 (mm²)</th><th class="num">小计成本</th>
      </tr></thead>
      <tbody>
        ${data.usage.map((u) => `
          <tr class="${u.used > 0 ? '' : 'unused'}">
            <td><span class="paper-cell"><span class="dot" style="background:${colorFor(u.id)}"></span>${u.name}（${u.id}）</span></td>
            <td>${fmt(u.width)}×${fmt(u.height)}</td>
            <td>${paperGrainLabel(u.grain)}</td>
            <td class="num">${money(u.price)}</td>
            <td class="num">${u.stock}</td>
            <td class="num">${u.used}</td>
            <td class="num">${u.remainingStock}</td>
            <td class="num">${fmt(u.placedArea)}</td>
            <td class="num">${money(u.cost)}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
  $('costUsage').hidden = false;

  renderOrderSummary(data);
  renderKitProgress(data);
  if (data.sheets.length) showStackPanel(data); else clearStackUi();

  renderSheetTabs(data.sheets, (sh) => {
    const kitTag = data.kit ? ` · ${sh.sets} 套` : '';
    return data.isolated && sh.orderNo
      ? `第 ${sh.round} 张 · ${sh.orderNo} · ${sh.paperName}${kitTag}（${sh.piecesPlaced} 件）`
      : `第 ${sh.round} 张 · ${sh.paperName}${kitTag}（${sh.piecesPlaced} 件）`;
  });

  if (data.sheets.length) {
    showCostSheet(0);
  } else {
    $('sheetMeta').hidden = true;
    $('stats').innerHTML = '';
    $('svgWrap').innerHTML = data.kit
      ? '<div class="placeholder">所有有库存纸型本轮都组不成一整套（成套生产无进展，不扣库存）</div>'
      : '<div class="placeholder">没有可用纸张布局（首轮所有有库存纸型都排不进任何成品）</div>';
    $('cutList').innerHTML = '';
    $('rankList').hidden = true;
    $('rankList').innerHTML = '';
  }

  if (data.kit) {
    $('unplaced').innerHTML = '';
  } else {
    renderUnplaced(
      { unplaced: data.remaining, stats: { piecesTotal: s.piecesTotal } },
      '未排完的成品（剩余需求）'
    );
  }
}

function showCostSheet(i) {
  if (!costState || !costState.sheets[i]) return;
  setActiveTab(i);
  const sh = costState.sheets[i];
  const orderMeta = sh.orderNo
    ? `<span>订单：<b style="color:var(--brand)">${sh.orderNo}</b>（本张仅此订单）</span>`
    : '';
  const kitMeta = costState.kit
    ? `<span style="color:#1a6b3c"><b>本张完整套数：${sh.sets} 套</b></span>`
    : '';
  $('sheetMeta').hidden = false;
  $('sheetMeta').innerHTML = `
    <span>第 <b>${sh.round}</b> 轮用纸</span>
    ${orderMeta}
    ${kitMeta}
    <span>纸型：<span class="paper-cell"><span class="dot" style="background:${colorFor(sh.paperId)}"></span><b>${sh.paperName}</b>（${sh.paperId}）</span></span>
    <span>纸面：<b>${fmt(sh.paperWidth)}×${fmt(sh.paperHeight)}</b> mm</span>
    <span>纹向：<b>${paperGrainLabel(sh.paperGrain)}</b></span>
    <span>单价：<b>${money(sh.price)}</b>/张</span>
    <span>已排：<b>${sh.piecesPlaced}</b> 件 / ${fmt(sh.placedArea)} mm²</span>
    <span>入选指标：<b>${money(sh.costPerM2)}/m²</b>（${costState.kit ? '同套数下单位已排成品面积成本' : '单位已排成品面积成本'}）</span>
  `;
  renderStats(sh.layout);
  renderSvg(sh.layout);
  renderCutList(sh.layout);
  renderRank(sh);
}

function renderRank(sh) {
  const isKit = !!costState.kit;
  // 成套模式：先按套数降序、再按单位成本升序；普通模式按单位成本升序
  const ranked = [...sh.selection.ranked].sort((a, b) =>
    isKit
      ? (b.sets !== a.sets ? b.sets - a.sets : a.costPerM2 - b.costPerM2)
      : a.costPerM2 - b.costPerM2
  );
  const showOrder = ranked.some((c) => c.orderNo);
  const orderHead = showOrder ? '<th>订单号</th>' : '';
  const setsHead = isKit ? '<th class="num">完整套数</th>' : '';
  $('rankList').hidden = false;
  $('rankList').innerHTML = `
    <h3>本轮候选${showOrder ? '「订单 × 纸型」' : '纸型'}选择指标（${isKit ? '先按完整套数、再按单位面积成本' : '按单位面积成本'}排序）</h3>
    <table class="rank-table">
      <thead><tr>
        <th>排名</th>${orderHead}<th>纸型</th>${setsHead}<th class="num">已排件数</th>
        <th class="num">已排面积 (mm²)</th><th class="num">单位成本（元/m²）</th><th>结果</th>
      </tr></thead>
      <tbody>
        ${ranked.map((c, i) => `
          <tr class="${c.selected ? 'winner' : ''}">
            <td>${i + 1}</td>
            ${showOrder ? `<td>${c.orderNo
              ? `<b style="color:var(--brand)">${c.orderNo}</b>`
              : '<span class="ord-null">未填写</span>'}</td>` : ''}
            <td><span class="paper-cell"><span class="dot" style="background:${colorFor(c.paperId)}"></span>${c.paperName}（${c.paperId}）</span></td>
            ${isKit ? `<td class="num"><b>${c.sets}</b></td>` : ''}
            <td class="num">${c.piecesPlaced}</td>
            <td class="num">${fmt(c.placedArea)}</td>
            <td class="num">${money(c.costPerM2)}</td>
            <td>${c.selected ? '✔ 选用' : ''}</td>
          </tr>`).join('')}
      </tbody>
    </table>
  `;
}

function clearCostUi() {
  costState = null;
  $('costBar').hidden = true;
  $('costBar').innerHTML = '';
  $('costMetrics').hidden = true;
  $('costMetrics').innerHTML = '';
  $('costUsage').hidden = true;
  $('costUsage').innerHTML = '';
  $('sheetMeta').hidden = true;
  $('sheetMeta').innerHTML = '';
  $('rankList').hidden = true;
  $('rankList').innerHTML = '';
  clearOrderSummary();
  clearKitProgress();
  clearStackUi();
}

/* ---------------- 叠纸裁切排程（复用批量/成本结果） ---------------- */

let stackState = null;      // 最近一次叠纸排程结果
let stackSourceData = null; // 排程所复用的批量/成本结果

/** 把批量/成本结果压缩为排程接口所需纸张（只带 paper 与切割树） */
function buildStackSheets(data) {
  const isCost = !!data && Array.isArray(data.sheets) && data.sheets.some((s) => s && s.layout);
  return {
    source: isCost ? 'cost' : 'batch',
    sheets: data.sheets.map((sh) => {
      const layout = isCost ? sh.layout : sh;
      const compact = {
        paper: layout.paper,
        cuts: layout.cuts.map((c) => ({
          n: c.n, depth: c.depth, orient: c.orient, region: c.region, band: c.band,
        })),
      };
      if (isCost) {
        compact.round = sh.round;
        compact.paperId = sh.paperId;
        compact.paperName = sh.paperName;
      }
      if (sh.orderNo !== undefined) compact.orderNo = sh.orderNo;
      return compact;
    }),
  };
}

function showStackPanel(data) {
  stackSourceData = data;
  stackState = null;
  $('stackResult').hidden = true;
  $('stackResult').innerHTML = '';
  $('stackError').hidden = true;
  $('stackError').textContent = '';
  $('stackPanel').hidden = false;
  clearWorkOrderUi();
}

function clearStackUi() {
  stackState = null;
  stackSourceData = null;
  $('stackPanel').hidden = true;
  $('stackResult').hidden = true;
  $('stackResult').innerHTML = '';
  $('stackError').hidden = true;
  $('stackError').textContent = '';
  clearWorkOrderUi();
}

const STACK_REASON_LABEL = {
  solo: '单张独刀',
  'stack-limit': '受叠纸上限制约',
  'waiting-parent': '等待父刀',
  'no-cuts': '无需切割',
};

function renderStack(data) {
  stackState = data;
  const s = data.summary;
  const sheetByIdx = new Map(data.sheets.map((sh) => [sh.index, sh]));

  // 批次表
  const batchRows = data.batches.map((b) => {
    const papers = b.members.map((m) => {
      const sh = sheetByIdx.get(m.sheetIndex);
      return `${sh ? sh.index : m.sheetIndex}#${m.cutNo}`;
    }).join('、');
    return `
      <tr class="${b.sheetCount > 1 ? 'merged' : 'solo'}">
        <td><b>${b.batchNo}</b></td>
        <td>${b.orient === 'v' ? '竖切 ↑↓' : '横切 ←→'}</td>
        <td class="num">${fmt(b.region.w)}×${fmt(b.region.h)}</td>
        <td class="num">${fmt(b.position)}</td>
        <td class="num">${fmt(b.kerf)}</td>
        <td class="num">${fmt(b.cutLength)}</td>
        <td class="num"><b>${b.sheetCount}</b>${b.capped ? ' <span class="cap-tag">封顶</span>' : ''}</td>
        <td class="num">${fmt(b.totalLength)}</td>
        <td>${papers}</td>
      </tr>`;
  }).join('');

  // 每张纸进度
  const sheetRows = data.sheets.map((sh) => {
    const pct = sh.cutsTotal > 0 ? (sh.cutsScheduled / sh.cutsTotal) * 100 : 100;
    const order = sh.orderNo ? ` <span class="stack-order">订单:${sh.orderNo}</span>` : '';
    const paperName = sh.paperName
      ? `<span class="paper-cell"><span class="dot" style="background:${sh.paperId ? colorFor(sh.paperId) : '#adb5bd'}"></span>${sh.paperName}${sh.paperId ? `（${sh.paperId}）` : ''}</span>`
      : '—';
    return `
      <tr class="${sh.hasCuts ? '' : 'nocuts'}">
        <td>${sh.index}</td>
        <td>${paperName}${order}</td>
        <td class="num">${fmt(sh.paperWidth)}×${fmt(sh.paperHeight)}</td>
        <td class="num">${sh.cutsTotal}</td>
        <td class="num">${sh.cutsScheduled}</td>
        <td class="num">${sh.mergedCutCount} / ${sh.soloCutCount}</td>
        <td>
          <div class="stack-bar"><span style="width:${pct.toFixed(1)}%"></span></div>
          <span class="stack-batches">${sh.batchNos.join('、') || '—'}</span>
        </td>
      </tr>`;
  }).join('');

  // 未排原因（诊断）
  const unmergedBlock = data.unmerged.length
    ? `
      <h4>未排原因 / 合批诊断（${data.unmerged.length} 条）</h4>
      <table class="stack-unmerged">
        <thead><tr><th>纸张</th><th>原刀号</th><th>原因</th><th>说明</th><th>所在批次</th></tr></thead>
        <tbody>
          ${data.unmerged.map((u) => `
            <tr class="${u.reason}">
              <td>${u.sheetIndex}</td>
              <td>${u.cutNo == null ? '—' : `#${u.cutNo}`}</td>
              <td><span class="reason-tag r-${u.reason}">${STACK_REASON_LABEL[u.reason] || u.reason}</span></td>
              <td>${u.detail}</td>
              <td>${u.batchNo != null ? u.batchNo : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>`
    : '<p class="badge-ok">✔ 所有刀次均完成合批，没有单刀/推迟项。</p>';

  $('stackResult').innerHTML = `
    <div class="stack-summary stats">
      <div class="stat">纸张：<b>${s.sheetsWithCuts}</b>${s.sheetsTotal !== s.sheetsWithCuts ? ` / ${s.sheetsTotal}` : ''} 张有刀</div>
      <div class="stat">总刀数：<b>${s.cutsTotal}</b></div>
      <div class="stat">刀次（批）：<b>${s.batchesTotal}</b></div>
      <div class="stat">合批 / 独刀批：<b>${s.mergedBatches}</b> / ${s.soloBatches}</div>
      <div class="stat">单批最多叠：<b>${s.maxSheetsPerBatch}</b> 张（上限 ${data.stackLimit}）</div>
      <div class="stat">总切线长度：<b>${fmt(s.totalLength)}</b> mm</div>
    </div>
    <h4>刀次批次表（${data.batches.length} 批）</h4>
    <div class="stack-table-wrap">
      <table class="stack-batches">
        <thead><tr>
          <th>批次</th><th>刀向</th><th>待切区域 宽×高 (mm)</th><th>刀位 (mm)</th>
          <th>刀缝 (mm)</th><th>切线长 (mm)</th><th>叠纸张数</th><th>批切线总长 (mm)</th>
          <th>所含纸张/原刀号（纸#刀）</th>
        </tr></thead>
        <tbody>${batchRows}</tbody>
      </table>
    </div>
    <h4>每张纸裁切进度</h4>
    <div class="stack-table-wrap">
      <table class="stack-sheets">
        <thead><tr>
          <th>纸张序号</th><th>纸型 / 订单</th><th>纸面 宽×高</th>
          <th>总刀数</th><th>已排刀数</th><th>合批刀 / 独刀</th><th>所在批次（顺序）</th>
        </tr></thead>
        <tbody>${sheetRows}</tbody>
      </table>
    </div>
    ${unmergedBlock}
  `;
  $('stackResult').hidden = false;
  showWorkOrderPanel(data);
}

async function generateStack() {
  const errBox = $('stackError');
  errBox.hidden = true;
  errBox.textContent = '';
  if (!stackSourceData || !stackSourceData.sheets || !stackSourceData.sheets.length) {
    errBox.textContent = '当前没有可复用的批量 / 多纸型排产结果，请先生成排产方案。';
    errBox.hidden = false;
    return;
  }
  const stackLimit = Number($('stackLimit').value);
  if (!(Number.isInteger(stackLimit) && stackLimit >= 1 && stackLimit <= 500)) {
    errBox.textContent = '叠纸上限须为 1～500 的整数。';
    errBox.hidden = false;
    return;
  }
  const payload = { ...buildStackSheets(stackSourceData), stackLimit };
  $('stackGenerate').disabled = true;
  try {
    const resp = await fetch('/api/layout/stack', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '排程失败');
    renderStack(data);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
  } finally {
    $('stackGenerate').disabled = false;
  }
}

/* ---------------- 执行工单（排程结果按班次容量拆分） ---------------- */

let workOrderState = null; // 最近一次工单结果
let workOrderPayload = null; // 生成工单所用请求体（导出复用）

const WO_REASON_LABEL = {
  'over-capacity': '超每批容量',
  'missing-parent': '父刀缺失',
  blocked: '上游被阻断',
};

function showWorkOrderPanel(schedule) {
  workOrderState = null;
  workOrderPayload = null;
  $('woResult').hidden = true;
  $('woResult').innerHTML = '';
  $('woError').hidden = true;
  $('woError').textContent = '';
  // 每批最多纸张默认沿用叠纸上限（此时所有批次都不会超容量）
  if (Number.isInteger(schedule && schedule.stackLimit)) {
    $('woMaxSheets').value = schedule.stackLimit;
  }
  $('workOrderPanel').hidden = false;
}

function clearWorkOrderUi() {
  workOrderState = null;
  workOrderPayload = null;
  $('workOrderPanel').hidden = true;
  $('woResult').hidden = true;
  $('woResult').innerHTML = '';
  $('woError').hidden = true;
  $('woError').textContent = '';
}

/** 触发服务器把当前工单结果导出为文件（json/csv） */
async function downloadWorkOrder(format) {
  if (!workOrderPayload) return;
  const resp = await fetch(`/api/layout/stack/work-order?format=${encodeURIComponent(format)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(workOrderPayload),
  });
  if (!resp.ok) {
    let msg = '导出失败';
    try {
      const data = await resp.json();
      msg = data.error || msg;
    } catch (_) { /* 忽略非 JSON 错误体 */ }
    throw new Error(msg);
  }
  const blob = await resp.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = format === 'csv' ? 'work-order.csv' : 'work-order.json';
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}

function renderWorkOrder(data) {
  workOrderState = data;
  const s = data.summary;

  const shiftBlocks = data.shifts.map((shift) => {
    const rows = shift.cuts.map((c) => `
      <tr>
        <td class="num">${c.cutInShift}</td>
        <td class="num">${c.cutNo}</td>
        <td class="num">${c.batchNo}</td>
        <td>${c.orient === 'v' ? '竖切 ↑↓' : c.orient === 'h' ? '横切 ←→' : '—'}</td>
        <td class="num">${c.region ? `${fmt(c.region.w)}×${fmt(c.region.h)}` : '—'}</td>
        <td class="num">${fmt(c.position)}</td>
        <td class="num">${fmt(c.cutLength)}</td>
        <td class="num"><b>${c.sheetCount}</b></td>
        <td class="members">${c.members.map((m) => `${m.sheetIndex}#${m.cutNo}`).join('、')}</td>
      </tr>`).join('');
    return `
      <details class="wo-shift"${shift.shiftNo === 1 ? ' open' : ''}>
        <summary>第 ${shift.shiftNo} 班 · ${shift.cutsTotal} 刀 · 涉及 ${shift.sheetsCut} 张次</summary>
        <div class="wo-table-wrap">
          <table class="wo-table">
            <thead><tr>
              <th class="num">班内刀次</th><th class="num">全局刀次</th><th class="num">来源批次</th>
              <th>刀向</th><th class="num">待切区域 宽×高</th><th class="num">刀位</th>
              <th class="num">切线长</th><th class="num">叠纸</th><th>所含纸张/原刀号</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </div>
      </details>`;
  }).join('');

  const crossBlock = data.crossShiftDeps.length
    ? `
      <h4>跨班次依赖（${data.crossShiftDeps.length} 条，后班开切前需确认前班已完成）</h4>
      <div class="wo-table-wrap">
        <table class="wo-table wo-cross">
          <thead><tr>
            <th class="num">纸张</th><th class="num">子刀</th><th class="num">父刀</th>
            <th class="num">父刀班次 / 刀次</th><th class="num">子刀班次 / 刀次</th>
          </tr></thead>
          <tbody>
            ${data.crossShiftDeps.map((d) => `
              <tr>
                <td class="num">${d.sheetIndex}</td>
                <td class="num">#${d.cutNo}</td>
                <td class="num">#${d.parentCutNo}</td>
                <td class="num">第 ${d.fromShift} 班 · 全局第 ${d.fromCutNo} 刀</td>
                <td class="num">第 ${d.toShift} 班 · 全局第 ${d.toCutNo} 刀</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '<p class="badge-ok">✔ 没有跨班次依赖：所有父刀均在同班次内完成。</p>';

  const unassignedBlock = data.unassigned.length
    ? `
      <h4>未分配刀（${data.unassigned.length} 把）及原因</h4>
      <div class="wo-table-wrap">
        <table class="wo-table wo-unassigned">
          <thead><tr>
            <th class="num">纸张</th><th class="num">原刀号</th><th>原因</th>
            <th class="num">来源批次</th><th>说明</th>
          </tr></thead>
          <tbody>
            ${data.unassigned.map((u) => `
              <tr>
                <td class="num">${u.sheetIndex}</td>
                <td class="num">#${u.cutNo}</td>
                <td><span class="reason-tag r-${u.reason}">${WO_REASON_LABEL[u.reason] || u.reason}</span></td>
                <td class="num">${u.batchNo == null ? '—' : u.batchNo}</td>
                <td>${u.detail}</td>
              </tr>`).join('')}
          </tbody>
        </table>
      </div>`
    : '<p class="badge-ok">✔ 全部刀次均已分配到班次。</p>';

  $('woResult').innerHTML = `
    <div class="stack-summary stats">
      <div class="stat">班次数：<b>${s.shiftsTotal}</b>（每班最多 ${data.maxCutsPerShift} 刀）</div>
      <div class="stat">各班刀数：<b>${s.cutsPerShift.join('、')}</b></div>
      <div class="stat">已分配 / 总刀次：<b>${s.batchesAssigned}</b> / ${s.batchesTotal}</div>
      <div class="stat">未分配刀：<b>${s.unassignedCuts}</b></div>
      <div class="stat">跨班次依赖：<b>${s.crossShiftDeps}</b> 条</div>
      <div class="stat">总切线长度：<b>${fmt(s.totalLength)}</b> mm</div>
    </div>
    <div class="wo-exports">
      <button type="button" id="woExportJson" class="btn btn-ghost">下载 JSON 工单</button>
      <button type="button" id="woExportCsv" class="btn btn-ghost">下载 CSV 工单</button>
    </div>
    ${unassignedBlock}
    ${crossBlock}
    <h4>班次 / 刀次清单</h4>
    ${shiftBlocks}
  `;
  $('woResult').hidden = false;
  $('woExportJson').addEventListener('click', async () => {
    try { await downloadWorkOrder('json'); }
    catch (e) { $('woError').textContent = e.message; $('woError').hidden = false; }
  });
  $('woExportCsv').addEventListener('click', async () => {
    try { await downloadWorkOrder('csv'); }
    catch (e) { $('woError').textContent = e.message; $('woError').hidden = false; }
  });
}

async function generateWorkOrder() {
  const errBox = $('woError');
  errBox.hidden = true;
  errBox.textContent = '';
  if (!stackState) {
    errBox.textContent = '请先生成叠纸裁切排程。';
    errBox.hidden = false;
    return;
  }
  const maxCutsPerShift = Number($('woMaxCuts').value);
  if (!(Number.isInteger(maxCutsPerShift) && maxCutsPerShift >= 1 && maxCutsPerShift <= 10000)) {
    errBox.textContent = '每班最多刀次须为 1～10000 的整数。';
    errBox.hidden = false;
    return;
  }
  const maxSheetsPerBatch = Number($('woMaxSheets').value);
  if (!(Number.isInteger(maxSheetsPerBatch) && maxSheetsPerBatch >= 1 && maxSheetsPerBatch <= 500)) {
    errBox.textContent = '每批最多纸张须为 1～500 的整数。';
    errBox.hidden = false;
    return;
  }
  const payload = { schedule: stackState, maxCutsPerShift, maxSheetsPerBatch };
  $('woGenerate').disabled = true;
  try {
    const resp = await fetch('/api/layout/stack/work-order', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '工单生成失败');
    workOrderPayload = payload;
    renderWorkOrder(data);
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
  } finally {
    $('woGenerate').disabled = false;
  }
}

/* ---------------- 逐张标签（批量/成本共用） ---------------- */

function renderSheetTabs(sheets, label) {
  const tabs = $('sheetTabs');
  if (sheets.length > 1) {
    tabs.innerHTML = sheets.map((sh, i) =>
      `<button type="button" data-i="${i}">${label(sh, i)}</button>`
    ).join('');
    [...tabs.querySelectorAll('button')].forEach((b) =>
      b.addEventListener('click', () => {
        const i = Number(b.dataset.i);
        if (costState) showCostSheet(i);
        else showBatchSheet(i);
      })
    );
    tabs.hidden = false;
  } else {
    tabs.innerHTML = '';
    tabs.hidden = true;
  }
}

function setActiveTab(i) {
  [...$('sheetTabs').querySelectorAll('button')].forEach((b, j) =>
    b.classList.toggle('active', j === i));
}

async function generate() {
  const errBox = $('formError');
  errBox.hidden = true;
  let payload;
  try {
    payload = readForm();
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
    return;
  }

  const mode = currentMode();
  $('generate').disabled = true;
  try {
    const url = mode === 'cost' ? '/api/layout/cost'
      : mode === 'batch' ? '/api/layout/batch' : '/api/layout/compare';
    const resp = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (!resp.ok) throw new Error(data.error || '排样失败');
    if (mode === 'cost') {
      clearBatchUi();
      clearCompareUi();
      renderCost(data);
    } else if (mode === 'batch') {
      clearCostUi();
      clearCompareUi();
      renderBatch(data);
    } else {
      clearBatchUi();
      clearCostUi();
      clearOrderSummary();
      renderCompare(data);
    }
  } catch (e) {
    errBox.textContent = e.message;
    errBox.hidden = false;
  } finally {
    $('generate').disabled = false;
  }
}

$('preset').addEventListener('change', (e) => {
  const v = e.target.value;
  if (!v) return;
  const [w, h] = v.split('x');
  $('paperW').value = w;
  $('paperH').value = h;
});
document.querySelectorAll('input[name="mode"]').forEach((r) =>
  r.addEventListener('change', () => {
    const mode = currentMode();
    const batch = mode === 'batch';
    const cost = mode === 'cost';
    $('batchOpts').hidden = !batch;
    $('costOpts').hidden = !cost;
    // 方案比选目标仅对单张试排有意义
    $('compareOpts').hidden = mode !== 'single';
    // 订单隔离与成套生产仅对批量 / 多纸型排产有意义
    $('isolateOpts').hidden = mode === 'single';
    $('kitOpts').hidden = mode === 'single';
    if (mode === 'single') {
      setKitMode(false);
      clearStackUi(); // 叠纸排程与执行工单仅复用批量 / 多纸型结果
    }
    // 成本模式下纸张宽高、纹向与常用纸度不适用（候选在纸型表格中录入）
    $('paperWLabel').hidden = cost;
    $('paperHLabel').hidden = cost;
    $('paperGrainLabel').hidden = cost;
    $('presetLabel').hidden = cost;
    $('generate').textContent = cost
      ? (kitMode ? '生成成套成本排产方案' : '生成成本排产方案')
      : batch ? (kitMode ? '生成成套排产方案' : '生成排产方案')
      : '生成裁切方案';
  })
);
$('kitMode').addEventListener('change', (e) => {
  setKitMode(e.target.checked);
  const mode = currentMode();
  $('generate').textContent = mode === 'cost'
    ? (kitMode ? '生成成套成本排产方案' : '生成成本排产方案')
    : (kitMode ? '生成成套排产方案' : '生成排产方案');
});
$('addRow').addEventListener('click', () => addProductRow());
$('addPaper').addEventListener('click', () => addPaperRow());
$('stackGenerate').addEventListener('click', generateStack);
$('woGenerate').addEventListener('click', generateWorkOrder);
$('clearBtn').addEventListener('click', () => {
  $('productRows').innerHTML = '';
  addProductRow();
  addProductRow();
  addProductRow();
});
$('generate').addEventListener('click', generate);

// 初始示例：大度全张 889×1194，刀缝 3mm
addProductRow('封面', '', 210, 285, 12);
addProductRow('名片', '', 90, 54, 80);
addProductRow();

// 多纸型成本排产初始候选：大度全张 + A3
addPaperRow('大度全张', 889, 1194, 3.5, 10);
addPaperRow('A3', 297, 420, 0.4, 50);
addPaperRow();

// 初始为普通（非成套）列布局
setKitMode(false);
