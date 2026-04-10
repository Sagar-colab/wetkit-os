const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// IS 1239 pipe specs + CPWD DSR 2023 rates (INR per metre)
const PIPE_LIBRARY = {
  // UPVC pipes (IS 4985) — drainage
  WASTE: {
    40:  { spec: '40mm UPVC Class C IS 4985', unit: 'm', rate: 185, material: 'UPVC' },
    50:  { spec: '50mm UPVC Class C IS 4985', unit: 'm', rate: 220, material: 'UPVC' },
    63:  { spec: '63mm UPVC Class C IS 4985', unit: 'm', rate: 295, material: 'UPVC' },
    75:  { spec: '75mm UPVC Class C IS 4985', unit: 'm', rate: 365, material: 'UPVC' },
    110: { spec: '110mm UPVC SWR IS 13592', unit: 'm', rate: 480, material: 'UPVC' },
  },
  SOIL: {
    75:  { spec: '75mm UPVC SWR IS 13592',  unit: 'm', rate: 365, material: 'UPVC' },
    110: { spec: '110mm UPVC SWR IS 13592', unit: 'm', rate: 480, material: 'UPVC' },
  },
  VENT: {
    40:  { spec: '40mm UPVC Class C IS 4985', unit: 'm', rate: 185, material: 'UPVC' },
    50:  { spec: '50mm UPVC Class C IS 4985', unit: 'm', rate: 220, material: 'UPVC' },
    75:  { spec: '75mm UPVC SWR IS 13592',    unit: 'm', rate: 365, material: 'UPVC' },
    110: { spec: '110mm UPVC SWR IS 13592',   unit: 'm', rate: 480, material: 'UPVC' },
  },
  CW: {
    20:  { spec: '20mm CPVC SDR-11 IS 15778', unit: 'm', rate: 145, material: 'CPVC' },
    25:  { spec: '25mm CPVC SDR-11 IS 15778', unit: 'm', rate: 185, material: 'CPVC' },
    32:  { spec: '32mm CPVC SDR-11 IS 15778', unit: 'm', rate: 245, material: 'CPVC' },
    40:  { spec: '40mm CPVC SDR-11 IS 15778', unit: 'm', rate: 320, material: 'CPVC' },
    50:  { spec: '50mm CPVC SDR-11 IS 15778', unit: 'm', rate: 425, material: 'CPVC' },
  },
  HW: {
    20:  { spec: '20mm CPVC SDR-11 IS 15778', unit: 'm', rate: 145, material: 'CPVC' },
    25:  { spec: '25mm CPVC SDR-11 IS 15778', unit: 'm', rate: 185, material: 'CPVC' },
    32:  { spec: '32mm CPVC SDR-11 IS 15778', unit: 'm', rate: 245, material: 'CPVC' },
    40:  { spec: '40mm CPVC SDR-11 IS 15778', unit: 'm', rate: 320, material: 'CPVC' },
    50:  { spec: '50mm CPVC SDR-11 IS 15778', unit: 'm', rate: 425, material: 'CPVC' },
  },
  HWR: {
    20:  { spec: '20mm CPVC SDR-11 IS 15778', unit: 'm', rate: 145, material: 'CPVC' },
    25:  { spec: '25mm CPVC SDR-11 IS 15778', unit: 'm', rate: 185, material: 'CPVC' },
    32:  { spec: '32mm CPVC SDR-11 IS 15778', unit: 'm', rate: 245, material: 'CPVC' },
    40:  { spec: '40mm CPVC SDR-11 IS 15778', unit: 'm', rate: 320, material: 'CPVC' },
    50:  { spec: '50mm CPVC SDR-11 IS 15778', unit: 'm', rate: 425, material: 'CPVC' },
  },
  FWS: {
    40:  { spec: '40mm GI Medium IS 1239',  unit: 'm', rate: 385, material: 'GI' },
    50:  { spec: '50mm GI Medium IS 1239',  unit: 'm', rate: 495, material: 'GI' },
    65:  { spec: '65mm GI Medium IS 1239',  unit: 'm', rate: 625, material: 'GI' },
    80:  { spec: '80mm GI Medium IS 1239',  unit: 'm', rate: 780, material: 'GI' },
    100: { spec: '100mm GI Medium IS 1239', unit: 'm', rate: 980, material: 'GI' },
  },
  SWD: {
    110: { spec: '110mm UPVC SWR IS 13592', unit: 'm', rate: 480, material: 'UPVC' },
    160: { spec: '160mm UPVC SWR IS 13592', unit: 'm', rate: 720, material: 'UPVC' },
  },
};

// Fitting rates (INR per piece) — CPWD DSR 2023
const FITTING_RATES = {
  UPVC: {
    elbow_90: { 40: 28, 50: 38, 63: 52, 75: 68, 110: 95 },
    tee:      { 40: 35, 50: 48, 63: 65, 75: 85, 110: 120 },
    reducer:  { 40: 22, 50: 30, 63: 42, 75: 55, 110: 78 },
  },
  CPVC: {
    elbow_90: { 20: 18, 25: 24, 32: 32, 40: 45, 50: 62 },
    tee:      { 20: 22, 25: 30, 32: 40, 40: 56, 50: 78 },
    reducer:  { 20: 15, 25: 20, 32: 28, 40: 38, 50: 52 },
  },
  GI: {
    elbow_90: { 40: 85, 50: 115, 65: 155, 80: 195, 100: 265 },
    tee:      { 40: 105, 50: 142, 65: 192, 80: 242, 100: 328 },
    reducer:  { 40: 65, 50: 88, 65: 118, 80: 148, 100: 202 },
  },
};

function nearestDN(dn, library) {
  const bores = Object.keys(library).map(Number).sort((a,b) => a-b);
  if (!bores.length) return null;
  return bores.reduce((a,b) => Math.abs(b-dn) < Math.abs(a-dn) ? b : a, bores[0]);
}

function getPipeSpec(systemType, diameterMm) {
  const lib = PIPE_LIBRARY[systemType];
  if (!lib) return null;
  const dn = nearestDN(Math.round(parseFloat(diameterMm) || 20), lib);
  return dn ? { ...lib[dn], dn } : null;
}

function getFittingRate(material, fittingType, dn) {
  const mat = FITTING_RATES[material];
  if (!mat || !mat[fittingType]) return 50; // fallback
  const bores = Object.keys(mat[fittingType]).map(Number).sort((a,b) => a-b);
  const nearest = bores.reduce((a,b) => Math.abs(b-dn) < Math.abs(a-dn) ? b : a, bores[0]);
  return mat[fittingType][nearest] || 50;
}

// POST /api/wetkit/projects/:projectId/bom/generate
router.post('/:projectId/bom/generate', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';

  try {
    // Get all spools
    const { rows: spools } = await db.query(`
      SELECT s.id, s.spool_code, s.system_type, s.total_length_mm,
             s.segment_ids, s.dfu_status
      FROM wetkit_spools s
      WHERE s.project_id=$1 AND s.tenant_id=$2
      ORDER BY s.system_type, s.spool_code
    `, [projectId, tenantId]);

    if (!spools.length)
      return res.status(404).json({ error: 'No spools found. Run spool generation first.' });

    // Clear existing kit items
    await db.query(
      `DELETE FROM wetkit_kit_items WHERE project_id=$1`, [projectId]);

    let grandTotal = 0;
    const systemTotals = {};
    const bomLines = [];

    for (const spool of spools) {
      // Get segments for this spool
      const { rows: segments } = await db.query(`
        SELECT system_type, diameter_mm, od_mm, length_mm
        FROM wetkit_pipe_segments
        WHERE spool_id=$1
      `, [spool.id]);

      // If no segments linked (split segments), use spool total
      const useLength = segments.length > 0
        ? segments.reduce((s,r) => s + parseFloat(r.length_mm), 0)
        : parseFloat(spool.total_length_mm);

      const sampleSeg = segments[0];
      const dn = sampleSeg ? Math.round(parseFloat(sampleSeg.diameter_mm) || 20) : 20;
      const spec = getPipeSpec(spool.system_type, dn);

      if (!spec) continue;

      const lengthM = useLength / 1000;
      const pipeAmount = lengthM * spec.rate;

      // Estimate fittings — 1 elbow per 2m, 1 tee per 4m
      const elbowQty = Math.ceil(lengthM / 2);
      const teeQty   = Math.ceil(lengthM / 4);
      const elbowRate = getFittingRate(spec.material, 'elbow_90', dn);
      const teeRate   = getFittingRate(spec.material, 'tee', dn);
      const fittingsAmount = (elbowQty * elbowRate) + (teeQty * teeRate);

      const spoolTotal = pipeAmount + fittingsAmount;
      grandTotal += spoolTotal;

      if (!systemTotals[spool.system_type])
        systemTotals[spool.system_type] = 0;
      systemTotals[spool.system_type] += spoolTotal;

      // Insert pipe item
      const pipeItemId = uuidv4();
      await db.query(`
        INSERT INTO wetkit_kit_items (
          id, spool_id, project_id, tenant_id,
          item_type, spec, qty, unit,
          unit_rate_inr, library_source, dsr_ref, step_sequence
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        pipeItemId, spool.id, projectId, tenantId,
        'pipe', spec.spec,
        Math.round(lengthM * 100) / 100, 'm',
        spec.rate, 'central', 'CPWD DSR 2023', 1
      ]);

      // Insert elbow item
      await db.query(`
        INSERT INTO wetkit_kit_items (
          id, spool_id, project_id, tenant_id,
          item_type, spec, qty, unit,
          unit_rate_inr, library_source, dsr_ref, step_sequence
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        uuidv4(), spool.id, projectId, tenantId,
        'elbow_90',
        `${dn}mm ${spec.material} 90° elbow`,
        elbowQty, 'no.',
        elbowRate, 'central', 'CPWD DSR 2023', 2
      ]);

      // Insert tee item
      await db.query(`
        INSERT INTO wetkit_kit_items (
          id, spool_id, project_id, tenant_id,
          item_type, spec, qty, unit,
          unit_rate_inr, library_source, dsr_ref, step_sequence
        ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)
      `, [
        uuidv4(), spool.id, projectId, tenantId,
        'tee',
        `${dn}mm ${spec.material} equal tee`,
        teeQty, 'no.',
        teeRate, 'central', 'CPWD DSR 2023', 3
      ]);

      bomLines.push({
        spoolCode: spool.spool_code,
        system: spool.system_type,
        pipe: spec.spec,
        lengthM: Math.round(lengthM * 100) / 100,
        elbows: elbowQty,
        tees: teeQty,
        material: spec.material,
        spoolTotal: Math.round(spoolTotal)
      });
    }

    res.json({
      success: true,
      grandTotalINR: Math.round(grandTotal),
      grandTotalLac: (grandTotal / 100000).toFixed(2),
      systemTotals: Object.fromEntries(
        Object.entries(systemTotals).map(([k,v]) => [k, Math.round(v)])
      ),
      itemCount: bomLines.length * 3,
      spoolCount: spools.length,
      bom: bomLines
    });

  } catch (err) {
    console.error('[wetkit] bom error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wetkit/projects/:projectId/bom
router.get('/:projectId/bom', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  try {
    const { rows } = await db.query(`
      SELECT k.item_type, k.spec, k.qty, k.unit,
             k.unit_rate_inr, k.dsr_ref,
             s.spool_code, s.system_type
      FROM wetkit_kit_items k
      JOIN wetkit_spools s ON s.id = k.spool_id
      WHERE k.project_id=$1 AND k.tenant_id=$2
      ORDER BY s.system_type, s.spool_code, k.step_sequence
    `, [projectId, tenantId]);

    // Summary by system
    const summary = {};
    rows.forEach(r => {
      if (!summary[r.system_type]) summary[r.system_type] = 0;
      summary[r.system_type] += parseFloat(r.qty) * parseFloat(r.unit_rate_inr);
    });

    const grandTotal = Object.values(summary).reduce((a,b) => a+b, 0);

    res.json({
      items: rows,
      summary,
      grandTotalINR: Math.round(grandTotal),
      grandTotalLac: (grandTotal/100000).toFixed(2)
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
