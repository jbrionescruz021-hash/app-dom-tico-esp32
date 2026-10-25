# App Domótico · ESP32 + DHT11

Dashboard web (instalable como app) para ver en tiempo real la temperatura y humedad que mide un **ESP32 físico** con sensor **DHT11**, y para **encender/apagar un ventilador** y **abrir/cerrar la alarma magnética RC-36** desde un switch.

```
[DHT11] → [ESP32] --HTTPS POST--> [Servidor en Render] → [Dashboard web / app]
[Ventilador]  ← [Relé 1] ←┐                              ↑ switches (protegidos con PIN)
[Alarma RC-36] ← [Relé 2] ←┴─ [ESP32] ←-- consulta cada 3 s ┘
```

## Estructura

```
├── firmware/esp32_dht11/
│   ├── esp32_dht11.ino      # Código del ESP32
│   └── config.example.h     # Plantilla de claves (copiar como config.h)
├── public/index.html        # Dashboard
├── server.js                # API + servidor web (Node/Express)
├── package.json
├── public/manifest.webmanifest, sw.js, icons/   # Para instalar el dashboard como app
├── public/downloads/        # (opcional) aquí va app-domotico.apk
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

### Ventilador y alarma magnética (relés)

| Componente | ESP32 |
|------------|-------|
| Relé 1 (ventilador) · IN | GPIO 26 |
| Relé 2 (alarma magnética) · IN | GPIO 27 |
| Contacto RC-36 (un cable) | GPIO 25 |
| Contacto RC-36 (otro cable) | GND |
| Módulos de relé · VCC / GND | 5 V (VIN) / GND |

- El switch **Ventilador** activa el relé 1: conecta el ventilador por los bornes **COM** y **NO** del relé.
- El switch **Alarma magnética · RC-36** activa el relé 2: relé activo = **Abierta**, relé en reposo = **Cerrada**. Conecta el circuito de la alarma por **COM** y **NO** (o **NC** si lo necesitas invertido).
- El RC-36 se lee como entrada con `INPUT_PULLUP` y el dashboard muestra si el contacto está *abierto* o *cerrado*. Si lo ves invertido, cambia `RC36_CLOSED_LEVEL` en el `.ino`.
- Si tu módulo de relé se activa con nivel alto, cambia `RELAY_ACTIVE_LOW` a `false`.
- Si el ventilador o la alarma trabajan con corriente de red (110/220 V), hazlo con el equipo desenergizado y las conexiones aisladas.

### Cambios respecto al DHT22
- `#define DHTTYPE DHT11` (antes `DHT22`).
- Rango del DHT11: **0–50 °C** y **20–90 % HR**, en pasos de 1 unidad. El dashboard ya está ajustado a ese rango.

## 2. Desplegar el servidor en Render

1. En [render.com](https://render.com): **New → Blueprint** y elige este repositorio. Render lee `render.yaml` y crea el servicio.
2. Cuando termine, copia la URL del servicio (algo como `https://app-domotico-esp32.onrender.com`).
3. En el servicio, ve a **Environment** y copia el valor de `API_KEY` (Render lo genera solo).
4. Define `CONTROL_PIN` (si el Blueprint no te lo pidió, agrégalo en **Environment**): es el PIN que el dashboard pide para operar los switches. **Sin este PIN los switches quedan deshabilitados** por seguridad.

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
| `POST` | `/api/sync` | Lo usa el ESP32 cada 3 s: reporta `{ device, fan, alarm, contact }` y recibe el estado pedido. Requiere `x-api-key`. |
| `GET` | `/api/state` | Estado de los switches (pedido y real) y si el ESP32 está en línea. |
| `POST` | `/api/control` | Dashboard → `{ fan: true\|false, alarm: 'open'\|'closed' }`. Requiere header `x-control-pin`. |
| `GET` | `/api/latest` | Última lectura. |
| `GET` | `/api/readings?hours=24` | Historial (máx. 168 h). |
| `GET` | `/healthz` | Estado del servidor. |

## Instalar el dashboard como app

El dashboard es una **PWA**: en el botón **Descargar app** (arriba a la derecha y al final de la página) se instala en Android, Windows, macOS y ChromeOS. En iPhone/iPad: Safari → Compartir → *Añadir a pantalla de inicio*.

### Opcional: archivo APK para Android
1. Entra a [pwabuilder.com](https://www.pwabuilder.com), pega la URL de tu servicio en Render y genera el paquete **Android**.
2. Renombra el APK a `app-domotico.apk` y colócalo en `public/downloads/`.
3. Haz commit y push: el botón **Descargar APK (Android)** aparece solo cuando el archivo existe.

## Notas de funcionamiento
- Si el ESP32 está sin conexión, los switches se bloquean y el servidor rechaza órdenes (no se dejan comandos en cola que se ejecuten después).
- El estado de los switches vive en memoria: si Render reinicia el servicio, vuelve a *ventilador apagado / alarma cerrada*.
- Tras 8 PINes incorrectos desde la misma IP, el servidor bloquea los intentos por 10 minutos.

## Probar en tu computadora

```bash
npm install
API_KEY=prueba CONTROL_PIN=1234 npm start
# en otra terminal:
curl -X POST http://localhost:3000/api/readings \
  -H "Content-Type: application/json" -H "x-api-key: prueba" \
  -d '{"device":"esp32-sala","temperature":27,"humidity":61}'
```
Luego abre http://localhost:3000
