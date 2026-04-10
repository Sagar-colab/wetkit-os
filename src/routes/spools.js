const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

const MAX_SPOOL_MM = 2000;

// IS 2065 DFU ratings per system per DN
function getDFU(systemType, diameterMm) {
  const dn = Math.round(parseFloat(diameterMm) || 0);
  const DFU_TABLE = {
    WASTE: { 40: 1, 50: 2, 63: 4, 75: 5, 110: 8 },
    SOIL:  { 75: 5, 100: 8, 110: 8 },
    VENT:  { 40: 0, 50: 0, 75: 0, 110: 0 },
    CW:    { 20: 0.5, 25: 1, 32: 2, 40: 3, 50: 5 },
    HW:    { 20: 0.5, 25: 1, 32: 2, 40: 3, 50: 5 },
    HWR:   { 20: 0, 25: 0, 32: 0, 40: 0, 50: 0 },
    FWS:   { 20: 0, 25: 0, 32: 0, 40: 0, 50: 0 },
    SWD:   { 75: 5, 100: 8, 110: 8 },
  };
  const table = DFU_TABLE[systemType] || {};
  const bores = Object.keys(table).map(Number).sort((a,b) => a-b);
  const nearest = bores.reduce((a,b) => Math.abs(b-dn) < Math.abs(a-dn) ? b : a, bores[0]);
  return table[nearest] || 0;
}

// DFU limits per system (IS 2065)
const DFU_LIMITS = {
  WASTE: 24, SOIL: 30, VENT: 999,
  CW: 999, HW: 999, HWR: 999, FWS: 999, SWD: 30
};

// Segment long pipes into ≤2000mm chunks
function splitSegment(seg) {
  const length = parseFloat(seg.length_mm);
  if (length <= MAX_SPOOL_MM) return [seg];

  const parts = [];
  const n = Math.ceil(length / MAX_SPOOL_MM);
  const sx = parseFloat(seg.start_x), sy = parseFloat(seg.start_y), sz = parseFloat(seg.start_z);
  const ex = parseFloat(seg.end_x),   ey = parseFloat(seg.end_y),   ez = parseFloat(seg.end_z);
  const dx = (ex-sx)/n, dy = (ey-sy)/n, dz = (ez-sz)/n;
  const partLen = length / n;

  for (let i = 0; i < n; i++) {
    parts.push({
      ...seg,
      global_id: `${seg.global_id}_split${i}`,
      start_x: sx + dx*i, start_y: sy + dy*i, start_z: sz + dz*i,
      end_x: sx + dx*(i+1), end_y: sy + dy*(i+1), end_z: sz + dz*(i+1),
      length_mm: partLen,
    });
  }
  return parts;
}

// POST /api/wetkit/projects/:projectId/spools/generate
router.post('/:projectId/spools/generate', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';

  try {
    // Fetch all segments
    const { rows: segments } = await db.query(`
      SELECT id, global_id, system_type, diameter_mm, od_mm,
             length_mm, floor_level, strang_nr,
             start_x, start_y, start_z, end_x, end_y, end_z
      FROM wetkit_pipe_segments
      WHERE project_id = $1 AND tenant_id = $2
      ORDER BY system_type, strang_nr, length_mm DESC
    `, [projectId, tenantId]);

    if (!segments.length)
      return res.status(404).json({ error: 'No segments found for this project' });

    // Clear existing spools for this project
    await db.query(
      `DELETE FROM wetkit_kit_items WHERE project_id = $1`, [projectId]);
    await db.query(
      `DELETE FROM wetkit_spools WHERE project_id = $1`, [projectId]);

    // Group by system_type + strang_nr
    const groups = {};
    for (const seg of segments) {
      const key = `${seg.system_type}:${seg.strang_nr || '0'}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(seg);
    }

    const spoolCodes = {}; // track sequence per system
    const createdSpools = [];

    for (const [key, groupSegs] of Object.entries(groups)) {
      const [system] = key.split(':');

      // Split long segments
      const allParts = [];
      for (const seg of groupSegs) {
        splitSegment(seg).forEach(p => allParts.push(p));
      }

      // Pack into spools ≤2000mm
      let currentSpool = [];
      let currentLength = 0;

      const flushSpool = async () => {
        if (!currentSpool.length) return;

        const seq = (spoolCodes[system] = (spoolCodes[system] || 0) + 1);
        const spoolCode = `${system}-GF-${String(seq).padStart(3,'0')}`;
        const spoolId = uuidv4();
        const totalLength = currentSpool.reduce((s,p) => s + parseFloat(p.length_mm), 0);
        const segIds = [...new Set(currentSpool.map(p => p.id).filter(Boolean))];
        const totalDfu = currentSpool.reduce((s,p) =>
          s + getDFU(system, p.diameter_mm), 0);
        const dfuLimit = DFU_LIMITS[system] || 999;
        const dfuStatus = totalDfu > dfuLimit ? 'overload'
          : totalDfu > dfuLimit * 0.8 ? 'warning' : 'ok';

        await db.query(`
          INSERT INTO wetkit_spools (
            id, project_id, tenant_id, spool_code, system_type,
            floor_level, segment_ids, total_length_mm,
            total_dfu, dfu_limit, dfu_status, fabrication_status
          ) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'pending')
        `, [
          spoolId, projectId, tenantId, spoolCode, system,
          'GF', segIds, Math.round(totalLength),
          totalDfu, dfuLimit, dfuStatus
        ]);

        // Update segments with spool_id
        for (const seg of currentSpool) {
          if (seg.id) {
            await db.query(
              `UPDATE wetkit_pipe_segments SET spool_id=$1 WHERE id=$2`,
              [spoolId, seg.id]
            );
          }
        }

        createdSpools.push({
          spoolCode, system, totalLength: Math.round(totalLength),
          segmentCount: currentSpool.length, totalDfu, dfuStatus
        });

        currentSpool = [];
        currentLength = 0;
      };

      for (const part of allParts) {
        const partLen = parseFloat(part.length_mm);
        if (currentLength + partLen > MAX_SPOOL_MM && currentSpool.length > 0) {
          await flushSpool();
        }
        currentSpool.push(part);
        currentLength += partLen;
      }
      await flushSpool();
    }

    res.json({
      success: true,
      spoolCount: createdSpools.length,
      spools: createdSpools,
      message: `Generated ${createdSpools.length} spools from ${segments.length} segments`
    });

  } catch (err) {
    console.error('[wetkit] spool error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

// GET /api/wetkit/projects/:projectId/spools
router.get('/:projectId/spools', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  try {
    const { rows } = await db.query(`
      SELECT id, spool_code, system_type, floor_level,
             total_length_mm, total_dfu, dfu_limit,
             dfu_status, fabrication_status,
             array_length(segment_ids, 1) as segment_count
      FROM wetkit_spools
      WHERE project_id=$1 AND tenant_id=$2
      ORDER BY system_type, spool_code
    `, [projectId, tenantId]);
    res.json({ spools: rows, count: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;

// PATCH /api/wetkit/projects/:projectId/spools/:spoolId/status
router.patch('/:projectId/spools/:spoolId/status', async (req, res) => {
  const { projectId, spoolId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { status } = req.body;

  const validStatuses = ['pending', 'confirmed', 'fabricated', 'installed'];
  if (!validStatuses.includes(status))
    return res.status(400).json({ error: 'Invalid status. Use: pending, confirmed, fabricated, installed' });

  try {
    const result = await db.query(`
      UPDATE wetkit_spools
      SET fabrication_status = $1,
          confirmed_at = CASE WHEN $1 = 'confirmed' THEN NOW() ELSE confirmed_at END
      WHERE id = $2 AND project_id = $3 AND tenant_id = $4
      RETURNING id, spool_code, fabrication_status
    `, [status, spoolId, projectId, tenantId]);

    if (!result.rows.length)
      return res.status(404).json({ error: 'Spool not found' });

    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/wetkit/projects/:projectId/spools/bulk-status
router.patch('/:projectId/spools/bulk-status', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { status, system_type } = req.body;

  const validStatuses = ['pending', 'confirmed', 'fabricated', 'installed'];
  if (!validStatuses.includes(status))
    return res.status(400).json({ error: 'Invalid status' });

  try {
    let query = `
      UPDATE wetkit_spools
      SET fabrication_status = $1,
          confirmed_at = CASE WHEN $1 = 'confirmed' THEN NOW() ELSE confirmed_at END
      WHERE project_id = $2 AND tenant_id = $3
    `;
    const params = [status, projectId, tenantId];

    if (system_type) {
      query += ` AND system_type = $4`;
      params.push(system_type);
    }

    query += ` RETURNING id`;
    const result = await db.query(query, params);
    res.json({ updated: result.rows.length, status });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
