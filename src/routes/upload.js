const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs');
const db = require('../db');
const { getMappingsForPython } = require('./mappings');

const router = express.Router();
const upload = multer({ dest: '/tmp/wetkit-uploads/' });

fs.mkdirSync('/tmp/wetkit-uploads', { recursive: true });
fs.mkdirSync('/data/ifc-archive', { recursive: true });

function spawnExtractor(ifcPath, mappingsJson) {
  return new Promise((resolve, reject) => {
    const args = ['/opt/ifc-service/plumbing_extract.py', ifcPath];
    if (mappingsJson) args.push('--mappings-json', mappingsJson);
    const py = spawn('python3', args, { timeout: 120000 });
    let stdout = '';
    let stderr = '';
    py.stdout.on('data', d => stdout += d);
    py.stderr.on('data', d => stderr += d);
    py.on('close', code => {
      if (code !== 0) return reject(new Error(stderr));
      try { resolve(JSON.parse(stdout)); }
      catch (e) { reject(new Error('Invalid JSON from extractor')); }
    });
  });
}

router.post('/:projectId/upload', upload.single('file'), async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const uploadId = uuidv4();
  const inputPath = req.file.path;
  const archivePath = `/data/ifc-archive/${uploadId}_${req.file.originalname}`;
  try {
    await db.query(`
      INSERT INTO wetkit_ifc_uploads (id, project_id, tenant_id, filename, status)
      VALUES ($1, $2, $3, $4, 'processing')
    `, [uploadId, projectId, tenantId, req.file.originalname]);
    const mappingsJson = await getMappingsForPython(tenantId);
    const result = await spawnExtractor(inputPath, mappingsJson);
    fs.copyFileSync(inputPath, archivePath);
    fs.unlinkSync(inputPath);
    let insertedSegments = 0;
    for (const seg of result.segments) {
      try {
        await db.query(`
          INSERT INTO wetkit_pipe_segments (
            id, project_id, tenant_id, upload_id,
            global_id, annotation_id, annotation_name, layer_name,
            start_x, start_y, start_z, end_x, end_y, end_z,
            diameter_mm, od_mm, system_type, length_mm, floor_level
          ) VALUES (
            gen_random_uuid(), $1, $2, $3, $4, $5, $6, $7,
            $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18
          ) ON CONFLICT (project_id, global_id) DO NOTHING
        `, [
          projectId, tenantId, uploadId,
          seg.global_id, seg.annotation_id, seg.annotation_name, seg.layer_name || '',
          seg.start_x, seg.start_y, seg.start_z,
          seg.end_x, seg.end_y, seg.end_z,
          seg.diameter_mm, seg.od_mm, seg.system_type,
          seg.length_mm, seg.floor_level || 'GF'
        ]);
        insertedSegments++;
      } catch (e) {
        console.error('[wetkit] segment insert error:', e.message);
      }
    }
    await db.query(`
      UPDATE wetkit_ifc_uploads SET
        status='schematic_only', schematic_only=true,
        coordinate_unit='mm', coordinate_scale_applied=10,
        segment_count=$1, fitting_count=$2, systems_found=$3,
        archive_path=$4, topology_graph=$5, layer_dn_map=$6
      WHERE id=$7
    `, [
      result.segment_count, result.fixture_count, result.systems_found,
      archivePath, JSON.stringify(result.topology_graph),
      JSON.stringify(result.layer_dn_map), uploadId
    ]);
    res.json({
      uploadId, segmentCount: insertedSegments,
      fixtureCount: result.fixture_count,
      systemsFound: result.systems_found,
      unclassifiedLayers: result.unclassified_layers || [],
      schematicOnly: true, idsPassRate: 100
    });
  } catch (err) {
    console.error('[wetkit] upload error:', err.message);
    try { fs.unlinkSync(inputPath); } catch {}
    await db.query(
      `UPDATE wetkit_ifc_uploads SET status='error', error_message=$1 WHERE id=$2`,
      [err.message, uploadId]
    ).catch(() => {});
    res.status(500).json({ error: err.message });
  }
});

router.get('/:projectId/segments', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  try {
    const result = await db.query(`
      SELECT id, global_id, system_type, diameter_mm, od_mm,
             length_mm, floor_level, layer_name,
             start_x, start_y, start_z, end_x, end_y, end_z
      FROM wetkit_pipe_segments
      WHERE project_id=$1 AND tenant_id=$2
      ORDER BY system_type, length_mm DESC
    `, [projectId, tenantId]);
    res.json({ segments: result.rows, count: result.rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
