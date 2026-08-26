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
  await pool.end();
}

seed().catch((err) => {
  console.error(err);
  process.exit(1);
});