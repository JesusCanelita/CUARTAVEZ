// ═══════════════════════════════════════════════════════════════
//   HABIT TRACKER PRO — Backend Node.js + Express
//   Conecta con la API de Claude (Anthropic) de forma segura
//   La API key NUNCA se expone al frontend
// ═══════════════════════════════════════════════════════════════

const express    = require('express');
const cors       = require('cors');
const dotenv     = require('dotenv');
const Anthropic  = require('@anthropic-ai/sdk');

// ── Cargar variables de entorno desde .env ──
dotenv.config();

const app  = express();
const PORT = process.env.PORT || 3001;

// ── Validación de API key al arrancar ──
if (!process.env.ANTHROPIC_API_KEY) {
  console.error('\n❌  ERROR: No se encontró ANTHROPIC_API_KEY en el archivo .env');
  console.error('   Crea un archivo .env con: ANTHROPIC_API_KEY=sk-ant-...\n');
  process.exit(1);
}

// ── Inicializar cliente de Anthropic ──
const anthropic = new Anthropic({
  apiKey: process.env.ANTHROPIC_API_KEY,
});

// ════════════════════════════════════════
//   MIDDLEWARES
// ════════════════════════════════════════
app.use(cors({
  origin: [
    'http://localhost:3000',
    'http://localhost:5500',
    'http://127.0.0.1:5500',
    'http://localhost:8080',
    'null',  // for file:// protocol
  ],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

app.use(express.json({ limit: '10kb' })); // Limit request body size

// ── Simple rate limiting (in-memory, per IP) ──
const rateLimitMap = new Map();
const RATE_LIMIT_WINDOW_MS  = 60 * 1000; // 1 minute
const RATE_LIMIT_MAX_REQUESTS = 20;       // 20 requests per minute

function rateLimit(req, res, next) {
  const ip  = req.ip || req.connection.remoteAddress || 'unknown';
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const requests = rateLimitMap.get(ip).filter(t => t > windowStart);
  requests.push(now);
  rateLimitMap.set(ip, requests);

  if (requests.length > RATE_LIMIT_MAX_REQUESTS) {
    return res.status(429).json({
      error: 'Demasiadas peticiones. Espera un minuto antes de continuar.',
      retryAfter: 60
    });
  }
  next();
}

// ── Input sanitization ──
function sanitizeString(str, maxLength = 4000) {
  if (typeof str !== 'string') return '';
  return str.trim().substring(0, maxLength);
}

// ════════════════════════════════════════
//   HEALTH CHECK
// ════════════════════════════════════════
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    timestamp: new Date().toISOString(),
    model: 'claude-sonnet-4-5',
    version: '1.0.0'
  });
});

// ════════════════════════════════════════
//   POST /api/chat  — Main chat endpoint
// ════════════════════════════════════════
app.post('/api/chat', rateLimit, async (req, res) => {
  const { message, history = [], systemPrompt } = req.body;

  // ── Validate input ──
  if (!message || typeof message !== 'string' || message.trim().length === 0) {
    return res.status(400).json({ error: 'El campo "message" es requerido y no puede estar vacío.' });
  }

  const cleanMessage = sanitizeString(message);
  const cleanSystem  = sanitizeString(systemPrompt || defaultSystemPrompt(), 8000);

  // ── Build messages array ──
  // Keep last 20 messages to avoid excessive token usage
  const recentHistory = Array.isArray(history)
    ? history.slice(-20).map(m => ({
        role:    m.role === 'assistant' ? 'assistant' : 'user',
        content: sanitizeString(m.content)
      }))
    : [];

  // Ensure the array ends with a user message
  const messages = [
    ...recentHistory,
    { role: 'user', content: cleanMessage }
  ];

  // Remove consecutive same-role messages (Claude API requirement)
  const dedupedMessages = [];
  for (const msg of messages) {
    if (dedupedMessages.length === 0 || dedupedMessages[dedupedMessages.length-1].role !== msg.role) {
      dedupedMessages.push(msg);
    }
  }

  try {
    console.log(`[${new Date().toISOString()}] 📨 Chat request — "${cleanMessage.substring(0,60)}..."`);

    // ── Call Claude API ──
    const response = await anthropic.messages.create({
      model:      'claude-sonnet-4-5',
      max_tokens:  1024,
      system:      cleanSystem,
      messages:    dedupedMessages,
    });

    const assistantText = response.content[0]?.text || '';

    console.log(`[${new Date().toISOString()}] ✅ Response generated — ${response.usage.output_tokens} tokens used`);

    res.json({
      response:    assistantText,
      model:       response.model,
      usage:       response.usage,
      stop_reason: response.stop_reason,
    });

  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ Anthropic API Error:`, err.message);

    // ── Handle specific Anthropic errors ──
    if (err.status === 401) {
      return res.status(401).json({ error: 'API key inválida. Verifica tu ANTHROPIC_API_KEY en el .env' });
    }
    if (err.status === 429) {
      return res.status(429).json({ error: 'Límite de uso de la API alcanzado. Intenta más tarde.' });
    }
    if (err.status === 529) {
      return res.status(503).json({ error: 'Anthropic API sobrecargada temporalmente. Intenta en unos segundos.' });
    }
    if (err.code === 'ENOTFOUND' || err.code === 'ECONNREFUSED') {
      return res.status(503).json({ error: 'No se puede conectar con la API de Anthropic. Verifica tu conexión.' });
    }

    res.status(500).json({
      error: `Error interno del servidor: ${err.message || 'Error desconocido'}`
    });
  }
});

// ════════════════════════════════════════
//   DEFAULT SYSTEM PROMPT (fallback)
// ════════════════════════════════════════
function defaultSystemPrompt() {
  return `Eres un asistente experto en productividad, psicología de hábitos y rendimiento personal.
Ayudas al usuario a mantener y mejorar sus hábitos diarios.
Sus hábitos son: Despertar 6am, Gimnasio, No Porn, Leer/Podcast, Racha Aimlabs, Trabajo en proyecto, No Alcohol, Detox redes sociales, Diario de objetivos, Ducha fría.
Responde siempre en español, de forma directa, empática y concisa. Usa emojis ocasionalmente.`;
}

// ════════════════════════════════════════
//   404 handler
// ════════════════════════════════════════
app.use((req, res) => {
  res.status(404).json({ error: `Ruta no encontrada: ${req.method} ${req.path}` });
});

// ════════════════════════════════════════
//   GLOBAL ERROR HANDLER
// ════════════════════════════════════════
app.use((err, req, res, next) => {
  console.error('Unhandled error:', err);
  res.status(500).json({ error: 'Error interno del servidor.' });
});

// ════════════════════════════════════════
//   START SERVER
// ════════════════════════════════════════
app.listen(PORT, () => {
  console.log('\n⚡ ════════════════════════════════════════');
  console.log('   Habit Tracker Pro — Backend Server');
  console.log('════════════════════════════════════════');
  console.log(`🚀  Servidor corriendo en http://localhost:${PORT}`);
  console.log(`🤖  Modelo: claude-sonnet-4-5`);
  console.log(`🔐  API Key: ${process.env.ANTHROPIC_API_KEY.substring(0,12)}...`);
  console.log(`📡  Endpoint: POST http://localhost:${PORT}/api/chat`);
  console.log(`💚  Health:   GET  http://localhost:${PORT}/health`);
  console.log('════════════════════════════════════════\n');
});

module.exports = app;
