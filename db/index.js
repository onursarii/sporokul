// Veritabanı: gömülü PostgreSQL'i başlatır (deneme ortamı). Üretimde DATABASE_URL verin.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const PG_PORT = Number(process.env.PG_PORT || 54329);
let embedded = null;

async function start() {
  let url = process.env.DATABASE_URL;
  if (!url) {
    const EmbeddedPostgres = require('embedded-postgres').default;
    const dir = path.join(__dirname, '..', 'pgdata');
    const fresh = !fs.existsSync(path.join(dir, 'PG_VERSION'));
    embedded = new EmbeddedPostgres({
      databaseDir: dir, user: 'app', password: 'app', port: PG_PORT, persistent: true,
    });
    if (fresh) await embedded.initialise();
    await embedded.start();
    try { await embedded.createDatabase('sporokul'); } catch (e) { /* zaten var */ }
    url = `postgres://app:app@127.0.0.1:${PG_PORT}/sporokul`;
  }
  const pool = new Pool({ connectionString: url, max: 10 });
  const { rows } = await pool.query(`SELECT to_regclass('public.users') AS t`);
  if (!rows[0].t) {
    await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
    await require('./seed')(pool);
    console.log('Şema ve demo veri yüklendi.');
  }
  return pool;
}

async function stop() { if (embedded) await embedded.stop(); }

module.exports = { start, stop };
