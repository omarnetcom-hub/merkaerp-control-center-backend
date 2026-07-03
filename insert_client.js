const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const DB_PATH = './data/control_center.db';
const db = new sqlite3.Database(DB_PATH);

const client = {
  name: 'Fernando Velez',
  nit: '123456789',
  city: 'Medellín',
  country: 'Colombia',
  status: 'active',
  plan: 'Básica',
  contract_value: 120000.0,
  renewal_date: '2026-08-01',
  usage_score: 75,
  created_at: '2026-07-01T00:00:00.000Z',
  reseller_id: null,
  tax_rate: 19.0,
  billing_type: 'mensual',
  billing_day: 5,
  notes: '',
  contact_name: 'Fernando Velez',
  contact_phone: '',
  contact_email: 'fernandovelez@gmail.com',
  contact_role: '',
  password: '123456789f'
};

const sql = `INSERT INTO cc_clients (name, nit, city, country, status, plan, contract_value, renewal_date, usage_score, created_at, reseller_id, tax_rate, billing_type, billing_day, notes, contact_name, contact_phone, contact_email, contact_role, password) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

db.run(sql, [
  client.name,
  client.nit,
  client.city,
  client.country,
  client.status,
  client.plan,
  client.contract_value,
  client.renewal_date,
  client.usage_score,
  client.created_at,
  client.reseller_id,
  client.tax_rate,
  client.billing_type,
  client.billing_day,
  client.notes,
  client.contact_name,
  client.contact_phone,
  client.contact_email,
  client.contact_role,
  client.password
], function(err) {
  if (err) {
    console.error('Error inserting client:', err);
  } else {
    console.log('Client inserted successfully with ID:', this.lastID);
  }
  db.close();
});
