import "dotenv/config";
import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connectDatabase } from "./database.js";
import apiRoutes from "./routes.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const app = express();
const port = Number(process.env.PORT || 5173);
const isProduction = process.env.NODE_ENV === "production";

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use("/api", apiRoutes);

if (isProduction) {
  const distDir = path.join(rootDir, "dist");
  app.use(express.static(distDir));
  app.use((req, res, next) => {
    if (req.method !== "GET" || req.path.startsWith("/api")) return next();
    return res.sendFile(path.join(distDir, "index.html"));
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: rootDir,
    appType: "spa",
    server: { middlewareMode: true },
  });
  app.use(vite.middlewares);
}

try {
  await connectDatabase();
  app.listen(port, "127.0.0.1", () => {
    console.log(`Milk Supply Vendor Management System running at http://127.0.0.1:${port}/`);
  });
} catch (error) {
  console.error("Server failed to start:", error);
  process.exit(1);
}
