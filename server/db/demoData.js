import crypto from "crypto";
import bcrypt from "bcryptjs";

// The demo organisation, its one area, and the four people in the demo.
//
// IDEMPOTENT: run it once or ten times and the database ends up the same, with
// one organisation, one "Wadgaon" and one row per phone number. Everything is
// looked up by its natural key first — organisation by name, area by
// (organisation, name), user by phone — and written only if it is missing or
// differs, so a second run changes nothing at all.
//
// The seed used to INSERT unconditionally. Run twice, it created a second
// "Demo Health Organisation", and the people seeded into it could not see the
// first one's records. When several organisations carry the demo name, the
// OLDEST is the demo organisation; a demo user found in another one is moved
// into it, but only if nothing they have done is filed under the other
// organisation — see moveBlockedBy().

const ORG_NAME = "Demo Health Organisation";
const AREA_NAME = "Wadgaon";

const BCRYPT_ROUNDS = 12;

// A password is used only to CREATE an account. An account that already exists
// keeps the password it has: a seed that quietly reset credentials every time
// it ran would undo anyone who changed them. If it no longer matches the one
// below, the seed says so instead.
const DEMO_USERS = [
  {
    fullName: "Archit Boraste",
    phone: "9999999999",
    password: "Admin@123", // change this after first login
    role: "admin",
    area: null,
  },
  {
    fullName: "Field Worker A",
    phone: "8888888888",
    password: "Worker@123",
    role: "field_worker",
    area: AREA_NAME,
  },
  {
    fullName: "Field Worker B",
    phone: "7777777777",
    password: "Worker@123",
    role: "field_worker",
    area: AREA_NAME,
  },
  // No area: a supervisor sees the whole organisation whatever area they have.
  {
    fullName: "Supervisor",
    phone: "6666666666",
    password: "Supervisor@123",
    role: "supervisor",
    area: null,
  },
];

async function ensureOrganisation(conn, log) {
  const [orgs] = await conn.query(
    `SELECT id FROM organizations
      WHERE name = ? AND deleted_at IS NULL
      ORDER BY created_at ASC, id ASC`,
    [ORG_NAME]
  );

  if (orgs.length > 1) {
    log(
      `Found ${orgs.length} organisations named "${ORG_NAME}". Using the oldest ` +
        `(${orgs[0].id}); the others are left as they are.`
    );
  }
  if (orgs.length > 0) return orgs[0].id;

  const id = crypto.randomUUID();
  await conn.query(`INSERT INTO organizations (id, name) VALUES (?, ?)`, [id, ORG_NAME]);
  log(`Created organisation "${ORG_NAME}".`);
  return id;
}

async function ensureArea(conn, organizationId, name, log) {
  const [[existing]] = await conn.query(
    `SELECT id FROM areas WHERE organization_id = ? AND name = ?`,
    [organizationId, name]
  );
  if (existing) return existing.id;

  const id = crypto.randomUUID();
  await conn.query(`INSERT INTO areas (id, organization_id, name) VALUES (?, ?, ?)`, [
    id,
    organizationId,
    name,
  ]);
  log(`Created area "${name}".`);
  return id;
}

/**
 * Why this user cannot be moved to another organisation, or null.
 *
 * A record's organisation is fixed when it is written. Moving the person who
 * captured, changed or disputed it would leave it filed under an organisation
 * they no longer belong to — out of their own pull, and out of every
 * supervisor's view who shares their new organisation.
 */
async function moveBlockedBy(conn, userId) {
  const [[{ records }]] = await conn.query(
    `SELECT COUNT(*) AS records FROM records WHERE created_by = ? OR updated_by = ?`,
    [userId, userId]
  );
  const [[{ conflicts }]] = await conn.query(
    `SELECT COUNT(*) AS conflicts FROM record_conflicts
      WHERE submitted_by = ? OR resolved_by = ?`,
    [userId, userId]
  );
  if (records === 0 && conflicts === 0) return null;
  return `${records} record(s) and ${conflicts} conflict(s)`;
}

async function ensureUser(conn, spec, organizationId, areaId, log) {
  const [[existing]] = await conn.query(
    `SELECT id, organization_id AS organizationId, full_name AS fullName, role,
            area_id AS areaId, is_active AS isActive, deleted_at AS deletedAt,
            password_hash AS passwordHash
       FROM users WHERE phone = ?`,
    [spec.phone]
  );

  if (!existing) {
    await conn.query(
      `INSERT INTO users
         (id, organization_id, full_name, phone, password_hash, role, area_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        crypto.randomUUID(),
        organizationId,
        spec.fullName,
        spec.phone,
        await bcrypt.hash(spec.password, BCRYPT_ROUNDS),
        spec.role,
        areaId,
      ]
    );
    log(`Created ${spec.fullName}. Sign in with ${spec.phone} / ${spec.password}`);
    return;
  }

  if (existing.organizationId !== organizationId) {
    const blocked = await moveBlockedBy(conn, existing.id);
    if (blocked) {
      throw new Error(
        `${spec.fullName} (${spec.phone}) belongs to another organisation and has ` +
          `${blocked} there, so the seed will not move them. Run ` +
          `"npm run demo:reset" to start the demo data from empty instead.`
      );
    }
  }

  const drifted =
    existing.organizationId !== organizationId ||
    existing.fullName !== spec.fullName ||
    existing.role !== spec.role ||
    existing.areaId !== areaId ||
    existing.isActive !== 1 ||
    existing.deletedAt !== null;

  if (drifted) {
    await conn.query(
      `UPDATE users
          SET organization_id = ?, full_name = ?, role = ?, area_id = ?,
              is_active = 1, deleted_at = NULL
        WHERE id = ?`,
      [organizationId, spec.fullName, spec.role, areaId, existing.id]
    );
    log(`Updated ${spec.fullName} (${spec.phone}).`);
  }

  if (!(await bcrypt.compare(spec.password, existing.passwordHash))) {
    log(
      `WARNING: ${spec.fullName} (${spec.phone}) exists with a password other than ` +
        `"${spec.password}". It was left unchanged.`
    );
  }
}

/**
 * Ensures the demo organisation, area and users exist, on the connection
 * given. The caller owns the transaction, so a reset can wipe and re-seed as
 * one unit: if the seed fails, the wipe is rolled back with it.
 *
 * @returns {Promise<string[]>} what it did, one line per change
 */
export async function seedDemoData(conn) {
  const lines = [];
  const log = (line) => lines.push(line);

  const organizationId = await ensureOrganisation(conn, log);
  const areaIds = new Map();

  for (const spec of DEMO_USERS) {
    let areaId = null;
    if (spec.area) {
      if (!areaIds.has(spec.area)) {
        areaIds.set(spec.area, await ensureArea(conn, organizationId, spec.area, log));
      }
      areaId = areaIds.get(spec.area);
    }
    await ensureUser(conn, spec, organizationId, areaId, log);
  }

  if (lines.length === 0) lines.push("Demo data already in place. Nothing changed.");
  return lines;
}
