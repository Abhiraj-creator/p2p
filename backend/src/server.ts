import express from "express";
import cors from "cors";
import { createServer } from "http";
import { Server } from "socket.io";
import { fileURLToPath } from "url";
import { dirname, join, resolve } from "path";
import { existsSync } from "fs";
import { env } from "./config/env.js";
import { errorHandler } from "./middleware/errorHandler.js";
import { SessionManager } from "./socket/sessionManager.js";
import { setupSignaling } from "./socket/signaling.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const distPath = resolve(__dirname, "../../frontend/dist");

const app = express();
// -----------------------
// 1️⃣ CSP middleware – allow local dev connections
// -----------------------
app.use((_req, res, next) => {
  const csp = [
    "default-src 'self'",
    "connect-src 'self' http://localhost:5001 http://localhost:5000 https://p2p-ivac.onrender.com ws://p2p-ivac.onrender.com ws://localhost:5000 ws://localhost:5001",
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
    "img-src 'self' data:",
    "font-src 'self' https://fonts.gstatic.com",
    "frame-src 'self'",
  ].join("; ");

  res.setHeader("Content-Security-Policy", csp);
  next();
});


app.use(
  cors({
    origin: env.clientUrl,
    methods: ["GET", "POST"],
  })
);
app.use(express.json());

// ----------
// 2️⃣ Serve static assets (including .well‑known)
// ----------

app.use(express.static(distPath));
const publicPath = resolve(__dirname, "../../dist");
app.use(express.static(publicPath));

// ----------
// API routes
// ----------
app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "p2p-connect-signaling" });
});

app.get("/", (_req, res) => {
  const indexPath = join(distPath, "index.html");
  if (existsSync(indexPath)) {
    res.sendFile(indexPath);
  } else {
    res.status(404).send("Index not found");
  }
});

// ----------
// 3️⃣ SPA fallback (production only)
// ----------

  app.get("*", (_req, res) => {
    const indexPath = join(distPath, "dist/index.html");
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(500).send("Frontend not built. Check build output.");
    }
  });

// ----------
// Error handling & server start
// ----------
app.use(errorHandler);

const httpServer = createServer(app);
const io = new Server(httpServer, {
  cors: {
    origin: env.clientUrl,
    methods: ["GET", "POST"],
  },
  pingTimeout: 60000,
  pingInterval: 25000,
});

const sessions = new SessionManager();
setupSignaling(io, sessions);

httpServer.listen(env.port, () => {
  console.log(
    `[signaling] listening on :${env.port} (client: ${env.clientUrl})`
  );
});
