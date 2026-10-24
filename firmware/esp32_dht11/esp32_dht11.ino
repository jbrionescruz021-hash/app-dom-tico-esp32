/*
  App Domótico ESP32 — Sensor DHT11
  ----------------------------------
  Lee temperatura y humedad del DHT11 y las envía por HTTPS
  al servidor desplegado en Render, que las muestra en el dashboard.

  Librerías necesarias (Arduino IDE → Gestor de librerías):
    - "DHT sensor library" de Adafruit
    - "Adafruit Unified Sensor" de Adafruit

  Antes de compilar: copia config.example.h como config.h
  y llena tus datos de Wi-Fi, URL del servidor y API key.
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

// ---------- Tiempos ----------
const unsigned long INTERVALO_ENVIO_MS = 15000;  // cada 15 s
const unsigned long TIMEOUT_WIFI_MS    = 20000;
unsigned long ultimoEnvio = 0;

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

void setup() {
  Serial.begin(115200);
  delay(200);
  pinMode(LED_PIN, OUTPUT);
  dht.begin();
  Serial.println("\n== App Domótico ESP32 — DHT11 ==");
  conectarWiFi();
}

void loop() {
  if (millis() - ultimoEnvio < INTERVALO_ENVIO_MS && ultimoEnvio != 0) return;
  ultimoEnvio = millis();

  float humedad = dht.readHumidity();
  float temperatura = dht.readTemperature();  // °C

  if (isnan(humedad) || isnan(temperatura)) {
    Serial.println("Lectura inválida del DHT11 (revisa cableado y pull-up)");
    return;
  }

  Serial.printf("Temp: %.1f °C | Humedad: %.1f %%\n", temperatura, humedad);

  conectarWiFi();
  if (WiFi.status() != WL_CONNECTED) return;

  digitalWrite(LED_PIN, HIGH);
  enviarLectura(temperatura, humedad);
  digitalWrite(LED_PIN, LOW);
}
