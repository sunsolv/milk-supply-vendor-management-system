import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const dataDir = path.join(__dirname, "data");
const dataFile = path.join(dataDir, "app-data.json");
const emptyData = {
  vendors: [],
  pendingRegistrations: [],
  customers: [],
  products: [],
  dailySupplies: [],
  reports: [],
};

async function ensureStore() {
  await fs.mkdir(dataDir, { recursive: true });
  try {
    await fs.access(dataFile);
  } catch {
    await fs.writeFile(dataFile, JSON.stringify(emptyData, null, 2));
  }
}

export async function readLocalStore() {
  await ensureStore();
  const raw = await fs.readFile(dataFile, "utf8");
  const parsed = raw ? JSON.parse(raw) : {};
  return {
    vendors: Array.isArray(parsed.vendors) ? parsed.vendors : [],
    pendingRegistrations: Array.isArray(parsed.pendingRegistrations)
      ? parsed.pendingRegistrations
      : [],
    customers: Array.isArray(parsed.customers) ? parsed.customers : [],
    products: Array.isArray(parsed.products) ? parsed.products : [],
    dailySupplies: Array.isArray(parsed.dailySupplies) ? parsed.dailySupplies : [],
    reports: Array.isArray(parsed.reports) ? parsed.reports : [],
  };
}

export async function writeLocalStore(data) {
  await ensureStore();
  await fs.writeFile(dataFile, JSON.stringify(data, null, 2));
}
