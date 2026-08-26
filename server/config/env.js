import "dotenv/config";

// fail at boot if something is missing, instead of getting undefined at runtime
const required = ["DB_HOST", "DB_USER", "DB_NAME", "JWT_SECRET"];
const missing = required.filter((key) => !process.env[key]);

if (missing.length > 0) {
  console.error(`Missing environment variables: ${missing.join(", ")}`);
  process.exit(1);
}

export const config = {
  port: Number(process.env.PORT) || 5000,
  db: {
    host: process.env.DB_HOST,
    port: Number(process.env.DB_PORT) || 3306,
    user: process.env.DB_USER,
    password: process.env.DB_PASSWORD,
    database: process.env.DB_NAME,
  },
  jwt: {
    secret: process.env.JWT_SECRET,
    accessTtl: process.env.ACCESS_TOKEN_TTL || "15m",
    refreshDays: Number(process.env.REFRESH_TOKEN_DAYS) || 30,
  },
};