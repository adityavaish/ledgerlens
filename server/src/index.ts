import express from "express";
import cors from "cors";
import fs from "fs";
import os from "os";
import path from "path";
import http from "http";
import https from "https";
import { dataRouter } from "./routes/data";
import { chatRouter } from "./routes/chat";

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));

app.get("/health", (_req, res) => res.json({ ok: true, service: "ledgerlens" }));
app.use("/data", dataRouter);
app.use("/chat", chatRouter);

const port = Number(process.env.PORT ?? 3001);
const certDir = path.join(os.homedir(), ".office-addin-dev-certs");
const certPath = path.join(certDir, "localhost.crt");
const keyPath = path.join(certDir, "localhost.key");

if (fs.existsSync(certPath) && fs.existsSync(keyPath)) {
  https
    .createServer({ cert: fs.readFileSync(certPath), key: fs.readFileSync(keyPath) }, app)
    .listen(port, () => console.log(`[ledgerlens] api listening on https://localhost:${port}`));
} else {
  http
    .createServer(app)
    .listen(port, () => console.log(`[ledgerlens] api listening on http://localhost:${port} (no dev cert)`));
}
