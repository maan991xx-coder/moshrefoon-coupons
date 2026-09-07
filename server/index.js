import { createApp } from './app.js';
import { config } from './config.js';
import { getDb } from './db.js';

getDb();
const app = createApp();

const server = app.listen(config.port, () => {
  const line = '─'.repeat(62);
  console.log(`\n${line}`);
  console.log('  نظام كوبونات المشرفون — Moshrefoon coupon system');
  console.log(`  الخادم يعمل على   : http://localhost:${config.port}`);
  console.log(`  العنوان في رمز QR : ${config.publicUrl}`);
  console.log(`  قاعدة البيانات    : ${config.dbPath}`);
  if (config.adminPasswordGenerated) {
    console.log(`  كلمة مرور الدخول  : ${config.adminPassword}   (data/admin-password.txt)`);
  }
  if (config.secretGenerated) {
    console.log('  تم توليد مفتاح التوقيع في data/secret.key — احتفظ به، فتغييره يُبطل الكوبونات القديمة.');
  }
  console.log(`${line}\n`);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => server.close(() => process.exit(0)));
}
