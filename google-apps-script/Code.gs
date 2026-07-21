function doGet() {
  return jsonResponse_({ success: true, message: "Milk Supply Vendor Apps Script API is running.", data: { version: "1.0.0" } });
}

function doPost(event) {
  try {
    var request = JSON.parse(event && event.postData && event.postData.contents ? event.postData.contents : "{}");
    var action = String(request.action || "");
    var payload = request.payload || {};
    var handler = actionHandler_(action);
    if (!handler) throw new Error("Unknown API action: " + action);
    var result = handler(payload) || {};
    return jsonResponse_({ success: true, message: result.message || "Success", data: result.data || {} });
  } catch (error) {
    console.error("API error: " + (error && error.stack ? error.stack : error));
    return jsonResponse_({ success: false, message: error && error.message ? error.message : "Unexpected server error.", data: error && error.data ? error.data : {} });
  }
}

function actionHandler_(action) {
  var handlers = {
    sendRegistrationOtp: function(payload) { return sendRegistrationOtp_(payload, false); },
    resendRegistrationOtp: function(payload) { return sendRegistrationOtp_(payload, true); },
    verifyRegistrationOtp: verifyRegistrationOtp_,
    vendorLogin: vendorLogin_, superAdminLogin: superAdminLogin_, logout: logout_, forgotPassword: forgotPassword_, resetPassword: resetPassword_,
    getVendorSession: getVendorSession_, getVendorDashboard: getVendorDashboard_, getVendorProfile: getVendorProfile_, updateVendorProfile: updateVendorProfile_,
    getCustomers: function(payload) { return getCustomers_(payload, false); },
    addCustomer: function(payload) { return addCustomer_(payload, false); },
    updateCustomer: function(payload) { return updateCustomer_(payload, false, false); },
    updateCustomerStatus: function(payload) { return updateCustomer_(payload, false, true); },
    getProducts: function(payload) { return getProducts_(payload, false); },
    addProduct: function(payload) { return addProduct_(payload, false); },
    updateProduct: function(payload) { return updateProduct_(payload, false, false); },
    updateProductStatus: function(payload) { return updateProduct_(payload, false, true); },
    saveDailySupply: saveDailySupply_, getDailySupply: getDailySupply_, generateReport: generateReport_, saveReport: saveReport_,
    getSavedReports: function(payload) { return getSavedReports_(payload, false); },
    updateReportPaymentStatus: updateReportPayment_, generateCustomerBill: generateCustomerBill_,
    getSuperAdminSession: getSuperAdminSession_, getSuperAdminDashboard: getSuperAdminDashboard_,
    getAllVendors: function(payload) { return getAllVendors_(payload, false); },
    getPendingVendors: function(payload) { return getAllVendors_(payload, true); },
    getVendorDetails: getVendorDetails_, approveVendor: approveVendor_, rejectVendor: rejectVendor_, updateVendorLimits: updateVendorLimits_, updateVendorStatus: updateVendorStatus_,
    getAllCustomers: function(payload) { return getCustomers_(payload, true); },
    getVendorCustomers: function(payload) { return getCustomers_(payload, true); },
    addCustomerAsAdmin: function(payload) { return addCustomer_(payload, true); },
    updateCustomerAsAdmin: function(payload) { return updateCustomer_(payload, true, false); },
    updateCustomerStatusAsAdmin: function(payload) { return updateCustomer_(payload, true, true); },
    deleteCustomer: deleteCustomer_,
    getAllProducts: function(payload) { return getProducts_(payload, true); },
    getVendorProducts: function(payload) { return getProducts_(payload, true); },
    addProductAsAdmin: function(payload) { return addProduct_(payload, true); },
    updateProductAsAdmin: function(payload) { return updateProduct_(payload, true, false); },
    updateProductStatusAsAdmin: function(payload) { return updateProduct_(payload, true, true); },
    deleteProduct: deleteProduct_,
    getAllReports: function(payload) { return getSavedReports_(payload, true); }
  };
  return handlers[action] || null;
}

function jsonResponse_(body) {
  return ContentService.createTextOutput(JSON.stringify(body)).setMimeType(ContentService.MimeType.JSON);
}
