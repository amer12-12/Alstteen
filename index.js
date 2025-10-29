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
      if (!userDocSnap.exists) {
        console.warn(`⚠️ لم يتم العثور على مستخدم بالـ uid: ${targetUid}`);
        return [];
      }
    } else if (targetEmail) {
      const q = await db.collection('users')
        .where('email', '==', targetEmail)
        .limit(1)
        .get();
      if (q.empty) {
        console.warn(`⚠️ لم يتم العثور على مستخدم بالإيميل: ${targetEmail}`);
        return [];
      }
      userDocSnap = q.docs[0];
    } else {
      console.warn('⚠️ لا يوجد target_uid أو target_email في المهمة.');
      return [];
    }

    const tokens = userDocSnap.data().device_tokens || [];
    if (!Array.isArray(tokens) || tokens.length === 0) {
      console.warn('⚠️ لا توجد device_tokens للمستخدم.');
      return [];
    }
    return tokens;
  } catch (e) {
    console.error('❌ خطأ في جلب device_tokens:', e.message);
    return [];
  }
}

// ---------- إدارة الليسنرز لكل Automation ----------
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
  const actionType   = data?.action?.type;
  const title        = data?.action?.payload?.title || 'Notification';
  const text         = data?.action?.payload?.text  || '';
  const operator     = data?.condition?.operator;
  const rtdbPath     = data?.condition?.path;
  const source       = data?.condition?.source;
  const targetValue  = data?.condition?.value;
  const targetUid    = data?.target_uid || null;
  const targetEmail  = data?.target_email || null;

  const repeatUnit   = data?.schedule?.unit || null;
  const repeatValue  = data?.schedule?.interval || null;
  const intervalMs   = msFromRepeat(repeatUnit, repeatValue);

  if (actionType !== 'notification' || source !== 'firebase_rtdb' || !rtdbPath || !operator || typeof targetValue === 'undefined') {
    console.log(`↩️ ${docId}: بيانات الأتمتة ناقصة — تخطّي`);
    return;
  }

  if (automationWatchers.has(docId)) {
    stopAutomation(docId);
  }

  if (!intervalMs) {
    console.log(`📡 [Event-Based] بدأنا نراقب "${rtdbPath}" للمهمة ${docId}`);
    const ref = rtdb.ref(rtdbPath);
    const callback = async (snap) => {
      const current = snap.val();
      if (evaluateCondition(current, operator, targetValue)) {
        console.log(`🚨 [Event-Based] تحقّق الشرط للمهمة ${docId} على ${rtdbPath}:`, current);
        const tokens = await getUserDeviceTokensByTarget({ targetUid, targetEmail });
        if (tokens.length > 0) {
          await sendToTokens(tokens, title, text);
        }
      }
    };
    ref.on('value', callback);
    automationWatchers.set(docId, { type: 'listener', rtdbRef: ref, callback });
    return;
  }

  console.log(`⏳ [Interval-Based] سنقوم بفحص "${rtdbPath}" كل ${repeatValue} ${repeatUnit} للمهمة ${docId}`);

  const intervalId = setInterval(async () => {
    try {
      console.log(`🔎 [Interval-Based] جاري فحص ${docId}...`);
      const snap = await rtdb.ref(rtdbPath).once('value');
      const current = snap.val();

      if (evaluateCondition(current, operator, targetValue)) {
        console.log(`🚨 [Interval-Based] تحقّق الشرط للمهمة ${docId} على ${rtdbPath}:`, current);
        const tokens = await getUserDeviceTokensByTarget({ targetUid, targetEmail });
        if (tokens.length > 0) {
          await sendToTokens(tokens, title, text);
        } else {
          console.warn(`⚠️ ${docId}: لا توجد device_tokens للمستخدم المستهدف.`);
        }
      }
    } catch (e) {
      console.error(`❌ خطأ أثناء الفحص الدوري للمهمة ${docId}:`, e.message);
    }
  }, intervalMs);

  automationWatchers.set(docId, { type: 'interval', intervalId });
}

function setupAutomationListeners() {
  console.log('👂 نتابع مجموعة automations بالتحديث الفوري...');
  return db.collection('automations').onSnapshot(
    (snapshot) => {
      snapshot.docChanges().forEach((change) => {
        const docId = change.doc.id;
        const data  = change.doc.data();

        if (change.type === 'added') {
          startAutomation(docId, data);
        } else if (change.type === 'modified') {
          console.log(`✏️ تم تعديل الأتمتة ${docId} — إعادة تشغيل الليسنر`);
          startAutomation(docId, data);
        } else if (change.type === 'removed') {
          stopAutomation(docId);
        }
      });
    },
    (err) => {
      console.error('❌ Firestore onSnapshot error:', err.message);
    }
  );
}

// ---------- Health/Test endpoints ----------
app.get('/check-firestore', async (_req, res) => {
  try {
    const snapshot = await db.collection('automations').get();
    const data = snapshot.docs.map(d => ({ id: d.id, ...d.data() }));
    res.json({ automations: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/check-rtdb', async (_req, res) => {
  try {
    const snapshot = await rtdb.ref('/Amr/Hum').once('value');
    res.json({ value: snapshot.val() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ---------- Graceful shutdown ----------
process.on('SIGTERM', () => {
  console.log('♻️ Shutting down… إيقاف جميع الليسنرز');
  for (const docId of automationWatchers.keys()) {
    stopAutomation(docId);
  }
  process.exit(0);
});

// ---------- Start server ----------
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`✅ Server running at http://localhost:${PORT}`);
  setupAutomationListeners();
});