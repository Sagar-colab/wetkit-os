const db = require('../db');

async function getMappingsForPython(tenantId) {
  const result = await db.query(`
    SELECT mapping_type, source_value, target_value, priority
    FROM wetkit_ifc_mappings
    WHERE tenant_id IS NULL OR tenant_id = $1
    ORDER BY priority DESC
  `, [tenantId]);
  const layerSystem = {};
  const dnProperty = {};
  for (const row of result.rows) {
    if (row.mapping_type === 'layer_system') {
      const k = row.source_value.toUpperCase();
      if (!layerSystem[k]) layerSystem[k] = row.target_value;
    }
    if (row.mapping_type === 'dn_property') {
      const systems = row.target_value === 'ALL'
        ? ['CW','HW','HWR','FWS','SOIL','WASTE','VENT','SWD']
        : row.target_value.split(',');
      for (const sys of systems) {
        if (!dnProperty[sys]) dnProperty[sys] = [];
        if (!dnProperty[sys].includes(row.source_value))
          dnProperty[sys].push(row.source_value);
      }
    }
  }
  return JSON.stringify({ layerSystem, dnProperty });
}

module.exports = { getMappingsForPython };
