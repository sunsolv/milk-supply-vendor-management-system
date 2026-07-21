var APP = Object.freeze({
  MASTER_TITLE: "Milk Mitra - A Milk Supply Management System - Master",
  DAILY_FOLDER_NAME: "MilkSupply_DailySupply_Data",
  DAILY_FILE_PREFIX: "DailySupply_",
  DAILY_SHEET: "DailySupply",
  OTP_EXPIRY_MS: 5 * 60 * 1000,
  OTP_COOLDOWN_MS: 60 * 1000,
  OTP_MAX_ATTEMPTS: 5,
  SESSION_EXPIRY_MS: 12 * 60 * 60 * 1000,
  DEFAULT_ADMIN_NAME: "Super Admin",
  DEFAULT_ADMIN_EMAIL: "admin@milkapp.com",
  DEFAULT_ADMIN_PASSWORD: "Admin@123"
});

var MASTER_HEADERS = Object.freeze({
  SuperAdmins: ["adminId", "name", "email", "passwordHash", "status", "createdAt", "updatedAt"],
  Vendors: ["vendorId", "vendorName", "shopName", "email", "mobileNumber", "passwordHash", "emailVerified", "status", "customerLimit", "productLimit", "currentCustomerCount", "currentProductCount", "phonePeGPayNumber", "upiId", "address", "shopLocation", "fssaiRegistrationNumber", "approvedBy", "approvedAt", "rejectedAt", "rejectionReason", "createdAt", "updatedAt"],
  Customers: ["customerId", "vendorId", "name", "email", "phoneNumber", "address", "status", "createdAt", "updatedAt"],
  Products: ["productId", "vendorId", "productName", "productDescription", "productQuantity", "unit", "pricePerUnit", "hsnCode", "status", "createdAt", "updatedAt"],
  OTP: ["otpId", "email", "otpHash", "purpose", "expiresAt", "isUsed", "attempts", "registrationJson", "lastSentAt", "createdAt", "updatedAt"],
  Sessions: ["sessionId", "userId", "role", "tokenHash", "expiresAt", "createdAt", "lastUsedAt", "status"],
  ReportsIndex: ["reportId", "vendorId", "reportType", "customerIds", "fromDate", "toDate", "totalAmount", "paymentStatus", "reportDataJson", "fileUrl", "createdAt", "updatedAt"],
  AuditLogs: ["logId", "userId", "role", "action", "details", "timestamp"],
  Settings: ["key", "value", "updatedAt"]
});

var DAILY_HEADERS = Object.freeze(["supplyId", "vendorId", "customerId", "productId", "date", "quantity", "unit", "rate", "amount", "status", "notes", "createdAt", "updatedAt"]);

function setupMasterSpreadsheet() {
  var props = PropertiesService.getScriptProperties();
  var masterId = props.getProperty("MASTER_SPREADSHEET_ID");
  var spreadsheet;
  if (masterId) {
    spreadsheet = SpreadsheetApp.openById(masterId);
  } else {
    spreadsheet = SpreadsheetApp.create(APP.MASTER_TITLE);
    masterId = spreadsheet.getId();
    props.setProperty("MASTER_SPREADSHEET_ID", masterId);
  }

  Object.keys(MASTER_HEADERS).forEach(function(name) {
    ensureSheet_(spreadsheet, name, MASTER_HEADERS[name]);
  });
  var defaultSheet = spreadsheet.getSheetByName("Sheet1");
  if (defaultSheet && Object.keys(MASTER_HEADERS).indexOf("Sheet1") === -1 && spreadsheet.getSheets().length > 1) {
    spreadsheet.deleteSheet(defaultSheet);
  }

  var folderId = props.getProperty("DAILY_SUPPLY_FOLDER_ID");
  if (!folderId) {
    var folders = DriveApp.getFoldersByName(APP.DAILY_FOLDER_NAME);
    var folder = folders.hasNext() ? folders.next() : DriveApp.createFolder(APP.DAILY_FOLDER_NAME);
    folderId = folder.getId();
    props.setProperty("DAILY_SUPPLY_FOLDER_ID", folderId);
  }

  setSetting_("MASTER_SPREADSHEET_ID", masterId);
  setSetting_("DAILY_SUPPLY_FOLDER_ID", folderId);
  setSetting_("SESSION_EXPIRY_HOURS", "12");
  setSetting_("TIME_ZONE", Session.getScriptTimeZone());
  ensureDefaultAdmin_();
  audit_("SYSTEM", "System", "MASTER_SETUP", { masterSpreadsheetId: masterId, dailySupplyFolderId: folderId });
  return {
    success: true,
    masterSpreadsheetId: masterId,
    masterSpreadsheetUrl: spreadsheet.getUrl(),
    dailySupplyFolderId: folderId
  };
}

function getMaster_() {
  var id = PropertiesService.getScriptProperties().getProperty("MASTER_SPREADSHEET_ID");
  if (!id) throw new Error("Run setupMasterSpreadsheet() before deploying the web app.");
  return SpreadsheetApp.openById(id);
}

function ensureSheet_(spreadsheet, name, headers) {
  var sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getMaxColumns() < headers.length) sheet.insertColumnsAfter(sheet.getMaxColumns(), headers.length - sheet.getMaxColumns());
  var current = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  var missing = headers.some(function(header, index) { return current[index] !== header; });
  if (missing) sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  sheet.setFrozenRows(1);
  sheet.getRange(1, 1, 1, headers.length).setFontWeight("bold").setBackground("#e5e7eb").setFontColor("#03045e");
  return sheet;
}

function readTable_(sheetName) {
  var sheet = getMaster_().getSheetByName(sheetName);
  if (!sheet) throw new Error("Missing sheet: " + sheetName);
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  var headers = values[0];
  return values.slice(1).filter(function(row) { return row.some(function(value) { return value !== ""; }); }).map(function(row, index) {
    var item = { _row: index + 2 };
    headers.forEach(function(header, column) { item[header] = normalizeCell_(row[column]); });
    return item;
  });
}

function appendRecord_(sheetName, record) {
  var sheet = getMaster_().getSheetByName(sheetName);
  var headers = MASTER_HEADERS[sheetName];
  sheet.appendRow(headers.map(function(header) { return serializeCell_(record[header]); }));
  return record;
}

function updateRecord_(sheetName, rowNumber, patch) {
  var sheet = getMaster_().getSheetByName(sheetName);
  var headers = MASTER_HEADERS[sheetName];
  var row = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  headers.forEach(function(header, index) {
    if (Object.prototype.hasOwnProperty.call(patch, header)) row[index] = serializeCell_(patch[header]);
  });
  sheet.getRange(rowNumber, 1, 1, headers.length).setValues([row]);
  return patch;
}

function deleteRecord_(sheetName, rowNumber) {
  getMaster_().getSheetByName(sheetName).deleteRow(rowNumber);
}

function findRecord_(sheetName, key, value) {
  var sheet = getMaster_().getSheetByName(sheetName);
  if (!sheet) throw new Error("Missing sheet: " + sheetName);
  var headers = MASTER_HEADERS[sheetName];
  var column = headers.indexOf(key) + 1;
  var lastRow = sheet.getLastRow();
  if (!column || lastRow < 2) return null;
  var match = sheet.getRange(2, column, lastRow - 1, 1)
    .createTextFinder(String(value))
    .matchEntireCell(true)
    .findNext();
  if (!match) return null;
  var rowNumber = match.getRow();
  var values = sheet.getRange(rowNumber, 1, 1, headers.length).getValues()[0];
  var item = { _row: rowNumber };
  headers.forEach(function(header, index) { item[header] = normalizeCell_(values[index]); });
  return item;
}

function withWriteLock_(callback) {
  var lock = LockService.getScriptLock();
  lock.waitLock(30000);
  try { return callback(); } finally { lock.releaseLock(); }
}

function setSetting_(key, value) {
  var existing = findRecord_("Settings", "key", key);
  var now = nowIso_();
  if (existing) updateRecord_("Settings", existing._row, { value: String(value), updatedAt: now });
  else appendRecord_("Settings", { key: key, value: String(value), updatedAt: now });
  CacheService.getScriptCache().put("setting:" + key, String(value), 21600);
}

function getSetting_(key) {
  var cache = CacheService.getScriptCache();
  var cached = cache.get("setting:" + key);
  if (cached !== null) return cached;
  var record = findRecord_("Settings", "key", key);
  if (record) cache.put("setting:" + key, String(record.value), 21600);
  return record ? String(record.value) : "";
}

function audit_(userId, role, action, details) {
  try {
    appendRecord_("AuditLogs", {
      logId: uuid_(), userId: userId || "", role: role || "", action: action,
      details: JSON.stringify(details || {}), timestamp: nowIso_()
    });
  } catch (error) {
    console.error("Audit log failed for " + action + ": " + error.message);
  }
}

function normalizeCell_(value) {
  return value instanceof Date ? value.toISOString() : value;
}

function serializeCell_(value) {
  if (value === undefined || value === null) return "";
  if (typeof value === "object") return JSON.stringify(value);
  return value;
}

function stripMeta_(record) {
  if (!record) return null;
  var copy = {};
  Object.keys(record).forEach(function(key) { if (key !== "_row") copy[key] = record[key]; });
  return copy;
}

function nowIso_() { return new Date().toISOString(); }
function uuid_() { return Utilities.getUuid(); }
function normalizeEmail_(value) { return String(value || "").trim().toLowerCase(); }
function normalizeMobile_(value) {
  var digits = String(value || "").replace(/\D/g, "");
  return digits.indexOf("91") === 0 && digits.length === 12 ? digits.slice(2) : digits;
}
function validEmail_(value) { return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value || "").trim()); }
function validMobile_(value) { return /^\d{10}$/.test(normalizeMobile_(value)); }
function parseJson_(value, fallback) { try { return JSON.parse(String(value || "")); } catch (error) { return fallback; } }
