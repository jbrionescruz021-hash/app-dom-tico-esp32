// App Domótico ESP32 — servidor para Render
// Recibe lecturas del ESP32 (POST /api/readings) y sirve el dashboard.
// Guarda en Postgres si existe DATABASE_URL; si no, en memoria (se pierde al reiniciar).

const express = require('express');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10kb' }));

const PORT = process.env.PORT || 3000;
const API_KEY = process.env.API_KEY || '';
const MAX_EN_MEMORIA = 20000; // ~3.5 días a 1 lectura cada 15 s
const MAX_HORAS = 24 * 7;

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
