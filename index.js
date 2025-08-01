const express = require('express');
const bodyParser = require('body-parser');
const admin = require('firebase-admin');

const app = express();
app.use(bodyParser.json());

const serviceAccount = require('./serviceAccountKey.json');
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: "https://test-for-flutter-flow-default-rtdb.firebaseio.com"
});

const db = admin.firestore();
const rtdb = admin.database();
// ✅ اختبار قراءة مستند من Firestore
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

// ✅ اختبار قراءة قيمة من RTDB
app.get('/check-rtdb', async (req, res) => {
  try {
    const snapshot = await rtdb.ref('/Amr/Hum').once('value');
    const value = snapshot.val();
    res.json({ rtdb_value: value });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// تشغيل السيرفر
app.listen(3000, () => {
  console.log('✅ Server running at http://localhost:3000');
});
