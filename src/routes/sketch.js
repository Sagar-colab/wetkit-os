const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

const IS1239_OD = {
  15:21.3, 20:26.9, 25:33.7, 32:42.4, 40:48.3,
  50:60.3, 63:76.1, 65:76.1, 75:88.9, 80:88.9,
  100:114.3, 110:114.3, 125:139.7, 150:168.3
};

function odFromDN(dn) {
  const bores = Object.keys(IS1239_OD).map(Number).sort((a,b) => a-b);
  const nearest = bores.reduce((a,b) => Math.abs(b-dn) < Math.abs(a-dn) ? b : a, bores[0]);
  return IS1239_OD[nearest];
}

// POST /api/wetkit/projects/:projectId/sketch
router.post('/:projectId/sketch', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { lines, scale_mm_per_px } = req.body;

  if (!lines || !lines.length)
    return res.status(400).json({ error: 'No lines provided' });

  const scale = parseFloat(scale_mm_per_px) || 100;

  try {
    // Create a sketch upload record
    const uploadId = uuidv4();
    await db.query(`
      INSERT INTO wetkit_ifc_uploads
        (id, project_id, tenant_id, filename, status, segment_count)
      VALUES ($1, $2, $3, $4, 'sketch', $5)
    `, [uploadId, projectId, tenantId, 'sketch-' + Date.now() + '.sketch', lines.length]);

    // Convert lines to pipe segments
    // Clear existing segments first
    await db.query('DELETE FROM wetkit_kit_items WHERE spool_id IN (SELECT id FROM wetkit_spools WHERE project_id=$1)', [projectId]);
    await db.query('DELETE FROM wetkit_spools WHERE project_id=$1', [projectId]);
    await db.query('DELETE FROM wetkit_pipe_segments WHERE project_id=$1 AND tenant_id=$2', [projectId, tenantId]);
    const segments = [];
    for (const line of lines) {
      const dn  = parseInt(line.dn) || 20;
      const od  = odFromDN(dn);
      const sx  = parseFloat(line.x1) * scale;
      const sy  = parseFloat(line.y1) * scale;
      const ex  = parseFloat(line.x2) * scale;
      const ey  = parseFloat(line.y2) * scale;
      const len = Math.sqrt(Math.pow(ex-sx,2) + Math.pow(ey-sy,2));
      if (len < 1) continue;

      const globalId = 'SKETCH-' + uuidv4().slice(0,8).toUpperCase();
      await db.query(`
        INSERT INTO wetkit_pipe_segments (
          id, project_id, tenant_id, upload_id,
          global_id, annotation_id, annotation_name, layer_name,
          strang_nr, start_x, start_y, start_z, end_x, end_y, end_z,
          diameter_mm, od_mm, wall_thickness_mm, material, system_type,
          length_mm, floor_level, dfu_rating, ids_validated
        ) VALUES (
          $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24
        )
      `, [
        uuidv4(), projectId, tenantId, uploadId,
        globalId, globalId, line.system + ' DN' + dn, line.system,
        line.strang || 'A',
        sx, sy, 0, ex, ey, 0,
        dn, od, 2.6, 'CPVC', line.system,
        len, line.floor || 'GF', 0.5, true
      ]);
      segments.push({ globalId, system: line.system, dn, length: len });
    }

    // Auto-generate spools and BOM
    await db.query(`DELETE FROM wetkit_kit_items WHERE spool_id IN (SELECT id FROM wetkit_spools WHERE project_id=$1 AND tenant_id=$2)`, [projectId, tenantId]);
    await db.query(`DELETE FROM wetkit_spools WHERE project_id=$1 AND tenant_id=$2`, [projectId, tenantId]);

    res.json({ success: true, segments: segments.length, uploadId });
  } catch (err) {
    console.error("[sketch] input lines:", JSON.stringify(lines.slice(0,3))); console.error("[sketch]", err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
