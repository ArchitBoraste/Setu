import { pool } from "./index.js";
import { seedDemoData } from "./demoData.js";

// `npm run demo:reset`: back to a clean demo between rehearsals.
//
// Deletes every collected record, every conflict and every refresh token — in
// every organisation in this database, not only the demo one — and then runs
// the seed. Users, organisations and areas are kept (the seed makes sure the
// demo ones are right).
//
// These are hard DELETEs, which the rest of the system never does to records:
// a device that still holds a copy will never be told the row is gone. That is
// acceptable only because a reset is always followed by resetting every browser
// used in the demo. See the run sheet.
//
// Wipe and seed are one transaction. If the seed fails, nothing is deleted.

async function main() {
  // A development convenience only. It must not be one mistyped command away
  // from destroying a real organisation's field data.
  if (process.env.NODE_ENV === "production") {
    throw new Error("demo:reset refuses to run with NODE_ENV=production.");
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    // Conflicts first: they reference records with a RESTRICT foreign key.
    const [conflicts] = await conn.query(`DELETE FROM record_conflicts`);
    const [records] = await conn.query(`DELETE FROM records`);
    // Every device has to sign in again after a reset. Old sessions would
    // otherwise keep syncing phones whose copies no longer exist here.
    const [tokens] = await conn.query(`DELETE FROM refresh_tokens`);

    const lines = await seedDemoData(conn);
    await conn.commit();

    console.log(
      `Wiped database "${process.env.DB_NAME}": ${records.affectedRows} records, ` +
        `${conflicts.affectedRows} conflicts, ${tokens.affectedRows} refresh tokens.`
    );
    for (const line of lines) console.log(line);
    console.log(
      "Now reset every browser used in the demo (see the run sheet) — they still " +
        "hold copies of the records that were just deleted."
    );
  } catch (error) {
    await conn.rollback();
    throw error;
  } finally {
    conn.release();
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err.message ?? err);
  process.exit(1);
});
