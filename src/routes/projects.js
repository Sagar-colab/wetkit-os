const express = require('express');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();

// GET /api/wetkit/projects-list
router.get('/', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  try {
    const { rows } = await db.query(`
      SELECT p.id, p.name, p.building_type, p.created_at,
        (SELECT COUNT(*) FROM wetkit_pipe_segments s WHERE s.project_id = p.id) as segments,
        (SELECT COUNT(*) FROM wetkit_spools sp WHERE sp.project_id = p.id) as spools
      FROM wetkit_projects p
      WHERE p.tenant_id = $1
      ORDER BY p.created_at DESC
    `, [tenantId]);
    res.json({ projects: rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/wetkit/projects-list
router.post('/', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { name, building_type = 'residential' } = req.body;
  if (!name) return res.status(400).json({ error: 'Project name required' });
  try {
    const projectId = uuidv4();
    const userId = uuidv4();
    await db.query(`
      INSERT INTO wetkit_projects (id, name, building_type, tenant_id, created_by)
      VALUES ($1, $2, $3, $4, $4)
    `, [projectId, name, building_type, tenantId]);
    res.json({ id: projectId, name, building_type, segments: 0, spools: 0 });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/wetkit/projects-list/:id
router.delete('/:id', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { id } = req.params;
  try {
    const check = await db.query(
      'SELECT id FROM wetkit_projects WHERE id=$1 AND tenant_id=$2', [id, tenantId]);
    if (!check.rows.length)
      return res.status(404).json({ error: 'Project not found' });
    await db.query('DELETE FROM wetkit_kit_items WHERE project_id=$1', [id]);
    await db.query('DELETE FROM wetkit_spools WHERE project_id=$1', [id]);
    await db.query('DELETE FROM wetkit_pipe_segments WHERE project_id=$1', [id]);
    await db.query('DELETE FROM wetkit_fittings WHERE project_id=$1', [id]);
    await db.query('DELETE FROM wetkit_ifc_uploads WHERE project_id=$1', [id]);
    await db.query('DELETE FROM wetkit_projects WHERE id=$1', [id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
