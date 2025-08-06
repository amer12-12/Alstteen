const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.json());

// 🔐 قراءة بيانات الخدمة من المتغير البيئي
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://test-for-flutter-flow-default-rtdb.firebaseio.com"
});

const db = admin.firestore();
const rtdb = admin.database();
const messaging = admin.messaging();

// 🔁 دالة التحقق من الشرط
function evaluateCondition(currentValue, operator, expectedValue) {
  switch (operator) {
    case '==': return currentValue == expectedValue;
    case '!=': return currentValue != expectedValue;
    case '>': return currentValue > expectedValue;
    case '<': return currentValue < expectedValue;
    case '>=': return currentValue >= expectedValue;
    case '<=': return currentValue <= expectedValue;
    default: return false;
  }
}

// 🔔 دالة إرسال إشعار إلى جميع الأجهزة المرتبطة بالمستخدمين
async function sendNotificationToAllDevices(title, body) {
  try {
    const usersSnapshot = await db.collection('users').get();

    usersSnapshot.forEach(async (userDoc) => {
      const userData = userDoc.data();
      const tokens = userData.device_tokens || [];

      if (tokens.length === 0) return;

      const message = {
        notification: { title, body },
        tokens: tokens,
      };

      const response = await messaging.sendMulticast(message);
      console.log(`✅ إشعار أُرسل لـ ${userData.email}: ${response.successCount}/${tokens.length}`);
    });
  } catch (error) {
    console.error("❌ فشل إرسال الإشعار:", error.message);
  }
}

// 📡 مراقبة المهام من Firestore وتفعيل المستمعين لـ RTDB
const monitorAutomationTasks = async () => {
  const snapshot = await db.collection('automations').get();

  snapshot.forEach(async (doc) => {
    const automation = doc.data();
    const { path, operator, value, source } = automation.condition;
    const { title, text } = automation.action.payload;

    if (source === 'firebase_rtdb') {
      const ref = rtdb.ref(`/Amr/${path}`);

      ref.on('value', async (snapshot) => {
        const currentValue = snapshot.val();
        if (evaluateCondition(currentValue, operator, value)) {
          console.log(`🚨 شرط تحقق للمهمة ${doc.id} على ${path}: ${currentValue}`);
          await sendNotificationToAllDevices(title, text);
        }
      });
    }
  });
};

// 🧪 اختبار يدوي Firestore
app.get('/check-firestore', async (req, res) => {
  try {
    const docRef = db.collection('automations').doc('Wo021nTU3eDMbGfFC579');
    const doc = await docRef.get();
    if (doc.exists) {
      res.json({ firestore: doc.data() });
    } else {
      res.json({ error: 'Document not found' });
    }
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🧪 اختبار يدوي RTDB
app.get('/check-rtdb', async (req, res) => {
  try {
    const snapshot = await rtdb.ref('/Amr/Hum').once('value');
    const value = snapshot.val();
    res.json({ rtdb_value: value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// 🚀 بدء تشغيل السيرفر
app.listen(3000, () => {
  console.log('✅ Server running at http://localhost:3000');
  monitorAutomationTasks(); // بدء مراقبة المهام
});
