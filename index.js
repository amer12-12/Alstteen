// index.js

const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.json());

// ---------- Firebase Admin init ----------
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://steenstation-37b01-default-rtdb.firebaseio.com/",
});

const db = admin.firestore();
const rtdb = admin.database();


// --- START: ESP32 HEARTBEAT WATCHDOG CODE ---
// هذا هو الجزء الجديد لمراقبة حالة الجهاز

const heartbeatRef = rtdb.ref('/heartbeat');
const statusRef = rtdb.ref('/is_online');
let lastHeartbeatValue = null;
let watchdogIntervalId = null; //  متغير للاحتفاظ بمعرّف المهمة الدورية لإيقافها لاحقًا

/**
 * دالة تبدأ عملية المراقبة لحالة الجهاز كل دقيقة
 */
function startHeartbeatWatchdog() {
  console.log('💓 Heartbeat watchdog service started. Monitoring ESP32 status...');

  // إيقاف أي مراقب قديم قد يكون يعمل لتجنب التكرار
  if (watchdogIntervalId) {
    clearInterval(watchdogIntervalId);
  }

  // في أول مرة تشغيل للسيرفر، نقوم بفحص مبدئي
  let initialCheck = true;

  watchdogIntervalId = setInterval(async () => {
    try {
      const snapshot = await heartbeatRef.once('value');
      const currentHeartbeatValue = snapshot.val();

      console.log(`💓 [Watchdog] Checking... Current: ${currentHeartbeatValue}, Previous: ${lastHeartbeatValue}`);

      if (initialCheck) {
        lastHeartbeatValue = currentHeartbeatValue;
        initialCheck = false;
        // عند بدء تشغيل السيرفر، نفترض أن الجهاز متصل إذا كانت هناك قيمة
        if (currentHeartbeatValue !== null) {
          await statusRef.set(true); 
          console.log('💓 [Watchdog] Initial check complete. Status set to Online.');
        }
        return;
      }
      
      // إذا لم تتغير القيمة خلال دقيقة، فالجهاز غير متصل
      if (currentHeartbeatValue === lastHeartbeatValue) {
        console.log('💓 [Watchdog] Value unchanged. Setting status to OFFLINE.');
        await statusRef.set(false);
      } else {
        // إذا تغيرت القيمة، فالجهاز متصل
        console.log('💓 [Watchdog] Value changed. Setting status to ONLINE.');
        await statusRef.set(true);
      }

      // تحديث القيمة السابقة للمقارنة في المرة القادمة
      lastHeartbeatValue = currentHeartbeatValue;

    } catch (error) {
      console.error("❌ [Watchdog] Error:", error);
      await statusRef.set(false); // عند حدوث خطأ، الأمان يقتضي اعتبار الجهاز غير متصل
    }
  }, 60000); // 60000 مللي ثانية = 1 دقيقة
}

// --- END: ESP32 HEARTBEAT WATCHDOG CODE ---


// ---------- Helpers ----------
// (كل الدوال المساعدة هنا تبقى كما هي بدون تغيير)
function evaluateCondition(value, operator, target) {
  // ... no changes here ...
}
async function sendToTokens(tokens, title, body) {
  // ... no changes here ...
}
async function getUserDeviceTokensByTarget({ targetUid, targetEmail }) {
  // ... no changes here ...
}


// ---------- إدارة الليسنرز لكل Automation ----------
// (كل هذا الجزء يبقى كما هو بدون تغيير)
const automationWatchers = new Map();
function msFromRepeat(repeatUnit, repeatValue) {
  // ... no changes here ...
}
function stopAutomation(docId) {
  // ... no changes here ...
}
function startAutomation(docId, data) {
  // ... no changes here ...
}
function setupAutomationListeners() {
  // ... no changes here ...
}


// ---------- Health/Test endpoints ----------
// (كل هذا الجزء يبقى كما هو بدون تغيير)
app.get('/check-firestore', async (_req, res) => {
  // ... no changes here ...
});

app.get('/check-rtdb', async (_req, res) => {
  // ... no changes here ...
});

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('♻️ Shutting down… إيقاف جميع الليسنرز');
  
  // --- START: ADDITION TO SHUTDOWN ---
  // إضافة إيقاف مراقب نبض القلب عند إغلاق السيرفر
  if (watchdogIntervalId) {
    clearInterval(watchdogIntervalId);
    console.log('💓 [Watchdog] Heartbeat watchdog stopped.');
  }
  // --- END: ADDITION TO SHUTDOWN ---

  for (const docId of automationWatchers.keys()) {
    stopAutomation(docId);
  }
  process.exit(0);
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  
  // تشغيل مراقب المهام الآلية الموجود لديك
  setupAutomationListeners();

  // --- START: STARTING THE WATCHDOG ---
  // تشغيل مراقب نبض القلب الجديد عند بدء تشغيل السيرفر
  startHeartbeatWatchdog();
  // --- END: STARTING THE WATCHDOG ---
});