const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.json());

// تهيئة Firebase Admin SDK من المتغير البيئي
const serviceAccount = JSON.parse(process.env.SERVICE_ACCOUNT_KEY);
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://test-for-flutter-flow-default-rtdb.firebaseio.com",
});

const db = admin.firestore();
const rtdb = admin.database();

// مقارنة الشرط (تدعم == و != و > و < و >= و <=)
function evaluateCondition(value, operator, target) {
  switch (operator) {
    case '==': return value == target;
    case '!=': return value != target;
    case '>': return value > target;
    case '<': return value < target;
    case '>=': return value >= target;
    case '<=': return value <= target;
    default: return false;
  }
}

// إرسال إشعار إلى قائمة توكنات
async function sendNotificationToTokens(tokens, title, body) {
  for (const token of tokens) {
    try {
      await admin.messaging().send({
        token,
        notification: {
          title,
          body,
        },
      });
      console.log(`✅ تم إرسال إشعار إلى ${token}`);
    } catch (err) {
      console.error(`❌ فشل إرسال الإشعار إلى ${token}:`, err.message);
    }
  }
}

// راقب كل مستند في automations
async function setupAutomationListeners() {
  const snapshot = await db.collection('automations').get();
  snapshot.forEach(doc => {
    const data = doc.data();
    const {
      id,
      source,
      operator,
      value,
      action,
      user_email,
      notification_title,
      notification_text
    } = data;

    if (source && operator && action === 'notification') {
      const ref = rtdb.ref(source);
      ref.on('value', async snapshot => {
        const currentValue = snapshot.val();
        if (evaluateCondition(currentValue, operator, value)) {
          console.log(`🚨 شرط تحقق للمهمة ${doc.id} على ${source}: ${currentValue}`);

          try {
            const usersQuery = await db.collection('users')
              .where('email', '==', user_email)
              .limit(1)
              .get();

            if (!usersQuery.empty) {
              const userDoc = usersQuery.docs[0];
              const tokens = userDoc.data().device_tokens || [];
              await sendNotificationToTokens(tokens, notification_title, notification_text);
            } else {
              console.log(`⚠️ لم يتم العثور على المستخدم: ${user_email}`);
            }
          } catch (err) {
            console.error(`❌ خطأ في إرسال الإشعار: ${err.message}`);
          }
        }
      });

      console.log(`📡 مراقبة المسار ${source} لتفعيل المهمة ${doc.id}`);
    }
  });
}

// نقطة اختبار Firestore
app.get('/check-firestore', async (req, res) => {
  try {
    const snapshot = await db.collection('automations').get();
    const data = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() }));
    res.json({ automations: data });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// نقطة اختبار RTDB
app.get('/check-rtdb', async (req, res) => {
  try {
    const snapshot = await rtdb.ref('/Amr/Hum').once('value');
    res.json({ value: snapshot.val() });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// تشغيل السيرفر والاستماع للمهمات
app.listen(3000, () => {
  console.log('✅ Server running at http://localhost:3000');
  setupAutomationListeners();
});
