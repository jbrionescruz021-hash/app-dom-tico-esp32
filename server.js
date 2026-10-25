// App Domótico ESP32 — servidor para Render
// - Recibe lecturas del ESP32 (POST /api/readings) y su estado cada pocos segundos (POST /api/device).
// - Guarda las órdenes del dashboard (ventilador, alarma de puerta) y se las entrega a la placa.
// - Sirve el dashboard, instalable como app en el teléfono.
// Guarda en Postgres si existe DATABASE_URL; si no, en memoria (se pierde al reiniciar).

const express = require('express');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json({ limit: '10kb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';          // clave de la placa
const CONTROL_PIN = process.env.CONTROL_PIN || '';  // PIN para usar los interruptores del dashboard
const MAX_EN_MEMORIA = 20000; // ~3.5 días a 1 lectura cada 15 s
const MAX_HORAS = 24 * 7;

let pool = null;
const memoria = [];

// Órdenes del dashboard (lo que el usuario quiere) y estado real que reporta la placa
let control = { fan: false, alarm_armed: false, updated_at: new Date().toISOString() };
let dispositivo = null; // { device, fan_on, alarm_armed, door_open, alarm_triggered, seen_at }

async function iniciarAlmacenamiento() {
  if (!process.env.DATABASE_URL) {
    console.log('Sin DATABASE_URL: guardando datos en memoria.');
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
    CREATE TABLE IF NOT EXISTS control (
      id          INTEGER PRIMARY KEY,
      fan         BOOLEAN     NOT NULL DEFAULT false,
      alarm_armed BOOLEAN     NOT NULL DEFAULT false,
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
    );
    INSERT INTO control (id) VALUES (1) ON CONFLICT (id) DO NOTHING;
  `);
  const { rows } = await pool.query('SELECT fan, alarm_armed, updated_at FROM control WHERE id = 1');
  if (rows[0]) control = rows[0];
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

async function guardarControl(cambios) {
  control = { ...control, ...cambios, updated_at: new Date().toISOString() };
  if (pool) {
    await pool.query('UPDATE control SET fan = $1, alarm_armed = $2, updated_at = now() WHERE id = 1',
      [control.fan, control.alarm_armed]);
  }
  return control;
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

// Comparación en tiempo constante para claves y PIN
function igual(a, b) {
  const x = Buffer.from(String(a || ''));
  const y = Buffer.from(String(b || ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
const esPlaca = (req) => !API_KEY || igual(req.get('x-api-key'), API_KEY);

// Respuesta corta para la placa: lo que debe hacer ahora
const ordenes = () => ({ fan: control.fan, alarm_armed: control.alarm_armed });

function registrarDispositivo(body) {
  const b = (v) => (typeof v === 'boolean' ? v : undefined);
  dispositivo = {
    ...(dispositivo || {}),
    device: String(body.device || dispositivo?.device || 'esp32').slice(0, 64),
    ...(b(body.fan_on) !== undefined && { fan_on: body.fan_on }),
    ...(b(body.alarm_armed) !== undefined && { alarm_armed: body.alarm_armed }),
    ...(b(body.door_open) !== undefined && { door_open: body.door_open }),
    ...(b(body.alarm_triggered) !== undefined && { alarm_triggered: body.alarm_triggered }),
    seen_at: new Date().toISOString(),
  };
}

// ---------- API de la placa ----------

app.post('/api/readings', async (req, res) => {
  if (!esPlaca(req)) return res.status(401).json({ error: 'API key inválida' });

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
    registrarDispositivo(req.body || {});
    const fila = await guardar({ device, temperature, humidity });
    res.status(201).json({ ...fila, control: ordenes() });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar' });
  }
});

// Latido de la placa cada pocos segundos: reporta su estado y recibe las órdenes
app.post('/api/device', (req, res) => {
  if (!esPlaca(req)) return res.status(401).json({ error: 'API key inválida' });
  registrarDispositivo(req.body || {});
  res.json(ordenes());
});

// ---------- API del dashboard ----------

app.get('/api/latest', async (_req, res) => {
  try {
    res.json({
      reading: await ultima(),
      control,
      device: dispositivo,
      control_enabled: Boolean(CONTROL_PIN),
      server_time: new Date().toISOString(),
    });
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

// Comprueba el PIN sin cambiar nada (para desbloquear los interruptores)
app.post('/api/control/check', (req, res) => {
  if (!CONTROL_PIN) return res.status(503).json({ error: 'Falta configurar CONTROL_PIN en Render' });
  if (!igual(req.get('x-control-pin'), CONTROL_PIN)) return res.status(401).json({ error: 'PIN incorrecto' });
  res.json({ ok: true });
});

app.post('/api/control', async (req, res) => {
  if (!CONTROL_PIN) return res.status(503).json({ error: 'Falta configurar CONTROL_PIN en Render' });
  if (!igual(req.get('x-control-pin'), CONTROL_PIN)) return res.status(401).json({ error: 'PIN incorrecto' });

  const cambios = {};
  if (typeof req.body?.fan === 'boolean') cambios.fan = req.body.fan;
  if (typeof req.body?.alarm_armed === 'boolean') cambios.alarm_armed = req.body.alarm_armed;
  if (!Object.keys(cambios).length) return res.status(400).json({ error: 'Nada que cambiar' });

  try {
    res.json(await guardarControl(cambios));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'No se pudo guardar la orden' });
  }
});

app.get('/healthz', (_req, res) => res.send('ok'));

// El service worker no debe quedar en caché para que las actualizaciones lleguen
app.get('/sw.js', (_req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(__dirname, 'public', 'sw.js'));
});

app.use(express.static(path.join(__dirname, 'public')));

iniciarAlmacenamiento()
  .catch((err) => {
    console.error('No se pudo conectar a Postgres, usando memoria:', err.message);
    pool = null;
  })
  .finally(() => {
    app.listen(PORT, () => console.log(`Servidor escuchando en puerto ${PORT}`));
  });
