import mongoose from "mongoose";
import Vendor from "./models/Vendor.js";
import PendingRegistration from "./models/PendingRegistration.js";
import Customer from "./models/Customer.js";
import Product from "./models/Product.js";
import DailySupply from "./models/DailySupply.js";
import Report from "./models/Report.js";
import { readLocalStore, writeLocalStore } from "./localStore.js";

let mongoEnabled = false;

function serialize(doc) {
  if (!doc) return null;
  const value = typeof doc.toObject === "function" ? doc.toObject() : doc;
  return {
    ...value,
    _id: undefined,
    __v: undefined,
  };
}

function normalizeVendor(vendor) {
  if (!vendor) return null;
  return {
    customerLimit: 0,
    productLimit: 0,
    currentCustomerCount: 0,
    currentProductCount: 0,
    approvedBy: "",
    rejectionReason: "",
    phonePeGPayNumber: "",
    upiId: "",
    shopAddress: "",
    shopLocation: "",
    fssaiNumber: "",
    resetPasswordTokenHash: "",
    resetPasswordExpiresAt: null,
    ...vendor,
  };
}

export async function connectDatabase() {
  if (!process.env.MONGODB_URI) {
    console.warn("MONGODB_URI is not set. Using local JSON storage for development.");
    return;
  }

  await mongoose.connect(process.env.MONGODB_URI);
  mongoEnabled = true;
  console.log("Connected to MongoDB.");
}

export function isMongoEnabled() {
  return mongoEnabled;
}

export async function findVendorByEmail(email) {
  if (mongoEnabled) return serialize(await Vendor.findOne({ email }).lean());
  const data = await readLocalStore();
  return normalizeVendor(data.vendors.find((vendor) => vendor.email === email) || null);
}

export async function findVendorByMobile(mobileNumber) {
  if (mongoEnabled) return serialize(await Vendor.findOne({ mobileNumber }).lean());
  const data = await readLocalStore();
  return normalizeVendor(data.vendors.find((vendor) => vendor.mobileNumber === mobileNumber) || null);
}

export async function findVendorById(id) {
  if (mongoEnabled) return serialize(await Vendor.findOne({ id }).lean());
  const data = await readLocalStore();
  return normalizeVendor(data.vendors.find((vendor) => vendor.id === id) || null);
}

export async function findVendorByResetTokenHash(resetPasswordTokenHash) {
  if (mongoEnabled) {
    return serialize(await Vendor.findOne({ resetPasswordTokenHash }).lean());
  }
  const data = await readLocalStore();
  return normalizeVendor(
    data.vendors.find((vendor) => vendor.resetPasswordTokenHash === resetPasswordTokenHash) ||
      null,
  );
}

export async function listVendors() {
  if (mongoEnabled) {
    const vendors = await Vendor.find({}).sort({ createdAt: -1 }).lean();
    return vendors.map(serialize);
  }
  const data = await readLocalStore();
  return data.vendors
    .map(normalizeVendor)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

export async function createVendor(vendor) {
  if (mongoEnabled) return serialize(await Vendor.create(vendor));
  const data = await readLocalStore();
  data.vendors.push(vendor);
  await writeLocalStore(data);
  return vendor;
}

export async function updateVendorById(id, patch) {
  const nextPatch = {
    ...patch,
    updatedAt: new Date().toISOString(),
  };
  if (mongoEnabled) {
    return serialize(await Vendor.findOneAndUpdate({ id }, nextPatch, { new: true }).lean());
  }

  const data = await readLocalStore();
  data.vendors = data.vendors.map((vendor) =>
    vendor.id === id ? normalizeVendor({ ...vendor, ...nextPatch }) : vendor,
  );
  await writeLocalStore(data);
  return data.vendors.find((vendor) => vendor.id === id) || null;
}

export async function findPendingRegistrationByEmail(email) {
  if (mongoEnabled) return serialize(await PendingRegistration.findOne({ email }).lean());
  const data = await readLocalStore();
  return data.pendingRegistrations.find((item) => item.email === email) || null;
}

export async function listPendingRegistrations() {
  if (mongoEnabled) {
    const pendingRegistrations = await PendingRegistration.find({}).sort({ createdAt: -1 }).lean();
    return pendingRegistrations.map(serialize);
  }
  const data = await readLocalStore();
  return [...data.pendingRegistrations].sort(
    (a, b) => new Date(b.createdAt) - new Date(a.createdAt),
  );
}

export async function upsertPendingRegistration(pendingRegistration) {
  if (mongoEnabled) {
    return serialize(
      await PendingRegistration.findOneAndUpdate(
        { email: pendingRegistration.email },
        pendingRegistration,
        { new: true, upsert: true, setDefaultsOnInsert: true },
      ).lean(),
    );
  }

  const data = await readLocalStore();
  data.pendingRegistrations = data.pendingRegistrations.filter(
    (item) => item.email !== pendingRegistration.email,
  );
  data.pendingRegistrations.push(pendingRegistration);
  await writeLocalStore(data);
  return pendingRegistration;
}

export async function updatePendingRegistration(email, patch) {
  if (mongoEnabled) {
    return serialize(
      await PendingRegistration.findOneAndUpdate({ email }, patch, { new: true }).lean(),
    );
  }

  const data = await readLocalStore();
  data.pendingRegistrations = data.pendingRegistrations.map((item) =>
    item.email === email ? { ...item, ...patch } : item,
  );
  await writeLocalStore(data);
  return data.pendingRegistrations.find((item) => item.email === email) || null;
}

export async function deletePendingRegistration(email) {
  if (mongoEnabled) {
    await PendingRegistration.deleteOne({ email });
    return;
  }

  const data = await readLocalStore();
  data.pendingRegistrations = data.pendingRegistrations.filter((item) => item.email !== email);
  await writeLocalStore(data);
}

function sortNewest(items) {
  return [...items].sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
}

function latestTimestamp(item) {
  return new Date(item.updatedAt || item.createdAt || 0).getTime();
}

function dedupeDailySupplies(items) {
  const latestByKey = new Map();
  items.forEach((item) => {
    const key = [item.vendorId, item.customerId, item.productId, item.date].join("|");
    const current = latestByKey.get(key);
    if (!current || latestTimestamp(item) >= latestTimestamp(current)) {
      latestByKey.set(key, item);
    }
  });
  return Array.from(latestByKey.values());
}

function matchesQuery(item, query = {}) {
  return Object.entries(query).every(([key, value]) => {
    if (value === undefined || value === null || value === "") return true;
    return item[key] === value;
  });
}

export async function listCustomers(query = {}) {
  if (mongoEnabled) {
    const customers = await Customer.find(query).sort({ createdAt: -1 }).lean();
    return customers.map(serialize);
  }
  const data = await readLocalStore();
  return sortNewest(data.customers.filter((item) => matchesQuery(item, query)));
}

export async function findCustomerById(id) {
  if (mongoEnabled) return serialize(await Customer.findOne({ id }).lean());
  const data = await readLocalStore();
  return data.customers.find((item) => item.id === id) || null;
}

export async function createCustomer(customer) {
  if (mongoEnabled) return serialize(await Customer.create(customer));
  const data = await readLocalStore();
  data.customers.push(customer);
  await writeLocalStore(data);
  return customer;
}

export async function updateCustomerById(id, patch) {
  const nextPatch = { ...patch, updatedAt: new Date().toISOString() };
  if (mongoEnabled) {
    return serialize(await Customer.findOneAndUpdate({ id }, nextPatch, { new: true }).lean());
  }
  const data = await readLocalStore();
  data.customers = data.customers.map((item) => (item.id === id ? { ...item, ...nextPatch } : item));
  await writeLocalStore(data);
  return data.customers.find((item) => item.id === id) || null;
}

export async function deleteCustomerById(id) {
  if (mongoEnabled) {
    await Customer.deleteOne({ id });
    return;
  }
  const data = await readLocalStore();
  data.customers = data.customers.filter((item) => item.id !== id);
  await writeLocalStore(data);
}

export async function listProducts(query = {}) {
  if (mongoEnabled) {
    const products = await Product.find(query).sort({ createdAt: -1 }).lean();
    return products.map(serialize);
  }
  const data = await readLocalStore();
  return sortNewest(data.products.filter((item) => matchesQuery(item, query)));
}

export async function findProductById(id) {
  if (mongoEnabled) return serialize(await Product.findOne({ id }).lean());
  const data = await readLocalStore();
  return data.products.find((item) => item.id === id) || null;
}

export async function createProduct(product) {
  if (mongoEnabled) return serialize(await Product.create(product));
  const data = await readLocalStore();
  data.products.push(product);
  await writeLocalStore(data);
  return product;
}

export async function updateProductById(id, patch) {
  const nextPatch = { ...patch, updatedAt: new Date().toISOString() };
  if (mongoEnabled) {
    return serialize(await Product.findOneAndUpdate({ id }, nextPatch, { new: true }).lean());
  }
  const data = await readLocalStore();
  data.products = data.products.map((item) => (item.id === id ? { ...item, ...nextPatch } : item));
  await writeLocalStore(data);
  return data.products.find((item) => item.id === id) || null;
}

export async function deleteProductById(id) {
  if (mongoEnabled) {
    await Product.deleteOne({ id });
    return;
  }
  const data = await readLocalStore();
  data.products = data.products.filter((item) => item.id !== id);
  await writeLocalStore(data);
}

export async function listDailySupplies(query = {}) {
  if (mongoEnabled) {
    const supplies = await DailySupply.find(query).sort({ date: -1, createdAt: -1 }).lean();
    return dedupeDailySupplies(supplies.map(serialize)).sort(
      (a, b) => `${b.date}-${latestTimestamp(b)}`.localeCompare(`${a.date}-${latestTimestamp(a)}`),
    );
  }
  const data = await readLocalStore();
  return dedupeDailySupplies(data.dailySupplies.filter((item) => matchesQuery(item, query))).sort((a, b) =>
    `${b.date}-${latestTimestamp(b)}`.localeCompare(`${a.date}-${latestTimestamp(a)}`),
  );
}

export async function findDailySupplyById(id) {
  if (mongoEnabled) return serialize(await DailySupply.findOne({ id }).lean());
  const data = await readLocalStore();
  return data.dailySupplies.find((item) => item.id === id) || null;
}

export async function createDailySupply(supply) {
  if (mongoEnabled) return serialize(await DailySupply.create(supply));
  const data = await readLocalStore();
  data.dailySupplies.push(supply);
  await writeLocalStore(data);
  return supply;
}

export async function updateDailySupplyById(id, patch) {
  const nextPatch = { ...patch, updatedAt: new Date().toISOString() };
  if (mongoEnabled) {
    return serialize(await DailySupply.findOneAndUpdate({ id }, nextPatch, { new: true }).lean());
  }
  const data = await readLocalStore();
  data.dailySupplies = data.dailySupplies.map((item) =>
    item.id === id ? { ...item, ...nextPatch } : item,
  );
  await writeLocalStore(data);
  return data.dailySupplies.find((item) => item.id === id) || null;
}

export async function listReports(query = {}) {
  if (mongoEnabled) {
    const reports = await Report.find(query).sort({ createdAt: -1 }).lean();
    return reports.map(serialize);
  }
  const data = await readLocalStore();
  return sortNewest(data.reports.filter((item) => matchesQuery(item, query)));
}

export async function findReportById(id) {
  if (mongoEnabled) return serialize(await Report.findOne({ id }).lean());
  const data = await readLocalStore();
  return data.reports.find((item) => item.id === id) || null;
}

export async function createReport(report) {
  if (mongoEnabled) return serialize(await Report.create(report));
  const data = await readLocalStore();
  data.reports.push(report);
  await writeLocalStore(data);
  return report;
}

export async function updateReportById(id, patch) {
  const nextPatch = { ...patch, updatedAt: new Date().toISOString() };
  if (mongoEnabled) {
    return serialize(await Report.findOneAndUpdate({ id }, nextPatch, { new: true }).lean());
  }
  const data = await readLocalStore();
  data.reports = data.reports.map((item) => (item.id === id ? { ...item, ...nextPatch } : item));
  await writeLocalStore(data);
  return data.reports.find((item) => item.id === id) || null;
}
