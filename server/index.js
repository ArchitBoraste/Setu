import express from "express";

const app = express();
const PORT = process.env.PORT || 5000;

app.use(express.json()); // parse JSON request bodies

app.get("/health", (req, res) => {
  res.json({ status: "ok" });
});

app.listen(PORT, () => {
  console.log(`Setu server running on http://localhost:${PORT}`);
});