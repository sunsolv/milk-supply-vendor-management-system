function getSuperAdminSession_(payload) {
  var auth = requireSession_(payload, "SuperAdmin");
  return { data: { admin: publicAdmin_(auth.user) } };
}

function adminDashboardData_() {
  var vendors = readTable_("Vendors");
  var customers = readTable_("Customers");
  var products = readTable_("Products");
  var reports = readTable_("ReportsIndex");
  var pending = vendors.filter(function(item) { return item.status === "Pending Approval"; });
  var active = vendors.filter(function(item) { return item.status === "Active"; });
  return {
    metrics: {
      totalVendors: vendors.length, pendingVendors: pending.length, activeVendors: active.length,
      inactiveVendors: vendors.filter(function(item) { return item.status === "Inactive"; }).length,
      rejectedVendors: vendors.filter(function(item) { return item.status === "Rejected"; }).length,
      totalCustomers: customers.length, totalProducts: products.length, totalReports: reports.length,
      pendingPaymentAmount: reports.filter(function(item) { return item.paymentStatus !== "Paid"; }).reduce(function(sum, item) { return sum + Number(item.totalAmount || 0); }, 0),
      totalApprovedCustomersLimit: active.reduce(function(sum, item) { return sum + Number(item.customerLimit || 0); }, 0),
      totalApprovedProductsLimit: active.reduce(function(sum, item) { return sum + Number(item.productLimit || 0); }, 0),
      pendingRegistrations: pending.length
    },
    vendors: vendors.map(publicVendor_), pendingVendors: pending.map(publicVendor_), pendingRegistrations: []
  };
}

function getSuperAdminDashboard_(payload) {
  requireSession_(payload, "SuperAdmin");
  return { data: adminDashboardData_() };
}

function getAllVendors_(payload, pendingOnly) {
  requireSession_(payload, "SuperAdmin");
  var vendors = readTable_("Vendors");
  if (pendingOnly) vendors = vendors.filter(function(item) { return item.status === "Pending Approval"; });
  var search = String(payload.search || "").toLowerCase();
  var status = String(payload.status || "");
  if (status) vendors = vendors.filter(function(item) { return item.status === status; });
  if (search) vendors = vendors.filter(function(item) { return [item.vendorName, item.shopName, item.email, item.mobileNumber].join(" ").toLowerCase().indexOf(search) >= 0; });
  return { data: { vendors: vendors.map(publicVendor_), metrics: adminDashboardData_().metrics } };
}

function getVendorDetails_(payload) {
  requireSession_(payload, "SuperAdmin");
  var vendor = findRecord_("Vendors", "vendorId", payload.vendorId || payload.id);
  if (!vendor) throw new Error("Vendor not found.");
  return { data: { vendor: publicVendor_(vendor) } };
}

function approveVendor_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "SuperAdmin");
    var vendor = findRecord_("Vendors", "vendorId", payload.vendorId || payload.id);
    if (!vendor) throw new Error("Vendor not found.");
    var customerLimit = Number(payload.customerLimit); var productLimit = Number(payload.productLimit);
    if (!Number.isInteger(customerLimit) || customerLimit < 1) throw new Error("Customer limit must be a positive whole number.");
    if (!Number.isInteger(productLimit) || productLimit < 1) throw new Error("Product limit must be a positive whole number.");
    var now = nowIso_();
    updateRecord_("Vendors", vendor._row, { status: "Active", customerLimit: customerLimit, productLimit: productLimit, approvedBy: auth.user.email, approvedAt: now, rejectedAt: "", rejectionReason: "", updatedAt: now });
    audit_(auth.user.adminId, "SuperAdmin", "VENDOR_APPROVED", { vendorId: vendor.vendorId, customerLimit: customerLimit, productLimit: productLimit });
    return { message: "Vendor approved successfully.", data: { vendor: publicVendor_(findRecord_("Vendors", "vendorId", vendor.vendorId)) } };
  });
}

function rejectVendor_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "SuperAdmin");
    var vendor = findRecord_("Vendors", "vendorId", payload.vendorId || payload.id);
    if (!vendor) throw new Error("Vendor not found.");
    updateRecord_("Vendors", vendor._row, { status: "Rejected", rejectedAt: nowIso_(), rejectionReason: String(payload.rejectionReason || "").trim(), updatedAt: nowIso_() });
    audit_(auth.user.adminId, "SuperAdmin", "VENDOR_REJECTED", { vendorId: vendor.vendorId });
    return { message: "Vendor rejected successfully.", data: { vendor: publicVendor_(findRecord_("Vendors", "vendorId", vendor.vendorId)) } };
  });
}

function updateVendorLimits_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "SuperAdmin");
    var vendor = findRecord_("Vendors", "vendorId", payload.vendorId || payload.id);
    if (!vendor) throw new Error("Vendor not found.");
    var customerLimit = Number(payload.customerLimit); var productLimit = Number(payload.productLimit);
    if (!Number.isInteger(customerLimit) || customerLimit < Number(vendor.currentCustomerCount || 0)) throw new Error("Customer limit cannot be less than current customer usage.");
    if (!Number.isInteger(productLimit) || productLimit < Number(vendor.currentProductCount || 0)) throw new Error("Product limit cannot be less than current product usage.");
    updateRecord_("Vendors", vendor._row, { customerLimit: customerLimit, productLimit: productLimit, updatedAt: nowIso_() });
    audit_(auth.user.adminId, "SuperAdmin", "VENDOR_LIMITS_UPDATED", { vendorId: vendor.vendorId, customerLimit: customerLimit, productLimit: productLimit });
    return { message: "Vendor limits updated successfully.", data: { vendor: publicVendor_(findRecord_("Vendors", "vendorId", vendor.vendorId)) } };
  });
}

function updateVendorStatus_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "SuperAdmin");
    var vendor = findRecord_("Vendors", "vendorId", payload.vendorId || payload.id);
    if (!vendor) throw new Error("Vendor not found.");
    var status = String(payload.status || "");
    if (["Active", "Inactive"].indexOf(status) === -1) throw new Error("Allowed status values are Active and Inactive.");
    updateRecord_("Vendors", vendor._row, { status: status, updatedAt: nowIso_() });
    audit_(auth.user.adminId, "SuperAdmin", "VENDOR_STATUS_UPDATED", { vendorId: vendor.vendorId, status: status });
    return { message: "Vendor status updated successfully.", data: { vendor: publicVendor_(findRecord_("Vendors", "vendorId", vendor.vendorId)) } };
  });
}
