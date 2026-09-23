import { pool } from "./index.js";
import { seedDemoData } from "./demoData.js";

// `npm run seed`. Safe to run again: see demoData.js. It never deletes
// anything; to start the demo from empty, use `npm run demo:reset`.

async function main() {
  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();
    const lines = await seedDemoData(conn);
    await conn.commit();
    for (const line of lines) console.log(line);
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
