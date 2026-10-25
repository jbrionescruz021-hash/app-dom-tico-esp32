// App Domótico ESP32 — servidor para Render
// Recibe lecturas del ESP32 (POST /api/readings) y sirve el dashboard.
// Guarda en Postgres si existe DATABASE_URL; si no, en memoria (se pierde al reiniciar).

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.set('trust proxy', 1); // Render está detrás de un proxy: así req.ip es la IP real
app.use(express.json({ limit: '10kb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const MAX_EN_MEMORIA = 20000; // ~3.5 días a 1 lectura cada 15 s
const MAX_HORAS = 24 * 7;

// ---- Control remoto (ventilador y alarma magnética RC-36) ----
const CONTROL_PIN = process.env.CONTROL_PIN || '';   // PIN que protege los switches del dashboard
const OFFLINE_MS = 20000;                            // sin sincronizar en 20 s → ESP32 desconectado
const MAX_FALLOS = 8;                                // intentos de PIN fallidos por IP...
const VENTANA_FALLOS_MS = 10 * 60 * 1000;            // ...dentro de esta ventana

const control = {
  deseado: { fan: false, alarm: 'closed' },          // lo que pide el dashboard
  actual: { fan: null, alarm: null, contact: null }, // lo que reporta el ESP32
  device: null,
  visto: 0,
};
const fallos = new Map();
setInterval(() => {
  const ahora = Date.now();
  for (const [ip, f] of fallos) if (ahora > f.hasta) fallos.delete(ip);
}, VENTANA_FALLOS_MS).unref();

const enLinea = () => control.visto > 0 && Date.now() - control.visto <= OFFLINE_MS;

function estadoPublico() {
  return {
    desired: control.deseado,
    actual: control.actual,
    device: control.device,
    online: enLinea(),
    controls_enabled: Boolean(CONTROL_PIN),
    server_time: new Date().toISOString(),
  };
}

function pinCorrecto(recibido) {
  const h = (v) => crypto.createHash('sha256').update(String(v)).digest();
  return crypto.timingSafeEqual(h(recibido), h(CONTROL_PIN));
}

function bloqueado(ip) {
  const f = fallos.get(ip);
  if (!f) return false;
  if (Date.now() > f.hasta) { fallos.delete(ip); return false; }
  return f.n >= MAX_FALLOS;
}

function registrarFallo(ip) {
  const f = fallos.get(ip);
  if (!f || Date.now() > f.hasta) fallos.set(ip, { n: 1, hasta: Date.now() + VENTANA_FALLOS_MS });
  else f.n++;
}

let pool = null;
const memoria = [];

async function iniciarAlmacenamiento() {
  if (!process.env.DATABASE_URL) {
    console.log('Sin DATABASE_URL: guardando lecturas en memoria.');
    return;
  }
  const { Pool } = require('pg');
  pool = new Pool({ connectionString: process.env.DATABASE_URL });
  await pool.query(`
    CREATE TABLE IF NOT EXISTS readings (
      id          SERIAL PRIMARY KEY,
      device      TEXT        NOT NULL,
      temperature REAL        NOT NULL,
      humidity    REAL        NOT NULL,
      created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    CREATE INDEX IF NOT EXISTS readings_created_at_idx ON readings (created_at);
  `);
  console.log('Postgres listo.');
}

async function guardar(lectura) {
  if (pool) {
    const { rows } = await pool.query(
      'INSERT INTO readings (device, temperature, humidity) VALUES ($1, $2, $3) RETURNING created_at',
      [lectura.device, lectura.temperature, lectura.humidity]
    );
    return { ...lectura, created_at: rows[0].created_at };
  }
  const fila = { ...lectura, created_at: new Date().toISOString() };
  memoria.push(fila);
  if (memoria.length > MAX_EN_MEMORIA) memoria.shift();
  return fila;
}

async function ultima() {
  if (pool) {
    const { rows } = await pool.query(
      'SELECT device, temperature, humidity, created_at FROM readings ORDER BY created_at DESC LIMIT 1'
    );
    return rows[0] || null;
  }
  return memoria[memoria.length - 1] || null;
}

async function historial(horas) {
  const desde = new Date(Date.now() - horas * 3600 * 1000);
  if (pool) {
    const { rows } = await pool.query(
      `SELECT device, temperature, humidity, created_at
         FROM readings WHERE created_at >= $1
        ORDER BY created_at ASC LIMIT 50000`,
      [desde]
    );
    return rows;
  }
  return memoria.filter((r) => new Date(r.created_at) >= desde);
}

// Reduce la cantidad de puntos para que la gráfica no se vuelva pesada
function reducir(filas, maxPuntos = 600) {
  if (filas.length <= maxPuntos) return filas;
  const tam = Math.ceil(filas.length / maxPuntos);
  const salida = [];
  for (let i = 0; i < filas.length; i += tam) {
    const grupo = filas.slice(i, i + tam);
    const prom = (k) => grupo.reduce((s, r) => s + Number(r[k]), 0) / grupo.length;
    salida.push({
      device: grupo[0].device,
      temperature: Math.round(prom('temperature') * 10) / 10,
      humidity: Math.round(prom('humidity') * 10) / 10,
      created_at: grupo[grupo.length - 1].created_at,
    });
  }
  return salida;
}

// ---------- API ----------

app.post('/api/readings', async (req, res) => {
  if (API_KEY && req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }

  const temperature = Number(req.body?.temperature);
  const humidity = Number(req.body?.humidity);
  const device = String(req.body?.device || 'esp32').slice(0, 64);

  // Rango amplio alrededor de lo que mide el DHT11 (0–50 °C, 20–90 %)
  if (!Number.isFinite(temperature) || temperature < -20 || temperature > 80) {
    return res.status(400).json({ error: 'temperature fuera de rango' });
  }
  if (!Number.isFinite(humidity) || humidity < 0 || humidity > 100) {
    return res.status(400).json({ error: 'humidity fuera de rango' });
  }

  try {
    const fila = await guardar({ device, temperature, humidity });
    res.status(201).json(fila);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});

app.get('/api/latest', async (_req, res) => {
  try {
    res.json({ reading: await ultima(), server_time: new Date().toISOString() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error leyendo datos' });
  }
});

app.get('/api/readings', async (req, res) => {
  const horas = Math.min(Math.max(Number(req.query.hours) || 24, 0.25), MAX_HORAS);
  try {
    const filas = await historial(horas);
    res.json({ hours: horas, count: filas.length, readings: reducir(filas) });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Error leyendo datos' });
  }
});

// El ESP32 llama aquí cada pocos segundos: reporta su estado real y recibe el estado deseado.
app.post('/api/sync', (req, res) => {
  if (API_KEY && req.get('x-api-key') !== API_KEY) {
    return res.status(401).json({ error: 'API key inválida' });
  }
  const b = req.body || {};
  control.device = String(b.device || 'esp32').slice(0, 64);
  control.actual = {
    fan: typeof b.fan === 'boolean' ? b.fan : null,
    alarm: b.alarm === 'open' || b.alarm === 'closed' ? b.alarm : null,
    contact: b.contact === 'open' || b.contact === 'closed' ? b.contact : null,
  };
  control.visto = Date.now();
  res.json({ fan: control.deseado.fan, alarm: control.deseado.alarm });
});

// Estado de los switches (lo lee el dashboard)
app.get('/api/state', (_req, res) => res.json(estadoPublico()));

// El dashboard envía aquí las órdenes. Requiere el PIN en el header x-control-pin.
// Body: { fan: true|false, alarm: 'open'|'closed' } (cualquiera de los dos). Con body vacío solo verifica el PIN.
app.post('/api/control', (req, res) => {
  if (!CONTROL_PIN) {
    return res.status(503).json({ error: 'Controles deshabilitados: define la variable CONTROL_PIN en el servidor.' });
  }
  if (bloqueado(req.ip)) {
    return res.status(429).json({ error: 'Demasiados intentos fallidos. Espera unos minutos.' });
  }
  if (!pinCorrecto(req.get('x-control-pin') || '')) {
    registrarFallo(req.ip);
    return res.status(401).json({ error: 'PIN incorrecto' });
  }
  fallos.delete(req.ip);

  const { fan, alarm } = req.body || {};
  const hayFan = fan !== undefined;
  const hayAlarm = alarm !== undefined;
  if (!hayFan && !hayAlarm) return res.json(estadoPublico()); // solo verificación del PIN

  if (hayFan && typeof fan !== 'boolean') {
    return res.status(400).json({ error: 'fan debe ser true o false' });
  }
  if (hayAlarm && alarm !== 'open' && alarm !== 'closed') {
    return res.status(400).json({ error: "alarm debe ser 'open' o 'closed'" });
  }
  // Seguridad: no dejamos órdenes en cola; si el ESP32 está caído, el comando se rechaza.
  if (!enLinea()) {
    return res.status(409).json({ error: 'El ESP32 está sin conexión; no se envió el comando.' });
  }
  if (hayFan) control.deseado.fan = fan;
  if (hayAlarm) control.deseado.alarm = alarm;
  res.json(estadoPublico());
});

app.get('/healthz', (_req, res) => res.send('ok'));

app.use(express.static(path.join(__dirname, 'public')));

iniciarAlmacenamiento()
  .catch((err) => {
    console.error('No se pudo conectar a Postgres, usando memoria:', err.message);
    pool = null;
  })
  .finally(() => {
    app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
  });
