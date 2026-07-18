// My SketchUp 用 距離センサー送信機 (ESP32 + VL53L1X)
//
// スマホの背中に貼って、レーザーが向いてる先 (壁など) までの距離を
// keihi-api に送り続ける。アプリはジャイロモード中にこれを受けて、
// 実測距離でモデルへの近づき/断面の深さが動く。
//
// 配線 (ESP32 DevKit 系):
//   VL53L1X VIN → 3V3 / GND → GND / SDA → GPIO21 / SCL → GPIO22
//
// 準備 (Arduino IDE):
//   1. ボードマネージャで "esp32" を入れて、ボードに自分の ESP32 を選ぶ
//   2. ライブラリマネージャで "SparkFun VL53L1X" をインストール
//   3. 下の ★ 3ヶ所を書き換えて書き込む
//
// CHANNEL はアプリ側の URL の ?dev= と同じ値にする (12文字以上の適当な英数字)。
// 例: https://keihi-496002.web.app/sketchup/?dev=a3f9c2e81b44

#include <WiFi.h>
#include <WiFiClientSecure.h>
#include <HTTPClient.h>
#include <Wire.h>
#include <SparkFun_VL53L1X.h>

const char* WIFI_SSID = "★あなたのWi-Fi名★";
const char* WIFI_PASS = "★Wi-Fiパスワード★";
const char* CHANNEL   = "★12文字以上の適当な英数字 (URLの?dev=と同じに)★";

const char* API_BASE = "https://keihi-api-734350696397.asia-northeast1.run.app";
const int   SEND_INTERVAL_MS = 150;   // 送信間隔 (これ以上速くしても体感は変わらない)

SFEVL53L1X sensor;
WiFiClientSecure tls;

void setup() {
  Serial.begin(115200);
  Wire.begin();

  if (sensor.begin() != 0) {
    Serial.println("VL53L1X が見つかりません。配線 (3V3/GND/21/22) を確認");
    while (true) delay(1000);
  }
  sensor.setDistanceModeLong();     // 射程 ~4m モード
  sensor.setTimingBudgetInMs(50);
  sensor.startRanging();

  WiFi.begin(WIFI_SSID, WIFI_PASS);
  Serial.print("Wi-Fi 接続中");
  while (WiFi.status() != WL_CONNECTED) { delay(300); Serial.print("."); }
  Serial.println(" OK: " + WiFi.localIP().toString());

  // 送るのは距離 1 個だけなので証明書検証は省略 (実装がラクなのを優先)
  tls.setInsecure();
}

void loop() {
  static unsigned long lastSend = 0;

  if (!sensor.checkForDataReady()) { delay(5); return; }
  int mm = sensor.getDistance();
  sensor.clearInterrupt();

  if (millis() - lastSend < SEND_INTERVAL_MS) return;
  lastSend = millis();
  Serial.printf("%d mm\n", mm);

  if (WiFi.status() != WL_CONNECTED) { WiFi.reconnect(); return; }
  HTTPClient http;
  http.begin(tls, String(API_BASE) + "/api/sketchup-range/" + CHANNEL);
  http.addHeader("Content-Type", "application/json");
  http.setTimeout(1000);
  int code = http.POST("{\"mm\":" + String(mm) + "}");
  if (code != 200) Serial.printf("send NG (%d)\n", code);
  http.end();
}
