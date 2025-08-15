// index.js
const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.json());

// -------- Firebase Admin init (من متغير البيئة) --------
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  // عدّل الـ URL لو مختلف عندك
  databaseURL: 'https://test-for-flutter-flow-default-rtdb.firebaseio.com',
});

const db = admin.firestore();
const rtdb = admin.database();

// -------- Helpers --------
function evaluateCondition(value, operator, target) {
  switch (operator) {
    case '==': return value == target;
    case '!=': return value != target;
    case '>':  return value >  target;
    case '<':  return value <  target;
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

// -------- إدارة الليسنرز لكل Automation --------
const automationWatchers = new Map(); // Map(docId -> { rtdbRef, callback })

function stopAutomation(docId) {
  const watcher = automationWatchers.get(docId);
  if (!watcher) return;
  try {
    watcher.rtdbRef.off('value', watcher.callback);
    console.log(`🛑 تم إيقاف مراقبة المهمة ${docId}`);
  } finally {
    automationWatchers.delete(docId);
  }
}

function startAutomation(docId, data) {
  const actionType   = data?.action?.type;
  const title        = data?.action?.payload?.title || 'Notification';
  const text         = data?.action?.payload?.text  || '';

  const operator     = data?.condition?.operator;
  const rtdbPath     = data?.condition?.path;     // مثال: "Amr/Hum" أو "Nomber"
  const source       = data?.condition?.source;   // يجب أن يكون "firebase_rtdb"
  const targetValue  = data?.condition?.value;

  const targetUid    = data?.target_uid || null;
  const targetEmail  = data?.target_email || null;

  // تحققات سريعة
  if (actionType !== 'notification') {
    console.log(`↩️ ${docId}: action.type ليس "notification" — تخطّي`);
    return;
  }
  if (source !== 'firebase_rtdb') {
    console.log(`↩️ ${docId}: source ليس "firebase_rtdb" — تخطّي`);
    return;
  }
  if (!rtdbPath || !operator || typeof targetValue === 'undefined') {
    console.log(`↩️ ${docId}: حقول condition ناقصة — تخطّي`);
    return;
  }

  // لا تكرر تشغيل نفس الأتمتة
  if (automationWatchers.has(docId)) {
    stopAutomation(docId);
  }

  const ref = rtdb.ref(rtdbPath);
  const callback = async (snap) => {
    const current = snap.val();
    if (evaluateCondition(current, operator, targetValue)) {
      console.log(`🚨 تحقّق الشرط للمهمة ${docId} على ${rtdbPath}:`, current);
      const tokens = await getUserDeviceTokensByTarget({ targetUid, targetEmail });
      if (tokens.length > 0) {
        await sendToTokens(tokens, title, text);
      } else {
        console.warn(`⚠️ ${docId}: لا توجد device_tokens للمستخدم المستهدف.`);
      }
    }
  };

  ref.on('value', callback);
  automationWatchers.set(docId, { rtdbRef: ref, callback });
  console.log(`📡 بدأنا نراقب "${rtdbPath}" للمهمة ${docId}`);
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
          startAutomation(docId, data); // سيوقف القديم إن وجد ثم يشغّل الجديد
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

// -------- Health/Test endpoints --------
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

// تنظيف جيّد عند الإيقاف
process.on('SIGTERM', () => {
  console.log('♻️ Shutting down… إيقاف جميع الليسنرز');
  for (const docId of automationWatchers.keys()) {
    stopAutomation(docId);
  }
  process.exit(0);
});

// -------- Start server --------
app.listen(3000, () => {
  console.log('✅ Server running at http://localhost:3000');
  setupAutomationListeners();
});
