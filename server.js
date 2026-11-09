const express = require('express');
const path = require('path');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { z, ZodError } = require('zod');
const db = require('./db');

const PORT = Number(process.env.PORT || 3000);
const JWT_SECRET = process.env.JWT_SECRET || 'dev-secret-degistir';
const COACH_SEES_FINANCE = process.env.COACH_SEES_FINANCE === 'true';
const BOT_WEBHOOK_URL = process.env.BOT_WEBHOOK_URL || '';

let pool;
const app = express();
app.set('trust proxy', 1);
app.use(express.json({ limit: '100kb' }));

// ---------- yardımcılar ----------
const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
class ApiError extends Error {
  constructor(status, code, message) { super(message); this.status = status; this.code = code; }
}
const ok = (res, data, meta, status = 200) => res.status(status).json(meta ? { data, meta } : { data });
const num = (v) => Number(v);
const uuid = z.string().uuid();
const page = (req) => {
  const p = Math.max(1, parseInt(req.query.page) || 1);
  const l = Math.min(100, Math.max(1, parseInt(req.query.limit) || 20));
  return { p, l, offset: (p - 1) * l };
};
const audit = (req, action, entity, id) =>
  pool.query(`INSERT INTO audit_log(user_id,action,entity,entity_id) VALUES($1,$2,$3,$4)`, [req.user.id, action, entity, id]).catch(() => {});

// ---------- auth ----------
const sign = (u, type, exp) => jwt.sign({ id: u.id, role: u.role, name: u.full_name, type }, JWT_SECRET, { expiresIn: exp });
const publicUser = (u) => ({ id: u.id, fullName: u.full_name, role: u.role });

function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const t = jwt.verify(h.replace(/^Bearer /, ''), JWT_SECRET);
    if (t.type !== 'access') throw new Error();
    req.user = t;
    next();
  } catch { next(new ApiError(401, 'UNAUTHORIZED', 'Oturum geçersiz')); }
}
const adminOnly = (req, res, next) =>
  req.user.role === 'admin' ? next() : next(new ApiError(403, 'FORBIDDEN', 'Bu işlem için yetkiniz yok'));
const financeAccess = (req, res, next) =>
  (req.user.role === 'admin' || COACH_SEES_FINANCE) ? next() : next(new ApiError(403, 'FORBIDDEN', 'Finans erişimi yok'));
const canSeeFinance = (req) => req.user.role === 'admin' || COACH_SEES_FINANCE;

const api = express.Router();
app.use('/api/v1', api);

api.get('/health', wrap(async (req, res) => { await pool.query('SELECT 1'); ok(res, { status: 'ok' }); }));

// basit giriş denemesi sınırı (IP başına dakikada 10)
const attempts = new Map();
setInterval(() => attempts.clear(), 60000).unref();

api.post('/auth/login', wrap(async (req, res) => {
  const ip = req.ip;
  attempts.set(ip, (attempts.get(ip) || 0) + 1);
  if (attempts.get(ip) > 10) throw new ApiError(429, 'TOO_MANY', 'Çok fazla deneme, bir dakika bekleyin');
  const { email, password } = z.object({ email: z.string().email(), password: z.string().min(1) }).parse(req.body);
  const { rows } = await pool.query(`SELECT * FROM users WHERE lower(email)=lower($1) AND is_active`, [email]);
  const u = rows[0];
  if (!u || !(await bcrypt.compare(password, u.password_hash))) throw new ApiError(401, 'BAD_CREDENTIALS', 'E-posta veya şifre hatalı');
  ok(res, { accessToken: sign(u, 'access', '2h'), refreshToken: sign(u, 'refresh', '30d'), user: publicUser(u) });
}));

api.post('/auth/refresh', wrap(async (req, res) => {
  const { refreshToken } = z.object({ refreshToken: z.string() }).parse(req.body);
  let t;
  try { t = jwt.verify(refreshToken, JWT_SECRET); if (t.type !== 'refresh') throw 0; } catch { throw new ApiError(401, 'UNAUTHORIZED', 'Oturum süresi doldu'); }
  const { rows } = await pool.query(`SELECT * FROM users WHERE id=$1 AND is_active`, [t.id]);
  if (!rows[0]) throw new ApiError(401, 'UNAUTHORIZED', 'Kullanıcı bulunamadı');
  ok(res, { accessToken: sign(rows[0], 'access', '2h') });
}));

api.use(auth);
api.get('/auth/me', (req, res) => ok(res, { id: req.user.id, fullName: req.user.name, role: req.user.role, canSeeFinance: canSeeFinance(req) }));

// ---------- finans SQL parçaları ----------
const BAL = `
  SELECT c.student_id,
         SUM(c.amount - COALESCE(a.paid,0)) AS debt,
         MIN(c.due_date) FILTER (WHERE c.amount - COALESCE(a.paid,0) > 0) AS oldest_due
  FROM charges c
  LEFT JOIN (SELECT charge_id, SUM(amount) paid FROM payment_allocations GROUP BY charge_id) a ON a.charge_id = c.id
  WHERE c.status <> 'void'
  GROUP BY c.student_id`;
const AGE = `date_part('year', age(s.birth_date))::int`;
const primaryPhone = `(SELECT g.phone FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id
                       WHERE sg.student_id=s.id ORDER BY sg.is_primary DESC LIMIT 1)`;

// ---------- dashboard ----------
api.get('/dashboard/summary', wrap(async (req, res) => {
  const sessions = (await pool.query(
    `SELECT g.id AS "groupId", g.name AS "groupName", g.schedule, se.id AS "sessionId",
            COALESCE(se.is_cancelled,false) AS cancelled,
            EXISTS (SELECT 1 FROM attendance a WHERE a.session_id = se.id) AS "attendanceTaken"
     FROM groups g LEFT JOIN sessions se ON se.group_id=g.id AND se.session_date=CURRENT_DATE
     WHERE g.is_active ORDER BY g.name`)).rows;
  const out = { today: { sessions } };
  if (canSeeFinance(req)) {
    const f = (await pool.query(
      `SELECT
        (SELECT COALESCE(SUM(amount),0) FROM payments WHERE voided_at IS NULL AND date_trunc('month',paid_at)=date_trunc('month',now())) AS collected,
        (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE voided_at IS NULL AND date_trunc('month',spent_at)=date_trunc('month',now())) AS expenses,
        (SELECT COALESCE(SUM(b.debt),0) FROM (${BAL}) b JOIN students s ON s.id=b.student_id WHERE s.is_active AND b.debt>0) AS debt,
        (SELECT COUNT(*) FROM (${BAL}) b JOIN students s ON s.id=b.student_id WHERE s.is_active AND b.debt>0) AS cnt`)).rows[0];
    out.finance = { monthCollected: num(f.collected), monthExpenses: num(f.expenses), totalDebt: num(f.debt), debtorCount: num(f.cnt) };
    out.topDebtors = (await pool.query(
      `SELECT s.id AS "studentId", s.first_name||' '||s.last_name AS name, g.name AS "groupName",
              b.debt::float AS debt, GREATEST(0, CURRENT_DATE - b.oldest_due) AS "overdueDays", ${primaryPhone} AS "guardianPhone"
       FROM (${BAL}) b JOIN students s ON s.id=b.student_id LEFT JOIN groups g ON g.id=s.group_id
       WHERE s.is_active AND b.debt>0 ORDER BY b.oldest_due, b.debt DESC LIMIT 5`)).rows;
  }
  ok(res, out);
}));

// ---------- gruplar ----------
api.get('/groups', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT g.id, g.name, g.min_age AS "minAge", g.max_age AS "maxAge", g.schedule, g.monthly_fee::float AS "monthlyFee",
            (SELECT COUNT(*) FROM students s WHERE s.group_id=g.id AND s.is_active)::int AS "studentCount"
     FROM groups g WHERE g.is_active ORDER BY g.min_age`);
  ok(res, rows);
}));
const groupSchema = z.object({
  name: z.string().min(1), minAge: z.number().int(), maxAge: z.number().int(),
  schedule: z.string().optional(), monthlyFee: z.number().min(0).default(0),
});
api.post('/groups', adminOnly, wrap(async (req, res) => {
  const b = groupSchema.parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO groups(name,min_age,max_age,schedule,monthly_fee) VALUES($1,$2,$3,$4,$5) RETURNING id`,
    [b.name, b.minAge, b.maxAge, b.schedule, b.monthlyFee]);
  ok(res, { id: rows[0].id }, null, 201);
}));
api.patch('/groups/:id', adminOnly, wrap(async (req, res) => {
  const b = groupSchema.partial().parse(req.body);
  await pool.query(
    `UPDATE groups SET name=COALESCE($2,name), min_age=COALESCE($3,min_age), max_age=COALESCE($4,max_age),
       schedule=COALESCE($5,schedule), monthly_fee=COALESCE($6,monthly_fee) WHERE id=$1`,
    [req.params.id, b.name, b.minAge, b.maxAge, b.schedule, b.monthlyFee]);
  ok(res, { id: req.params.id });
}));

// ---------- öğrenciler ----------
api.get('/students', wrap(async (req, res) => {
  const { p, l, offset } = page(req);
  const { groupId, minAge, maxAge, q, hasDebt } = req.query;
  const showDebt = canSeeFinance(req);
  const params = [];
  const where = ['s.is_active'];
  const add = (sql, v) => { params.push(v); where.push(sql.replace('?', '$' + params.length)); };
  if (groupId) add('s.group_id = ?', groupId);
  if (minAge) add(`${AGE} >= ?`, Number(minAge));
  if (maxAge) add(`${AGE} <= ?`, Number(maxAge));
  if (q) add(`(s.first_name || ' ' || s.last_name) ILIKE ?`, `%${q}%`);
  if (hasDebt === 'true' && showDebt) where.push('COALESCE(b.debt,0) > 0');
  const from = `FROM students s LEFT JOIN groups g ON g.id=s.group_id LEFT JOIN (${BAL}) b ON b.student_id=s.id WHERE ${where.join(' AND ')}`;
  const total = (await pool.query(`SELECT COUNT(*)::int c ${from}`, params)).rows[0].c;
  const { rows } = await pool.query(
    `SELECT s.id, s.first_name AS "firstName", s.last_name AS "lastName", ${AGE} AS age, s.group_id AS "groupId", g.name AS "groupName",
            COALESCE(b.debt,0)::float AS debt, (s.health_notes IS NOT NULL OR s.allergies IS NOT NULL) AS "hasHealthAlert"
     ${from} ORDER BY s.first_name, s.last_name LIMIT ${l} OFFSET ${offset}`, params);
  if (!showDebt) rows.forEach((r) => delete r.debt);
  ok(res, rows, { page: p, limit: l, total });
}));

api.get('/students/:id', wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const s = (await pool.query(
    `SELECT s.*, ${AGE} AS age, g.name AS group_name, COALESCE(b.debt,0)::float AS debt
     FROM students s LEFT JOIN groups g ON g.id=s.group_id LEFT JOIN (${BAL}) b ON b.student_id=s.id
     WHERE s.id=$1 AND s.is_active`, [id])).rows[0];
  if (!s) throw new ApiError(404, 'NOT_FOUND', 'Öğrenci bulunamadı');
  const guardians = (await pool.query(
    `SELECT g.id, g.full_name AS "fullName", sg.relation, g.phone, sg.is_emergency AS "isEmergency", sg.is_primary AS "isPrimary"
     FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id WHERE sg.student_id=$1 ORDER BY sg.is_primary DESC`, [id])).rows;
  const att = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE a.status IN ('present','late'))::float AS ok, COUNT(*)::int AS total
     FROM attendance a JOIN sessions se ON se.id=a.session_id WHERE a.student_id=$1 AND se.session_date >= CURRENT_DATE - 30`, [id])).rows[0];
  audit(req, 'view_health', 'student', id);
  const data = {
    id: s.id, firstName: s.first_name, lastName: s.last_name, birthDate: s.birth_date, age: s.age,
    group: s.group_id ? { id: s.group_id, name: s.group_name } : null,
    health: { notes: s.health_notes, allergies: s.allergies, bloodType: s.blood_type },
    guardians, attendanceRate30d: att.total ? att.ok / att.total : null,
  };
  if (canSeeFinance(req)) {
    const charged = (await pool.query(`SELECT COALESCE(SUM(amount),0)::float v FROM charges WHERE student_id=$1 AND status<>'void'`, [id])).rows[0].v;
    data.balance = { charged, paid: charged - s.debt, debt: s.debt };
    data.payments = (await pool.query(
      `SELECT id, amount::float, method, paid_at AS "paidAt", note FROM payments WHERE student_id=$1 AND voided_at IS NULL ORDER BY paid_at DESC LIMIT 10`, [id])).rows;
  }
  ok(res, data);
}));

const studentSchema = z.object({
  firstName: z.string().min(1), lastName: z.string().min(1),
  birthDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  groupId: uuid.nullable().optional(),
  healthNotes: z.string().nullable().optional(), allergies: z.string().nullable().optional(), bloodType: z.string().nullable().optional(),
  guardians: z.array(z.object({
    fullName: z.string().min(1), phone: z.string().regex(/^\+\d{10,15}$/, 'Telefon +90... biçiminde olmalı'),
    relation: z.string().optional(), isEmergency: z.boolean().default(true), isPrimary: z.boolean().default(false),
  })).default([]),
});
api.post('/students', adminOnly, wrap(async (req, res) => {
  const b = studentSchema.parse(req.body);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const s = (await c.query(
      `INSERT INTO students(first_name,last_name,birth_date,group_id,health_notes,allergies,blood_type) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [b.firstName, b.lastName, b.birthDate, b.groupId || null, b.healthNotes || null, b.allergies || null, b.bloodType || null])).rows[0];
    for (const g of b.guardians) {
      const gid = (await c.query(`INSERT INTO guardians(full_name,phone) VALUES($1,$2) RETURNING id`, [g.fullName, g.phone])).rows[0].id;
      await c.query(`INSERT INTO student_guardians VALUES($1,$2,$3,$4,$5)`, [s.id, gid, g.relation, g.isEmergency, g.isPrimary]);
    }
    await c.query('COMMIT');
    ok(res, { id: s.id }, null, 201);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));
api.patch('/students/:id', adminOnly, wrap(async (req, res) => {
  const b = studentSchema.omit({ guardians: true }).partial().parse(req.body);
  await pool.query(
    `UPDATE students SET first_name=COALESCE($2,first_name), last_name=COALESCE($3,last_name), birth_date=COALESCE($4,birth_date),
       group_id=COALESCE($5,group_id), health_notes=COALESCE($6,health_notes), allergies=COALESCE($7,allergies), blood_type=COALESCE($8,blood_type)
     WHERE id=$1`,
    [req.params.id, b.firstName, b.lastName, b.birthDate, b.groupId, b.healthNotes, b.allergies, b.bloodType]);
  ok(res, { id: req.params.id });
}));
api.delete('/students/:id', adminOnly, wrap(async (req, res) => {
  await pool.query(`UPDATE students SET is_active=false WHERE id=$1`, [req.params.id]);
  ok(res, { id: req.params.id });
}));
api.get('/students/:id/attendance', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT se.session_date AS date, a.status, a.note FROM attendance a JOIN sessions se ON se.id=a.session_id
     WHERE a.student_id=$1 AND se.session_date BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'2999-01-01')
     ORDER BY se.session_date DESC LIMIT 100`, [req.params.id, req.query.from || null, req.query.to || null]);
  ok(res, rows);
}));

// ---------- yoklama ----------
api.post('/sessions', wrap(async (req, res) => {
  const b = z.object({ groupId: uuid, sessionDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), startTime: z.string().optional() }).parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO sessions(group_id,session_date,start_time,created_by) VALUES($1,$2,$3,$4)
     ON CONFLICT (group_id,session_date) DO UPDATE SET group_id=EXCLUDED.group_id RETURNING id`,
    [b.groupId, b.sessionDate, b.startTime || null, req.user.id]);
  ok(res, { sessionId: rows[0].id });
}));
api.get('/sessions/:id/attendance', wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const se = (await pool.query(
    `SELECT se.id, se.session_date AS date, se.group_id, g.name FROM sessions se JOIN groups g ON g.id=se.group_id WHERE se.id=$1`, [id])).rows[0];
  if (!se) throw new ApiError(404, 'NOT_FOUND', 'Oturum bulunamadı');
  const students = (await pool.query(
    `SELECT s.id AS "studentId", s.first_name||' '||s.last_name AS name, a.status, a.note,
            (s.health_notes IS NOT NULL OR s.allergies IS NOT NULL) AS "healthAlert"
     FROM students s LEFT JOIN attendance a ON a.student_id=s.id AND a.session_id=$1
     WHERE s.group_id=$2 AND s.is_active ORDER BY s.first_name, s.last_name`, [id, se.group_id])).rows;
  ok(res, { sessionId: se.id, groupName: se.name, date: se.date, students });
}));
api.put('/sessions/:id/attendance', wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const { records } = z.object({ records: z.array(z.object({
    studentId: uuid, status: z.enum(['present', 'absent', 'excused', 'late']), note: z.string().optional() })).min(1) }).parse(req.body);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    for (const r of records) {
      await c.query(
        `INSERT INTO attendance(session_id,student_id,status,note,marked_by) VALUES($1,$2,$3,$4,$5)
         ON CONFLICT (session_id,student_id) DO UPDATE SET status=EXCLUDED.status, note=EXCLUDED.note, marked_by=EXCLUDED.marked_by, marked_at=now()`,
        [id, r.studentId, r.status, r.note || null, req.user.id]);
    }
    await c.query('COMMIT');
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
  const cnt = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='present')::int present, COUNT(*) FILTER (WHERE status='absent')::int absent,
            COUNT(*) FILTER (WHERE status='excused')::int excused, COUNT(*) FILTER (WHERE status='late')::int late
     FROM attendance WHERE session_id=$1`, [id])).rows[0];
  ok(res, cnt);
}));

// ---------- finans ----------
api.use('/finance', financeAccess);

api.get('/finance/debtors', wrap(async (req, res) => {
  const { p, l, offset } = page(req);
  const params = [Number(req.query.minDebt) || 0];
  let gf = '';
  if (req.query.groupId) { params.push(req.query.groupId); gf = `AND s.group_id=$2`; }
  const base = `FROM (${BAL}) b JOIN students s ON s.id=b.student_id LEFT JOIN groups g ON g.id=s.group_id
                WHERE s.is_active AND b.debt > 0 AND b.debt >= $1 ${gf}`;
  const tot = (await pool.query(`SELECT COUNT(*)::int c, COALESCE(SUM(b.debt),0)::float t ${base}`, params)).rows[0];
  const { rows } = await pool.query(
    `SELECT s.id AS "studentId", s.first_name||' '||s.last_name AS name, g.name AS "groupName", b.debt::float AS debt,
            b.oldest_due AS "oldestDueDate", GREATEST(0, CURRENT_DATE - b.oldest_due) AS "overdueDays", ${primaryPhone} AS "guardianPhone"
     ${base} ORDER BY b.oldest_due, b.debt DESC LIMIT ${l} OFFSET ${offset}`, params);
  ok(res, rows, { totalDebt: tot.t, count: tot.c, page: p, limit: l });
}));

const paymentSchema = z.object({
  studentId: uuid, amount: z.number().positive(), method: z.enum(['cash', 'eft', 'other']),
  reference: z.string().optional(), note: z.string().optional(),
});
api.post('/finance/payments', adminOnly, wrap(async (req, res) => {
  const b = paymentSchema.parse(req.body);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query(`SELECT 1 FROM students WHERE id=$1 FOR UPDATE`, [b.studentId]);   // aynı öğrenciye eşzamanlı ödemeyi sıraya sokar
    const open = (await c.query(
      `SELECT c.id, c.amount::float - COALESCE(a.paid,0)::float AS remaining
       FROM charges c LEFT JOIN (SELECT charge_id, SUM(amount) paid FROM payment_allocations GROUP BY charge_id) a ON a.charge_id=c.id
       WHERE c.student_id=$1 AND c.status IN ('open','partial') ORDER BY c.due_date, c.period`, [b.studentId])).rows;
    const debt = open.reduce((s, r) => s + r.remaining, 0);
    if (b.amount > debt + 0.001) throw new ApiError(400, 'EXCEEDS_DEBT', `Tutar borçtan fazla (kalan borç: ${debt.toFixed(2)})`);
    const pay = (await c.query(
      `INSERT INTO payments(student_id,amount,method,reference,note,received_by) VALUES($1,$2,$3,$4,$5,$6) RETURNING id`,
      [b.studentId, b.amount, b.method, b.reference, b.note, req.user.id])).rows[0];
    let left = b.amount;
    const applied = [];
    for (const ch of open) {
      if (left <= 0.001) break;
      const use = Math.min(left, ch.remaining);
      await c.query(`INSERT INTO payment_allocations VALUES($1,$2,$3)`, [pay.id, ch.id, use.toFixed(2)]);
      const status = use >= ch.remaining - 0.001 ? 'paid' : 'partial';
      await c.query(`UPDATE charges SET status=$2 WHERE id=$1`, [ch.id, status]);
      applied.push({ chargeId: ch.id, amount: Number(use.toFixed(2)), status });
      left -= use;
    }
    await c.query('COMMIT');
    ok(res, { paymentId: pay.id, applied, remainingDebt: Number((debt - b.amount).toFixed(2)) }, null, 201);
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));
api.delete('/finance/payments/:id', adminOnly, wrap(async (req, res) => {
  const id = uuid.parse(req.params.id);
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const r = await c.query(`UPDATE payments SET voided_at=now() WHERE id=$1 AND voided_at IS NULL RETURNING id`, [id]);
    if (!r.rowCount) throw new ApiError(404, 'NOT_FOUND', 'Ödeme bulunamadı veya zaten iptal');
    const ch = (await c.query(`DELETE FROM payment_allocations WHERE payment_id=$1 RETURNING charge_id`, [id])).rows;
    for (const { charge_id } of ch) {
      await c.query(
        `UPDATE charges c SET status = CASE WHEN COALESCE((SELECT SUM(amount) FROM payment_allocations WHERE charge_id=c.id),0)=0 THEN 'open'
                                            ELSE 'partial' END WHERE c.id=$1`, [charge_id]);
    }
    await c.query('COMMIT');
    ok(res, { id });
  } catch (e) { await c.query('ROLLBACK'); throw e; } finally { c.release(); }
}));
api.get('/finance/payments', wrap(async (req, res) => {
  const { p, l, offset } = page(req);
  const { rows } = await pool.query(
    `SELECT p.id, p.student_id AS "studentId", s.first_name||' '||s.last_name AS "studentName", p.amount::float AS amount, p.method,
            p.paid_at AS "paidAt", p.note, p.reference
     FROM payments p JOIN students s ON s.id=p.student_id
     WHERE p.voided_at IS NULL AND ($1::uuid IS NULL OR p.student_id=$1) AND ($2::text IS NULL OR p.method::text=$2)
       AND p.paid_at >= COALESCE($3::date,'1900-01-01') AND p.paid_at < COALESCE($4::date + 1,'2999-01-01')
     ORDER BY p.paid_at DESC LIMIT ${l} OFFSET ${offset}`,
    [req.query.studentId || null, req.query.method || null, req.query.from || null, req.query.to || null]);
  ok(res, rows, { page: p, limit: l });
}));

api.post('/finance/expenses', adminOnly, wrap(async (req, res) => {
  const b = z.object({ category: z.string().min(1), amount: z.number().positive(),
    spentAt: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(), description: z.string().optional() }).parse(req.body);
  const { rows } = await pool.query(
    `INSERT INTO expenses(category,amount,spent_at,description,created_by) VALUES($1,$2,COALESCE($3::date,CURRENT_DATE),$4,$5) RETURNING id`,
    [b.category, b.amount, b.spentAt, b.description, req.user.id]);
  ok(res, { id: rows[0].id }, null, 201);
}));
api.get('/finance/expenses', wrap(async (req, res) => {
  const { rows } = await pool.query(
    `SELECT id, category, amount::float AS amount, spent_at AS "spentAt", description FROM expenses
     WHERE voided_at IS NULL AND ($1::text IS NULL OR category=$1)
       AND spent_at BETWEEN COALESCE($2::date,'1900-01-01') AND COALESCE($3::date,'2999-01-01')
     ORDER BY spent_at DESC, id LIMIT 100`, [req.query.category || null, req.query.from || null, req.query.to || null]);
  ok(res, rows);
}));
api.delete('/finance/expenses/:id', adminOnly, wrap(async (req, res) => {
  await pool.query(`UPDATE expenses SET voided_at=now() WHERE id=$1`, [uuid.parse(req.params.id)]);
  ok(res, { id: req.params.id });
}));

api.post('/finance/charges/generate', adminOnly, wrap(async (req, res) => {
  const { period } = z.object({ period: z.string().regex(/^\d{4}-\d{2}$/) }).parse(req.body);
  const r = await pool.query(
    `INSERT INTO charges(student_id,period,amount,due_date)
     SELECT s.id, ($1 || '-01')::date, COALESCE(s.monthly_fee, g.monthly_fee), (($1 || '-01')::date + 9)
     FROM students s JOIN groups g ON g.id=s.group_id WHERE s.is_active
     ON CONFLICT DO NOTHING`, [period]);
  ok(res, { created: r.rowCount });
}));
api.get('/finance/report', wrap(async (req, res) => {
  const month = String(req.query.month || new Date().toISOString().slice(0, 7));
  const r = (await pool.query(
    `SELECT (SELECT COALESCE(SUM(amount),0) FROM payments WHERE voided_at IS NULL AND to_char(paid_at,'YYYY-MM')=$1)::float AS income,
            (SELECT COALESCE(SUM(amount),0) FROM expenses WHERE voided_at IS NULL AND to_char(spent_at,'YYYY-MM')=$1)::float AS expense`, [month])).rows[0];
  const byCat = (await pool.query(
    `SELECT category, SUM(amount)::float AS total FROM expenses WHERE voided_at IS NULL AND to_char(spent_at,'YYYY-MM')=$1 GROUP BY category ORDER BY 2 DESC`, [month])).rows;
  ok(res, { month, income: r.income, expense: r.expense, net: r.income - r.expense, expensesByCategory: byCat });
}));

// ---------- bildirimler ----------
const fmtDate = (d) => new Date(d + 'T00:00:00').toLocaleDateString('tr-TR', { day: 'numeric', month: 'long', weekday: 'long' });
const fmtTL = (n) => Number(n).toLocaleString('tr-TR', { minimumFractionDigits: 0 }) + ' ₺';

async function recipientsForGroup(groupId, channel) {
  return (await pool.query(
    `SELECT DISTINCT ON (g.id) g.id AS "guardianId", g.phone, g.full_name AS "guardianName", g.telegram_chat_id
     FROM students s JOIN student_guardians sg ON sg.student_id=s.id JOIN guardians g ON g.id=sg.guardian_id
     WHERE s.group_id=$1 AND s.is_active AND ($2='telegram' OR g.whatsapp_opt_in)`, [groupId, channel])).rows;
}
async function enqueue(req, res, type, channel, items, group) {
  // items: [{guardianId, phone, message}]
  const dry = req.query.dryRun === 'true';
  if (dry) return ok(res, { recipients: items.length, sample: items[0]?.message || null });
  if (!items.length) throw new ApiError(400, 'NO_RECIPIENTS', 'Alıcı bulunamadı');
  const ids = [];
  for (const it of items) {
    ids.push((await pool.query(
      `INSERT INTO notifications(type,channel,guardian_id,phone,group_id,message,created_by) VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [type, channel, it.guardianId, it.phone, group || null, it.message, req.user.id])).rows[0].id);
  }
  ok(res, { queued: ids.length, notificationIds: ids }, null, 202);
}
const channelEnum = z.enum(['whatsapp', 'telegram']);

api.post('/notifications/training-cancel', wrap(async (req, res) => {
  const b = z.object({ groupId: uuid, date: z.string(), reason: z.string().optional(), channel: channelEnum }).parse(req.body);
  const g = (await pool.query(`SELECT name FROM groups WHERE id=$1`, [b.groupId])).rows[0];
  if (!g) throw new ApiError(404, 'NOT_FOUND', 'Grup bulunamadı');
  const msg = `Sayın veli, ${fmtDate(b.date)} günü ${g.name} antrenmanı iptal edilmiştir.${b.reason ? ' Sebep: ' + b.reason + '.' : ''}`;
  const rec = await recipientsForGroup(b.groupId, b.channel);
  await pool.query(
    `INSERT INTO sessions(group_id,session_date,is_cancelled) VALUES($1,$2,true) ON CONFLICT (group_id,session_date) DO UPDATE SET is_cancelled=true`,
    [b.groupId, b.date]).catch(() => {});
  await enqueue(req, res, 'training_cancel', b.channel, rec.map((r) => ({ ...r, message: msg })), b.groupId);
}));
api.post('/notifications/time-change', wrap(async (req, res) => {
  const b = z.object({ groupId: uuid, date: z.string(), newTime: z.string(), channel: channelEnum }).parse(req.body);
  const g = (await pool.query(`SELECT name FROM groups WHERE id=$1`, [b.groupId])).rows[0];
  if (!g) throw new ApiError(404, 'NOT_FOUND', 'Grup bulunamadı');
  const msg = `Sayın veli, ${fmtDate(b.date)} günü ${g.name} antrenman saati ${b.newTime} olarak değişmiştir.`;
  const rec = await recipientsForGroup(b.groupId, b.channel);
  await enqueue(req, res, 'time_change', b.channel, rec.map((r) => ({ ...r, message: msg })), b.groupId);
}));
api.post('/notifications/custom', wrap(async (req, res) => {
  const b = z.object({ groupId: uuid, message: z.string().min(1).max(1000), channel: channelEnum }).parse(req.body);
  const rec = await recipientsForGroup(b.groupId, b.channel);
  await enqueue(req, res, 'custom', b.channel, rec.map((r) => ({ ...r, message: b.message })), b.groupId);
}));
api.post('/notifications/fee-reminder', financeAccess, wrap(async (req, res) => {
  const b = z.object({ studentIds: z.array(uuid).optional(), allDebtors: z.boolean().optional(), minDebt: z.number().optional(),
    channel: channelEnum.default('whatsapp') }).parse(req.body);
  const rows = (await pool.query(
    `SELECT s.first_name AS student, b.debt::float AS debt, g.id AS "guardianId", g.phone, g.full_name AS "guardianName"
     FROM (${BAL}) b JOIN students s ON s.id=b.student_id
     JOIN LATERAL (SELECT g.* FROM student_guardians sg JOIN guardians g ON g.id=sg.guardian_id WHERE sg.student_id=s.id
                   ORDER BY sg.is_primary DESC LIMIT 1) g ON TRUE
     WHERE s.is_active AND b.debt > GREATEST($1::numeric, 0) AND ($2::uuid[] IS NULL OR s.id = ANY($2))`,
    [b.minDebt || 0, b.allDebtors ? null : (b.studentIds || [])])).rows;
  const items = rows.map((r) => ({ ...r, message: `Sayın ${r.guardianName}, ${r.student} için ${fmtTL(r.debt)} aidat borcu bulunmaktadır. Müsait olduğunuzda ödemenizi rica ederiz. Teşekkürler.` }));
  await enqueue(req, res, 'fee_reminder', b.channel, items, null);
}));
api.get('/notifications', wrap(async (req, res) => {
  const { p, l, offset } = page(req);
  const { rows } = await pool.query(
    `SELECT n.id, n.type, n.channel, n.phone, n.message, n.status, n.error, n.created_at AS "createdAt", n.sent_at AS "sentAt"
     FROM notifications n WHERE ($1::text IS NULL OR n.status::text=$1) ORDER BY n.created_at DESC LIMIT ${l} OFFSET ${offset}`,
    [req.query.status || null]);
  const sum = (await pool.query(
    `SELECT COUNT(*) FILTER (WHERE status='pending' OR status='sending')::int pending, COUNT(*) FILTER (WHERE status='sent')::int sent,
            COUNT(*) FILTER (WHERE status='failed')::int failed FROM notifications`)).rows[0];
  ok(res, rows, { page: p, limit: l, ...sum });
}));
api.post('/notifications/:id/retry', wrap(async (req, res) => {
  await pool.query(`UPDATE notifications SET status='pending', error=NULL WHERE id=$1 AND status='failed'`, [uuid.parse(req.params.id)]);
  ok(res, { id: req.params.id });
}));

// ---------- worker (aynı süreçte; üretimde ayrı süreç olabilir) ----------
async function workerTick() {
  const { rows } = await pool.query(
    `UPDATE notifications SET status='sending' WHERE id IN (
       SELECT id FROM notifications WHERE status='pending' ORDER BY created_at LIMIT 20 FOR UPDATE SKIP LOCKED) RETURNING *`);
  for (const n of rows) {
    try {
      if (BOT_WEBHOOK_URL) {
        const r = await fetch(BOT_WEBHOOK_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: n.channel, to: n.phone, text: n.message }), signal: AbortSignal.timeout(10000) });
        if (!r.ok) throw new Error('Bot yanıtı: ' + r.status);
      } else {
        console.log(`[SİMÜLASYON ${n.channel}] ${n.phone}: ${n.message}`);   // BOT_WEBHOOK_URL yoksa gerçek gönderim yapılmaz
      }
      await pool.query(`UPDATE notifications SET status='sent', sent_at=now(), error=$2 WHERE id=$1`, [n.id, BOT_WEBHOOK_URL ? null : 'simülasyon (bot bağlı değil)']);
    } catch (e) {
      await pool.query(`UPDATE notifications SET status='failed', error=$2 WHERE id=$1`, [n.id, e.message]);
    }
  }
}

// ---------- statik arayüz + hata ----------
app.use(express.static(path.join(__dirname, 'web')));
api.use((req, res, next) => next(new ApiError(404, 'NOT_FOUND', 'Uç nokta yok')));
app.use((err, req, res, next) => {
  if (err instanceof ZodError) {
    return res.status(400).json({ error: { code: 'VALIDATION_ERROR', message: err.issues[0]?.message || 'Geçersiz veri', details: err.issues } });
  }
  if (err instanceof ApiError) return res.status(err.status).json({ error: { code: err.code, message: err.message } });
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: { code: 'BAD_JSON', message: 'Geçersiz JSON' } });
  console.error(err);
  res.status(500).json({ error: { code: 'INTERNAL', message: 'Sunucu hatası' } });
});

(async () => {
  pool = await db.start();
  setInterval(() => workerTick().catch((e) => console.error('worker', e.message)), 4000);
  app.listen(PORT, '0.0.0.0', () => console.log(`API+Web hazır: http://localhost:${PORT}`));
  const bye = async () => { await db.stop(); process.exit(0); };
  process.on('SIGINT', bye); process.on('SIGTERM', bye);
})();
