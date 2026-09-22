'use strict';

const path = require('node:path');
const express = require('express');
const { layout, layoutBatch, layoutCompare } = require('./src/packer');
const { layoutCostBatch } = require('./src/cost');
const { stackSchedule } = require('./src/stack');
const { workOrder, workOrderCsv } = require('./src/workorder');

const app = express();
const PORT = Number(process.env.PORT) || 3000;

// 叠纸排程会回传多张纸的完整切割树（最多 500 张），放宽请求体上限
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

app.get('/api/health', (_req, res) => {
  res.json({ ok: true });
});

app.post('/api/layout', (req, res) => {
  try {
    const body = req.body || {};
    const result = layout(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 方案比选：同一输入按三种确定性策略分别试排，按比选目标择优
app.post('/api/layout/compare', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCompare(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 批量排产：逐张排样直到完成 / 达到上限 / 某张纸无进展
app.post('/api/layout/batch', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 多纸型成本排产：2～8 种候选纸逐轮按单位面积成本择优
app.post('/api/layout/cost', (req, res) => {
  try {
    const body = req.body || {};
    const result = layoutCostBatch(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 叠纸裁切排程：复用批量/多纸型排产结果，把各张纸的断头台切割树
// 按合批规则（区域宽高、刀向、刀位、刀缝一致）与父刀先后约束转换为刀次
app.post('/api/layout/stack', (req, res) => {
  try {
    const body = req.body || {};
    const result = stackSchedule(body);
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

// 执行工单：在叠纸排程结果上按班次容量（每班最多刀次、每批最多纸张）
// 做稳定拓扑拆分，输出班次/刀次清单、跨班次依赖与未分配刀；?format=csv 直接下载
app.post('/api/layout/stack/work-order', (req, res) => {
  try {
    const body = req.body || {};
    const format = typeof req.query.format === 'string'
      ? req.query.format
      : (typeof body.format === 'string' ? body.format : 'json');
    const result = workOrder(body);
    if (format === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="work-order.csv"');
      res.send(workOrderCsv(result));
      return;
    }
    if (format !== 'json') {
      res.status(400).json({ error: 'format 仅支持 json 或 csv' });
      return;
    }
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message || '输入无效' });
  }
});

app.listen(PORT, () => {
  console.log(`单张纸裁切试排服务已启动: http://localhost:${PORT}`);
});

module.exports = app;
