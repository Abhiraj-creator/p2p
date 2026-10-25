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

app.use(
  cors({
    origin: env.clientUrl,
    methods: ["GET", "POST"],
  }),
);
app.use(express.json());

// Serve frontend static files in production
if (env.nodeEnv === "production") {
  app.use(express.static(distPath));
}

app.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "p2p-connect-signaling" });
});
app.get('/', (_req, res) => {
  res.send('hello world')
})

// Serve everything under ./public (including .well-known)
const publicPath = resolve(__dirname, "../../public");
app.use(express.static(publicPath));

// Now the request to http://localhost:5000/.well-known/... works automatically.

// ------------------------------------------------
// CSP middleware – allow local dev connections
// ------------------------------------------------
app.use((_req, res, next) => {
  const csp = [
    "default-src 'self'",
    // allow fetch/XHR to the dev server
    "connect-src 'self' http://localhost:5000",
    // allow scripts, styles, images from self
    "script-src 'self'",
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    // optional: allow fonts, websockets, etc.
    "font-src 'self'",
    "frame-src 'self'",
  ].join('; ');

  res.setHeader('Content-Security-Policy', csp);
  next();
});

// Catch-all: serve index.html for SPA routes (production only)
if (env.nodeEnv === "production") {
  app.get("*", (_req, res) => {
    const indexPath = join(distPath, "index.html");
    if (existsSync(indexPath)) {
      res.sendFile(indexPath);
    } else {
      res.status(500).send("Frontend not built. Check build output.");
    }
  });
}

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
  console.log(`[signaling] listening on :${env.port} (client: ${env.clientUrl})`);
});
