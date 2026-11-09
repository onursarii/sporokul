CREATE EXTENSION IF NOT EXISTS "pgcrypto";

CREATE TYPE user_role AS ENUM ('admin', 'coach');
CREATE TYPE payment_method AS ENUM ('cash', 'eft', 'other');
CREATE TYPE attendance_status AS ENUM ('present', 'absent', 'excused', 'late');
CREATE TYPE charge_status AS ENUM ('open', 'partial', 'paid', 'void');
CREATE TYPE notif_type AS ENUM ('training_cancel', 'time_change', 'fee_reminder', 'custom');
CREATE TYPE notif_channel AS ENUM ('whatsapp', 'telegram');
CREATE TYPE notif_status AS ENUM ('pending', 'sending', 'sent', 'failed');

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL,
  role user_role NOT NULL DEFAULT 'coach',
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE groups (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  min_age SMALLINT NOT NULL,
  max_age SMALLINT NOT NULL,
  coach_id UUID REFERENCES users(id),
  schedule TEXT,
  monthly_fee NUMERIC(10,2) NOT NULL DEFAULT 0,
  is_active BOOLEAN NOT NULL DEFAULT TRUE
);

CREATE TABLE students (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  first_name TEXT NOT NULL,
  last_name TEXT NOT NULL,
  birth_date DATE NOT NULL,
  group_id UUID REFERENCES groups(id),
  health_notes TEXT,
  allergies TEXT,
  blood_type TEXT,
  monthly_fee NUMERIC(10,2),
  is_active BOOLEAN NOT NULL DEFAULT TRUE,
  enrolled_at DATE NOT NULL DEFAULT CURRENT_DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX idx_students_group ON students(group_id) WHERE is_active;

CREATE TABLE guardians (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  full_name TEXT NOT NULL,
  phone TEXT NOT NULL,
  telegram_chat_id TEXT,
  whatsapp_opt_in BOOLEAN NOT NULL DEFAULT TRUE,
  email TEXT
);

CREATE TABLE student_guardians (
  student_id UUID REFERENCES students(id) ON DELETE CASCADE,
  guardian_id UUID REFERENCES guardians(id) ON DELETE CASCADE,
  relation TEXT,
  is_emergency BOOLEAN NOT NULL DEFAULT TRUE,
  is_primary BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (student_id, guardian_id)
);

CREATE TABLE sessions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  group_id UUID NOT NULL REFERENCES groups(id),
  session_date DATE NOT NULL,
  start_time TIME,
  is_cancelled BOOLEAN NOT NULL DEFAULT FALSE,
  created_by UUID REFERENCES users(id),
  UNIQUE (group_id, session_date)
);

CREATE TABLE attendance (
  session_id UUID REFERENCES sessions(id) ON DELETE CASCADE,
  student_id UUID REFERENCES students(id),
  status attendance_status NOT NULL DEFAULT 'present',
  note TEXT,
  marked_by UUID REFERENCES users(id),
  marked_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (session_id, student_id)
);

CREATE TABLE charges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id),
  period DATE NOT NULL,
  description TEXT NOT NULL DEFAULT 'Aylık aidat',
  amount NUMERIC(10,2) NOT NULL CHECK (amount >= 0),
  due_date DATE NOT NULL,
  status charge_status NOT NULL DEFAULT 'open',
  UNIQUE (student_id, period, description)
);
CREATE INDEX idx_charges_status ON charges(status, due_date);

CREATE TABLE payments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id UUID NOT NULL REFERENCES students(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  method payment_method NOT NULL,
  paid_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  reference TEXT,
  note TEXT,
  received_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ
);
CREATE INDEX idx_payments_student ON payments(student_id);

-- Hangi ödeme hangi tahakkuğu ne kadar kapattı
CREATE TABLE payment_allocations (
  payment_id UUID NOT NULL REFERENCES payments(id) ON DELETE CASCADE,
  charge_id UUID NOT NULL REFERENCES charges(id),
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  PRIMARY KEY (payment_id, charge_id)
);

CREATE TABLE expenses (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  category TEXT NOT NULL,
  amount NUMERIC(10,2) NOT NULL CHECK (amount > 0),
  spent_at DATE NOT NULL DEFAULT CURRENT_DATE,
  description TEXT,
  created_by UUID REFERENCES users(id),
  voided_at TIMESTAMPTZ
);

CREATE TABLE notifications (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type notif_type NOT NULL,
  channel notif_channel NOT NULL,
  guardian_id UUID REFERENCES guardians(id),
  phone TEXT,
  group_id UUID REFERENCES groups(id),
  message TEXT NOT NULL,
  status notif_status NOT NULL DEFAULT 'pending',
  error TEXT,
  created_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  sent_at TIMESTAMPTZ
);

CREATE TABLE audit_log (
  id BIGSERIAL PRIMARY KEY,
  user_id UUID, action TEXT, entity TEXT, entity_id UUID,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
