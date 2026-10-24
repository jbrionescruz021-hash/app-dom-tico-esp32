# App Domótico · ESP32 + DHT11

Dashboard web para ver en tiempo real la temperatura y humedad que mide un **ESP32 físico** con sensor **DHT11**. El ESP32 envía las lecturas a un servidor en **Render**, que las guarda y las muestra en una página web.

```
[DHT11] → [ESP32] --HTTPS POST--> [Servidor en Render] → [Dashboard web]
```

## Estructura

```
├── firmware/esp32_dht11/
│   ├── esp32_dht11.ino      # Código del ESP32
│   └── config.example.h     # Plantilla de claves (copiar como config.h)
├── public/index.html        # Dashboard
├── server.js                # API + servidor web (Node/Express)
├── package.json
└── render.yaml              # Configuración de despliegue en Render
```

## 1. Conexión del DHT11 al ESP32

| DHT11 | ESP32 |
|-------|-------|
| VCC (+) | 3V3 |
| DATA (out) | GPIO 4 |
| GND (−) | GND |

- Si usas el **módulo** de 3 pines (en placa azul), ya trae la resistencia pull-up.
- Si es el **sensor suelto de 4 pines**, pon una resistencia de **10 kΩ entre DATA y VCC**. El pin 3 queda sin conectar.
- Para usar otro pin, cambia `#define DHTPIN 4` en `esp32_dht11.ino`.

### Cambios respecto al DHT22
- `#define DHTTYPE DHT11` (antes `DHT22`).
- Rango del DHT11: **0–50 °C** y **20–90 % HR**, en pasos de 1 unidad. El dashboard ya está ajustado a ese rango.

## 2. Desplegar el servidor en Render

1. En [render.com](https://render.com): **New → Blueprint** y elige este repositorio. Render lee `render.yaml` y crea el servicio.
2. Cuando termine, copia la URL del servicio (algo como `https://app-domotico-esp32.onrender.com`).
3. En el servicio, ve a **Environment** y copia el valor de `API_KEY` (Render lo genera solo).

> **Plan gratuito:** el servicio se duerme tras ~15 min sin tráfico y tarda ~30-50 s en despertar. Mientras el ESP32 esté enviando datos, se mantiene activo. Sin base de datos, el historial se borra cuando el servicio se reinicia.

### Opcional: historial permanente
Crea una base **Postgres** en Render (**New → PostgreSQL**), copia su *Internal Database URL* y agrégala al servicio web como variable `DATABASE_URL`. El servidor crea la tabla automáticamente.

## 3. Cargar el código al ESP32

1. Instala en Arduino IDE el soporte para ESP32 (*Boards Manager → esp32 de Espressif*).
2. Instala las librerías **DHT sensor library** y **Adafruit Unified Sensor** (Adafruit).
3. En `firmware/esp32_dht11/`, copia `config.example.h` como **`config.h`** y llena:
   - `WIFI_SSID` y `WIFI_PASSWORD` (red de 2.4 GHz)
   - `SERVER_URL` → `https://TU-SERVICIO.onrender.com/api/readings`
   - `API_KEY` → la de Render
4. Selecciona la placa (*ESP32 Dev Module*), el puerto y sube el código.
5. Abre el Monitor Serie a **115200** baudios. Deberías ver las lecturas y `Servidor respondió 201`.

`config.h` está en `.gitignore`, así que tus claves no se suben a GitHub.

## API

| Método | Ruta | Descripción |
|--------|------|-------------|
| `POST` | `/api/readings` | Recibe `{ device, temperature, humidity }`. Requiere header `x-api-key`. |
| `GET` | `/api/latest` | Última lectura. |
| `GET` | `/api/readings?hours=24` | Historial (máx. 168 h). |
| `GET` | `/healthz` | Estado del servidor. |

## Probar en tu computadora

```bash
npm install
API_KEY=prueba npm start
# en otra terminal:
curl -X POST http://localhost:3000/api/readings \
  -H "Content-Type: application/json" -H "x-api-key: prueba" \
  -d '{"device":"esp32-sala","temperature":27,"humidity":61}'
```
Luego abre http://localhost:3000
