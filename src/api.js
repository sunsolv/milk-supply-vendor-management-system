const APPS_SCRIPT_API_URL = String(import.meta.env.VITE_APPS_SCRIPT_API_URL || "").trim();

function queryPayload(url) {
  return Object.fromEntries(url.searchParams.entries());
}

function routeToAction(path, method) {
  const url = new URL(path, window.location.origin);
  const pathname = url.pathname.replace(/^\/api/, "");
  const query = queryPayload(url);
  const exact = {
    "POST /vendor/register/send-otp": "sendRegistrationOtp",
    "POST /vendor/register/resend-otp": "resendRegistrationOtp",
    "POST /vendor/register/verify-otp": "verifyRegistrationOtp",
    "POST /vendor/login": "vendorLogin",
    "POST /vendor/logout": "logout",
    "POST /vendor/forgot-password": "forgotPassword",
    "POST /vendor/reset-password": "resetPassword",
    "GET /vendor/me": "getVendorSession",
    "GET /vendor/dashboard": "getVendorDashboard",
    "GET /vendor/profile": "getVendorProfile",
    "PATCH /vendor/profile": "updateVendorProfile",
    "PATCH /vendor/profile/payment-details": "updateVendorProfile",
    "GET /vendor/customers": "getCustomers",
    "POST /vendor/customers": "addCustomer",
    "GET /vendor/products": "getProducts",
    "POST /vendor/products": "addProduct",
    "GET /vendor/daily-supply": "getDailySupply",
    "POST /vendor/daily-supply": "saveDailySupply",
    "GET /vendor/customer-bills": "generateCustomerBill",
    "POST /vendor/reports/generate": "generateReport",
    "POST /vendor/reports/save": "saveReport",
    "GET /vendor/reports": "getSavedReports",
    "POST /super-admin/login": "superAdminLogin",
    "POST /super-admin/logout": "logout",
    "GET /super-admin/me": "getSuperAdminSession",
    "GET /super-admin/dashboard": "getSuperAdminDashboard",
    "GET /super-admin/vendors": "getAllVendors",
    "GET /super-admin/vendors/pending": "getPendingVendors",
    "GET /super-admin/customers": "getAllCustomers",
    "POST /super-admin/customers": "addCustomerAsAdmin",
    "GET /super-admin/products": "getAllProducts",
    "POST /super-admin/products": "addProductAsAdmin",
    "GET /super-admin/reports": "getAllReports",
  };
  const key = `${method} ${pathname}`;
  if (exact[key]) return { action: exact[key], query };

  let match = pathname.match(/^\/vendor\/customers\/([^/]+)(\/status)?$/);
  if (match) return { action: match[2] ? "updateCustomerStatus" : "updateCustomer", query, id: match[1] };
  match = pathname.match(/^\/vendor\/products\/([^/]+)(\/status)?$/);
  if (match) return { action: match[2] ? "updateProductStatus" : "updateProduct", query, id: match[1] };
  match = pathname.match(/^\/vendor\/daily-supply\/([^/]+)$/);
  if (match) return { action: "saveDailySupply", query, id: match[1] };
  match = pathname.match(/^\/vendor\/reports\/([^/]+)\/payment-status$/);
  if (match) return { action: "updateReportPaymentStatus", query, id: match[1] };
  match = pathname.match(/^\/super-admin\/vendors\/([^/]+)(?:\/(approve|reject|limits|status))?$/);
  if (match) {
    const action = { approve: "approveVendor", reject: "rejectVendor", limits: "updateVendorLimits", status: "updateVendorStatus" }[match[2]] || "getVendorDetails";
    return { action, query, vendorId: match[1] };
  }
  match = pathname.match(/^\/super-admin\/(customers|products)\/([^/]+)(?:\/(status))?$/);
  if (match) {
    const entity = match[1];
    const deleting = method === "DELETE";
    const action = deleting
      ? entity === "customers" ? "deleteCustomer" : "deleteProduct"
      : match[3]
        ? entity === "customers" ? "updateCustomerStatusAsAdmin" : "updateProductStatusAsAdmin"
        : entity === "customers" ? "updateCustomerAsAdmin" : "updateProductAsAdmin";
    return { action, query, id: match[2] };
  }
  throw new Error(`Apps Script action mapping is missing for ${key}.`);
}

async function appsScriptRequest(path, { method = "GET", body, token } = {}) {
  const route = routeToAction(path, method);
  const payload = { ...route.query, ...(body || {}) };
  if (token) payload.token = token;
  if (route.id) payload.id = route.id;
  if (route.vendorId) payload.vendorId = route.vendorId;

  const response = await fetch(APPS_SCRIPT_API_URL, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({ action: route.action, payload }),
    redirect: "follow",
  });
  const result = await response.json().catch(() => ({ success: false, message: "Unexpected Apps Script response." }));
  if (!response.ok || result.success === false) {
    const error = new Error(result.message || "Request failed.");
    error.status = response.status;
    error.payload = { ...(result.data || {}), success: false, message: result.message };
    throw error;
  }
  return { success: true, message: result.message, ...(result.data || {}) };
}

async function legacyRequest(path, { method = "GET", body, token } = {}) {
  const headers = { "Content-Type": "application/json" };
  if (token) headers.Authorization = `Bearer ${token}`;
  const response = await fetch(path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  const payload = await response.json().catch(() => ({ success: false, message: "Unexpected server response." }));
  if (!response.ok || payload.success === false) {
    const error = new Error(payload.message || "Request failed.");
    error.status = response.status;
    error.payload = payload;
    throw error;
  }
  return payload;
}

export async function apiRequest(path, options = {}) {
  return APPS_SCRIPT_API_URL ? appsScriptRequest(path, options) : legacyRequest(path, options);
}
