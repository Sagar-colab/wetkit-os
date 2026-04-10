const express = require('express');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { v4: uuidv4 } = require('uuid');
const db = require('../db');

const router = express.Router();
const JWT_SECRET = process.env.JWT_SECRET || 'wetkit_jwt_secret_2026';

// POST /api/auth/register
router.post('/register', async (req, res) => {
  const { name, email, pin, role = 'plumbing_designer' } = req.body;
  if (!name || !email || !pin)
    return res.status(400).json({ error: 'name, email and pin required' });
  if (pin.length < 4)
    return res.status(400).json({ error: 'PIN must be at least 4 digits' });

  try {
    const existing = await db.query(
      'SELECT id FROM wetkit_users WHERE phone=$1', [email]);
    if (existing.rows.length)
      return res.status(409).json({ error: 'Email already registered' });

    const tenantId = uuidv4();
    const hash = await bcrypt.hash(pin, 10);

    await db.query(`
      INSERT INTO wetkit_users (id, phone, name, role, tenant_id)
      VALUES (gen_random_uuid(), $1, $2, $3, $4)
    `, [email, name, role, tenantId]);

    // Store PIN hash
    await db.query(`
      INSERT INTO wetkit_otp (phone, code, expires_at)
      VALUES ($1, $2, NOW() + INTERVAL '100 years')
      ON CONFLICT (phone) DO UPDATE SET code=$2
    `, [email, hash]);

    // Create default project for new user
    const projectId = uuidv4();
    await db.query(`
      INSERT INTO wetkit_projects (id, name, building_type, tenant_id, created_by)
      VALUES ($1, $2, 'residential', $3, $3)
    `, [projectId, `${name}'s Project`, tenantId]);

    const token = jwt.sign(
      { email, tenantId, role, name, projectId },
      JWT_SECRET, { expiresIn: '7d' }
    );

    res.json({ token, tenantId, projectId, name, role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/auth/login
router.post('/login', async (req, res) => {
  const { email, pin } = req.body;
  if (!email || !pin)
    return res.status(400).json({ error: 'email and pin required' });

  try {
    const user = await db.query(
      'SELECT id, name, role, tenant_id FROM wetkit_users WHERE phone=$1',
      [email]
    );
    if (!user.rows.length)
      return res.status(401).json({ error: 'Invalid email or PIN' });

    const storedHash = await db.query(
      'SELECT code FROM wetkit_otp WHERE phone=$1', [email]);
    if (!storedHash.rows.length)
      return res.status(401).json({ error: 'Invalid email or PIN' });

    const valid = await bcrypt.compare(pin, storedHash.rows[0].code);
    if (!valid)
      return res.status(401).json({ error: 'Invalid email or PIN' });

    const u = user.rows[0];

    // Get user's latest project
    const proj = await db.query(`
      SELECT id FROM wetkit_projects
      WHERE tenant_id=$1 ORDER BY created_at DESC LIMIT 1
    `, [u.tenant_id]);
    const projectId = proj.rows[0]?.id;

    const token = jwt.sign(
      { email, tenantId: u.tenant_id, role: u.role, name: u.name, projectId },
      JWT_SECRET, { expiresIn: '7d' }
    );

    res.json({ token, tenantId: u.tenant_id, projectId, name: u.name, role: u.role });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/auth/me (verify token)
router.get('/me', (req, res) => {
  const auth = req.headers.authorization;
  if (!auth) return res.status(401).json({ error: 'No token' });
  try {
    const decoded = jwt.verify(auth.replace('Bearer ', ''), JWT_SECRET);
    res.json(decoded);
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

module.exports = router;
