import express from "express";
import cors from "cors";
import { pool } from "./db/index.js";
import authRoutes from "./routes/auth.js";
import syncRoutes from "./routes/sync.js";
import conflictRoutes from "./routes/conflicts.js";

// Last-resort visibility. `node --watch` clears the terminal when it restarts
// a crashed process, so without these a fatal error can scroll away before it
// is ever read — which is how a crash looks like "nothing in the terminal".
process.on("unhandledRejection", (reason) => {
  // With asyncHandler in place a rejecting route no longer lands here; anything
  // that still does is a promise nobody is awaiting, so log it and stay up.
  console.error("[unhandledRejection]", reason);
});

process.on("uncaughtException", (err) => {
  // Process state is not trustworthy after this, so log and let the supervisor
  // (node --watch / nodemon) restart us cleanly rather than limping on.
  console.error("[uncaughtException]", err);
  process.exit(1);
});

const app = express();
const PORT = process.env.PORT || 5000;

// allow the Vite dev server to call the API directly if it ever bypasses the proxy
// in case proxy fails, we shall allow route of the origin: "http://localhost:5173" to access the
// express backend for data not just any random site
//by default it will not give away some sensitive data...by setting credentials:true we are 
//making sure all data is actually given to the react frontend
app.use(cors({ origin: "http://localhost:5173", credentials: true }));

app.use(express.json({ limit: "5mb" })); //raising above the default limit as field records can carry compressed photos later

// The service worker routes /api as NetworkOnly, but that only keeps responses
// out of the *service worker's* cache. The browser's own HTTP cache is a separate
// store the worker never sees, and without a directive it is free to reuse a
// response heuristically — which could hand a field worker another user's
// profile after a device handover, or a stale record they just edited. One
// header on the whole prefix is easier to keep right than per-route rules.
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  next();
});

// every API route lives under /api so the proxy has one clean prefix to match
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "setu-server",
    time: new Date().toISOString(),
  });
});

app.get("/api/db-health", async (req, res) => {
  try {
    // We ask Driver #1 from the pool to run a simple command
    const [rows] = await pool.query("SHOW TABLES;");
    
    res.json({
      message: "Database connection successful!",
      tables: rows
    });
  } catch (error) {
    console.error("Database connection failed:", error);
    res.status(500).json({ error: error.message });
  }
});

app.use("/api/auth", authRoutes);
app.use("/api/sync", syncRoutes);
// Mounted apart from /api/sync on purpose: these are a supervisor reviewing a
// decision, not a device moving data, and unlike everything under /api/sync they
// are online-only by design (see sync/conflictRules.js).
app.use("/api/conflicts", conflictRoutes);

// 404 handler — anything not matched above
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Error handler. The four arguments are what mark this as Express's error
// middleware, so `next` must stay in the signature even though it is only used
// for the headers-already-sent case. Everything asyncHandler catches ends here.
app.use((err, req, res, next) => {
  console.error(`[error] ${req.method} ${req.originalUrl}`, err);

  // response already streaming — hand back to Express to close the socket
  if (res.headersSent) return next(err);

  const status = err.status || err.statusCode || 500;

  res.status(status).json({
    error: status >= 500 ? "Internal server error" : err.message,
    // the message is useful while developing but can leak internals in prod
    ...(process.env.NODE_ENV === "production" ? {} : { detail: err.message }),
  });
});

app.listen(PORT, () => {
  console.log(`Setu server running on http://localhost:${PORT}`);
});