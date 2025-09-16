// /server/server.js
import 'dotenv/config';
import express from 'express';
import helmet from 'helmet';
import mongoose from 'mongoose';
import cors from 'cors';
import morgan from 'morgan';
import rateLimit from 'express-rate-limit';
import nodemailer from 'nodemailer';

const app = express();

// CORS (why: only allow your sites to call the API)
const allowed = (process.env.ALLOWED_ORIGINS || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);

app.use(cors({
  origin: (origin, cb) => {
    if (!origin) return cb(null, true); // allow curl/hoppscotch without Origin
    if (allowed.length === 0 || allowed.includes(origin)) return cb(null, true);
    return cb(new Error('Not allowed by CORS'));
  }
}));

app.use(helmet({ crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(express.json({ limit: '256kb' }));
if (process.env.NODE_ENV !== 'production') app.use(morgan('dev'));
app.set('trust proxy', 1);

const limiter = rateLimit({ windowMs: 60_000, max: 20 });
app.use('/api/', limiter);

// ===== Mongoose model =====
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

// ===== Health =====
app.get('/api/health', (req, res) => res.json({ ok: true }));

// ===== Email transport (SMTP) =====
function buildTransport() {
  // why: allow standard SMTP providers (SendGrid/Mailgun/Outlook/GSuite)
  const host = process.env.SMTP_HOST;
  const port = parseInt(process.env.SMTP_PORT || '587', 10);
  const user = process.env.SMTP_USER;
  const pass = process.env.SMTP_PASS;

  if (!host || !port || !user || !pass) {
    console.warn('SMTP not fully configured; emails will be skipped.');
    return null;
  }

  const secure = port === 465; // true for 465, false for others
  return nodemailer.createTransport({
    host, port, secure,
    auth: { user, pass }
  });
}

const mailer = buildTransport();

// ===== Routes =====
app.post('/api/lead', async (req, res) => {
  try {
    const { name, email, phone, company, message, consent, source } = req.body || {};

    // Basic validation
    if (!name || !email || !message || consent !== true) {
      return res.status(400).json({ ok: false, error: 'Missing required fields' });
    }
    if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
      return res.status(400).json({ ok: false, error: 'Invalid email' });
    }

    // Save to MongoDB (at minimum collects name + email)
    const doc = await Lead.create({
      name,
      email,
      phone: phone || '',
      company: company || '',
      message,
      consent: true,
      source: source || 'web'
    });

    // Send notification email (best-effort; do not fail the request if mail fails)
    let mailed = false;
    if (mailer) {
      try {
        const to = process.env.MAIL_TO || 'info@datanetplus.co.uk';
        const from = process.env.MAIL_FROM || process.env.SMTP_USER;
        const subject = `New enquiry from ${name}`;
        const text = [
          `New enquiry from DataNet Plus website`,
          ``,
          `Name: ${name}`,
          `Email: ${email}`,
          `Phone: ${phone || '-'}`,
          `Company: ${company || '-'}`,
          `Message:`,
          message,
          ``,
          `Consent: ${consent ? 'Yes' : 'No'}`,
          `Source: ${source || 'web'}`,
          `Submitted: ${new Date().toISOString()}`
        ].join('\n');

        const html = `
          <div style="font-family:system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif;line-height:1.5">
            <h2 style="margin:0 0 8px">New enquiry from DataNet Plus website</h2>
            <p><strong>Name:</strong> ${escapeHtml(name)}<br/>
               <strong>Email:</strong> ${escapeHtml(email)}<br/>
               <strong>Phone:</strong> ${escapeHtml(phone || '-') }<br/>
               <strong>Company:</strong> ${escapeHtml(company || '-') }</p>
            <p><strong>Message:</strong><br/>${nl2br(escapeHtml(message))}</p>
            <p><strong>Consent:</strong> ${consent ? 'Yes' : 'No'}<br/>
               <strong>Source:</strong> ${escapeHtml(source || 'web')}<br/>
               <strong>Submitted:</strong> ${new Date().toISOString()}</p>
          </div>
        `;

        await mailer.sendMail({
          from,
          to,
          subject,
          text,
          html,
          replyTo: email // why: reply goes to the sender
        });
        mailed = true;
      } catch (e) {
        console.error('Email send failed:', e);
      }
    }

    return res.status(201).json({ ok: true, id: doc._id, mailed });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: 'Server error' });
  }
});

// ===== Utils =====
function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c => ({
    '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'
  }[c]));
}
function nl2br(s) {
  return String(s).replace(/\n/g, '<br/>');
}

// ===== Start =====
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
