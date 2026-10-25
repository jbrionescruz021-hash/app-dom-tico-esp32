/*
  App Domótico ESP32 — DHT11, ventilador y alarma de puerta
  ----------------------------------------------------------
  - Lee temperatura y humedad del DHT11 y las envía al servidor cada 15 s.
  - Cada 3 s envía su estado (puerta, ventilador, alarma) y recibe las
    órdenes del dashboard: encender/apagar el ventilador y armar/desarmar
    la alarma de la puerta.
  - La alarma funciona en la placa: si está armada y la puerta se abre,
    suena el zumbador aunque no haya Internet.

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

// ---------- Pines ----------
#define DHTPIN       4    // DATA del DHT11
#define DHTTYPE      DHT11
#define RELAY_PIN    26   // IN del módulo de relé (ventilador)
#define DOOR_PIN     27   // Sensor magnético MC-38 (el otro cable va a GND)
#define BUZZER_PIN   25   // Zumbador de la alarma
#define LED_PIN      2    // LED integrado: parpadea al comunicarse

// La mayoría de módulos de relé de 5 V se activan con nivel BAJO.
// Si tu relé hace lo contrario, cambia a false.
const bool RELAY_ACTIVO_EN_BAJO = true;

DHT dht(DHTPIN, DHTTYPE);

// ---------- Tiempos ----------
const unsigned long INTERVALO_LECTURA_MS = 15000;  // lecturas del DHT11
const unsigned long INTERVALO_LATIDO_MS  = 3000;   // estado y órdenes
const unsigned long TIMEOUT_WIFI_MS      = 20000;
unsigned long ultimaLectura = 0;
unsigned long ultimoLatido  = 0;

// ---------- Estado ----------
bool ventiladorEncendido = false;
bool alarmaArmada        = false;
bool alarmaDisparada     = false;
bool puertaAbierta       = false;
bool enviarYa            = false;   // forzar latido inmediato (cambio de puerta)

WiFiClientSecure clienteSeguro;

// ---------- Actuadores ----------
void aplicarVentilador(bool encender) {
  ventiladorEncendido = encender;
  bool nivel = RELAY_ACTIVO_EN_BAJO ? !encender : encender;
  digitalWrite(RELAY_PIN, nivel ? HIGH : LOW);
}

void aplicarAlarma(bool armar) {
  if (armar == alarmaArmada) return;
  alarmaArmada = armar;
  if (!armar) {                 // al desarmar se apaga el zumbador
    alarmaDisparada = false;
    noTone(BUZZER_PIN);
  }
  Serial.printf("Alarma %s\n", armar ? "ARMADA" : "desarmada");
}

void actualizarZumbador() {
  if (!alarmaDisparada) return;
  // Pitido intermitente: 300 ms sonando, 300 ms en silencio
  if ((millis() / 300) % 2 == 0) tone(BUZZER_PIN, 2200);
  else noTone(BUZZER_PIN);
}

void leerPuerta() {
  static bool lecturaAnterior = false;
  static unsigned long cambioDesde = 0;

  // Con INPUT_PULLUP: imán cerca (puerta cerrada) = LOW; puerta abierta = HIGH
  bool abierta = digitalRead(DOOR_PIN) == HIGH;
  if (abierta != lecturaAnterior) {
    lecturaAnterior = abierta;
    cambioDesde = millis();
  }
  // Antirrebote de 50 ms
  if (millis() - cambioDesde > 50 && abierta != puertaAbierta) {
    puertaAbierta = abierta;
    Serial.printf("Puerta %s\n", abierta ? "ABIERTA" : "cerrada");
    if (abierta && alarmaArmada && !alarmaDisparada) {
      alarmaDisparada = true;
      Serial.println("¡ALARMA DISPARADA!");
    }
    enviarYa = true;
  }
}

// ---------- Red ----------
void conectarWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;

  Serial.printf("Conectando a Wi-Fi \"%s\"", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);

  unsigned long inicio = millis();
  while (WiFi.status() != WL_CONNECTED && millis() - inicio < TIMEOUT_WIFI_MS) {
    delay(250);
    leerPuerta();          // la alarma sigue funcionando mientras conecta
    actualizarZumbador();
    Serial.print(".");
  }

  if (WiFi.status() == WL_CONNECTED) {
    Serial.printf("\nConectado. IP: %s\n", WiFi.localIP().toString().c_str());
  } else {
    Serial.println("\nNo se pudo conectar. Se reintentará en el próximo ciclo.");
  }
}

// Lee "fan":true/false y "alarm_armed":true/false de la respuesta del servidor
void aplicarOrdenes(const String& respuesta) {
  int iFan = respuesta.indexOf("\"fan\":");
  if (iFan >= 0) {
    bool fan = respuesta.startsWith("true", iFan + 6);
    if (fan != ventiladorEncendido) {
      aplicarVentilador(fan);
      Serial.printf("Ventilador %s (orden del dashboard)\n", fan ? "ENCENDIDO" : "apagado");
    }
  }
  int iAlarma = respuesta.indexOf("\"alarm_armed\":");
  if (iAlarma >= 0) aplicarAlarma(respuesta.startsWith("true", iAlarma + 14));
}

String estadoJSON() {
  char buf[200];
  snprintf(buf, sizeof(buf),
           "\"device\":\"%s\",\"fan_on\":%s,\"alarm_armed\":%s,\"door_open\":%s,\"alarm_triggered\":%s",
           DEVICE_ID,
           ventiladorEncendido ? "true" : "false",
           alarmaArmada ? "true" : "false",
           puertaAbierta ? "true" : "false",
           alarmaDisparada ? "true" : "false");
  return String(buf);
}

int enviar(const char* ruta, const String& cuerpo, String& respuesta) {
  HTTPClient http;
  http.setReuse(true);
  // El plan gratuito de Render "despierta" en ~30-50 s, por eso el timeout amplio
  http.setTimeout(60000);

  String url = String(SERVER_BASE_URL) + ruta;
  if (!http.begin(clienteSeguro, url)) {
    Serial.println("No se pudo iniciar la conexión HTTP");
    return -1;
  }
  http.addHeader("Content-Type", "application/json");
  http.addHeader("x-api-key", API_KEY);

  digitalWrite(LED_PIN, HIGH);
  int codigo = http.POST(cuerpo);
  digitalWrite(LED_PIN, LOW);

  if (codigo > 0) respuesta = http.getString();
  else Serial.printf("Error en %s: %s\n", ruta, http.errorToString(codigo).c_str());
  http.end();
  return codigo;
}

void enviarLectura() {
  float humedad = dht.readHumidity();
  float temperatura = dht.readTemperature();  // °C

  if (isnan(humedad) || isnan(temperatura)) {
    Serial.println("Lectura inválida del DHT11 (revisa cableado y pull-up)");
    return;
  }
  Serial.printf("Temp: %.1f °C | Humedad: %.1f %%\n", temperatura, humedad);

  String cuerpo = "{" + estadoJSON() +
                  ",\"temperature\":" + String(temperatura, 1) +
                  ",\"humidity\":" + String(humedad, 1) + "}";
  String respuesta;
  int codigo = enviar("/api/readings", cuerpo, respuesta);
  if (codigo > 0) Serial.printf("Servidor respondió %d\n", codigo);
  if (codigo == 201) aplicarOrdenes(respuesta);
}

void enviarLatido() {
  String respuesta;
  if (enviar("/api/device", "{" + estadoJSON() + "}", respuesta) == 200) {
    aplicarOrdenes(respuesta);
  }
}

// ---------- Programa ----------
void setup() {
  Serial.begin(115200);
  delay(200);

  pinMode(LED_PIN, OUTPUT);
  pinMode(RELAY_PIN, OUTPUT);
  pinMode(DOOR_PIN, INPUT_PULLUP);
  pinMode(BUZZER_PIN, OUTPUT);
  aplicarVentilador(false);
  noTone(BUZZER_PIN);

  dht.begin();
  // Render usa HTTPS. Para simplificar no validamos el certificado.
  clienteSeguro.setInsecure();

  Serial.println("\n== App Domótico ESP32 — DHT11, ventilador y alarma ==");
  leerPuerta();
  conectarWiFi();
}

void loop() {
  // Lógica local: siempre se ejecuta, haya o no Internet
  leerPuerta();
  actualizarZumbador();

  unsigned long ahora = millis();
  bool tocaLectura = ultimaLectura == 0 || ahora - ultimaLectura >= INTERVALO_LECTURA_MS;
  bool tocaLatido  = enviarYa || ahora - ultimoLatido >= INTERVALO_LATIDO_MS;
  if (!tocaLectura && !tocaLatido) return;

  conectarWiFi();
  if (WiFi.status() != WL_CONNECTED) {
    ultimoLatido = ahora;  // evita reintentar en cada vuelta del loop
    return;
  }

  if (tocaLectura) {
    ultimaLectura = ahora;
    ultimoLatido = ahora;   // la lectura ya incluye el estado
    enviarYa = false;
    enviarLectura();
  } else {
    ultimoLatido = ahora;
    enviarYa = false;
    enviarLatido();
  }
}
