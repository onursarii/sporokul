# Spor Okulu Paneli (MVP)
Node.js (Express) + PostgreSQL + mobil uyumlu vanilla JS arayüz. Tek süreçte API + web.

    npm install
    node ../node_modules/.../hydrate-symlinks.js   # embedded-postgres için bir kez (bkz. aşağı)
    JWT_SECRET=gizli node server.js                # http://localhost:3000

- DATABASE_URL verilmezse gömülü PostgreSQL (./pgdata) kullanılır; verilirse harici PostgreSQL.
- Ortam değişkenleri: PORT, JWT_SECRET, DATABASE_URL, BOT_WEBHOOK_URL, COACH_SEES_FINANCE=true|false
- BOT_WEBHOOK_URL yoksa mesajlar simüle edilir (sunucu loguna yazılır), gerçek gönderim yapılmaz.
- Demo: admin@demo.com / demo1234, coach@demo.com / demo1234 (ilk açılışta şema + demo veri yüklenir)
- Sıfırlamak için: sunucuyu durdur, `pgdata` klasörünü sil.
