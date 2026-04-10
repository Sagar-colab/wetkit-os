require('dotenv').config({ path: '/opt/wetkit-os/.env' });
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const db = require('./db');

const app = express();

app.use(helmet({
  contentSecurityPolicy: {
    directives: {
      defaultSrc: ["'self'"],
      scriptSrc: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      scriptSrcAttr: ["'unsafe-inline'"],
      scriptSrcElem: ["'self'", "'unsafe-inline'", "https://cdnjs.cloudflare.com"],
      styleSrc: ["'self'", "'unsafe-inline'", "https://fonts.googleapis.com"],
      fontSrc: ["'self'", "https://fonts.gstatic.com"],
      connectSrc: ["'self'"],
      imgSrc: ["'self'", "data:"],
    }
  }
}));

app.use(cors());
app.use(express.json());
app.use(express.static('/opt/wetkit-os/public'));

const uploadRouter = require('./routes/upload');
app.use('/api/wetkit/projects', uploadRouter);
const ifcMappingsRouter = require('./routes/ifcMappings');
app.use('/api/wetkit/settings/ifc-mappings', ifcMappingsRouter);
const spoolsRouter = require('./routes/spools');
app.use('/api/wetkit/projects', spoolsRouter);
const bomRouter = require('./routes/bom');
app.use('/api/wetkit/projects', bomRouter);
const projectsRouter = require('./routes/projects');
app.use('/api/wetkit/projects-list', projectsRouter);
const exportRouter = require('./routes/export');
app.use('/api/wetkit/projects', exportRouter);
const pdfRouter = require('./routes/pdf');
app.use('/api/wetkit/projects', pdfRouter);
const authRouter = require('./routes/auth');
app.use('/api/auth', authRouter);

app.get('/health', async (req, res) => {
  try {
    await db.query('SELECT 1');
    res.json({ status: 'ok', app: 'wetkit-os', port: 3006, db: true });
  } catch (e) {
    res.status(500).json({ status: 'error', db: false });
  }
});

const PORT = process.env.PORT || 3006;
app.listen(PORT, () => console.log(`[wetkit] running on port ${PORT}`));
