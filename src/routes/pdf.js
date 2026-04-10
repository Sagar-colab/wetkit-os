const express = require('express');
const PDFDocument = require('pdfkit');
const db = require('../db');

const router = express.Router();

const SYSTEM_COLORS = {
  CW:    [37, 99, 235],   HW:    [220, 38, 38],
  HWR:   [249, 115, 22],  FWS:   [239, 68, 68],
  SOIL:  [68, 64, 60],    WASTE: [120, 113, 108],
  VENT:  [13, 148, 136],  SWD:   [22, 163, 74]
};

const SYSTEM_LABELS = {
  CW:'Cold water (DWS)', HW:'Hot water (HWS)', HWR:'Hot water return',
  FWS:'Fire water supply', SOIL:'Soil stack', WASTE:'Waste water',
  VENT:'Vent pipe', SWD:'Stormwater drain'
};

// Simple QR code as text placeholder (real QR needs qrcode library)
function drawQRPlaceholder(doc, x, y, size, text) {
  doc.rect(x, y, size, size).stroke('#cccccc');
  doc.fontSize(5).fillColor('#666666')
    .text('QR', x + size/2 - 5, y + size/2 - 3, { width: 10 });
}

// Draw isometric pipe line
function drawIsometricPipe(doc, x, y, lengthMm, odMm, systemType) {
  const color = SYSTEM_COLORS[systemType] || [100, 100, 100];
  const scale = 0.04; // mm to points
  const pipeLen = Math.min(lengthMm * scale, 150);
  const pipeW   = Math.max((odMm || 48) * scale * 0.8, 4);

  // Draw pipe body
  doc.save();
  doc.roundedRect(x, y - pipeW/2, pipeLen, pipeW, pipeW/4)
    .fillColor(`rgb(${color[0]},${color[1]},${color[2]})`)
    .fill();

  // Draw end caps
  doc.circle(x, y, pipeW/2 + 1)
    .fillColor(`rgb(${Math.max(0,color[0]-30)},${Math.max(0,color[1]-30)},${Math.max(0,color[2]-30)})`)
    .fill();
  doc.circle(x + pipeLen, y, pipeW/2 + 1)
    .fillColor(`rgb(${Math.max(0,color[0]-30)},${Math.max(0,color[1]-30)},${Math.max(0,color[2]-30)})`)
    .fill();

  // Dimension line
  doc.moveTo(x, y + pipeW/2 + 6).lineTo(x + pipeLen, y + pipeW/2 + 6)
    .stroke('#999999');
  doc.moveTo(x, y + pipeW/2 + 3).lineTo(x, y + pipeW/2 + 9).stroke('#999999');
  doc.moveTo(x + pipeLen, y + pipeW/2 + 3).lineTo(x + pipeLen, y + pipeW/2 + 9).stroke('#999999');
  doc.fontSize(6).fillColor('#666666')
    .text(Math.round(lengthMm) + 'mm', x + pipeLen/2 - 15, y + pipeW/2 + 9, { width: 30, align: 'center' });

  doc.restore();
  return pipeLen;
}

// GET /api/wetkit/projects/:projectId/spools/:spoolId/pdf
router.get('/:projectId/spools/:spoolId/pdf', async (req, res) => {
  const { projectId, spoolId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';

  try {
    // Get spool
    const spoolRes = await db.query(`
      SELECT * FROM wetkit_spools
      WHERE id=$1 AND project_id=$2 AND tenant_id=$3
    `, [spoolId, projectId, tenantId]);

    if (!spoolRes.rows.length)
      return res.status(404).json({ error: 'Spool not found' });

    const spool = spoolRes.rows[0];

    // Get BOM items
    const itemsRes = await db.query(`
      SELECT item_type, spec, qty, unit, unit_rate_inr, dsr_ref, step_sequence
      FROM wetkit_kit_items
      WHERE spool_id=$1
      ORDER BY step_sequence, item_type
    `, [spoolId]);

    // Get segments
    const segRes = await db.query(`
      SELECT global_id, system_type, diameter_mm, od_mm, length_mm
      FROM wetkit_pipe_segments
      WHERE spool_id=$1
      LIMIT 10
    `, [spoolId]);

    const items    = itemsRes.rows;
    const segments = segRes.rows;
    const color    = SYSTEM_COLORS[spool.system_type] || [100, 100, 100];
    const sysLabel = SYSTEM_LABELS[spool.system_type] || spool.system_type;
    const totalAmt = items.reduce((s,i) => s + (parseFloat(i.qty) * parseFloat(i.unit_rate_inr)), 0);

    // Create PDF
    const doc = new PDFDocument({ size: 'A4', margin: 0 });
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', `attachment; filename="spool-${spool.spool_code}.pdf"`);
    doc.pipe(res);

    const W = 595, H = 842;
    const M = 24; // margin

    // ── Header band ──────────────────────────────────────────
    doc.rect(0, 0, W, 52)
      .fillColor(`rgb(${color[0]},${color[1]},${color[2]})`).fill();

    doc.fontSize(18).fillColor('white').font('Helvetica-Bold')
      .text(spool.spool_code, M, 14);

    doc.fontSize(10).fillColor('white').font('Helvetica')
      .text(sysLabel, M, 34);

    // WetKit OS logo text
    doc.fontSize(8).fillColor('rgba(255,255,255,0.7)')
      .text('WetKit OS · OneEvolve.AI', W - 160, 20);
    doc.fontSize(7).fillColor('rgba(255,255,255,0.6)')
      .text('Single line. Full spool. Pre-fab ready.', W - 160, 32);

    // ── Metadata row ─────────────────────────────────────────
    doc.rect(0, 52, W, 36).fillColor('#f8fafc').fill();
    doc.rect(0, 88, W, 1).fillColor('#e2e8f0').fill();

    const meta = [
      ['Floor', spool.floor_level || 'GF'],
      ['Length', (parseFloat(spool.total_length_mm||0)/1000).toFixed(2) + 'm'],
      ['DFU load', parseFloat(spool.total_dfu||0).toFixed(1) + ' / ' + spool.dfu_limit],
      ['DFU status', (spool.dfu_status || 'ok').toUpperCase()],
      ['Fabrication', (spool.fabrication_status || 'pending').toUpperCase()],
      ['Segments', segments.length],
    ];
    const colW = (W - 2*M) / meta.length;
    meta.forEach(([label, value], i) => {
      const cx = M + i * colW;
      doc.fontSize(7).fillColor('#6b7280').font('Helvetica')
        .text(label, cx, 57, { width: colW });
      doc.fontSize(10).fillColor('#1e293b').font('Helvetica-Bold')
        .text(String(value), cx, 67, { width: colW });
    });

    // ── Pipe diagram ─────────────────────────────────────────
    doc.rect(M, 100, W - 2*M, 100).fillColor('#f1f5f9').strokeColor('#e2e8f0').fillAndStroke();
    doc.fontSize(7).fillColor('#94a3b8').font('Helvetica')
      .text('PIPE DIAGRAM', M + 8, 106);

    // Draw each segment as a pipe
    let px = M + 20, py = 155;
    segments.slice(0, 5).forEach((seg, i) => {
      const len = drawIsometricPipe(doc, px, py, parseFloat(seg.length_mm||500), parseFloat(seg.od_mm||48), seg.system_type);
      px += len + 20;
      if (px > W - 80) { px = M + 20; py += 30; }
    });

    // DN label
    if (segments.length) {
      const dn = parseFloat(segments[0].diameter_mm || 20);
      doc.fontSize(7).fillColor('#64748b')
        .text('DN' + Math.round(dn) + ' · OD' + (segments[0].od_mm || '—') + 'mm · ' + sysLabel,
          M + 8, 192);
    }

    // ── BOM Table ────────────────────────────────────────────
    const tableY = 215;
    doc.fontSize(8).fillColor('#1e293b').font('Helvetica-Bold')
      .text('BILL OF MATERIALS', M, tableY);
    doc.rect(M, tableY + 12, W - 2*M, 1).fillColor('#e2e8f0').fill();

    // Table header
    const cols = [180, 60, 50, 70, 80, 80];
    const headers = ['Specification', 'Type', 'Qty', 'Unit', 'Rate (₹)', 'Amount (₹)'];
    let ty = tableY + 18;

    doc.rect(M, ty - 2, W - 2*M, 14).fillColor('#f1f5f9').fill();
    let tx = M + 4;
    headers.forEach((h, i) => {
      doc.fontSize(7).fillColor('#64748b').font('Helvetica-Bold')
        .text(h, tx, ty, { width: cols[i] - 4 });
      tx += cols[i];
    });
    ty += 14;

    // Table rows
    items.forEach((item, idx) => {
      if (ty > H - 120) return; // prevent overflow
      if (idx % 2 === 0)
        doc.rect(M, ty - 2, W - 2*M, 13).fillColor('#fafafa').fill();

      const amt = parseFloat(item.qty) * parseFloat(item.unit_rate_inr);
      const row = [
        item.spec,
        item.item_type.replace('_',' '),
        parseFloat(item.qty).toFixed(2),
        item.unit,
        'Rs.' + parseFloat(item.unit_rate_inr).toLocaleString('en-IN'),
        'Rs.' + Math.round(amt).toLocaleString('en-IN')
      ];
      tx = M + 4;
      row.forEach((val, i) => {
        doc.fontSize(7).fillColor('#334155').font('Helvetica')
          .text(String(val), tx, ty, { width: cols[i] - 4, ellipsis: true });
        tx += cols[i];
      });
      ty += 13;
    });

    // Total row
    doc.rect(M, ty, W - 2*M, 16)
      .fillColor(`rgb(${color[0]},${color[1]},${color[2]})`)
      .fill();
    doc.fontSize(8).fillColor('white').font('Helvetica-Bold')
      .text('TOTAL', M + 4, ty + 4)
      .text('Rs.' + Math.round(totalAmt).toLocaleString('en-IN'),
        W - M - 84, ty + 4, { width: 80, align: 'right' });
    ty += 16;

    // ── Standards bar ────────────────────────────────────────
    ty += 12;
    doc.rect(M, ty, W - 2*M, 1).fillColor('#e2e8f0').fill();
    ty += 8;
    doc.fontSize(6.5).fillColor('#94a3b8').font('Helvetica')
      .text('Standards: IS 2065 · IS 1239 · NBC Part 9 · CPHEEO · CPWD DSR 2023 · IS 4985 · IS 15778',
        M, ty);

    // ── QR + footer ──────────────────────────────────────────
    const footerY = H - 70;
    doc.rect(0, footerY - 8, W, 1).fillColor('#e2e8f0').fill();

    drawQRPlaceholder(doc, M, footerY, 50, spool.spool_code);

    doc.fontSize(7).fillColor('#64748b').font('Helvetica')
      .text('Spool: ' + spool.spool_code, M + 58, footerY + 4)
      .text('System: ' + sysLabel, M + 58, footerY + 14)
      .text('Generated: ' + new Date().toLocaleDateString('en-IN'), M + 58, footerY + 24);

    doc.fontSize(7).fillColor('#94a3b8')
      .text('WetKit OS · dttradesman.ai · OneEvolve.AI',
        W - 200, footerY + 4, { width: 176, align: 'right' })
      .text('"Train in India. Deploy worldwide."',
        W - 200, footerY + 14, { width: 176, align: 'right' });

    // Fabrication status stamp
    if (spool.fabrication_status === 'confirmed' || spool.fabrication_status === 'fabricated') {
      doc.save();
      doc.rotate(-30, { origin: [W/2, H/2] });
      doc.fontSize(48).fillColor('rgba(22,163,74,0.08)').font('Helvetica-Bold')
        .text(spool.fabrication_status.toUpperCase(), 100, H/2 - 30, { width: 400, align: 'center' });
      doc.restore();
    }

    doc.end();

  } catch (err) {
    console.error('[wetkit] pdf error:', err.message);
    if (!res.headersSent) res.status(500).json({ error: err.message });
  }
});

// GET /api/wetkit/projects/:projectId/pdf/all — all spools as one PDF
router.get('/:projectId/pdf/all', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';

  try {
    const { rows: spools } = await db.query(`
      SELECT id, spool_code FROM wetkit_spools
      WHERE project_id=$1 AND tenant_id=$2
      ORDER BY system_type, spool_code
      LIMIT 20
    `, [projectId, tenantId]);

    if (!spools.length)
      return res.status(404).json({ error: 'No spools found' });

    res.setHeader('Content-Type', 'application/json');
    res.json({
      message: 'Use individual spool PDF endpoint',
      spools: spools.map(s => ({
        code: s.spool_code,
        url: `/api/wetkit/projects/${projectId}/spools/${s.id}/pdf`
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
