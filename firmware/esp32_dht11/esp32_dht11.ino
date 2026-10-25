/*
  App Domótico ESP32 — Sensor DHT11 + ventilador + alarma magnética RC-36
  ----------------------------------------------------------------------
  - Lee temperatura y humedad del DHT11 y las envía por HTTPS
    al servidor desplegado en Render, que las muestra en el dashboard.
  - Cada pocos segundos consulta al servidor (POST /api/sync) para saber si
    el dashboard pidió encender/apagar el ventilador o abrir/cerrar la
    alarma magnética, y activa los relés correspondientes.
  - Lee el contacto RC-36 (reed) y reporta si está abierto o cerrado.

  Conexión (todos los relés de 5 V):
    Relé del ventilador (módulo de 1 canal, independiente):
      VCC → VIN/5V · GND → GND · IN → GPIO 26
    Relé de la alarma (módulo de 2 canales SRD-05VDC-SL-C, se usa el canal 1):
      VCC → VIN/5V · GND → GND · IN1 → GPIO 27   (IN2 queda libre)
    DHT11 DATA  → GPIO 4  (VCC → 3V3, GND → GND)
    RC-36 (aviso de estado): un cable → GPIO 25, el otro → GND

  Contactos de cada relé (lado de carga):
    COM = común, NO = abierto en reposo, NC = cerrado en reposo.
    Alarma: relé activo = ABIERTA, relé en reposo = CERRADA.
*/

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include "DHT.h"
#include "config.h"

// ---------- Sensor ----------
#define DHTPIN   4        // GPIO donde está conectado DATA del DHT11
#define DHTTYPE  DHT11    // Antes era DHT22
DHT dht(DHTPIN, DHTTYPE);

// ---------- Salidas / entradas de control ----------
#define FAN_PIN    26     // Módulo de 1 canal: ventilador
#define ALARM_PIN  27     // Módulo de 2 canales (canal 1): alarma magnética (relé activo = ABIERTA)
#define RC36_PIN   25     // Contacto magnético RC-36 (con INPUT_PULLUP, al otro lado va GND)

// Cada módulo de relé puede ser distinto. La mayoría se activa con nivel BAJO (LOW).
// Si un relé se activa con HIGH, pon false en el que corresponda.
#define FAN_RELAY_ACTIVE_LOW    true   // módulo de 1 canal (ventilador)
#define ALARM_RELAY_ACTIVE_LOW  true   // módulo de 2 canales (alarma)

// Nivel que lee el pin cuando el RC-36 está CERRADO (imán cerca / puerta cerrada).
// Con contacto normalmente cerrado y cableado a GND es LOW. Si ves el estado invertido, cámbialo a HIGH.
#define RC36_CLOSED_LEVEL LOW

bool fanOn = false;
bool alarmaAbierta = false;

void setRele(uint8_t pin, bool activo, bool activoBajo) {
  digitalWrite(pin, (activo != activoBajo) ? HIGH : LOW);
}

const char* leerContacto() {
  return digitalRead(RC36_PIN) == RC36_CLOSED_LEVEL ? "closed" : "open";
}

// ---------- Tiempos ----------
const unsigned long INTERVALO_ENVIO_MS = 15000;  // lectura del DHT11 cada 15 s
const unsigned long INTERVALO_SYNC_MS  = 3000;   // órdenes del dashboard cada 3 s
const unsigned long TIMEOUT_WIFI_MS    = 20000;
unsigned long ultimoEnvio = 0;
unsigned long ultimoSync  = 0;

// LED integrado (la mayoría de placas ESP32 DevKit lo tienen en GPIO 2)
#define LED_PIN 2

void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("Conectando a Wi-Fi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < TIMEOUT_WIFI_MS) {
    delay(500);
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConectado. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nNo se pudo conectar. Se reintentará en el próximo ciclo.");
  }
}

bool enviarLectura(float temperatura, float humedad) {
  WiFiClientSecure client;
  // Render usa HTTPS. Para simplificar no validamos el certificado.
  client.setInsecure();

  HTTPClient http;
  // El plan gratuito de Render "despierta" en ~30-50 s, por eso el timeout amplio
  http.setTimeout(60000);

  if (!http.begin(client, SERVER_URL)) {
    Serial.println("No se pudo iniciar la conexión HTTP");
    return false;
  }

  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  char cuerpo[128];
  snprintf(cuerpo, sizeof(cuerpo),
           "{\"device\":\"%s\",\"temperature\":%.1f,\"humidity\":%.1f}",
           DEVICE_ID, temperatura, humedad);

  int codigo = http.POST(cuerpo);
  if (codigo > 0) {
    Serial.printf("Servidor respondió %d\n", codigo);
  } else {
    Serial.printf("Error al enviar: %s\n", http.errorToString(codigo).c_str());
  }
  http.end();
  return codigo == 201;
}

// Reporta el estado real al servidor y aplica el estado que pide el dashboard.
void sincronizar() {
  String url = SERVER_URL;
  url.replace("/api/readings", "/api/sync");

  WiFiClientSecure client;
  client.setInsecure();

  HTTPClient http;
  http.setTimeout(15000);
  if (!http.begin(client, url)) {
    Serial.println("Sync: no se pudo iniciar la conexión HTTP");
    return;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  char cuerpo[160];
  snprintf(cuerpo, sizeof(cuerpo),
           "{\"device\":\"%s\",\"fan\":%s,\"alarm\":\"%s\",\"contact\":\"%s\"}",
           DEVICE_ID, fanOn ? "true" : "false",
           alarmaAbierta ? "open" : "closed", leerContacto());

  int codigo = http.POST(cuerpo);
  if (codigo == 200) {
    String r = http.getString();   // {"fan":true,"alarm":"open"}
    bool nuevoFan    = r.indexOf("\"fan\":true") >= 0;
    bool nuevoAlarma = r.indexOf("\"alarm\":\"open\"") >= 0;

    if (nuevoFan != fanOn) {
      fanOn = nuevoFan;
      setRele(FAN_PIN, fanOn, FAN_RELAY_ACTIVE_LOW);
      Serial.printf("Ventilador: %s\n", fanOn ? "ENCENDIDO" : "APAGADO");
    }
    if (nuevoAlarma != alarmaAbierta) {
      alarmaAbierta = nuevoAlarma;
      setRele(ALARM_PIN, alarmaAbierta, ALARM_RELAY_ACTIVE_LOW);
      Serial.printf("Alarma magnética: %s\n", alarmaAbierta ? "ABIERTA" : "CERRADA");
    }
  } else if (codigo > 0) {
    Serial.printf("Sync: servidor respondió %d\n", codigo);
  } else {
    Serial.printf("Sync: error %s\n", http.errorToString(codigo).c_str());
  }
  http.end();
}

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);

  // Primero el nivel de reposo y luego OUTPUT, para que los relés no den un pulso al arrancar
  setRele(FAN_PIN, false, FAN_RELAY_ACTIVE_LOW);
  setRele(ALARM_PIN, false, ALARM_RELAY_ACTIVE_LOW);
  pinMode(FAN_PIN, OUTPUT);
  pinMode(ALARM_PIN, OUTPUT);
  pinMode(RC36_PIN, INPUT_PULLUP);

  dht.begin();
  Serial.println("\n== App Domótico ESP32 — DHT11 + ventilador + alarma RC-36 ==");
  conectarWiFi();
}

void leerYEnviarDHT() {
  float humedad = dht.readHumidity();
  float temperatura = dht.readTemperature();  // °C

  if (isnan(humedad) || isnan(temperatura)) {
    Serial.println("Lectura inválida del DHT11 (revisa cableado y pull-up)");
    return;
  }

  Serial.printf("Temp: %.1f °C | Humedad: %.1f %%\n", temperatura, humedad);

  if (WiFi.status() != WL_CONNECTED) return;

  digitalWrite(LED_PIN, HIGH);
  enviarLectura(temperatura, humedad);
  digitalWrite(LED_PIN, LOW);
}

void loop() {
  unsigned long ahora = millis();

  if (WiFi.status() != WL_CONNECTED) {
    conectarWiFi();
    if (WiFi.status() != WL_CONNECTED) { delay(1000); return; }
  }

  if (ultimoSync == 0 || ahora - ultimoSync >= INTERVALO_SYNC_MS) {
    ultimoSync = millis();
    sincronizar();
  }

  if (ultimoEnvio == 0 || millis() - ultimoEnvio >= INTERVALO_ENVIO_MS) {
    ultimoEnvio = millis();
    leerYEnviarDHT();
  }

  delay(50);
}
