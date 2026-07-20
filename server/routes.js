import { createHash, randomBytes, randomInt, randomUUID } from "node:crypto";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import {
  createVendor,
  createCustomer,
  createDailySupply,
  createProduct,
  createReport,
  deleteCustomerById,
  deletePendingRegistration,
  deleteProductById,
  findCustomerById,
  findDailySupplyById,
  findPendingRegistrationByEmail,
  findProductById,
  findReportById,
  findVendorByEmail,
  findVendorById,
  findVendorByMobile,
  findVendorByResetTokenHash,
  listCustomers,
  listDailySupplies,
  listPendingRegistrations,
  listProducts,
  listReports,
  listVendors,
  updateCustomerById,
  updateDailySupplyById,
  updatePendingRegistration,
  updateProductById,
  updateReportById,
  updateVendorById,
  upsertPendingRegistration,
} from "./database.js";
import { sendPasswordResetEmail, sendRegistrationOtpEmail } from "./email.js";

const router = express.Router();
const OTP_EXPIRY_MS = 5 * 60 * 1000;
const RESEND_COOLDOWN_MS = 60 * 1000;
const MAX_OTP_ATTEMPTS = 5;
const RESET_PASSWORD_EXPIRY_MS = 30 * 60 * 1000;

function normalizeEmail(email = "") {
  return String(email).trim().toLowerCase();
}

function normalizeMobile(mobileNumber = "") {
  const digits = String(mobileNumber).replace(/\D/g, "");
  if (digits.startsWith("91") && digits.length === 12) return digits.slice(2);
  return digits;
}

function isValidEmail(email = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(email).trim());
}

function passwordPolicyError(password = "") {
  if (password.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(password)) return "Password must contain at least one capital letter.";
  if (!/\d/.test(password)) return "Password must contain at least one number.";
  if (!/[@!#%&*]/.test(password)) {
    return "Password must contain at least one symbol: @!#%&*.";
  }
  return "";
}

function resetTokenHash(token = "") {
  return createHash("sha256").update(token).digest("hex");
}

function resetPasswordLink(req, token) {
  const host = req.get("host");
  const protocol = req.protocol || "http";
  return `${protocol}://${host}/vendor/reset-password?token=${encodeURIComponent(token)}`;
}

function createOtp() {
  return String(randomInt(100000, 1000000));
}

function toMillis(value) {
  if (!value) return 0;
  if (typeof value === "number") return value;
  return new Date(value).getTime();
}

function vendorPaymentDetails(vendor = {}) {
  return {
    phonePeGPayNumber:
      vendor.phonePeGPayNumber ||
      vendor.phonePeNumber ||
      vendor.gpayNumber ||
      vendor.paymentNumber ||
      "",
    upiId: vendor.upiId || vendor.upiID || vendor.upi || "",
  };
}

function publicVendor(vendor) {
  const paymentDetails = vendorPaymentDetails(vendor);
  const shopAddress = vendor.shopAddress || vendor.address || "";
  const fssaiNumber = vendor.fssaiNumber || vendor.fssaiRegistrationNumber || "";
  return {
    id: vendor.id,
    vendorName: vendor.vendorName,
    shopName: vendor.shopName,
    email: vendor.email,
    mobileNumber: vendor.mobileNumber,
    emailVerified: Boolean(vendor.emailVerified),
    status: vendor.status,
    customerLimit: Number(vendor.customerLimit || 0),
    productLimit: Number(vendor.productLimit || 0),
    currentCustomerCount: Number(vendor.currentCustomerCount || 0),
    currentProductCount: Number(vendor.currentProductCount || 0),
    approvedBy: vendor.approvedBy || "",
    approvedAt: vendor.approvedAt || null,
    rejectedAt: vendor.rejectedAt || null,
    rejectionReason: vendor.rejectionReason || "",
    phonePeGPayNumber: paymentDetails.phonePeGPayNumber,
    upiId: paymentDetails.upiId,
    address: shopAddress,
    shopAddress,
    shopLocation: vendor.shopLocation || "",
    fssaiRegistrationNumber: fssaiNumber,
    fssaiNumber,
    createdAt: vendor.createdAt,
    updatedAt: vendor.updatedAt,
  };
}

function publicVendorDetails(vendor) {
  return {
    ...publicVendor(vendor),
    shopAddress: vendor.shopAddress || "",
    shopLocation: vendor.shopLocation || "",
    fssaiNumber: vendor.fssaiNumber || "",
  };
}

function publicAdmin() {
  return {
    email: normalizeEmail(process.env.SUPER_ADMIN_EMAIL),
    name: process.env.SUPER_ADMIN_NAME || "Super Admin",
    role: "super-admin",
  };
}

function signToken(vendor) {
  if (!process.env.JWT_SECRET) {
    const error = new Error("Authentication is not configured. Missing: JWT_SECRET.");
    error.code = "JWT_SECRET_MISSING";
    throw error;
  }

  return jwt.sign(
    {
      sub: vendor.id,
      email: vendor.email,
      role: "vendor",
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
}

function signAdminToken() {
  if (!process.env.JWT_SECRET) {
    const error = new Error("Authentication is not configured. Missing: JWT_SECRET.");
    error.code = "JWT_SECRET_MISSING";
    throw error;
  }

  return jwt.sign(
    {
      sub: normalizeEmail(process.env.SUPER_ADMIN_EMAIL),
      email: normalizeEmail(process.env.SUPER_ADMIN_EMAIL),
      role: "super-admin",
    },
    process.env.JWT_SECRET,
    { expiresIn: "7d" },
  );
}

function sendError(res, status, message, extra = {}) {
  return res.status(status).json({ success: false, message, ...extra });
}

function statusMessageForVendor(status) {
  if (status === "Pending Approval") {
    return "Your account is pending Super Admin approval. You will be able to access the dashboard once approved.";
  }
  if (status === "Inactive") {
    return "Your account is inactive. Please contact Super Admin.";
  }
  if (status === "Rejected") {
    return "Your registration has been rejected. Please contact Super Admin.";
  }
  return "Unable to login. Please contact Super Admin.";
}

function validatePositiveLimit(value, label) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return { message: `${label} should be a positive number.` };
  }
  return { value: Math.floor(number) };
}

function isValidMobile(value = "") {
  return normalizeMobile(value).length === 10;
}

function isValidOptionalEmail(value = "") {
  return !String(value || "").trim() || isValidEmail(value);
}

function isValidUpi(value = "") {
  return !String(value || "").trim() || /^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(String(value).trim());
}

function monthName(month) {
  return new Date(Number(new Date().getFullYear()), Number(month), 1).toLocaleString("en-IN", {
    month: "long",
  });
}

function startsInMonth(dateValue, month, year) {
  const date = new Date(dateValue);
  return date.getMonth() === Number(month) && date.getFullYear() === Number(year);
}

function enrichCustomer(customer, vendors = []) {
  const vendor = vendors.find((item) => item.id === customer.vendorId);
  return {
    ...customer,
    vendorName: vendor?.vendorName || "",
    vendorShopName: vendor?.shopName || "",
  };
}

function enrichProduct(product, vendors = []) {
  const vendor = vendors.find((item) => item.id === product.vendorId);
  return {
    ...product,
    vendorName: vendor?.vendorName || "",
    vendorShopName: vendor?.shopName || "",
  };
}

async function refreshVendorUsage(vendorId) {
  const [customers, products] = await Promise.all([
    listCustomers({ vendorId }),
    listProducts({ vendorId }),
  ]);
  return updateVendorById(vendorId, {
    currentCustomerCount: customers.length,
    currentProductCount: products.length,
  });
}

function validateCustomerPayload(body, partial = false) {
  const name = String(body.name || "").trim();
  const email = String(body.email || "").trim();
  const phoneNumber = normalizeMobile(body.phoneNumber);
  const address = String(body.address || "").trim();
  const status = String(body.status || "Active").trim();

  if (!partial || name) {
    if (!name) return { message: "Name is required." };
  }
  if (!partial || phoneNumber) {
    if (!phoneNumber) return { message: "Phone number is required." };
    if (!isValidMobile(phoneNumber)) {
      return { message: "Phone number must be a valid 10-digit Indian mobile number." };
    }
  }
  if (!partial || address) {
    if (!address) return { message: "Address is required." };
  }
  if (!isValidOptionalEmail(email)) return { message: "Enter a valid customer email address." };
  if (status && !["Active", "Inactive"].includes(status)) {
    return { message: "Customer status must be Active or Inactive." };
  }

  return { name, email, phoneNumber, address, status };
}

function validateProductPayload(body, partial = false) {
  const name = String(body.name || "").trim();
  const description = String(body.description || "").trim();
  const unit = String(body.unit || "").trim();
  const hsnCode = String(body.hsnCode || "").trim();
  const quantity = Number(body.quantity);
  const pricePerUnit = Number(body.pricePerUnit);
  const status = String(body.status || "Active").trim();

  if (!partial || name) {
    if (!name) return { message: "Product name is required." };
  }
  if (!partial || description) {
    if (!description) return { message: "Product description is required." };
  }
  if (!partial || unit) {
    if (!unit) return { message: "Product unit is required." };
  }
  if (!partial || body.quantity !== undefined) {
    if (body.quantity === "" || !Number.isFinite(quantity) || quantity < 0) {
      return { message: "Quantity should be a number greater than or equal to 0." };
    }
  }
  if (!partial || body.pricePerUnit !== undefined) {
    if (!Number.isFinite(pricePerUnit) || pricePerUnit <= 0) {
      return { message: "Price should be a positive number." };
    }
  }
  if (status && !["Active", "Inactive"].includes(status)) {
    return { message: "Product status must be Active or Inactive." };
  }

  return {
    name,
    description,
    unit,
    quantity: Number.isFinite(quantity) ? quantity : 0,
    hsnCode,
    pricePerUnit,
    status,
  };
}

function applySupplyFilters(items, query) {
  return items.filter((item) => {
    if (query.date && item.date !== query.date) return false;
    if (query.customerId && item.customerId !== query.customerId) return false;
    if (query.productId && item.productId !== query.productId) return false;
    if (query.status && item.status !== query.status) return false;
    return true;
  });
}

function isValidIsoDate(value = "") {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(value))) return false;
  const [year, month, day] = String(value).split("-").map(Number);
  const date = new Date(year, month - 1, day);
  return date.getFullYear() === year && date.getMonth() === month - 1 && date.getDate() === day;
}

function reportPeriodText({ fromDate, toDate, month, year }) {
  if (fromDate && toDate) return `${fromDate} to ${toDate}`;
  return `${monthName(month)} ${year}`;
}

function buildReportData({
  vendor,
  customers,
  products,
  supplies,
  month,
  year,
  reportType,
  customerId,
  customerIds = [],
  productId,
  status,
  fromDate = "",
  toDate = "",
}) {
  const selectedCustomerIds = new Set(customerIds.filter(Boolean));
  if (customerId) selectedCustomerIds.add(customerId);
  const filteredSupplies = supplies.filter((supply) => {
    if (fromDate && supply.date < fromDate) return false;
    if (toDate && supply.date > toDate) return false;
    if (!fromDate && !toDate && !startsInMonth(supply.date, month, year)) return false;
    if (selectedCustomerIds.size && !selectedCustomerIds.has(supply.customerId)) return false;
    if (customerId && supply.customerId !== customerId) return false;
    if (productId && supply.productId !== productId) return false;
    if (status && supply.status !== status) return false;
    return true;
  });

  const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
  const productMap = new Map(products.map((product) => [product.id, product]));
  const detailRows = filteredSupplies.map((supply) => {
    const customer = customerMap.get(supply.customerId);
    const product = productMap.get(supply.productId);
    return {
      date: supply.date,
      customerId: supply.customerId,
      customerName: customer?.name || "Customer",
      customerPhone: customer?.phoneNumber || "",
      customerAddress: customer?.address || "",
      productId: supply.productId,
      productName: product?.name || "Product",
      quantity: Number(supply.quantity || 0),
      unit: supply.unit || product?.unit || "",
      rate: Number(supply.rate || product?.pricePerUnit || 0),
      status: supply.status,
      amount: Number(supply.amount || 0),
      notes: supply.notes || "",
    };
  });

  const customerSummaryMap = new Map();
  const productSummaryMap = new Map();
  detailRows.forEach((row) => {
    const customerKey = `${row.customerId}-${row.productId}`;
    const customerSummary = customerSummaryMap.get(customerKey) || {
      customerId: row.customerId,
      customerName: row.customerName,
      phoneNumber: row.customerPhone,
      productName: row.productName,
      totalQuantity: 0,
      unit: row.unit,
      daysSupplied: 0,
      daysNotSupplied: 0,
      totalAmount: 0,
      paymentStatus: "Unpaid",
    };
    const productSummary = productSummaryMap.get(row.productId) || {
      productId: row.productId,
      productName: row.productName,
      unit: row.unit,
      totalQuantity: 0,
      rate: row.rate,
      daysSupplied: 0,
      daysNotSupplied: 0,
      totalAmount: 0,
    };

    if (["Supplied", "Extra Supply"].includes(row.status)) {
      customerSummary.totalQuantity += row.quantity;
      customerSummary.daysSupplied += 1;
      customerSummary.totalAmount += row.amount;
      productSummary.totalQuantity += row.quantity;
      productSummary.daysSupplied += 1;
      productSummary.totalAmount += row.amount;
    } else {
      customerSummary.daysNotSupplied += 1;
      productSummary.daysNotSupplied += 1;
    }

    customerSummaryMap.set(customerKey, customerSummary);
    productSummaryMap.set(row.productId, productSummary);
  });

  const grandTotalAmount = detailRows.reduce((sum, row) => sum + Number(row.amount || 0), 0);
  const selectedCustomer =
    reportType === "Individual" && selectedCustomerIds.size === 1
      ? customerMap.get(Array.from(selectedCustomerIds)[0])
      : null;
  const periodText = reportPeriodText({ fromDate, toDate, month, year });

  return {
    reportType,
    month,
    year,
    monthName: monthName(month),
    fromDate,
    toDate,
    periodText,
    selectedCustomerIds: Array.from(selectedCustomerIds),
    vendor: {
      id: vendor.id,
      vendorName: vendor.vendorName,
      shopName: vendor.shopName,
      mobileNumber: vendor.mobileNumber,
      phonePeGPayNumber: vendorPaymentDetails(vendor).phonePeGPayNumber,
      upiId: vendorPaymentDetails(vendor).upiId,
    },
    customer: selectedCustomer || null,
    totalCustomers: new Set(detailRows.map((row) => row.customerId)).size,
    totalSuppliedDays: detailRows.filter((row) => ["Supplied", "Extra Supply"].includes(row.status)).length,
    totalNotSuppliedDays: detailRows.filter((row) => row.status === "Not Supplied").length,
    totalAmount: grandTotalAmount,
    customerSummary: Array.from(customerSummaryMap.values()),
    productSummary: Array.from(productSummaryMap.values()),
    detailRows,
  };
}

function parseCustomerIds(value) {
  const values = Array.isArray(value) ? value : [value || ""];
  return [
    ...new Set(
      values
        .flatMap((item) => String(item || "").split(","))
        .map((item) => item.trim())
        .filter(Boolean),
    ),
  ];
}

function roundedBillNumber(value) {
  return Number(Number(value || 0).toFixed(2));
}

function buildBillPaymentLine(vendor) {
  const paymentDetails = vendorPaymentDetails(vendor);
  const phonePeGPayNumber = normalizeMobile(paymentDetails.phonePeGPayNumber || "");
  const safePhonePeGPayNumber = isValidMobile(phonePeGPayNumber) ? phonePeGPayNumber : "";
  const upiId = String(paymentDetails.upiId || "").trim();
  if (safePhonePeGPayNumber && upiId) {
    return `Pay via PhonePe or GPay number ${safePhonePeGPayNumber} or UPI ID ${upiId}`;
  }
  if (safePhonePeGPayNumber) return `Pay via PhonePe or GPay number ${safePhonePeGPayNumber}`;
  if (upiId) return `Pay via UPI ID ${upiId}`;
  return "";
}

function buildCustomerBills({ vendor, customers, products, supplies, month, year, customerIds }) {
  const selectedIds = new Set(customerIds);
  const selectedCustomers = customers.filter(
    (customer) => customer.status === "Active" && selectedIds.has(customer.id),
  );
  const selectedCustomerIds = new Set(selectedCustomers.map((customer) => customer.id));
  const productMap = new Map(products.map((product) => [product.id, product]));
  const paymentLine = buildBillPaymentLine(vendor);
  const summaries = new Map();

  selectedCustomers.forEach((customer) => {
    summaries.set(customer.id, {
      customerId: customer.id,
      customerName: customer.name,
      customerPhone: customer.phoneNumber || "",
      month: monthName(month),
      year,
      totalQuantitySupplied: 0,
      daysSupplied: 0,
      daysNotSupplied: 0,
      totalAmountPayable: 0,
      paymentStatus: "Unpaid",
      paymentLine,
      shopName: vendor.shopName || "",
      hasSupplyRecords: false,
      suppliedDates: new Set(),
      notSuppliedDates: new Set(),
    });
  });

  supplies.forEach((supply) => {
    if (!startsInMonth(supply.date, month, year)) return;
    if (!selectedCustomerIds.has(supply.customerId)) return;
    const summary = summaries.get(supply.customerId);
    if (!summary) return;
    const product = productMap.get(supply.productId);
    const status = String(supply.status || "");
    const quantity = status === "Supplied" ? Number(supply.quantity || 0) : 0;
    const storedAmount = Number(supply.amount);
    const hasStoredAmount = supply.amount !== undefined && supply.amount !== null && supply.amount !== "" && Number.isFinite(storedAmount);
    const fallbackRate = Number(supply.rate || product?.pricePerUnit || 0);

    if (status === "Supplied") {
      summary.hasSupplyRecords = true;
      summary.totalQuantitySupplied += quantity;
      summary.totalAmountPayable += hasStoredAmount ? storedAmount : quantity * fallbackRate;
      summary.suppliedDates.add(supply.date);
      return;
    }

    if (status === "Not Supplied") {
      summary.hasSupplyRecords = true;
      summary.notSuppliedDates.add(supply.date);
    }
  });

  return Array.from(summaries.values()).map((summary) => ({
    customerId: summary.customerId,
    customerName: summary.customerName,
    customerPhone: summary.customerPhone,
    month: summary.month,
    year: summary.year,
    totalQuantitySupplied: roundedBillNumber(summary.totalQuantitySupplied),
    daysSupplied: summary.suppliedDates.size,
    daysNotSupplied: summary.notSuppliedDates.size,
    totalAmountPayable: roundedBillNumber(summary.totalAmountPayable),
    paymentStatus: summary.paymentStatus,
    paymentLine: summary.paymentLine,
    shopName: summary.shopName,
    hasSupplyRecords: summary.hasSupplyRecords,
  }));
}

function validateRegistration(body) {
  const vendorName = String(body.vendorName || "").trim();
  const shopName = String(body.shopName || "").trim();
  const email = normalizeEmail(body.email);
  const mobileNumber = normalizeMobile(body.mobileNumber);
  const password = String(body.password || "");
  const confirmPassword = String(body.confirmPassword || "");

  if (!vendorName) return { message: "Vendor name is required." };
  if (!shopName) return { message: "Shop name is required." };
  if (!isValidEmail(email)) return { message: "Enter a valid email address." };
  if (mobileNumber.length !== 10) return { message: "Enter a valid 10 digit mobile number." };
  const passwordError = passwordPolicyError(password);
  if (passwordError) return { message: passwordError };
  if (password !== confirmPassword) return { message: "Password and Confirm Password do not match." };

  return { vendorName, shopName, email, mobileNumber, password };
}

async function sendOtpForPendingRegistration(pendingRegistration, res, successMessage) {
  const otp = createOtp();
  const otpHash = await bcrypt.hash(otp, 12);
  const now = Date.now();
  const nextPendingRegistration = {
    ...pendingRegistration,
    otpHash,
    otpExpiresAt: now + OTP_EXPIRY_MS,
    otpUsed: false,
    otpAttempts: 0,
    lastOtpSentAt: now,
    updatedAt: new Date(now).toISOString(),
  };

  await sendRegistrationOtpEmail({
    to: nextPendingRegistration.email,
    vendorName: nextPendingRegistration.vendorName,
    otp,
  });

  await upsertPendingRegistration(nextPendingRegistration);
  return res.json({ success: true, message: successMessage });
}

async function requireVendor(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) return sendError(res, 401, "Please login to continue.");
  if (!process.env.JWT_SECRET) {
    return sendError(res, 503, "Authentication is not configured. Missing: JWT_SECRET.");
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const vendor = await findVendorById(payload.sub);
    if (!vendor) return sendError(res, 401, "Please login to continue.");
    if (vendor.status !== "Active") {
      return sendError(res, 403, statusMessageForVendor(vendor.status), {
        status: vendor.status,
      });
    }
    req.vendor = vendor;
    return next();
  } catch {
    return sendError(res, 401, "Session expired. Please login again.");
  }
}

async function requireAdmin(req, res, next) {
  const authHeader = req.headers.authorization || "";
  const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";

  if (!token) return sendError(res, 401, "Please login to continue.");
  if (!process.env.JWT_SECRET) {
    return sendError(res, 503, "Authentication is not configured. Missing: JWT_SECRET.");
  }

  try {
    const payload = jwt.verify(token, process.env.JWT_SECRET);
    const expectedEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL);
    if (payload.role !== "super-admin" || payload.email !== expectedEmail) {
      return sendError(res, 403, "Super Admin access required.");
    }
    req.admin = publicAdmin();
    return next();
  } catch {
    return sendError(res, 401, "Session expired. Please login again.");
  }
}

async function verifyAdminPassword(password) {
  if (process.env.SUPER_ADMIN_PASSWORD_HASH) {
    return bcrypt.compare(password, process.env.SUPER_ADMIN_PASSWORD_HASH);
  }
  if (process.env.SUPER_ADMIN_PASSWORD) {
    return password === process.env.SUPER_ADMIN_PASSWORD;
  }
  return false;
}

function assertAdminConfigured() {
  const missing = [];
  if (!process.env.SUPER_ADMIN_EMAIL) missing.push("SUPER_ADMIN_EMAIL");
  if (!process.env.SUPER_ADMIN_PASSWORD && !process.env.SUPER_ADMIN_PASSWORD_HASH) {
    missing.push("SUPER_ADMIN_PASSWORD or SUPER_ADMIN_PASSWORD_HASH");
  }
  if (!process.env.JWT_SECRET) missing.push("JWT_SECRET");

  if (missing.length) {
    const error = new Error(`Super Admin is not configured. Missing: ${missing.join(", ")}.`);
    error.code = "ADMIN_CONFIG_MISSING";
    throw error;
  }
}

router.post("/vendor/register/send-otp", async (req, res) => {
  try {
    const validation = validateRegistration(req.body);
    if (validation.message) return sendError(res, 400, validation.message);

    const existingEmail = await findVendorByEmail(validation.email);
    if (existingEmail) return sendError(res, 409, "Email already registered.");

    const existingMobile = await findVendorByMobile(validation.mobileNumber);
    if (existingMobile) return sendError(res, 409, "Mobile number already registered.");

    const existingPending = await findPendingRegistrationByEmail(validation.email);
    const lastOtpSentAt = toMillis(existingPending?.lastOtpSentAt);
    if (lastOtpSentAt && Date.now() - lastOtpSentAt < RESEND_COOLDOWN_MS) {
      return sendError(res, 429, "Please wait before requesting another OTP.", {
        retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastOtpSentAt)) / 1000),
      });
    }

    const passwordHash = await bcrypt.hash(validation.password, 12);
    const now = Date.now();
    const pendingRegistration = {
      id: existingPending?.id || randomUUID(),
      vendorName: validation.vendorName,
      shopName: validation.shopName,
      email: validation.email,
      mobileNumber: validation.mobileNumber,
      passwordHash,
      otpHash: "",
      otpExpiresAt: now + OTP_EXPIRY_MS,
      otpUsed: false,
      otpAttempts: 0,
      lastOtpSentAt: now,
      createdAt: existingPending?.createdAt || new Date(now).toISOString(),
      updatedAt: new Date(now).toISOString(),
    };

    return await sendOtpForPendingRegistration(
      pendingRegistration,
      res,
      "OTP sent to your email address",
    );
  } catch (error) {
    console.error("Registration OTP email failed:", error.code || error.message);
    const message =
      error.code === "EMAIL_CONFIG_MISSING"
        ? error.message
        : "Unable to send OTP email. Please try again.";
    return sendError(res, error.code === "EMAIL_CONFIG_MISSING" ? 503 : 500, message);
  }
});

router.post("/vendor/register/resend-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return sendError(res, 400, "Enter a valid email address.");

    const pendingRegistration = await findPendingRegistrationByEmail(email);
    if (!pendingRegistration) {
      return sendError(res, 404, "No pending registration found for this email.");
    }

    const lastOtpSentAt = toMillis(pendingRegistration.lastOtpSentAt);
    if (lastOtpSentAt && Date.now() - lastOtpSentAt < RESEND_COOLDOWN_MS) {
      return sendError(res, 429, "Please wait before requesting another OTP.", {
        retryAfterSeconds: Math.ceil((RESEND_COOLDOWN_MS - (Date.now() - lastOtpSentAt)) / 1000),
      });
    }

    return await sendOtpForPendingRegistration(
      pendingRegistration,
      res,
      "OTP resent successfully",
    );
  } catch (error) {
    const message =
      error.code === "EMAIL_CONFIG_MISSING"
        ? error.message
        : "Unable to resend OTP. Please try again.";
    return sendError(res, error.code === "EMAIL_CONFIG_MISSING" ? 503 : 500, message);
  }
});

router.post("/vendor/register/verify-otp", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const otp = String(req.body.otp || "").trim();
    if (!isValidEmail(email)) return sendError(res, 400, "Enter a valid email address.");
    if (!/^\d{6}$/.test(otp)) return sendError(res, 400, "Enter the 6 digit OTP.");

    const pendingRegistration = await findPendingRegistrationByEmail(email);
    if (!pendingRegistration) {
      return sendError(res, 404, "No pending registration found for this email.");
    }

    if (pendingRegistration.otpUsed) return sendError(res, 400, "OTP already used.");
    if (Date.now() > toMillis(pendingRegistration.otpExpiresAt)) {
      return sendError(res, 410, "OTP expired. Please request a new OTP.");
    }
    if (Number(pendingRegistration.otpAttempts || 0) >= MAX_OTP_ATTEMPTS) {
      return sendError(res, 429, "Too many invalid attempts. Please request a new OTP.");
    }

    const matches = await bcrypt.compare(otp, pendingRegistration.otpHash);
    if (!matches) {
      const attempts = Number(pendingRegistration.otpAttempts || 0) + 1;
      await updatePendingRegistration(email, {
        otpAttempts: attempts,
        updatedAt: new Date().toISOString(),
      });
      const message =
        attempts >= MAX_OTP_ATTEMPTS
          ? "Too many invalid attempts. Please request a new OTP."
          : "Invalid OTP. Please try again.";
      return sendError(res, attempts >= MAX_OTP_ATTEMPTS ? 429 : 400, message, {
        attemptsRemaining: Math.max(0, MAX_OTP_ATTEMPTS - attempts),
      });
    }

    const existingVendor = await findVendorByEmail(email);
    if (existingVendor) return sendError(res, 409, "Email already registered.");

    const now = new Date().toISOString();
    await createVendor({
      id: randomUUID(),
      vendorName: pendingRegistration.vendorName,
      shopName: pendingRegistration.shopName,
      email: pendingRegistration.email,
      mobileNumber: pendingRegistration.mobileNumber,
      passwordHash: pendingRegistration.passwordHash,
      emailVerified: true,
      status: "Pending Approval",
      customerLimit: 0,
      productLimit: 0,
      currentCustomerCount: 0,
      currentProductCount: 0,
      approvedBy: "",
      approvedAt: null,
      rejectedAt: null,
      rejectionReason: "",
      createdAt: now,
      updatedAt: now,
    });
    await deletePendingRegistration(email);

    return res.json({
      success: true,
      message: "Registration completed successfully. Your account is pending Super Admin approval.",
    });
  } catch {
    return sendError(res, 500, "Unable to verify OTP. Please try again.");
  }
});

router.post("/vendor/login", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    if (!isValidEmail(email)) return sendError(res, 400, "Enter a valid email address.");

    const vendor = await findVendorByEmail(email);
    if (!vendor) return sendError(res, 404, "No account found with this email address.");

    const passwordMatches = await bcrypt.compare(password, vendor.passwordHash);
    if (!passwordMatches) return sendError(res, 401, "Invalid email or password.");
    if (vendor.status !== "Active") {
      return sendError(res, 403, statusMessageForVendor(vendor.status), {
        status: vendor.status,
        vendor: publicVendor(vendor),
      });
    }

    const token = signToken(vendor);
    return res.json({
      success: true,
      message: "Login successful",
      token,
      vendor: publicVendor(vendor),
    });
  } catch (error) {
    const message =
      error.code === "JWT_SECRET_MISSING"
        ? error.message
        : "Unable to login. Please try again.";
    return sendError(res, error.code === "JWT_SECRET_MISSING" ? 503 : 500, message);
  }
});

router.post("/vendor/forgot-password", async (req, res) => {
  try {
    const email = normalizeEmail(req.body.email);
    if (!isValidEmail(email)) return sendError(res, 400, "Enter a valid email address.");

    const vendor = await findVendorByEmail(email);
    if (!vendor) return sendError(res, 404, "No account found with this email address.");

    const token = randomBytes(32).toString("hex");
    const expiresAt = new Date(Date.now() + RESET_PASSWORD_EXPIRY_MS).toISOString();
    await updateVendorById(vendor.id, {
      resetPasswordTokenHash: resetTokenHash(token),
      resetPasswordExpiresAt: expiresAt,
    });

    await sendPasswordResetEmail({
      to: vendor.email,
      vendorName: vendor.vendorName,
      resetLink: resetPasswordLink(req, token),
    });

    return res.json({
      success: true,
      message: "Password reset link has been sent to your email.",
    });
  } catch (error) {
    const message =
      error.code === "EMAIL_CONFIG_MISSING"
        ? error.message
        : "Unable to send password reset link. Please try again.";
    return sendError(res, error.code === "EMAIL_CONFIG_MISSING" ? 503 : 500, message);
  }
});

router.post("/vendor/reset-password", async (req, res) => {
  try {
    const token = String(req.body.token || "").trim();
    const password = String(req.body.password || "");
    const confirmPassword = String(req.body.confirmPassword || "");
    if (!token) return sendError(res, 400, "Invalid or expired reset link.");

    const vendor = await findVendorByResetTokenHash(resetTokenHash(token));
    if (!vendor || !vendor.resetPasswordExpiresAt || Date.now() > toMillis(vendor.resetPasswordExpiresAt)) {
      return sendError(res, 400, "Invalid or expired reset link.");
    }

    const passwordError = passwordPolicyError(password);
    if (passwordError) {
      return sendError(res, 400, "Password does not meet security requirements.", {
        detail: passwordError,
      });
    }
    if (password !== confirmPassword) {
      return sendError(res, 400, "Password and Confirm Password do not match.");
    }

    const passwordHash = await bcrypt.hash(password, 12);
    await updateVendorById(vendor.id, {
      passwordHash,
      resetPasswordTokenHash: "",
      resetPasswordExpiresAt: null,
    });

    return res.json({
      success: true,
      message: "Password has been reset successfully.",
    });
  } catch {
    return sendError(res, 500, "Unable to reset password. Please try again.");
  }
});

router.get("/vendor/me", requireVendor, async (req, res) => {
  return res.json({
    success: true,
    vendor: publicVendor(req.vendor),
  });
});

router.get("/vendor/dashboard", requireVendor, async (req, res) => {
  const [customers, products, supplies, reports] = await Promise.all([
    listCustomers({ vendorId: req.vendor.id }),
    listProducts({ vendorId: req.vendor.id }),
    listDailySupplies({ vendorId: req.vendor.id }),
    listReports({ vendorId: req.vendor.id }),
  ]);
  const today = new Date().toISOString().slice(0, 10);
  const now = new Date();
  const monthlyReports = reports.filter(
    (report) => Number(report.month) === now.getMonth() && Number(report.year) === now.getFullYear(),
  );
  const pendingPayments = reports
    .filter((report) => report.paymentStatus !== "Paid")
    .reduce((sum, report) => sum + Number(report.balanceAmount ?? report.totalAmount ?? 0), 0);

  return res.json({
    success: true,
    metrics: {
      totalCustomers: customers.length,
      activeCustomers: customers.filter((customer) => customer.status === "Active").length,
      inactiveCustomers: customers.filter((customer) => customer.status === "Inactive").length,
      customerLimitUsed: customers.length,
      totalProducts: products.length,
      activeProducts: products.filter((product) => product.status === "Active").length,
      inactiveProducts: products.filter((product) => product.status === "Inactive").length,
      productLimitUsed: products.length,
      todaysDeliveries: supplies.filter((supply) => supply.date === today).length,
      monthlyRevenue: monthlyReports.reduce((sum, report) => sum + Number(report.totalAmount || 0), 0),
      pendingPayments,
      reportsGenerated: reports.length,
    },
    limits: {
      customerLimit: Number(req.vendor.customerLimit || 0),
      productLimit: Number(req.vendor.productLimit || 0),
      currentCustomerCount: Number(req.vendor.currentCustomerCount || 0),
      currentProductCount: Number(req.vendor.currentProductCount || 0),
    },
    emptyMessage: "No data available yet. Start by adding your customers and products.",
  });
});

router.get("/vendor/profile", requireVendor, async (req, res) => {
  return res.json({
    success: true,
    vendor: publicVendorDetails(req.vendor),
  });
});

async function updateVendorProfileHandler(req, res) {
  const shopName = String(req.body.shopName ?? req.vendor.shopName ?? "").trim();
  const phonePeGPayNumber = req.body.phonePeGPayNumber
    ? normalizeMobile(req.body.phonePeGPayNumber)
    : "";
  const upiId = String(req.body.upiId || "").trim();
  const shopAddress = String(req.body.shopAddress ?? req.body.address ?? req.vendor.shopAddress ?? req.vendor.address ?? "").trim();
  const shopLocation = String(req.body.shopLocation ?? req.vendor.shopLocation ?? "").trim();
  const fssaiNumber = String(
    req.body.fssaiNumber ??
      req.body.fssaiRegistrationNumber ??
      req.vendor.fssaiNumber ??
      req.vendor.fssaiRegistrationNumber ??
      "",
  ).trim();

  if (!shopName) return sendError(res, 400, "Shop name is required.");
  if (phonePeGPayNumber && !isValidMobile(phonePeGPayNumber)) {
    return sendError(res, 400, "PhonePe / GPay number should be a valid 10-digit mobile number.");
  }
  if (!isValidUpi(upiId)) return sendError(res, 400, "Enter a valid UPI ID.");

  const vendor = await updateVendorById(req.vendor.id, {
    shopName,
    phonePeGPayNumber,
    upiId,
    shopAddress,
    shopLocation,
    fssaiNumber,
  });
  return res.json({
    success: true,
    message: "Profile updated successfully.",
    vendor: publicVendorDetails(vendor),
  });
}

router.patch("/vendor/profile", requireVendor, updateVendorProfileHandler);
router.patch("/vendor/profile/payment-details", requireVendor, updateVendorProfileHandler);

router.get("/vendor/customers", requireVendor, async (req, res) => {
  const customers = await listCustomers({ vendorId: req.vendor.id });
  return res.json({ success: true, customers });
});

router.post("/vendor/customers", requireVendor, async (req, res) => {
  const validation = validateCustomerPayload(req.body);
  if (validation.message) return sendError(res, 400, validation.message);

  const customers = await listCustomers({ vendorId: req.vendor.id });
  if (customers.length >= Number(req.vendor.customerLimit || 0)) {
    return sendError(res, 403, "Customer limit reached. Please contact Super Admin to increase your limit.");
  }

  const now = new Date().toISOString();
  const customer = await createCustomer({
    id: randomUUID(),
    vendorId: req.vendor.id,
    ...validation,
    createdBy: req.vendor.id,
    updatedBy: req.vendor.id,
    createdAt: now,
    updatedAt: now,
  });
  await refreshVendorUsage(req.vendor.id);
  return res.json({ success: true, message: "Customer added successfully.", customer });
});

router.get("/vendor/customers/:id", requireVendor, async (req, res) => {
  const customer = await findCustomerById(req.params.id);
  if (!customer || customer.vendorId !== req.vendor.id) return sendError(res, 404, "Customer not found.");
  return res.json({ success: true, customer });
});

router.patch("/vendor/customers/:id", requireVendor, async (req, res) => {
  const existing = await findCustomerById(req.params.id);
  if (!existing || existing.vendorId !== req.vendor.id) return sendError(res, 404, "Customer not found.");
  const validation = validateCustomerPayload({ ...existing, ...req.body }, true);
  if (validation.message) return sendError(res, 400, validation.message);
  const customer = await updateCustomerById(existing.id, {
    ...validation,
    updatedBy: req.vendor.id,
  });
  return res.json({ success: true, message: "Customer updated successfully.", customer });
});

router.patch("/vendor/customers/:id/status", requireVendor, async (req, res) => {
  const existing = await findCustomerById(req.params.id);
  if (!existing || existing.vendorId !== req.vendor.id) return sendError(res, 404, "Customer not found.");
  const status = String(req.body.status || "").trim();
  if (!["Active", "Inactive"].includes(status)) return sendError(res, 400, "Invalid customer status.");
  const customer = await updateCustomerById(existing.id, { status, updatedBy: req.vendor.id });
  return res.json({
    success: true,
    message: status === "Active" ? "Customer marked active." : "Customer marked inactive.",
    customer,
  });
});

router.get("/vendor/products", requireVendor, async (req, res) => {
  const products = await listProducts({ vendorId: req.vendor.id });
  return res.json({ success: true, products });
});

router.post("/vendor/products", requireVendor, async (req, res) => {
  const validation = validateProductPayload(req.body);
  if (validation.message) return sendError(res, 400, validation.message);

  const products = await listProducts({ vendorId: req.vendor.id });
  if (products.length >= Number(req.vendor.productLimit || 0)) {
    return sendError(res, 403, "Product limit reached. Please contact Super Admin to increase your limit.");
  }

  const now = new Date().toISOString();
  const product = await createProduct({
    id: randomUUID(),
    vendorId: req.vendor.id,
    ...validation,
    createdBy: req.vendor.id,
    updatedBy: req.vendor.id,
    createdAt: now,
    updatedAt: now,
  });
  await refreshVendorUsage(req.vendor.id);
  return res.json({ success: true, message: "Product added successfully.", product });
});

router.get("/vendor/products/:id", requireVendor, async (req, res) => {
  const product = await findProductById(req.params.id);
  if (!product || product.vendorId !== req.vendor.id) return sendError(res, 404, "Product not found.");
  return res.json({ success: true, product });
});

router.patch("/vendor/products/:id", requireVendor, async (req, res) => {
  const existing = await findProductById(req.params.id);
  if (!existing || existing.vendorId !== req.vendor.id) return sendError(res, 404, "Product not found.");
  const validation = validateProductPayload({ ...existing, ...req.body }, true);
  if (validation.message) return sendError(res, 400, validation.message);
  const product = await updateProductById(existing.id, {
    ...validation,
    updatedBy: req.vendor.id,
  });
  return res.json({ success: true, message: "Product updated successfully.", product });
});

router.patch("/vendor/products/:id/status", requireVendor, async (req, res) => {
  const existing = await findProductById(req.params.id);
  if (!existing || existing.vendorId !== req.vendor.id) return sendError(res, 404, "Product not found.");
  const status = String(req.body.status || "").trim();
  if (!["Active", "Inactive"].includes(status)) return sendError(res, 400, "Invalid product status.");
  const product = await updateProductById(existing.id, { status, updatedBy: req.vendor.id });
  return res.json({
    success: true,
    message: status === "Active" ? "Product marked active." : "Product marked inactive.",
    product,
  });
});

router.get("/vendor/daily-supply", requireVendor, async (req, res) => {
  const supplies = applySupplyFilters(await listDailySupplies({ vendorId: req.vendor.id }), req.query);
  const [customers, products] = await Promise.all([
    listCustomers({ vendorId: req.vendor.id }),
    listProducts({ vendorId: req.vendor.id }),
  ]);
  return res.json({
    success: true,
    supplies: supplies.map((supply) => ({
      ...supply,
      customerName: customers.find((customer) => customer.id === supply.customerId)?.name || "",
      productName: products.find((product) => product.id === supply.productId)?.name || "",
    })),
  });
});

async function buildSupplyPayload(body, vendor, existing = {}, overrideCustomerId = "") {
  const customerId = String(overrideCustomerId || (body.customerId ?? existing.customerId ?? "")).trim();
  const productId = String(body.productId ?? existing.productId ?? "").trim();
  const date = String(body.date ?? existing.date ?? "").trim();
  const status = String(body.status ?? existing.status ?? "Supplied").trim();
  const notes = String(body.notes ?? existing.notes ?? "").trim();
  const quantity = Number(body.quantity ?? existing.quantity ?? 0);

  if (!date) return { message: "Date is required." };
  if (!customerId) return { message: "Customer is required." };
  if (!productId) return { message: "Product is required." };
  if (!["Supplied", "Not Supplied", "Extra Supply"].includes(status)) {
    return { message: "Invalid supply status." };
  }
  const customer = await findCustomerById(customerId);
  if (!customer || customer.vendorId !== vendor.id) return { message: "Customer not found." };
  if (customer.status !== "Active") return { message: "Only active customers can be selected." };
  const product = await findProductById(productId);
  if (!product || product.vendorId !== vendor.id) return { message: "Product not found." };
  if (product.status !== "Active") return { message: "Only active products can be selected." };
  if (status !== "Not Supplied" && (!Number.isFinite(quantity) || quantity <= 0)) {
    return { message: "Quantity is required for supplied entries." };
  }
  if (status === "Not Supplied" && (!Number.isFinite(quantity) || quantity < 0)) {
    return { message: "Quantity cannot be negative." };
  }

  const safeQuantity = status === "Not Supplied" ? 0 : quantity;
  const rate = Number(product.pricePerUnit || 0);
  return {
    vendorId: vendor.id,
    customerId,
    productId,
    date,
    quantity: safeQuantity,
    unit: product.unit,
    rate,
    amount: ["Supplied", "Extra Supply"].includes(status) ? safeQuantity * rate : 0,
    status,
    notes,
  };
}

async function saveOrUpdateSupply(payload, actorId, now) {
  const existingSupplies = await listDailySupplies({
    vendorId: payload.vendorId,
    customerId: payload.customerId,
    productId: payload.productId,
    date: payload.date,
  });
  const existing = existingSupplies[0];
  if (existing) {
    const supply = await updateDailySupplyById(existing.id, {
      ...payload,
      updatedBy: actorId,
    });
    return { supply, created: false };
  }

  const supply = await createDailySupply({
    id: randomUUID(),
    ...payload,
    createdBy: actorId,
    updatedBy: actorId,
    createdAt: now,
    updatedAt: now,
  });
  return { supply, created: true };
}

router.post("/vendor/daily-supply", requireVendor, async (req, res) => {
  const customerIds = Array.isArray(req.body.customerIds)
    ? [...new Set(req.body.customerIds.map((id) => String(id || "").trim()).filter(Boolean))]
    : [];
  if (Array.isArray(req.body.customerIds) && !customerIds.length) {
    return sendError(res, 400, "Customer selection is required.");
  }

  const now = new Date().toISOString();

  if (customerIds.length) {
    const payloads = [];
    for (const customerId of customerIds) {
      const payload = await buildSupplyPayload(req.body, req.vendor, {}, customerId);
      if (payload.message) return sendError(res, 400, payload.message);
      payloads.push(payload);
    }
    const results = [];
    for (const payload of payloads) {
      results.push(await saveOrUpdateSupply(payload, req.vendor.id, now));
    }
    const supplies = results.map((result) => result.supply);
    const createdCount = results.filter((result) => result.created).length;
    const updatedCount = results.length - createdCount;
    return res.json({
      success: true,
      message:
        supplies.length === 1 && updatedCount === 1
          ? "Supply entry updated successfully."
          : supplies.length === 1
            ? "Supply entry saved successfully."
            : `Supply entries saved successfully. Created: ${createdCount}, Updated: ${updatedCount}.`,
      createdCount,
      updatedCount,
      supplies,
    });
  }

  const payload = await buildSupplyPayload(req.body, req.vendor);
  if (payload.message) return sendError(res, 400, payload.message);
  const result = await saveOrUpdateSupply(payload, req.vendor.id, now);
  return res.json({
    success: true,
    message: result.created ? "Supply entry saved successfully." : "Supply entry updated successfully.",
    createdCount: result.created ? 1 : 0,
    updatedCount: result.created ? 0 : 1,
    supply: result.supply,
  });
});

router.get("/vendor/daily-supply/:id", requireVendor, async (req, res) => {
  const supply = await findDailySupplyById(req.params.id);
  if (!supply || supply.vendorId !== req.vendor.id) return sendError(res, 404, "Supply entry not found.");
  return res.json({ success: true, supply });
});

router.patch("/vendor/daily-supply/:id", requireVendor, async (req, res) => {
  const existing = await findDailySupplyById(req.params.id);
  if (!existing || existing.vendorId !== req.vendor.id) return sendError(res, 404, "Supply entry not found.");
  const payload = await buildSupplyPayload(req.body, req.vendor, existing);
  if (payload.message) return sendError(res, 400, payload.message);
  const supply = await updateDailySupplyById(existing.id, {
    ...payload,
    updatedBy: req.vendor.id,
  });
  return res.json({ success: true, message: "Supply entry updated successfully.", supply });
});

router.get("/vendor/customer-bills", requireVendor, async (req, res) => {
  const month = Number(req.query.month);
  const year = Number(req.query.year);
  const customerIds = parseCustomerIds(req.query.customerIds);

  if (!Number.isInteger(month) || month < 0 || month > 11) return sendError(res, 400, "Month is required.");
  if (!Number.isInteger(year) || year < 2000) return sendError(res, 400, "Year is required.");
  if (!customerIds.length) return sendError(res, 400, "Select at least one customer.");

  const [customers, products, supplies] = await Promise.all([
    listCustomers({ vendorId: req.vendor.id }),
    listProducts({ vendorId: req.vendor.id }),
    listDailySupplies({ vendorId: req.vendor.id }),
  ]);
  const activeSelectedCustomers = customers.filter(
    (customer) => customer.status === "Active" && customerIds.includes(customer.id),
  );
  if (!activeSelectedCustomers.length) return sendError(res, 400, "No active customers available.");

  const data = buildCustomerBills({
    vendor: req.vendor,
    customers: activeSelectedCustomers,
    products,
    supplies,
    month,
    year,
    customerIds,
  });
  const hasSupplyRecords = data.some((bill) => bill.hasSupplyRecords);
  const paymentWarning = buildBillPaymentLine(req.vendor)
    ? ""
    : "Payment details missing. Please update your PhonePe/GPay number or UPI ID in Vendor Profile before sending bills.";

  return res.json({
    success: true,
    message: "Bill preview generated successfully.",
    data,
    hasSupplyRecords,
    paymentWarning,
  });
});

router.post("/vendor/reports/generate", requireVendor, async (req, res) => {
  const reportType = String(req.body.reportType || "Consolidated");
  const fromDate = String(req.body.fromDate || "").trim();
  const toDate = String(req.body.toDate || "").trim();
  const hasDateRange = Boolean(fromDate || toDate);
  const month = hasDateRange ? Number(fromDate.slice(5, 7)) - 1 : Number(req.body.month);
  const year = hasDateRange ? Number(fromDate.slice(0, 4)) : Number(req.body.year);
  const customerId = String(req.body.customerId || "").trim();
  const customerIds = parseCustomerIds(req.body.customerIds);
  const productId = String(req.body.productId || "").trim();
  const status = String(req.body.status || "").trim();

  if (hasDateRange) {
    if (!fromDate || !toDate) return sendError(res, 400, "From Date and To Date are required.");
    if (!isValidIsoDate(fromDate) || !isValidIsoDate(toDate)) return sendError(res, 400, "Enter a valid date range.");
    if (fromDate > toDate) return sendError(res, 400, "From Date cannot be later than To Date.");
    if (!customerIds.length) return sendError(res, 400, "Please select at least one customer to generate the report.");
  } else {
    if (!Number.isInteger(month) || month < 0 || month > 11) return sendError(res, 400, "Month is required.");
    if (!Number.isInteger(year) || year < 2000) return sendError(res, 400, "Year is required.");
  }
  if (!["Consolidated", "Individual"].includes(reportType)) return sendError(res, 400, "Invalid report type.");

  const [customers, products, supplies] = await Promise.all([
    listCustomers({ vendorId: req.vendor.id }),
    listProducts({ vendorId: req.vendor.id }),
    listDailySupplies({ vendorId: req.vendor.id }),
  ]);
  const selectedCustomerIds = customerIds.length ? customerIds : customerId ? [customerId] : [];
  const activeCustomerIds = new Set(customers.filter((customer) => customer.status === "Active").map((customer) => customer.id));
  if (selectedCustomerIds.some((id) => !activeCustomerIds.has(id))) {
    return sendError(res, 400, "Selected customer is not available for report generation.");
  }
  if (reportType === "Individual" && selectedCustomerIds.length !== 1) {
    return sendError(res, 400, "Select one customer for an individual report.");
  }
  const reportData = buildReportData({
    vendor: req.vendor,
    customers,
    products,
    supplies,
    month,
    year,
    reportType,
    customerId: reportType === "Individual" ? selectedCustomerIds[0] : "",
    customerIds: selectedCustomerIds,
    productId,
    status,
    fromDate,
    toDate,
  });

  return res.json({ success: true, message: "Report generated successfully.", reportData });
});

router.post("/vendor/reports/save", requireVendor, async (req, res) => {
  const reportData = req.body.reportData || {};
  const reportType = String(reportData.reportType || req.body.reportType || "");
  const month = Number(reportData.month ?? req.body.month);
  const year = Number(reportData.year ?? req.body.year);
  const customerId = reportData.customer?.id || req.body.customerId || "";
  if (!["Consolidated", "Individual"].includes(reportType)) return sendError(res, 400, "Invalid report type.");
  if (!Number.isInteger(month) || !Number.isInteger(year)) return sendError(res, 400, "Invalid report period.");

  const now = new Date().toISOString();
  const totalAmount = Number(reportData.totalAmount || 0);
  const report = await createReport({
    id: randomUUID(),
    vendorId: req.vendor.id,
    customerId,
    reportType,
    month,
    year,
    reportData,
    totalAmount,
    paymentStatus: "Unpaid",
    paidAmount: 0,
    balanceAmount: totalAmount,
    paymentDate: "",
    paymentMode: "",
    createdAt: now,
    updatedAt: now,
  });
  return res.json({ success: true, message: "Report saved successfully.", report });
});

router.get("/vendor/reports", requireVendor, async (req, res) => {
  const reports = await listReports({ vendorId: req.vendor.id });
  return res.json({ success: true, reports });
});

router.get("/vendor/reports/:id", requireVendor, async (req, res) => {
  const report = await findReportById(req.params.id);
  if (!report || report.vendorId !== req.vendor.id) return sendError(res, 404, "Report not found.");
  return res.json({ success: true, report });
});

router.patch("/vendor/reports/:id/payment-status", requireVendor, async (req, res) => {
  const report = await findReportById(req.params.id);
  if (!report || report.vendorId !== req.vendor.id) return sendError(res, 404, "Report not found.");
  const paymentStatus = String(req.body.paymentStatus || "Unpaid");
  if (!["Paid", "Unpaid", "Partially Paid"].includes(paymentStatus)) {
    return sendError(res, 400, "Invalid payment status.");
  }
  const paidAmount = Number(req.body.paidAmount || 0);
  const totalAmount = Number(report.totalAmount || 0);
  const updatedReport = await updateReportById(report.id, {
    paymentStatus,
    paidAmount,
    balanceAmount: Math.max(0, totalAmount - paidAmount),
    paymentDate: String(req.body.paymentDate || ""),
    paymentMode: String(req.body.paymentMode || ""),
  });
  return res.json({
    success: true,
    message: "Payment status updated successfully.",
    report: updatedReport,
  });
});

async function adminLoginHandler(req, res) {
  try {
    assertAdminConfigured();
    const email = normalizeEmail(req.body.email);
    const password = String(req.body.password || "");
    const expectedEmail = normalizeEmail(process.env.SUPER_ADMIN_EMAIL);

    if (!isValidEmail(email)) return sendError(res, 400, "Enter a valid email address.");
    if (email !== expectedEmail) return sendError(res, 401, "Invalid admin email or password.");

    const passwordMatches = await verifyAdminPassword(password);
    if (!passwordMatches) return sendError(res, 401, "Invalid admin email or password.");

    return res.json({
      success: true,
      message: "Super Admin login successful",
      token: signAdminToken(),
      admin: publicAdmin(),
    });
  } catch (error) {
    const message =
      error.code === "ADMIN_CONFIG_MISSING"
        ? error.message
        : "Unable to login. Please try again.";
    return sendError(res, error.code === "ADMIN_CONFIG_MISSING" ? 503 : 500, message);
  }
}

function filterVendors(vendors, query) {
  const status = String(query.status || "").trim();
  const search = String(query.search || "").trim().toLowerCase();
  const date = String(query.date || "").trim();

  return vendors.filter((vendor) => {
    const matchesStatus = status ? vendor.status === status : true;
    const searchable = [
      vendor.vendorName,
      vendor.shopName,
      vendor.email,
      vendor.mobileNumber,
      vendor.status,
    ]
      .join(" ")
      .toLowerCase();
    const matchesSearch = search ? searchable.includes(search) : true;
    const matchesDate = date ? String(vendor.createdAt || "").startsWith(date) : true;
    return matchesStatus && matchesSearch && matchesDate;
  });
}

async function getAdminDashboardPayload(query = {}) {
  const [allVendors, allCustomers, allProducts, allReports, pendingRegistrations] = await Promise.all([
    listVendors(),
    listCustomers(),
    listProducts(),
    listReports(),
    listPendingRegistrations(),
  ]);
  const vendors = filterVendors(allVendors, query);
  const pendingApprovalVendors = allVendors.filter(
    (vendor) => vendor.status === "Pending Approval",
  );
  const activeVendors = allVendors.filter((vendor) => vendor.status === "Active");
  const inactiveVendors = allVendors.filter((vendor) => vendor.status === "Inactive");
  const rejectedVendors = allVendors.filter((vendor) => vendor.status === "Rejected");

  return {
    metrics: {
      totalVendors: allVendors.length,
      pendingApprovalVendors: pendingApprovalVendors.length,
      activeVendors: activeVendors.length,
      inactiveVendors: inactiveVendors.length,
      rejectedVendors: rejectedVendors.length,
      totalCustomers: allCustomers.length,
      totalProducts: allProducts.length,
      totalReports: allReports.length,
      pendingPaymentAmount: allReports
        .filter((report) => report.paymentStatus !== "Paid")
        .reduce((sum, report) => sum + Number(report.balanceAmount ?? report.totalAmount ?? 0), 0),
      totalApprovedCustomersLimit: activeVendors.reduce(
        (sum, vendor) => sum + Number(vendor.customerLimit || 0),
        0,
      ),
      totalApprovedProductsLimit: activeVendors.reduce(
        (sum, vendor) => sum + Number(vendor.productLimit || 0),
        0,
      ),
      pendingRegistrations: pendingRegistrations.length,
    },
    vendors: vendors.map(publicVendor),
    pendingVendors: pendingApprovalVendors.map(publicVendor),
    pendingRegistrations: pendingRegistrations.map((item) => ({
      id: item.id,
      vendorName: item.vendorName,
      shopName: item.shopName,
      email: item.email,
      mobileNumber: item.mobileNumber,
      createdAt: item.createdAt,
      lastOtpSentAt: item.lastOtpSentAt,
    })),
  };
}

router.post("/admin/login", adminLoginHandler);
router.post("/super-admin/login", adminLoginHandler);

router.get("/admin/me", requireAdmin, async (req, res) => {
  return res.json({
    success: true,
    admin: req.admin,
  });
});
router.get("/super-admin/me", requireAdmin, async (req, res) => {
  return res.json({
    success: true,
    admin: req.admin,
  });
});

router.get("/admin/dashboard", requireAdmin, async (req, res) => {
  const payload = await getAdminDashboardPayload();
  return res.json({
    success: true,
    ...payload,
  });
});
router.get("/super-admin/dashboard", requireAdmin, async (req, res) => {
  const payload = await getAdminDashboardPayload();
  return res.json({
    success: true,
    ...payload,
  });
});

router.get("/super-admin/vendors", requireAdmin, async (req, res) => {
  const payload = await getAdminDashboardPayload(req.query);
  return res.json({
    success: true,
    vendors: payload.vendors,
    metrics: payload.metrics,
  });
});

router.get("/super-admin/vendors/pending", requireAdmin, async (req, res) => {
  const vendors = (await listVendors()).filter((vendor) => vendor.status === "Pending Approval");
  return res.json({
    success: true,
    vendors: vendors.map(publicVendor),
  });
});

router.get("/super-admin/vendors/:vendorId", requireAdmin, async (req, res) => {
  const vendor = await findVendorById(req.params.vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");
  return res.json({
    success: true,
    vendor: publicVendorDetails(vendor),
  });
});

router.post("/super-admin/vendors/:vendorId/approve", requireAdmin, async (req, res) => {
  const vendor = await findVendorById(req.params.vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");
  if (!["Pending Approval", "Inactive", "Rejected"].includes(vendor.status)) {
    return sendError(res, 400, "Vendor cannot be approved from the current status.");
  }

  if (req.body.customerLimit === undefined || req.body.customerLimit === "") {
    return sendError(res, 400, "Customer limit is required.");
  }
  if (req.body.productLimit === undefined || req.body.productLimit === "") {
    return sendError(res, 400, "Product limit is required.");
  }

  const customerLimit = validatePositiveLimit(req.body.customerLimit, "Customer limit");
  if (customerLimit.message) return sendError(res, 400, customerLimit.message);
  const productLimit = validatePositiveLimit(req.body.productLimit, "Product limit");
  if (productLimit.message) return sendError(res, 400, productLimit.message);

  const now = new Date().toISOString();
  const updatedVendor = await updateVendorById(vendor.id, {
    status: "Active",
    customerLimit: customerLimit.value,
    productLimit: productLimit.value,
    approvedBy: req.admin.email,
    approvedAt: now,
    rejectedAt: null,
    rejectionReason: "",
  });

  return res.json({
    success: true,
    message: "Vendor approved successfully.",
    vendor: publicVendor(updatedVendor),
  });
});

router.post("/super-admin/vendors/:vendorId/reject", requireAdmin, async (req, res) => {
  const vendor = await findVendorById(req.params.vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");

  const updatedVendor = await updateVendorById(vendor.id, {
    status: "Rejected",
    rejectedAt: new Date().toISOString(),
    rejectionReason: String(req.body.rejectionReason || "").trim(),
  });

  return res.json({
    success: true,
    message: "Vendor rejected successfully.",
    vendor: publicVendor(updatedVendor),
  });
});

router.patch("/super-admin/vendors/:vendorId/limits", requireAdmin, async (req, res) => {
  const vendor = await findVendorById(req.params.vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");

  if (req.body.customerLimit === undefined || req.body.customerLimit === "") {
    return sendError(res, 400, "Customer limit is required.");
  }
  if (req.body.productLimit === undefined || req.body.productLimit === "") {
    return sendError(res, 400, "Product limit is required.");
  }

  const customerLimit = validatePositiveLimit(req.body.customerLimit, "Customer limit");
  if (customerLimit.message) return sendError(res, 400, customerLimit.message);
  const productLimit = validatePositiveLimit(req.body.productLimit, "Product limit");
  if (productLimit.message) return sendError(res, 400, productLimit.message);

  if (customerLimit.value < Number(vendor.currentCustomerCount || 0)) {
    return sendError(res, 400, "Customer limit cannot be less than current customer usage.");
  }
  if (productLimit.value < Number(vendor.currentProductCount || 0)) {
    return sendError(res, 400, "Product limit cannot be less than current product usage.");
  }

  const updatedVendor = await updateVendorById(vendor.id, {
    customerLimit: customerLimit.value,
    productLimit: productLimit.value,
  });

  return res.json({
    success: true,
    message: "Vendor limits updated successfully.",
    vendor: publicVendor(updatedVendor),
  });
});

router.patch("/super-admin/vendors/:vendorId/status", requireAdmin, async (req, res) => {
  const vendor = await findVendorById(req.params.vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");

  const status = String(req.body.status || "").trim();
  if (!["Active", "Inactive"].includes(status)) {
    return sendError(res, 400, "Allowed status values are Active and Inactive.");
  }

  const updatedVendor = await updateVendorById(vendor.id, {
    status,
  });

  return res.json({
    success: true,
    message: "Vendor status updated successfully.",
    vendor: publicVendor(updatedVendor),
  });
});

router.get("/super-admin/customers", requireAdmin, async (req, res) => {
  const vendors = await listVendors();
  let customers = (await listCustomers()).map((customer) => enrichCustomer(customer, vendors));
  const search = String(req.query.search || "").trim().toLowerCase();
  const vendorId = String(req.query.vendorId || "").trim();
  if (vendorId) customers = customers.filter((customer) => customer.vendorId === vendorId);
  if (search) {
    customers = customers.filter((customer) =>
      [customer.name, customer.email, customer.phoneNumber]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );
  }
  return res.json({ success: true, customers, vendors: vendors.map(publicVendor) });
});

router.post("/super-admin/customers", requireAdmin, async (req, res) => {
  const vendorId = String(req.body.vendorId || "").trim();
  const vendor = await findVendorById(vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");
  const validation = validateCustomerPayload(req.body);
  if (validation.message) return sendError(res, 400, validation.message);
  const customers = await listCustomers({ vendorId });
  if (customers.length >= Number(vendor.customerLimit || 0)) {
    return sendError(res, 403, "Vendor customer limit reached. Please increase vendor limit before adding customer.");
  }
  const now = new Date().toISOString();
  const customer = await createCustomer({
    id: randomUUID(),
    vendorId,
    ...validation,
    createdBy: req.admin.email,
    updatedBy: req.admin.email,
    createdAt: now,
    updatedAt: now,
  });
  await refreshVendorUsage(vendorId);
  return res.json({ success: true, message: "Customer added successfully.", customer });
});

router.get("/super-admin/customers/:id", requireAdmin, async (req, res) => {
  const customer = await findCustomerById(req.params.id);
  if (!customer) return sendError(res, 404, "Customer not found.");
  const vendors = await listVendors();
  return res.json({ success: true, customer: enrichCustomer(customer, vendors) });
});

router.patch("/super-admin/customers/:id", requireAdmin, async (req, res) => {
  const existing = await findCustomerById(req.params.id);
  if (!existing) return sendError(res, 404, "Customer not found.");
  const validation = validateCustomerPayload({ ...existing, ...req.body }, true);
  if (validation.message) return sendError(res, 400, validation.message);
  const customer = await updateCustomerById(existing.id, {
    ...validation,
    updatedBy: req.admin.email,
  });
  return res.json({ success: true, message: "Customer updated successfully.", customer });
});

router.patch("/super-admin/customers/:id/status", requireAdmin, async (req, res) => {
  const existing = await findCustomerById(req.params.id);
  if (!existing) return sendError(res, 404, "Customer not found.");
  const status = String(req.body.status || "").trim();
  if (!["Active", "Inactive"].includes(status)) return sendError(res, 400, "Invalid customer status.");
  const customer = await updateCustomerById(existing.id, { status, updatedBy: req.admin.email });
  return res.json({
    success: true,
    message: status === "Active" ? "Customer marked active." : "Customer marked inactive.",
    customer,
  });
});

router.delete("/super-admin/customers/:id", requireAdmin, async (req, res) => {
  const customer = await findCustomerById(req.params.id);
  if (!customer) return sendError(res, 404, "Customer not found.");
  await deleteCustomerById(customer.id);
  await refreshVendorUsage(customer.vendorId);
  return res.json({ success: true, message: "Customer deleted successfully." });
});

router.get("/super-admin/products", requireAdmin, async (req, res) => {
  const vendors = await listVendors();
  let products = (await listProducts()).map((product) => enrichProduct(product, vendors));
  const search = String(req.query.search || "").trim().toLowerCase();
  const vendorId = String(req.query.vendorId || "").trim();
  if (vendorId) products = products.filter((product) => product.vendorId === vendorId);
  if (search) {
    products = products.filter((product) =>
      [product.name, product.unit, product.quantity, product.hsnCode].join(" ").toLowerCase().includes(search),
    );
  }
  return res.json({ success: true, products, vendors: vendors.map(publicVendor) });
});

router.post("/super-admin/products", requireAdmin, async (req, res) => {
  const vendorId = String(req.body.vendorId || "").trim();
  const vendor = await findVendorById(vendorId);
  if (!vendor) return sendError(res, 404, "Vendor not found.");
  const validation = validateProductPayload(req.body);
  if (validation.message) return sendError(res, 400, validation.message);
  const products = await listProducts({ vendorId });
  if (products.length >= Number(vendor.productLimit || 0)) {
    return sendError(res, 403, "Vendor product limit reached. Please increase vendor limit before adding product.");
  }
  const now = new Date().toISOString();
  const product = await createProduct({
    id: randomUUID(),
    vendorId,
    ...validation,
    createdBy: req.admin.email,
    updatedBy: req.admin.email,
    createdAt: now,
    updatedAt: now,
  });
  await refreshVendorUsage(vendorId);
  return res.json({ success: true, message: "Product added successfully.", product });
});

router.get("/super-admin/products/:id", requireAdmin, async (req, res) => {
  const product = await findProductById(req.params.id);
  if (!product) return sendError(res, 404, "Product not found.");
  const vendors = await listVendors();
  return res.json({ success: true, product: enrichProduct(product, vendors) });
});

router.patch("/super-admin/products/:id", requireAdmin, async (req, res) => {
  const existing = await findProductById(req.params.id);
  if (!existing) return sendError(res, 404, "Product not found.");
  const validation = validateProductPayload({ ...existing, ...req.body }, true);
  if (validation.message) return sendError(res, 400, validation.message);
  const product = await updateProductById(existing.id, {
    ...validation,
    updatedBy: req.admin.email,
  });
  return res.json({ success: true, message: "Product updated successfully.", product });
});

router.patch("/super-admin/products/:id/status", requireAdmin, async (req, res) => {
  const existing = await findProductById(req.params.id);
  if (!existing) return sendError(res, 404, "Product not found.");
  const status = String(req.body.status || "").trim();
  if (!["Active", "Inactive"].includes(status)) return sendError(res, 400, "Invalid product status.");
  const product = await updateProductById(existing.id, { status, updatedBy: req.admin.email });
  return res.json({
    success: true,
    message: status === "Active" ? "Product marked active." : "Product marked inactive.",
    product,
  });
});

router.delete("/super-admin/products/:id", requireAdmin, async (req, res) => {
  const product = await findProductById(req.params.id);
  if (!product) return sendError(res, 404, "Product not found.");
  await deleteProductById(product.id);
  await refreshVendorUsage(product.vendorId);
  return res.json({ success: true, message: "Product deleted successfully." });
});

router.get("/super-admin/reports", requireAdmin, async (req, res) => {
  const [reports, vendors, customers] = await Promise.all([
    listReports(),
    listVendors(),
    listCustomers(),
  ]);
  const vendorId = String(req.query.vendorId || "").trim();
  const search = String(req.query.search || "").trim().toLowerCase();
  const vendorMap = new Map(vendors.map((vendor) => [vendor.id, vendor]));
  const customerMap = new Map(customers.map((customer) => [customer.id, customer]));
  let enrichedReports = reports.map((report) => {
    const vendor = vendorMap.get(report.vendorId);
    const customer = customerMap.get(report.customerId);
    return {
      ...report,
      vendorName: vendor?.vendorName || "",
      vendorShopName: vendor?.shopName || "",
      customerName: customer?.name || report.reportData?.customer?.name || "",
    };
  });

  if (vendorId) {
    enrichedReports = enrichedReports.filter((report) => report.vendorId === vendorId);
  }
  if (search) {
    enrichedReports = enrichedReports.filter((report) =>
      [
        report.reportType,
        report.vendorName,
        report.vendorShopName,
        report.customerName,
        report.paymentStatus,
      ]
        .join(" ")
        .toLowerCase()
        .includes(search),
    );
  }

  return res.json({
    success: true,
    reports: enrichedReports,
    vendors: vendors.map(publicVendor),
  });
});

export default router;
