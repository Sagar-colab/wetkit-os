const { Pool } = require('pg');
require('dotenv').config({ path: '/opt/wetkit-os/.env' });

const pool = new Pool({
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

pool.query('SELECT NOW()', (err, res) => {
  if (err) console.error('[wetkit] DB connection failed:', err.message);
  else console.log('[wetkit] DB connected:', res.rows[0].now);
});

module.exports = pool;
