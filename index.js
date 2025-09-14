// index.js (الكود الكامل بعد التعديل)

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
const heartbeatRef = rtdb.ref('/heartbeat');
const statusRef = rtdb.ref('/is_online');
let lastHeartbeatValue = null;
let watchdogIntervalId = null; 

function startHeartbeatWatchdog() {
  console.log('💓 Heartbeat watchdog service started. Monitoring ESP32 status...');
  if (watchdogIntervalId) {
    clearInterval(watchdogIntervalId);
  }

  let initialCheck = true;
  watchdogIntervalId = setInterval(async () => {
    try {
      const snapshot = await heartbeatRef.once('value');
      const currentHeartbeatValue = snapshot.val();
      console.log(`💓 [Watchdog] Checking... Current: ${currentHeartbeatValue}, Previous: ${lastHeartbeatValue}`);

      if (initialCheck) {
        lastHeartbeatValue = currentHeartbeatValue;
        initialCheck = false;
        if (currentHeartbeatValue !== null) {
          await statusRef.set(true); 
          console.log('💓 [Watchdog] Initial check complete. Status set to Online.');
        }
        return;
      }
      
      if (currentHeartbeatValue === lastHeartbeatValue) {
        console.log('💓 [Watchdog] Value unchanged. Setting status to OFFLINE.');
        await statusRef.set(false);
      } else {
        console.log('💓 [Watchdog] Value changed. Setting status to ONLINE.');
        await statusRef.set(true);
      }
      lastHeartbeatValue = currentHeartbeatValue;
    } catch (error) {
      console.error("❌ [Watchdog] Error:", error);
      await statusRef.set(false);
    }
  }, 60000); 
}
// --- END: ESP32 HEARTBEAT WATCHDOG CODE ---


// ---------- Helpers ----------
function evaluateCondition(value, operator, target) {
  switch (operator) {
    case '==': return value == target;
    case '!=': return value != target;
    case '>':  return value > target;
    case '<':  return value < target;
    case '>=': return value >= target;
    case '<=': return value <= target;
    default:   return false;
  }
}

async function sendToTokens(tokens, title, body) {
  for (const token of tokens) {
    try {
      await admin.messaging().send({
        token,
        notification: { title, body },
      });
      console.log(`✅ إشعار أُرسل إلى: ${token}`);
    } catch (err) {
      console.error(`❌ فشل إرسال الإشعار إلى ${token}: ${err.message}`);
    }
  }
}

async function getUserDeviceTokensByTarget({ targetUid, targetEmail }) {
  try {
    let userDocSnap = null;
    if (targetUid) {
      userDocSnap = await db.collection('users').doc(targetUid).get();
    } else if (targetEmail) {
      const q = await db.collection('users').where('email', '==', targetEmail).limit(1).get();
      if (!q.empty) userDocSnap = q.docs[0];
    }
    if (!userDocSnap || !userDocSnap.exists) {
        console.warn(`⚠️ لم يتم العثور على مستخدم`);
        return [];
    }
    const tokens = userDocSnap.data().device_tokens || [];
    return Array.isArray(tokens) ? tokens : [];
  } catch (e) {
    console.error('❌ خطأ في جلب device_tokens:', e.message);
    return [];
  }
}


// ---------- Automation Listeners Management ----------
const automationWatchers = new Map();

function msFromRepeat(repeatUnit, repeatValue) {
  if (!repeatUnit || !repeatValue) return 0;
  const n = Number(repeatValue);
  if (!Number.isFinite(n) || n <= 0) return 0;
  switch (repeatUnit) {
    case 'seconds': return n * 1000;
    case 'minutes': return n * 60 * 1000;
    case 'hours':   return n * 60 * 60 * 1000;
    default:        return 0;
  }
}

function stopAutomation(docId) {
  const watcher = automationWatchers.get(docId);
  if (!watcher) return;
  try {
    if (watcher.type === 'interval') {
      clearInterval(watcher.intervalId);
      console.log(`🛑 [Interval-Based] تم إيقاف الفحص الدوري للمهمة ${docId}`);
    } else if (watcher.type === 'listener') {
      watcher.rtdbRef.off('value', watcher.callback);
      console.log(`🛑 [Event-Based] تم إيقاف مراقبة المهمة ${docId}`);
    }
  } finally {
    automationWatchers.delete(docId);
  }
}

function startAutomation(docId, data) {
  const { action, condition, target_uid, target_email, schedule } = data;
  if (action?.type !== 'notification' || condition?.source !== 'firebase_rtdb' || !condition?.path || !condition?.operator || typeof condition?.value === 'undefined') {
    console.log(`↩️ ${docId}: بيانات الأتمتة ناقصة — تخطّي`);
    return;
  }
  if (automationWatchers.has(docId)) {
    stopAutomation(docId);
  }
  const intervalMs = msFromRepeat(schedule?.unit, schedule?.interval);

  if (!intervalMs) {
    console.log(`📡 [Event-Based] بدأنا نراقب "${condition.path}" للمهمة ${docId}`);
    const ref = rtdb.ref(condition.path);
    const callback = async (snap) => {
      const current = snap.val();
      if (evaluateCondition(current, condition.operator, condition.value)) {
        console.log(`🚨 [Event-Based] تحقّق الشرط للمهمة ${docId}`);
        const tokens = await getUserDeviceTokensByTarget({ targetUid: target_uid, targetEmail: target_email });
        if (tokens.length > 0) {
          await sendToTokens(tokens, action.payload.title, action.payload.text);
        }
      }
    };
    ref.on('value', callback);
    automationWatchers.set(docId, { type: 'listener', rtdbRef: ref, callback });
  } else {
    console.log(`⏳ [Interval-Based] سنقوم بفحص "${condition.path}" كل ${schedule.interval} ${schedule.unit} للمهمة ${docId}`);
    const intervalId = setInterval(async () => {
      try {
        const snap = await rtdb.ref(condition.path).once('value');
        const current = snap.val();
        if (evaluateCondition(current, condition.operator, condition.value)) {
          console.log(`🚨 [Interval-Based] تحقّق الشرط للمهمة ${docId}`);
          const tokens = await getUserDeviceTokensByTarget({ targetUid: target_uid, targetEmail: target_email });
          if (tokens.length > 0) {
            await sendToTokens(tokens, action.payload.title, action.payload.text);
          }
        }
      } catch (e) {
        console.error(`❌ خطأ أثناء الفحص الدوري للمهمة ${docId}:`, e.message);
      }
    }, intervalMs);
    automationWatchers.set(docId, { type: 'interval', intervalId });
  }
}

// ========== START: الكود الذي تم تعديله ==========
function setupAutomationListeners() {
  console.log('👂 نتابع مجموعة automations بالتحديث الفوري...');
  return db.collection('automations').onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const docId = change.doc.id;
        const data = change.doc.data();

        if (change.type === 'added') {
          startAutomation(docId, data);
        } else if (change.type === 'modified') {
          // تمت إضافة هذه الرسالة لجعل السلوك مطابق للكود الأول
          console.log(`✏️ تم تعديل الأتمتة ${docId} — إعادة تشغيل الليسنر`);
          startAutomation(docId, data);
        } else if (change.type === 'removed') {
          stopAutomation(docId);
        }
      });
    },
    (err) => console.error('❌ Firestore onSnapshot error:', err.message)
  );
}
// ========== END: الكود الذي تم تعديله ==========


// ---------- Health/Test endpoints ----------
app.get('/check-firestore', async (_req, res) => {
    try {
        const snapshot = await db.collection('automations').get();
        res.json({ count: snapshot.size });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.get('/check-rtdb', async (_req, res) => {
    try {
        const snapshot = await rtdb.ref('/heartbeat').once('value');
        res.json({ value: snapshot.val() });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});


// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('♻️ Shutting down… إيقاف جميع الليسنرز');
  
  if (watchdogIntervalId) {
    clearInterval(watchdogIntervalId);
    console.log('💓 [Watchdog] Heartbeat watchdog stopped.');
  }

  for (const docId of automationWatchers.keys()) {
    stopAutomation(docId);
  }
  process.exit(0);
});


// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
 
  
  // تشغيل مراقب المهام الآلية
  setupAutomationListeners();

  // تشغيل مراقب نبض القلب
  startHeartbeatWatchdog();
});