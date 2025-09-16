// /server/server.js  (drop-in replacement)
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';

const app = express();

// ---- CORS (with logging & wildcard support) ----
const rawOrigins = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

// why: support simple wildcard like *.github.io
function originAllowed(origin) {
  if (!origin) return true; // curl, Postman, server-to-server
  for (const rule of rawOrigins) {
    if (rule === origin) return true;
    if (rule.startsWith('*.')) {
      const domain = rule.slice(2); // after "*."
      if (origin.endsWith(domain) && origin.split('.').length >= domain.split('.').length + 1) return true;
    }
  }
  return false;
}

app.use((req, _res, next) => {
  const o = req.headers.origin || '';
  const ok = originAllowed(o);
  if (process.env.NODE_ENV !== 'production') {
    console.log(`[CORS] origin="${o}" allowed=${ok} rules=${JSON.stringify(rawOrigins)}`);
  }
  next();
});

app.use(cors({
  origin: (origin, cb) => {
    if (originAllowed(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  },
  credentials: false
}));

app.options('*', cors()); // preflight

// ---- Security / middleware ----
app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '256kb' }));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));
app.set('trust proxy', 1);

// Basic abuse protection
const limiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use('/api/', limiter);

// ---- Mongo model ----
const LeadSchema = new mongoose.Schema({
  name: { type: String, required: true, trim: true, maxlength: 100 },
  email: { type: String, required: true, lowercase: true, trim: true, maxlength: 200 },
  phone: { type: String, trim: true, maxlength: 50 },
  company: { type: String, trim: true, maxlength: 120 },
  message: { type: String, required: true, trim: true, maxlength: 5000 },
  consent: { type: Boolean, required: true },
  source: { type: String, trim: true, default: 'web' }
}, { timestamps: true });

const Lead = mongoose.model('Lead', LeadSchema);

// ---- Routes ----
app.get('/api/health', (_req, res) => res.json({ ok: true }));

app.post('/api/lead', async (req, res) => {
  try {
    const { name, email, phone, company, message, consent, source } = req.body || {};
    if (!name || !email || !message || consent !== true) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }
    const doc = await Lead.create({ name, email, phone, company, message, consent, source });
    return res.status(201).json({ ok: true, id: doc._id });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ---- Startup ----
const PORT = process.env.PORT || 3000;

async function start() {
  try {
    if (!process.env.MONGODB_URI) throw new Error('MONGODB_URI not set');
    await mongoose.connect(process.env.MONGODB_URI);
    app.listen(PORT, () => console.log(`API listening on :${PORT}`));
  } catch (e) {
    console.error(e);
    process.exit(1);
  }
}

start();
