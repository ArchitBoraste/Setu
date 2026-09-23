import crypto from "crypto";
import bcrypt from "bcryptjs";
import { pool } from "./index.js";

const ORG_NAME = "Demo Health Organisation";
const ADMIN = {
  fullName: "Archit Boraste",
  phone: "9999999999",
  password: "Admin@123", // change this after first login
};

async function seed() {
  const orgId = crypto.randomUUID();
  await pool.query(`INSERT INTO organizations (id, name) VALUES (?, ?)`, [
    orgId,
    ORG_NAME,
  ]);

  const passwordHash = await bcrypt.hash(ADMIN.password, 12);

  await pool.query(
    `INSERT INTO users (id, organization_id, full_name, phone, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'admin')`,
    [crypto.randomUUID(), orgId, ADMIN.fullName, ADMIN.phone, passwordHash]
  );

  console.log(`Seeded org and admin. Login with ${ADMIN.phone} / ${ADMIN.password}`);

  const fwPasswordHash = await bcrypt.hash('Worker@123', 12);
  await pool.query(
    `INSERT INTO users (id, organization_id, full_name, phone, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'field_worker')`,
    [crypto.randomUUID(), orgId, 'Field Worker A', '8888888888', fwPasswordHash]
  );
  console.log(`Seeded field worker. Login with 8888888888 / Worker@123`);

  const fw2PasswordHash = await bcrypt.hash('Worker@123', 12);
  await pool.query(
    `INSERT INTO users (id, organization_id, full_name, phone, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'field_worker')`,
    [crypto.randomUUID(), orgId, 'Field Worker B', '7777777777', fw2PasswordHash]
  );
  console.log(`Seeded field worker B. Login with 7777777777 / Worker@123`);

  const supPasswordHash = await bcrypt.hash('Supervisor@123', 12);
  await pool.query(
    `INSERT INTO users (id, organization_id, full_name, phone, password_hash, role)
     VALUES (?, ?, ?, ?, ?, 'supervisor')`,
    [crypto.randomUUID(), orgId, 'Supervisor', '6666666666', supPasswordHash]
  );
  console.log(`Seeded supervisor. Login with 6666666666 / Supervisor@123`);

  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});