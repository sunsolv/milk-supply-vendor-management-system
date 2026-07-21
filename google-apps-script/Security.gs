function bytesToHex_(bytes) {
  return bytes.map(function(byte) { var value = byte < 0 ? byte + 256 : byte; return ("0" + value.toString(16)).slice(-2); }).join("");
}

function sha256_(value) {
  return bytesToHex_(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(value), Utilities.Charset.UTF_8));
}

function randomSecret_() {
  return Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, uuid_() + ":" + new Date().getTime() + ":" + Math.random())).replace(/=+$/, "");
}

function hashPassword_(password) {
  var salt = randomSecret_().slice(0, 32);
  var digest = String(password);
  for (var i = 0; i < 12000; i += 1) digest = sha256_(salt + ":" + digest);
  return "v1$12000$" + salt + "$" + digest;
}

function verifyPassword_(password, encoded) {
  var parts = String(encoded || "").split("$");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  var iterations = Number(parts[1]);
  var digest = String(password);
  for (var i = 0; i < iterations; i += 1) digest = sha256_(parts[2] + ":" + digest);
  return digest === parts[3];
}

function passwordError_(password) {
  var value = String(password || "");
  if (value.length < 8) return "Password must be at least 8 characters.";
  if (!/[A-Z]/.test(value)) return "Password must contain at least one capital letter.";
  if (!/\d/.test(value)) return "Password must contain at least one number.";
  if (!/[@!#%&*]/.test(value)) return "Password must contain at least one symbol: @!#%&*.";
  return "";
}

function createSession_(userId, role) {
  var token = randomSecret_() + randomSecret_();
  var now = new Date();
  appendRecord_("Sessions", {
    sessionId: uuid_(), userId: userId, role: role, tokenHash: sha256_(token),
    expiresAt: new Date(now.getTime() + APP.SESSION_EXPIRY_MS).toISOString(),
    createdAt: now.toISOString(), lastUsedAt: now.toISOString(), status: "Active"
  });
  return token;
}

function requireSession_(payload, expectedRole) {
  var token = String((payload || {}).token || "");
  if (!token) throw new Error("Please login to continue.");
  var tokenHash = sha256_(token);
  var session = findRecord_("Sessions", "tokenHash", tokenHash);
  if (session && session.status !== "Active") session = null;
  if (!session || new Date(session.expiresAt).getTime() <= Date.now()) {
    if (session) updateRecord_("Sessions", session._row, { status: "Expired" });
    throw new Error("Session expired. Please login again.");
  }
  if (expectedRole && session.role !== expectedRole) throw new Error("Access denied.");
  updateRecord_("Sessions", session._row, { lastUsedAt: nowIso_() });
  if (session.role === "Vendor") {
    var vendor = findRecord_("Vendors", "vendorId", session.userId);
    if (!vendor) throw new Error("Vendor account not found.");
    if (vendor.status !== "Active") throw new Error(vendorStatusMessage_(vendor.status));
    return { session: session, user: vendor, role: "Vendor" };
  }
  var admin = findRecord_("SuperAdmins", "adminId", session.userId);
  if (!admin || admin.status !== "Active") throw new Error("Super Admin account is inactive.");
  return { session: session, user: admin, role: "SuperAdmin" };
}

function vendorStatusMessage_(status) {
  if (status === "Pending Approval") return "Your account is pending Super Admin approval.";
  if (status === "Inactive") return "Your account is inactive. Please contact Super Admin.";
  if (status === "Rejected") return "Your registration has been rejected. Please contact Super Admin.";
  return "Your account is not active. Please contact Super Admin.";
}

function publicVendor_(vendor) {
  var value = stripMeta_(vendor) || {};
  delete value.passwordHash;
  value.id = value.vendorId;
  value.shopAddress = value.address || "";
  value.fssaiNumber = value.fssaiRegistrationNumber || "";
  return value;
}

function publicAdmin_(admin) {
  var value = stripMeta_(admin) || {};
  delete value.passwordHash;
  value.id = value.adminId;
  value.role = "super-admin";
  return value;
}

function ensureDefaultAdmin_() {
  var email = normalizeEmail_(PropertiesService.getScriptProperties().getProperty("DEFAULT_ADMIN_EMAIL") || APP.DEFAULT_ADMIN_EMAIL);
  if (findRecord_("SuperAdmins", "email", email)) return;
  var now = nowIso_();
  appendRecord_("SuperAdmins", {
    adminId: uuid_(), name: APP.DEFAULT_ADMIN_NAME, email: email,
    passwordHash: hashPassword_(PropertiesService.getScriptProperties().getProperty("DEFAULT_ADMIN_PASSWORD") || APP.DEFAULT_ADMIN_PASSWORD),
    status: "Active", createdAt: now, updatedAt: now
  });
}
