const express = require('express');
const db = require('../db');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const router = express.Router();

// IS 1239 OD lookup
const IS1239_OD = {
  15:21.3, 20:26.9, 25:33.7, 32:42.4, 40:48.3,
  50:60.3, 63:76.1, 65:76.1, 75:88.9, 80:88.9,
  100:114.3, 110:114.3, 125:139.7, 150:168.3
};

function odFromDN(dn) {
  if (!dn || dn <= 0) return 48.3;
  const bores = Object.keys(IS1239_OD).map(Number).sort((a,b) => a-b);
  const nearest = bores.reduce((a,b) => Math.abs(b-dn) < Math.abs(a-dn) ? b : a, bores[0]);
  return IS1239_OD[nearest];
}

// System → IFC output name mapping
const SYSTEM_IFC_NAME = {
  WASTE: 'WASTE WATER PIPE', SOIL: 'SOIL PIPE', VENT: 'VENT PIPE',
  CW: 'DWS PIPE', HW: 'HWS PIPE', HWR: 'HWR PIPE',
  FWS: 'FWS PIPE', SWD: 'SWD PIPE'
};

function generateGUID() {
  return uuidv4().replace(/-/g,'').substring(0,22).toUpperCase();
}

function vec3(x, y, z) {
  // Convert from mm storage back to cm for IFC output
  return [(x/10).toFixed(6), (y/10).toFixed(6), (z/10).toFixed(6)];
}

// GET /api/wetkit/projects/:projectId/export/ifc
router.get('/:projectId/export/ifc', async (req, res) => {
  const { projectId } = req.params;
  const tenantId = req.headers['x-tenant-id'] || '00000000-0000-0000-0000-000000000001';

  try {
    // Get all segments with their spool info
    const { rows: segments } = await db.query(`
      SELECT s.global_id, s.system_type, s.diameter_mm, s.od_mm,
             s.start_x, s.start_y, s.start_z,
             s.end_x, s.end_y, s.end_z,
             s.length_mm, s.floor_level,
             sp.spool_code, sp.fabrication_status
      FROM wetkit_pipe_segments s
      LEFT JOIN wetkit_spools sp ON sp.id = s.spool_id
      WHERE s.project_id = $1 AND s.tenant_id = $2
      ORDER BY s.system_type, sp.spool_code
    `, [projectId, tenantId]);

    if (!segments.length)
      return res.status(404).json({ error: 'No segments found' });

    // Build IFC file
    const timestamp = new Date().toISOString().replace(/[:.]/g, '');
    const projectGUID = generateGUID();
    const ownerGUID   = generateGUID();
    const personGUID  = generateGUID();
    const siteGUID    = generateGUID();
    const buildingGUID= generateGUID();
    const storeyGUID  = generateGUID();

    let entityId = 1;
    const entities = [];

    // Header entities
    entities.push(`#${entityId++}=IFCORGANIZATION($,'WetKit OS','OneEvolve.AI',$,$);`);
    entities.push(`#${entityId++}=IFCPERSON($,'WetKit','OS',$,$,$,$,$);`);
    const personOrgId = entityId;
    entities.push(`#${entityId++}=IFCPERSONANDORGANIZATION(#2,#1,$);`);
    const appId = entityId;
    entities.push(`#${entityId++}=IFCAPPLICATION(#1,'1.0','WetKit OS IFC Exporter','WetKitOS');`);
    const ownerHistId = entityId;
    entities.push(`#${entityId++}=IFCOWNERHISTORY(#${personOrgId},#${appId},$,.ADDED.,$,$,$,0);`);

    // Units
    const unitId = entityId;
    entities.push(`#${entityId++}=IFCSIUNIT(*,.LENGTHUNIT.,.CENTI.,.METRE.);`);
    entities.push(`#${entityId++}=IFCSIUNIT(*,.AREAUNIT.,$,.SQUARE_METRE.);`);
    entities.push(`#${entityId++}=IFCSIUNIT(*,.VOLUMEUNIT.,$,.CUBIC_METRE.);`);
    const unitAssignId = entityId;
    entities.push(`#${entityId++}=IFCUNITASSIGNMENT((#${unitId},#${unitId+1},#${unitId+2}));`);

    // Geometric context
    const ctxId = entityId;
    entities.push(`#${entityId++}=IFCGEOMETRICREPRESENTATIONCONTEXT($,'Model',3,1.E-05,#${entityId+1},$);`);
    entities.push(`#${entityId++}=IFCAXIS2PLACEMENT3D(#${entityId+1},$,$);`);
    entities.push(`#${entityId++}=IFCCARTESIANPOINT((0.,0.,0.));`);

    // Project
    const projId = entityId;
    entities.push(`#${entityId++}=IFCPROJECT('${projectGUID}',#${ownerHistId},'WetKit Export',$,$,$,$,(#${ctxId}),#${unitAssignId});`);

    // Site → Building → Storey
    const siteId = entityId;
    entities.push(`#${entityId++}=IFCSITE('${siteGUID}',#${ownerHistId},'Site',$,$,$,$,$,.ELEMENT.,$,$,$,$,$);`);
    const buildId = entityId;
    entities.push(`#${entityId++}=IFCBUILDING('${buildingGUID}',#${ownerHistId},'Building',$,$,$,$,$,.ELEMENT.,$,$,$);`);
    const storeyId = entityId;
    entities.push(`#${entityId++}=IFCBUILDINGSTOREY('${storeyGUID}',#${ownerHistId},'GF',$,$,$,$,$,.ELEMENT.,0.);`);

    // Relationships
    entities.push(`#${entityId++}=IFCRELAGGREGATES('${generateGUID()}',#${ownerHistId},$,$,#${projId},(#${siteId}));`);
    entities.push(`#${entityId++}=IFCRELAGGREGATES('${generateGUID()}',#${ownerHistId},$,$,#${siteId},(#${buildId}));`);
    entities.push(`#${entityId++}=IFCRELAGGREGATES('${generateGUID()}',#${ownerHistId},$,$,#${buildId},(#${storeyId}));`);

    // Generate IfcPipeSegment for each segment
    const pipeSegmentIds = [];

    for (const seg of segments) {
      const sx = parseFloat(seg.start_x), sy = parseFloat(seg.start_y), sz = parseFloat(seg.start_z);
      const ex = parseFloat(seg.end_x),   ey = parseFloat(seg.end_y),   ez = parseFloat(seg.end_z);
      const dn = parseFloat(seg.diameter_mm) || 20;
      const od = parseFloat(seg.od_mm) || odFromDN(dn);

      // Direction vector
      const dx = ex - sx, dy = ey - sy, dz = ez - sz;
      const len = Math.sqrt(dx*dx + dy*dy + dz*dz);
      if (len < 0.1) continue;
      const nx = dx/len, ny = dy/len, nz = dz/len;

      // Convert mm → cm for IFC
      const [sxc, syc, szc] = [(sx/10).toFixed(4), (sy/10).toFixed(4), (sz/10).toFixed(4)];
      const radiusCm = (od/2/10).toFixed(4);
      const lenCm    = (len/10).toFixed(4);

      // Placement
      const ptId = entityId;
      entities.push(`#${entityId++}=IFCCARTESIANPOINT((${sxc},${syc},${szc}));`);
      const dirId = entityId;
      entities.push(`#${entityId++}=IFCDIRECTION((${nx.toFixed(6)},${ny.toFixed(6)},${nz.toFixed(6)}));`);
      const axisId = entityId;
      entities.push(`#${entityId++}=IFCAXIS2PLACEMENT3D(#${ptId},#${dirId},$);`);
      const placementId = entityId;
      entities.push(`#${entityId++}=IFCLOCALPLACEMENT($,#${axisId});`);

      // Circle profile
      const circleId = entityId;
      entities.push(`#${entityId++}=IFCCIRCLEPROFILEDEF(.AREA.,$,#${entityId+1},${radiusCm});`);
      const profAxisId = entityId;
      entities.push(`#${entityId++}=IFCAXIS2PLACEMENT2D(#${entityId+1},$);`);
      entities.push(`#${entityId++}=IFCCARTESIANPOINT((0.,0.));`);

      // Extrusion
      const extDirId = entityId;
      entities.push(`#${entityId++}=IFCDIRECTION((0.,0.,1.));`);
      const solidId = entityId;
      entities.push(`#${entityId++}=IFCEXTRUDEDAREASOLID(#${circleId},#${axisId},#${extDirId},${lenCm});`);

      // Shape representation
      const shapeRepId = entityId;
      entities.push(`#${entityId++}=IFCSHAPEREPRESENTATION(#${ctxId},'Body','SweptSolid',(#${solidId}));`);
      const prodDefId = entityId;
      entities.push(`#${entityId++}=IFCPRODUCTDEFINITIONSHAPE($,$,(#${shapeRepId}));`);

      // IfcPipeSegment
      const ifcName = SYSTEM_IFC_NAME[seg.system_type] || seg.system_type;
      const pipeId = entityId;
      entities.push(`#${entityId++}=IFCPIPESEGMENT('${generateGUID()}',#${ownerHistId},'${ifcName}','${seg.spool_code || ''}',$,#${placementId},#${prodDefId},$,.RIGIDSEGMENT.);`);
      pipeSegmentIds.push(pipeId);
    }

    // Relate all pipe segments to storey
    if (pipeSegmentIds.length) {
      entities.push(`#${entityId++}=IFCRELCONTAINEDINSPATIALSTRUCTURE('${generateGUID()}',#${ownerHistId},$,$,(${pipeSegmentIds.map(id => '#'+id).join(',')}),#${storeyId});`);
    }

    // Build IFC file content
    const ifcContent = `ISO-10303-21;
HEADER;
FILE_DESCRIPTION(('WetKit OS IFC Export','Generated by WetKit OS - OneEvolve.AI'),'2;1');
FILE_NAME('wetkit_export_${timestamp}.ifc','${new Date().toISOString()}',('WetKit OS'),('OneEvolve.AI'),'WetKit OS 1.0','WetKit OS IFC Exporter','');
FILE_SCHEMA(('IFC4'));
ENDSEC;

DATA;
${entities.join('\n')}
ENDSEC;

END-ISO-10303-21;`;

    // Save to disk
    const exportDir = '/data/ifc-exports';
    fs.mkdirSync(exportDir, { recursive: true });
    const filename = `wetkit_${projectId.slice(0,8)}_${timestamp}.ifc`;
    const filepath = path.join(exportDir, filename);
    fs.writeFileSync(filepath, ifcContent);

    // Send file
    res.setHeader('Content-Type', 'application/x-step');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
    res.send(ifcContent);

  } catch (err) {
    console.error('[wetkit] ifc export error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
