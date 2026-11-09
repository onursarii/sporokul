// Demo verisi (tamamen kurgusal)
const bcrypt = require('bcryptjs');

const FIRST = ['Ali','Ahmet','Mehmet','Mustafa','Emir','Yusuf','Kerem','Efe','Arda','Can','Ayşe','Zeynep','Elif','Defne','Ecrin','Asya','Ada','Deniz','Burak','Barış','Eren','Mira','Selin','Ceren','Onur'];
const LAST = ['Yılmaz','Kaya','Demir','Çelik','Şahin','Yıldız','Aydın','Özdemir','Arslan','Doğan','Koç','Aksoy'];
const ALLERGY = [null,null,null,null,null,'Fıstık','Arı sokması','Penisilin','Polen'];
const HEALTH = [null,null,null,null,null,null,'Astım','Epilepsi (kontrollü)','Şeker hastalığı (Tip 1)'];

module.exports = async function seed(pool) {
  const hash = await bcrypt.hash('demo1234', 10);
  const admin = (await pool.query(
    `INSERT INTO users(full_name,email,password_hash,role) VALUES
     ('Yönetici Demo','admin@demo.com',$1,'admin'),
     ('Antrenör Ahmet','coach@demo.com',$1,'coach') RETURNING id`, [hash])).rows;
  const coach = admin[1].id;

  const groups = [];
  for (const [name, min, max, sched, fee] of [
    ['U8 Salı-Perşembe', 6, 8, 'Sal-Per 16:00', 1200],
    ['U11 Pazartesi-Çarşamba', 9, 11, 'Pzt-Çar 17:30', 1500],
    ['U15 Salı-Cuma', 12, 15, 'Sal-Cum 19:00', 1800],
  ]) {
    groups.push((await pool.query(
      `INSERT INTO groups(name,min_age,max_age,coach_id,schedule,monthly_fee) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
      [name, min, max, coach, sched, fee])).rows[0]);
  }

  let seedN = 7;
  const rnd = (n) => { seedN = (seedN * 9301 + 49297) % 233280; return Math.floor((seedN / 233280) * n); };
  const now = new Date();
  const students = [];
  for (let i = 0; i < 36; i++) {
    const g = groups[i % 3];
    const age = g.min_age + rnd(g.max_age - g.min_age + 1);
    const bd = new Date(now.getFullYear() - age, rnd(12), 1 + rnd(27));
    const fn = FIRST[rnd(FIRST.length)], ln = LAST[rnd(LAST.length)];
    const s = (await pool.query(
      `INSERT INTO students(first_name,last_name,birth_date,group_id,health_notes,allergies,blood_type)
       VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING id`,
      [fn, ln, bd.toISOString().slice(0, 10), g.id, HEALTH[rnd(HEALTH.length)], ALLERGY[rnd(ALLERGY.length)],
       ['A+','0+','B+','AB+','A-','0-'][rnd(6)]])).rows[0];
    students.push({ id: s.id, group: g });
    const phone = '+90555' + String(1000000 + rnd(8999999));
    const gd = (await pool.query(
      `INSERT INTO guardians(full_name,phone) VALUES($1,$2) RETURNING id`,
      [(rnd(2) ? 'Ayşe ' : 'Mehmet ') + ln, phone])).rows[0];
    await pool.query(`INSERT INTO student_guardians VALUES($1,$2,$3,true,true)`, [s.id, gd.id, rnd(2) ? 'anne' : 'baba']);
    if (rnd(2)) {
      const gd2 = (await pool.query(
        `INSERT INTO guardians(full_name,phone) VALUES($1,$2) RETURNING id`,
        ['Fatma ' + ln, '+90532' + String(1000000 + rnd(8999999))])).rows[0];
      await pool.query(`INSERT INTO student_guardians VALUES($1,$2,'büyükanne',true,false)`, [s.id, gd2.id]);
    }
  }

  // Son 3 ay tahakkuk, bazı öğrencilere ödeme
  for (let m = 2; m >= 0; m--) {
    const period = new Date(now.getFullYear(), now.getMonth() - m, 1);
    const due = new Date(now.getFullYear(), now.getMonth() - m, 10);
    for (const st of students) {
      const ch = (await pool.query(
        `INSERT INTO charges(student_id,period,amount,due_date) VALUES($1,$2,$3,$4) RETURNING id,amount`,
        [st.id, period, st.group.monthly_fee, due])).rows[0];
      const pays = rnd(10) < (m === 0 ? 4 : 8);   // eski aylar çoğunlukla ödenmiş
      if (pays) {
        const p = (await pool.query(
          `INSERT INTO payments(student_id,amount,method,paid_at,received_by) VALUES($1,$2,$3,$4,$5) RETURNING id`,
          [st.id, ch.amount, rnd(2) ? 'cash' : 'eft', due, admin[0].id])).rows[0];
        await pool.query(`INSERT INTO payment_allocations VALUES($1,$2,$3)`, [p.id, ch.id, ch.amount]);
        await pool.query(`UPDATE charges SET status='paid' WHERE id=$1`, [ch.id]);
      }
    }
  }

  for (const [cat, amt, d] of [['Saha kirası', 3000, 3], ['Su', 250, 5], ['Ekipman', 900, 8]]) {
    await pool.query(
      `INSERT INTO expenses(category,amount,spent_at,description,created_by) VALUES($1,$2,CURRENT_DATE - $3::int,'demo',$4)`,
      [cat, amt, d, admin[0].id]);
  }
};
