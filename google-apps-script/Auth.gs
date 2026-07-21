function validateRegistration_(payload) {
  var vendorName = String(payload.vendorName || "").trim();
  var shopName = String(payload.shopName || "").trim();
  var email = normalizeEmail_(payload.email);
  var mobileNumber = normalizeMobile_(payload.mobileNumber);
  var password = String(payload.password || "");
  var confirmPassword = String(payload.confirmPassword || "");
  if (!vendorName) throw new Error("Vendor name is required.");
  if (!shopName) throw new Error("Shop name is required.");
  if (!validEmail_(email)) throw new Error("Enter a valid email address.");
  if (!validMobile_(mobileNumber)) throw new Error("Enter a valid 10 digit mobile number.");
  var passwordError = passwordError_(password);
  if (passwordError) throw new Error(passwordError);
  if (password !== confirmPassword) throw new Error("Password and Confirm Password do not match.");
  return { vendorName: vendorName, shopName: shopName, email: email, mobileNumber: mobileNumber, password: password };
}

function sendRegistrationOtp_(payload, isResend) {
  return withWriteLock_(function() {
    var registration;
    var email = normalizeEmail_(payload.email);
    var existingOtp = readTable_("OTP").filter(function(item) {
      return item.email === email && item.purpose === "VendorRegistration" && String(item.isUsed) !== "true";
    }).sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); })[0];

    if (isResend) {
      if (!existingOtp) throw new Error("No pending registration found for this email.");
      registration = parseJson_(existingOtp.registrationJson, null);
      if (!registration) throw new Error("Pending registration data is invalid. Please register again.");
    } else {
      registration = validateRegistration_(payload);
      if (findRecord_("Vendors", "email", registration.email)) throw new Error("Email already registered.");
      if (findRecord_("Vendors", "mobileNumber", registration.mobileNumber)) throw new Error("Mobile number already registered.");
    }

    var now = Date.now();
    if (existingOtp && now - new Date(existingOtp.lastSentAt || existingOtp.createdAt).getTime() < APP.OTP_COOLDOWN_MS) {
      var retry = Math.ceil((APP.OTP_COOLDOWN_MS - (now - new Date(existingOtp.lastSentAt || existingOtp.createdAt).getTime())) / 1000);
      var cooldownError = new Error("Please wait before requesting another OTP.");
      cooldownError.data = { retryAfterSeconds: retry };
      throw cooldownError;
    }

    var otp = String(Math.floor(100000 + Math.random() * 900000));
    var record = {
      otpId: uuid_(), email: registration.email, otpHash: hashPassword_(otp), purpose: "VendorRegistration",
      expiresAt: new Date(now + APP.OTP_EXPIRY_MS).toISOString(), isUsed: false, attempts: 0,
      registrationJson: JSON.stringify({
        vendorName: registration.vendorName, shopName: registration.shopName, email: registration.email,
        mobileNumber: registration.mobileNumber, passwordHash: registration.passwordHash || hashPassword_(registration.password)
      }),
      lastSentAt: new Date(now).toISOString(), createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    };
    if (existingOtp) {
      updateRecord_("OTP", existingOtp._row, record);
      record.otpId = existingOtp.otpId;
    } else appendRecord_("OTP", record);

    MailApp.sendEmail({
      to: registration.email,
      subject: "Your Milk Vendor Registration OTP",
      body: "Dear " + registration.vendorName + ",\n\nYour OTP for Milk Supply Vendor registration is: " + otp + "\n\nThis OTP is valid for 5 minutes. Do not share it with anyone.\n\nThank you,\nMilk Supply Vendor Management System",
      htmlBody: "<div style=\"font-family:Arial,sans-serif;line-height:1.6;color:#03045e\"><p>Dear " + escapeHtml_(registration.vendorName) + ",</p><p>Your OTP for Milk Supply Vendor registration is:</p><p style=\"font-size:28px;font-weight:700;letter-spacing:6px\">" + otp + "</p><p>This OTP is valid for 5 minutes. Do not share it with anyone.</p><p>Thank you,<br>Milk Supply Vendor Management System</p></div>"
    });
    audit_(registration.email, "Public", isResend ? "OTP_RESENT" : "OTP_SENT", { purpose: "VendorRegistration" });
    return { message: isResend ? "OTP resent successfully" : "OTP sent to your email address", data: {} };
  });
}

function verifyRegistrationOtp_(payload) {
  return withWriteLock_(function() {
    var email = normalizeEmail_(payload.email);
    var otp = String(payload.otp || "").trim();
    if (!validEmail_(email)) throw new Error("Enter a valid email address.");
    if (!/^\d{6}$/.test(otp)) throw new Error("Enter the 6 digit OTP.");
    var record = readTable_("OTP").filter(function(item) {
      return item.email === email && item.purpose === "VendorRegistration";
    }).sort(function(a, b) { return new Date(b.createdAt) - new Date(a.createdAt); })[0];
    if (!record) throw new Error("No pending registration found for this email.");
    if (String(record.isUsed) === "true") throw new Error("OTP already used.");
    if (Date.now() > new Date(record.expiresAt).getTime()) throw new Error("OTP expired. Please request a new OTP.");
    if (Number(record.attempts || 0) >= APP.OTP_MAX_ATTEMPTS) throw new Error("Too many invalid attempts. Please request a new OTP.");
    if (!verifyPassword_(otp, record.otpHash)) {
      var attempts = Number(record.attempts || 0) + 1;
      updateRecord_("OTP", record._row, { attempts: attempts, updatedAt: nowIso_() });
      throw new Error(attempts >= APP.OTP_MAX_ATTEMPTS ? "Too many invalid attempts. Please request a new OTP." : "Invalid OTP. Please try again.");
    }
    if (findRecord_("Vendors", "email", email)) throw new Error("Email already registered.");
    var registration = parseJson_(record.registrationJson, null);
    if (!registration) throw new Error("Pending registration data is invalid. Please register again.");
    var now = nowIso_();
    var vendor = {
      vendorId: uuid_(), vendorName: registration.vendorName, shopName: registration.shopName,
      email: registration.email, mobileNumber: registration.mobileNumber, passwordHash: registration.passwordHash,
      emailVerified: true, status: "Pending Approval", customerLimit: 0, productLimit: 0,
      currentCustomerCount: 0, currentProductCount: 0, phonePeGPayNumber: "", upiId: "", address: "",
      shopLocation: "", fssaiRegistrationNumber: "", approvedBy: "", approvedAt: "", rejectedAt: "",
      rejectionReason: "", createdAt: now, updatedAt: now
    };
    appendRecord_("Vendors", vendor);
    updateRecord_("OTP", record._row, { isUsed: true, updatedAt: now });
    audit_(vendor.vendorId, "Vendor", "OTP_VERIFIED", { email: email });
    audit_(vendor.vendorId, "Vendor", "VENDOR_REGISTERED", { status: vendor.status });
    return { message: "Registration completed successfully. Your account is pending Super Admin approval.", data: {} };
  });
}

function vendorLogin_(payload) {
  var email = normalizeEmail_(payload.email);
  var vendor = findRecord_("Vendors", "email", email);
  if (!vendor || !verifyPassword_(String(payload.password || ""), vendor.passwordHash)) throw new Error("Invalid email or password.");
  if (vendor.status !== "Active") {
    var statusError = new Error(vendorStatusMessage_(vendor.status));
    statusError.data = { status: vendor.status };
    throw statusError;
  }
  var token = createSession_(vendor.vendorId, "Vendor");
  audit_(vendor.vendorId, "Vendor", "VENDOR_LOGIN", {});
  return { message: "Vendor login successful", data: { token: token, vendor: publicVendor_(vendor) } };
}

function superAdminLogin_(payload) {
  var email = normalizeEmail_(payload.email);
  var admin = findRecord_("SuperAdmins", "email", email);
  if (!admin || admin.status !== "Active" || !verifyPassword_(String(payload.password || ""), admin.passwordHash)) throw new Error("Invalid admin email or password.");
  var token = createSession_(admin.adminId, "SuperAdmin");
  audit_(admin.adminId, "SuperAdmin", "SUPER_ADMIN_LOGIN", {});
  return { message: "Super Admin login successful", data: { token: token, admin: publicAdmin_(admin) } };
}

function logout_(payload) {
  var tokenHash = sha256_(String(payload.token || ""));
  var session = findRecord_("Sessions", "tokenHash", tokenHash);
  if (session) {
    updateRecord_("Sessions", session._row, { status: "Logged Out", lastUsedAt: nowIso_() });
    audit_(session.userId, session.role, "LOGOUT", {});
  }
  return { message: "Logged out successfully.", data: {} };
}

function forgotPassword_(payload) {
  var email = normalizeEmail_(payload.email);
  if (!validEmail_(email)) throw new Error("Enter a valid email address.");
  var vendor = findRecord_("Vendors", "email", email);
  if (vendor) {
    var token = randomSecret_() + randomSecret_();
    var now = Date.now();
    appendRecord_("OTP", {
      otpId: uuid_(), email: email, otpHash: sha256_(token), purpose: "PasswordReset",
      expiresAt: new Date(now + 30 * 60 * 1000).toISOString(), isUsed: false, attempts: 0,
      registrationJson: JSON.stringify({ vendorId: vendor.vendorId }), lastSentAt: new Date(now).toISOString(),
      createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString()
    });
    var frontendUrl = PropertiesService.getScriptProperties().getProperty("FRONTEND_URL") || getSetting_("FRONTEND_URL");
    if (!frontendUrl) throw new Error("Password reset is not configured. Set FRONTEND_URL in Script Properties.");
    var resetLink = frontendUrl.replace(/\/$/, "") + "/vendor/reset-password?token=" + encodeURIComponent(token);
    MailApp.sendEmail({ to: email, subject: "Reset your Milk Vendor account password", body: "Open this secure link to set a new password:\n" + resetLink + "\n\nThis link is valid for 30 minutes." });
  }
  return { message: "If an account exists for this email, a password reset link has been sent.", data: {} };
}

function resetPassword_(payload) {
  return withWriteLock_(function() {
    var token = String(payload.token || "");
    var password = String(payload.password || "");
    var error = passwordError_(password);
    if (error) throw new Error(error);
    if (password !== String(payload.confirmPassword || "")) throw new Error("Password and Confirm Password do not match.");
    var tokenHash = sha256_(token);
    var record = readTable_("OTP").find(function(item) { return item.purpose === "PasswordReset" && item.otpHash === tokenHash && String(item.isUsed) !== "true"; });
    if (!record || Date.now() > new Date(record.expiresAt).getTime()) throw new Error("Invalid or expired reset link.");
    var data = parseJson_(record.registrationJson, {});
    var vendor = findRecord_("Vendors", "vendorId", data.vendorId);
    if (!vendor) throw new Error("Vendor account not found.");
    updateRecord_("Vendors", vendor._row, { passwordHash: hashPassword_(password), updatedAt: nowIso_() });
    updateRecord_("OTP", record._row, { isUsed: true, updatedAt: nowIso_() });
    audit_(vendor.vendorId, "Vendor", "PASSWORD_RESET", {});
    return { message: "Password has been reset successfully.", data: {} };
  });
}

function escapeHtml_(value) {
  return String(value || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\"/g, "&quot;").replace(/'/g, "&#039;");
}
