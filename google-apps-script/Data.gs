function customerPayload_(payload) {
  var name = String(payload.name || "").trim();
  var email = normalizeEmail_(payload.email);
  var phoneNumber = normalizeMobile_(payload.phoneNumber);
  var address = String(payload.address || "").trim();
  var status = String(payload.status || "Active");
  if (!name) throw new Error("Customer name is required.");
  if (email && !validEmail_(email)) throw new Error("Enter a valid customer email address.");
  if (!validMobile_(phoneNumber)) throw new Error("Enter a valid 10 digit mobile number.");
  if (!address) throw new Error("Customer address is required.");
  if (["Active", "Inactive"].indexOf(status) === -1) throw new Error("Invalid customer status.");
  return { name: name, email: email, phoneNumber: phoneNumber, address: address, status: status };
}

function productPayload_(payload) {
  var name = String(payload.name || payload.productName || "").trim();
  var description = String(payload.description || payload.productDescription || "").trim();
  var quantity = Number(payload.quantity !== undefined ? payload.quantity : payload.productQuantity);
  var unit = String(payload.unit || "").trim();
  var price = Number(payload.pricePerUnit !== undefined ? payload.pricePerUnit : payload.price);
  var hsnCode = String(payload.hsnCode || "").trim();
  var status = String(payload.status || "Active");
  var units = ["Liters", "Kgs", "Gms", "ML", "Packets", "Bottles", "Pieces", "Other"];
  if (!name) throw new Error("Product name is required.");
  if (!description) throw new Error("Product description is required.");
  if (!isFinite(quantity) || quantity <= 0) throw new Error("Product quantity is required.");
  if (units.indexOf(unit) === -1) throw new Error("Select a valid product unit.");
  if (!isFinite(price) || price < 0) throw new Error("Enter a valid product price.");
  if (["Active", "Inactive"].indexOf(status) === -1) throw new Error("Invalid product status.");
  return { productName: name, productDescription: description, productQuantity: quantity, unit: unit, pricePerUnit: price, hsnCode: hsnCode, status: status };
}

function frontendProduct_(record) {
  var value = stripMeta_(record);
  value.id = value.productId;
  value.name = value.productName;
  value.description = value.productDescription;
  value.quantity = Number(value.productQuantity || 0);
  value.pricePerUnit = Number(value.pricePerUnit || 0);
  return value;
}

function frontendCustomer_(record) { var value = stripMeta_(record); value.id = value.customerId; return value; }

function refreshVendorUsage_(vendorId) {
  var vendor = findRecord_("Vendors", "vendorId", vendorId);
  if (!vendor) return;
  updateRecord_("Vendors", vendor._row, {
    currentCustomerCount: readTable_("Customers").filter(function(item) { return item.vendorId === vendorId; }).length,
    currentProductCount: readTable_("Products").filter(function(item) { return item.vendorId === vendorId; }).length,
    updatedAt: nowIso_()
  });
}

function getVendorSession_(payload) {
  var auth = requireSession_(payload, "Vendor");
  return { data: { vendor: publicVendor_(auth.user) } };
}

function getVendorProfile_(payload) { return getVendorSession_(payload); }

function updateVendorProfile_(payload) {
  var auth = requireSession_(payload, "Vendor");
  var vendor = auth.user;
  var shopName = String(payload.shopName !== undefined ? payload.shopName : vendor.shopName).trim();
  var phone = payload.phonePeGPayNumber ? normalizeMobile_(payload.phonePeGPayNumber) : "";
  var upiId = String(payload.upiId || "").trim();
  if (!shopName) throw new Error("Shop name is required.");
  if (phone && !validMobile_(phone)) throw new Error("PhonePe / GPay number should be a valid 10-digit mobile number.");
  if (upiId && !/^[\w.-]{2,}@[\w.-]{2,}$/.test(upiId)) throw new Error("Enter a valid UPI ID.");
  updateRecord_("Vendors", vendor._row, {
    shopName: shopName, phonePeGPayNumber: phone, upiId: upiId,
    address: String(payload.shopAddress !== undefined ? payload.shopAddress : payload.address || vendor.address || "").trim(),
    shopLocation: String(payload.shopLocation !== undefined ? payload.shopLocation : vendor.shopLocation || "").trim(),
    fssaiRegistrationNumber: String(payload.fssaiNumber !== undefined ? payload.fssaiNumber : payload.fssaiRegistrationNumber || vendor.fssaiRegistrationNumber || "").trim(),
    updatedAt: nowIso_()
  });
  var updated = findRecord_("Vendors", "vendorId", vendor.vendorId);
  audit_(vendor.vendorId, "Vendor", "VENDOR_PROFILE_UPDATED", {});
  return { message: "Profile updated successfully.", data: { vendor: publicVendor_(updated) } };
}

function getCustomers_(payload, adminMode) {
  var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
  var vendorId = adminMode ? String(payload.vendorId || "") : auth.user.vendorId;
  var customers = readTable_("Customers").filter(function(item) { return !vendorId || item.vendorId === vendorId; });
  var search = String(payload.search || "").toLowerCase();
  if (search) customers = customers.filter(function(item) { return [item.name, item.email, item.phoneNumber].join(" ").toLowerCase().indexOf(search) >= 0; });
  var data = { customers: customers.map(frontendCustomer_) };
  if (adminMode) data.vendors = readTable_("Vendors").map(publicVendor_);
  return { data: data };
}

function addCustomer_(payload, adminMode) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
    var vendorId = adminMode ? String(payload.vendorId || "") : auth.user.vendorId;
    var vendor = findRecord_("Vendors", "vendorId", vendorId);
    if (!vendor) throw new Error("Vendor not found.");
    var customers = readTable_("Customers").filter(function(item) { return item.vendorId === vendorId; });
    if (customers.length >= Number(vendor.customerLimit || 0)) throw new Error(adminMode ? "Vendor customer limit reached. Please increase vendor limit before adding customer." : "Customer limit reached. Please contact Super Admin to increase your limit.");
    var values = customerPayload_(payload);
    var now = nowIso_();
    var customer = { customerId: uuid_(), vendorId: vendorId, name: values.name, email: values.email, phoneNumber: values.phoneNumber, address: values.address, status: values.status, createdAt: now, updatedAt: now };
    appendRecord_("Customers", customer);
    refreshVendorUsage_(vendorId);
    audit_(auth.user.vendorId || auth.user.adminId, auth.role, "CUSTOMER_ADDED", { customerId: customer.customerId, vendorId: vendorId });
    return { message: "Customer added successfully.", data: { customer: frontendCustomer_(customer) } };
  });
}

function updateCustomer_(payload, adminMode, statusOnly) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
    var customer = findRecord_("Customers", "customerId", payload.id || payload.customerId);
    if (!customer || (!adminMode && customer.vendorId !== auth.user.vendorId)) throw new Error("Customer not found.");
    var patch;
    if (statusOnly) {
      var status = String(payload.status || "");
      if (["Active", "Inactive"].indexOf(status) === -1) throw new Error("Invalid customer status.");
      patch = { status: status, updatedAt: nowIso_() };
    } else {
      var values = customerPayload_(Object.assign({}, customer, payload));
      patch = Object.assign({}, values, { updatedAt: nowIso_() });
    }
    updateRecord_("Customers", customer._row, patch);
    var updated = findRecord_("Customers", "customerId", customer.customerId);
    audit_(auth.user.vendorId || auth.user.adminId, auth.role, statusOnly ? "CUSTOMER_STATUS_UPDATED" : "CUSTOMER_UPDATED", { customerId: customer.customerId });
    return { message: statusOnly ? (patch.status === "Active" ? "Customer marked active." : "Customer marked inactive.") : "Customer updated successfully.", data: { customer: frontendCustomer_(updated) } };
  });
}

function deleteCustomer_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "SuperAdmin");
    var customer = findRecord_("Customers", "customerId", payload.id || payload.customerId);
    if (!customer) throw new Error("Customer not found.");
    deleteRecord_("Customers", customer._row);
    refreshVendorUsage_(customer.vendorId);
    audit_(auth.user.adminId, "SuperAdmin", "CUSTOMER_DELETED", { customerId: customer.customerId });
    return { message: "Customer deleted successfully.", data: {} };
  });
}

function getProducts_(payload, adminMode) {
  var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
  var vendorId = adminMode ? String(payload.vendorId || "") : auth.user.vendorId;
  var products = readTable_("Products").filter(function(item) { return !vendorId || item.vendorId === vendorId; });
  var search = String(payload.search || "").toLowerCase();
  if (search) products = products.filter(function(item) { return [item.productName, item.unit, item.productQuantity, item.hsnCode].join(" ").toLowerCase().indexOf(search) >= 0; });
  var data = { products: products.map(frontendProduct_) };
  if (adminMode) data.vendors = readTable_("Vendors").map(publicVendor_);
  return { data: data };
}

function addProduct_(payload, adminMode) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
    var vendorId = adminMode ? String(payload.vendorId || "") : auth.user.vendorId;
    var vendor = findRecord_("Vendors", "vendorId", vendorId);
    if (!vendor) throw new Error("Vendor not found.");
    var products = readTable_("Products").filter(function(item) { return item.vendorId === vendorId; });
    if (products.length >= Number(vendor.productLimit || 0)) throw new Error(adminMode ? "Vendor product limit reached. Please increase vendor limit before adding product." : "Product limit reached. Please contact Super Admin to increase your limit.");
    var values = productPayload_(payload);
    var now = nowIso_();
    var product = Object.assign({ productId: uuid_(), vendorId: vendorId }, values, { createdAt: now, updatedAt: now });
    appendRecord_("Products", product);
    refreshVendorUsage_(vendorId);
    audit_(auth.user.vendorId || auth.user.adminId, auth.role, "PRODUCT_ADDED", { productId: product.productId, vendorId: vendorId });
    return { message: "Product added successfully.", data: { product: frontendProduct_(product) } };
  });
}

function updateProduct_(payload, adminMode, statusOnly) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
    var product = findRecord_("Products", "productId", payload.id || payload.productId);
    if (!product || (!adminMode && product.vendorId !== auth.user.vendorId)) throw new Error("Product not found.");
    var patch;
    if (statusOnly) {
      var status = String(payload.status || "");
      if (["Active", "Inactive"].indexOf(status) === -1) throw new Error("Invalid product status.");
      patch = { status: status, updatedAt: nowIso_() };
    } else patch = Object.assign({}, productPayload_(Object.assign({}, product, payload)), { updatedAt: nowIso_() });
    updateRecord_("Products", product._row, patch);
    var updated = findRecord_("Products", "productId", product.productId);
    audit_(auth.user.vendorId || auth.user.adminId, auth.role, statusOnly ? "PRODUCT_STATUS_UPDATED" : "PRODUCT_UPDATED", { productId: product.productId });
    return { message: statusOnly ? (patch.status === "Active" ? "Product marked active." : "Product marked inactive.") : "Product updated successfully.", data: { product: frontendProduct_(updated) } };
  });
}

function deleteProduct_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "SuperAdmin");
    var product = findRecord_("Products", "productId", payload.id || payload.productId);
    if (!product) throw new Error("Product not found.");
    deleteRecord_("Products", product._row);
    refreshVendorUsage_(product.vendorId);
    audit_(auth.user.adminId, "SuperAdmin", "PRODUCT_DELETED", { productId: product.productId });
    return { message: "Product deleted successfully.", data: {} };
  });
}
