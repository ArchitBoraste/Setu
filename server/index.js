import express from "express";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 5000;

// allow the Vite dev server to call the API directly if it ever bypasses the proxy
// in case proxy fails, we shall allow route of the origin: "http://localhost:5173" to access the
// express backend for data not just any random site
//by default it will not give away some sensitive data...by setting credentials:true we are 
//making sure all data is actually given to the react frontend
app.use(cors({ origin: "http://localhost:5173", credentials: true }));

app.use(express.json({ limit: "5mb" })); //raising above the default limit as field records can carry compressed photos later

// every API route lives under /api so the proxy has one clean prefix to match
app.get("/api/health", (req, res) => {
  res.json({
    status: "ok",
    service: "setu-server",
    time: new Date().toISOString(),
  });
});

// 404 handler — anything not matched above
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

app.listen(PORT, () => {
  console.log(`Setu server running on http://localhost:${PORT}`);
});