# App Domótico · ESP32 + DHT11

Dashboard web, instalable como app en el teléfono, para un **ESP32 físico** con:
- sensor **DHT11** (temperatura y humedad),
- **ventilador** controlado por un módulo de relé,
- **alarma de puerta** con sensor magnético **MC-38** y zumbador.

```
[DHT11, MC-38] → [ESP32] ⇄ HTTPS ⇄ [Servidor en Render] ⇄ [Dashboard / app]
                    ↓
          [Relé → ventilador, zumbador]
```

La placa envía las lecturas del DHT11 cada 15 s y cada 3 s reporta su estado (puerta, ventilador, alarma) y recibe las órdenes del dashboard. La alarma funciona en la propia placa: si está armada y la puerta se abre, el zumbador suena aunque no haya Internet.

## Estructura

```
├── firmware/esp32_dht11/
│   ├── esp32_dht11.ino      # Código del ESP32
│   └── config.example.h     # Plantilla de claves (copiar como config.h)
├── public/
│   ├── index.html           # Dashboard
│   ├── manifest.webmanifest # Datos de la app instalable
│   ├── sw.js                # Service worker (permite instalarla)
│   └── icons/               # Íconos de la app
├── server.js                # API + servidor web (Node/Express)
├── package.json
└── render.yaml              # Configuración de despliegue en Render
```

## 1. Conexiones

| Componente | Pin del componente | ESP32 |
|---|---|---|
| DHT11 | VCC (+) | 3V3 |
| DHT11 | DATA | GPIO 4 |
| DHT11 | GND (−) | GND |
| Módulo de relé 5 V | VCC | VIN (5 V) |
| Módulo de relé 5 V | GND | GND |
| Módulo de relé 5 V | IN | GPIO 26 |
| Sensor MC-38 | Cable 1 | GPIO 27 |
| Sensor MC-38 | Cable 2 | GND |
| Zumbador | + | GPIO 25 |
| Zumbador | − | GND |

- El MC-38 no necesita resistencia: el programa activa la resistencia interna (pull-up) del GPIO 27. Con el imán junto al sensor la puerta se lee **cerrada**; al separarlo, **abierta**.
- Si el relé se activa al revés (enciende cuando debería apagar), cambia `RELAY_ACTIVO_EN_BAJO` a `false` en el `.ino`.
- El ventilador de 120 V se conecta a los contactos **COM** y **NO** del relé, con su fusible. Haz esa parte con el equipo desconectado de la corriente.
- Para cambiar cualquier pin, edita los `#define` al inicio del `.ino` y el texto de las tarjetas en `public/index.html`.

## 2. Servidor en Render

1. **New → Blueprint** y elige este repositorio. Render lee `render.yaml`.
2. En el servicio, ve a **Environment**:
   - Copia el valor de `API_KEY` (lo genera Render).
   - Agrega **`CONTROL_PIN`** con el PIN que quieran usar para los interruptores (por ejemplo 4 a 6 dígitos). Sin este PIN los interruptores quedan bloqueados para todos.
3. Guarda los cambios; Render vuelve a desplegar solo.

> **Plan gratuito:** el servicio se duerme tras ~15 min sin tráfico. Mientras la placa esté conectada se mantiene activo. Sin base de datos, el historial se borra cuando el servicio se reinicia; para guardarlo, crea una **PostgreSQL** en Render y agrega su *Internal Database URL* como `DATABASE_URL`.

## 3. Cargar el código al ESP32

1. Instala en Arduino IDE el soporte **esp32 de Espressif** (versión 2.0 o superior) y las librerías **DHT sensor library** y **Adafruit Unified Sensor**.
2. Copia `config.example.h` como **`config.h`** y llena:
   - `WIFI_SSID` y `WIFI_PASSWORD` (red de 2.4 GHz)
   - `SERVER_BASE_URL` → `https://TU-SERVICIO.onrender.com` (sin `/api/...` al final)
   - `API_KEY` → la de Render
3. Placa **ESP32 Dev Module**, puerto correcto y **Subir**.
4. Monitor Serie a **115200**: verás las lecturas, `Servidor respondió 201`, y mensajes como `Puerta ABIERTA` o `Ventilador ENCENDIDO (orden del dashboard)`.

## 4. Usar el dashboard

- **Interruptores:** escribe el PIN en la sección *Control* y pulsa **Desbloquear** (se recuerda en ese teléfono o computadora). Cada interruptor muestra si la placa ya confirmó la orden; tarda unos 3 segundos.
- **Ventilador:** enciende o apaga el relé.
- **Alarma de puerta:** arma o desarma la vigilancia. El dashboard muestra siempre si la puerta está abierta o cerrada. Si la alarma está armada y la puerta se abre, la tarjeta se marca en rojo; desarmarla silencia el zumbador.

## 5. Instalar la app en el teléfono

- **Android (Chrome):** pulsa **Instalar app** en el dashboard, o menú **⋮ → Instalar app**.
- **iPhone (Safari):** botón **Compartir → Agregar a pantalla de inicio**.
- **Computadora (Chrome o Edge):** ícono de instalar en la barra de direcciones.

La app abre el mismo dashboard a pantalla completa, con su propio ícono.

## API

| Método | Ruta | Quién | Descripción |
|---|---|---|---|
| `POST` | `/api/readings` | Placa (`x-api-key`) | Lectura `{temperature, humidity}` + estado. Responde las órdenes. |
| `POST` | `/api/device` | Placa (`x-api-key`) | Estado `{fan_on, alarm_armed, door_open, alarm_triggered}`. Responde `{fan, alarm_armed}`. |
| `GET` | `/api/latest` | Dashboard | Última lectura, órdenes y estado de la placa. |
| `GET` | `/api/readings?hours=24` | Dashboard | Historial (máx. 168 h). |
| `POST` | `/api/control` | Dashboard (`x-control-pin`) | Cambia `{fan}` y/o `{alarm_armed}`. |
| `POST` | `/api/control/check` | Dashboard (`x-control-pin`) | Verifica el PIN. |
| `GET` | `/healthz` | — | Estado del servidor. |

## Probar en tu computadora

```bash
npm install
API_KEY=prueba CONTROL_PIN=1234 npm start
# simular la placa:
curl -X POST http://localhost:3000/api/readings \
  -H "Content-Type: application/json" -H "x-api-key: prueba" \
  -d '{"device":"esp32-sala","temperature":27,"humidity":61,"door_open":false,"fan_on":false,"alarm_armed":false,"alarm_triggered":false}'
```
Luego abre http://localhost:3000
