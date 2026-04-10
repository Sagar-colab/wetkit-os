const express = require('express');
const db = require('../db');
const router = express.Router();

router.get('/', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  try {
    const result = await db.query(`
      SELECT id, tenant_id, mapping_type, source_value, target_value,
             priority, notes, created_at
      FROM wetkit_ifc_mappings
      WHERE tenant_id IS NULL OR tenant_id = $1
      ORDER BY mapping_type, priority DESC
    `, [tenantId]);
    res.json({ mappings: result.rows });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { mapping_type, source_value, target_value, priority = 50, notes } = req.body;
  if (!mapping_type || !source_value || !target_value)
    return res.status(400).json({ error: 'mapping_type, source_value, target_value required' });
  try {
    const result = await db.query(`
      INSERT INTO wetkit_ifc_mappings
        (tenant_id, mapping_type, source_value, target_value, priority, notes)
      VALUES ($1,$2,$3,$4,$5,$6) RETURNING *
    `, [tenantId, mapping_type, source_value, target_value, priority, notes]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.patch('/:id', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { id } = req.params;
  const { target_value, priority, notes } = req.body;
  try {
    const check = await db.query(
      'SELECT tenant_id FROM wetkit_ifc_mappings WHERE id=$1', [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (!check.rows[0].tenant_id)
      return res.status(403).json({ error: 'Cannot edit global defaults' });
    if (check.rows[0].tenant_id !== tenantId)
      return res.status(403).json({ error: 'Not your mapping' });
    const result = await db.query(`
      UPDATE wetkit_ifc_mappings
      SET target_value=COALESCE($1,target_value),
          priority=COALESCE($2,priority),
          notes=COALESCE($3,notes),
          updated_at=NOW()
      WHERE id=$4 RETURNING *
    `, [target_value, priority, notes, id]);
    res.json(result.rows[0]);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/:id', async (req, res) => {
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';
  const { id } = req.params;
  try {
    const check = await db.query(
      'SELECT tenant_id FROM wetkit_ifc_mappings WHERE id=$1', [id]);
    if (!check.rows.length) return res.status(404).json({ error: 'Not found' });
    if (!check.rows[0].tenant_id)
      return res.status(403).json({ error: 'Cannot delete global defaults' });
    if (check.rows[0].tenant_id !== tenantId)
      return res.status(403).json({ error: 'Not your mapping' });
    await db.query('DELETE FROM wetkit_ifc_mappings WHERE id=$1', [id]);
    res.json({ deleted: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
