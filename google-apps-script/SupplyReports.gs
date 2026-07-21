function monthKey_(dateText) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(dateText || ""))) throw new Error("Enter a valid date.");
  return String(dateText).slice(0, 7).replace("-", "_");
}

function getMonthlySupplySheet_(dateText, createIfMissing) {
  var key = monthKey_(dateText);
  var settingKey = "DAILY_FILE_" + key;
  var fileId = getSetting_(settingKey);
  var spreadsheet;
  if (fileId) {
    try { spreadsheet = SpreadsheetApp.openById(fileId); } catch (error) { fileId = ""; }
  }
  if (!fileId && !createIfMissing) return null;
  if (!fileId) {
    spreadsheet = SpreadsheetApp.create(APP.DAILY_FILE_PREFIX + key);
    fileId = spreadsheet.getId();
    var folderId = getSetting_("DAILY_SUPPLY_FOLDER_ID");
    if (!folderId) throw new Error("Daily supply folder is not configured. Run setupMasterSpreadsheet().");
    var file = DriveApp.getFileById(fileId);
    DriveApp.getFolderById(folderId).addFile(file);
    try { DriveApp.getRootFolder().removeFile(file); } catch (ignore) {}
    ensureSheet_(spreadsheet, APP.DAILY_SHEET, DAILY_HEADERS);
    var defaultSheet = spreadsheet.getSheetByName("Sheet1");
    if (defaultSheet && defaultSheet.getName() !== APP.DAILY_SHEET && spreadsheet.getSheets().length > 1) spreadsheet.deleteSheet(defaultSheet);
    setSetting_(settingKey, fileId);
  }
  return ensureSheet_(spreadsheet, APP.DAILY_SHEET, DAILY_HEADERS);
}

function readSupplySheet_(sheet) {
  if (!sheet) return [];
  var values = sheet.getDataRange().getValues();
  if (values.length < 2) return [];
  return values.slice(1).filter(function(row) { return row[0] !== ""; }).map(function(row, index) {
    var item = { _row: index + 2 };
    DAILY_HEADERS.forEach(function(header, column) { item[header] = normalizeCell_(row[column]); });
    item.id = item.supplyId;
    return item;
  });
}

function monthsBetween_(fromDate, toDate) {
  var start = new Date(fromDate + "T00:00:00Z");
  var end = new Date(toDate + "T00:00:00Z");
  var values = [];
  var cursor = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), 1));
  while (cursor <= end) {
    values.push(Utilities.formatDate(cursor, "UTC", "yyyy-MM-dd"));
    cursor.setUTCMonth(cursor.getUTCMonth() + 1);
  }
  return values;
}

function readSuppliesForRange_(vendorId, fromDate, toDate) {
  var supplies = [];
  monthsBetween_(fromDate, toDate).forEach(function(monthDate) {
    var sheet = getMonthlySupplySheet_(monthDate, false);
    if (sheet) supplies = supplies.concat(readSupplySheet_(sheet).filter(function(item) {
      return item.vendorId === vendorId && item.date >= fromDate && item.date <= toDate;
    }));
  });
  return supplies;
}

function supplyPayload_(payload, vendor, customerId) {
  var date = String(payload.date || "");
  monthKey_(date);
  var customer = findRecord_("Customers", "customerId", customerId);
  var product = findRecord_("Products", "productId", payload.productId);
  if (!customer || customer.vendorId !== vendor.vendorId) throw new Error("Customer not found.");
  if (customer.status !== "Active") throw new Error("Only active customers can be selected.");
  if (!product || product.vendorId !== vendor.vendorId) throw new Error("Product not found.");
  if (product.status !== "Active") throw new Error("Only active products can be selected.");
  var status = String(payload.status || "Supplied");
  if (["Supplied", "Not Supplied", "Extra Supply"].indexOf(status) === -1) throw new Error("Invalid supply status.");
  var quantity = status === "Not Supplied" ? 0 : Number(payload.quantity);
  if (status !== "Not Supplied" && (!isFinite(quantity) || quantity <= 0)) throw new Error("Quantity is required for supplied entries.");
  var rate = Number(product.pricePerUnit || 0);
  return {
    vendorId: vendor.vendorId, customerId: customerId, productId: product.productId, date: date,
    quantity: quantity, unit: product.unit, rate: rate, amount: status === "Not Supplied" ? 0 : quantity * rate,
    status: status, notes: String(payload.notes || "").trim()
  };
}

function saveDailySupply_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "Vendor");
    var customerIds = Array.isArray(payload.customerIds) ? payload.customerIds : payload.customerId ? [payload.customerId] : [];
    customerIds = customerIds.map(String).filter(function(value, index, list) { return value && list.indexOf(value) === index; });
    if (!customerIds.length) throw new Error("Customer selection is required.");
    var sheet = getMonthlySupplySheet_(payload.date, true);
    var existing = readSupplySheet_(sheet);
    var createdCount = 0;
    var updatedCount = 0;
    var saved = [];
    var newRows = [];
    var now = nowIso_();
    customerIds.forEach(function(customerId) {
      var values = supplyPayload_(payload, auth.user, customerId);
      var match = existing.find(function(item) {
        return item.vendorId === values.vendorId && item.customerId === values.customerId && item.productId === values.productId && item.date === values.date;
      });
      if (match) {
        var row = DAILY_HEADERS.map(function(header) {
          if (header === "supplyId") return match.supplyId;
          if (header === "createdAt") return match.createdAt;
          if (header === "updatedAt") return now;
          return serializeCell_(values[header]);
        });
        sheet.getRange(match._row, 1, 1, DAILY_HEADERS.length).setValues([row]);
        values.supplyId = match.supplyId; values.id = match.supplyId; values.createdAt = match.createdAt; values.updatedAt = now;
        updatedCount += 1;
      } else {
        values.supplyId = uuid_(); values.id = values.supplyId; values.createdAt = now; values.updatedAt = now;
        newRows.push(DAILY_HEADERS.map(function(header) { return serializeCell_(values[header]); }));
        createdCount += 1;
      }
      saved.push(values);
    });
    if (newRows.length) sheet.getRange(sheet.getLastRow() + 1, 1, newRows.length, DAILY_HEADERS.length).setValues(newRows);
    audit_(auth.user.vendorId, "Vendor", "DAILY_SUPPLY_SAVED", { date: payload.date, createdCount: createdCount, updatedCount: updatedCount });
    var message = saved.length === 1 ? (updatedCount ? "Supply entry updated successfully." : "Supply entry saved successfully.") : "Supply entries saved successfully. Created: " + createdCount + ", Updated: " + updatedCount + ".";
    return { message: message, data: { createdCount: createdCount, updatedCount: updatedCount, supplies: saved, supply: saved[0] } };
  });
}

function getDailySupply_(payload) {
  var auth = requireSession_(payload, "Vendor");
  var fromDate = String(payload.fromDate || payload.date || Utilities.formatDate(new Date(), "UTC", "yyyy-MM-01"));
  var toDate = String(payload.toDate || payload.date || Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd"));
  var customers = readTable_("Customers").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var products = readTable_("Products").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var customerMap = {}; customers.forEach(function(item) { customerMap[item.customerId] = item.name; });
  var productMap = {}; products.forEach(function(item) { productMap[item.productId] = item.productName; });
  var supplies = readSuppliesForRange_(auth.user.vendorId, fromDate, toDate).map(function(item) {
    item.customerName = customerMap[item.customerId] || "";
    item.productName = productMap[item.productId] || "";
    return stripMeta_(item);
  });
  return { data: { supplies: supplies } };
}

function reportData_(vendor, customers, products, supplies, reportType, fromDate, toDate, selectedIds) {
  var customerMap = {}; customers.forEach(function(item) { customerMap[item.customerId] = item; });
  var productMap = {}; products.forEach(function(item) { productMap[item.productId] = item; });
  var filtered = supplies.filter(function(item) { return selectedIds.indexOf(item.customerId) >= 0; });
  var detailRows = filtered.map(function(item) {
    return Object.assign({}, stripMeta_(item), {
      customerName: customerMap[item.customerId] ? customerMap[item.customerId].name : "",
      productName: productMap[item.productId] ? productMap[item.productId].productName : ""
    });
  });
  var totalAmount = detailRows.reduce(function(sum, item) { return sum + Number(item.amount || 0); }, 0);
  var productSummaryMap = {};
  detailRows.forEach(function(item) {
    var key = item.productId;
    if (!productSummaryMap[key]) productSummaryMap[key] = { productId: key, productName: item.productName, unit: item.unit, rate: Number(item.rate || 0), totalQuantity: 0, daysSupplied: 0, daysNotSupplied: 0, totalAmount: 0 };
    productSummaryMap[key].totalQuantity += Number(item.quantity || 0);
    productSummaryMap[key].totalAmount += Number(item.amount || 0);
    if (item.status === "Not Supplied") productSummaryMap[key].daysNotSupplied += 1; else productSummaryMap[key].daysSupplied += 1;
  });
  var customerSummary = selectedIds.map(function(id) {
    var customer = customerMap[id] || {};
    var rows = detailRows.filter(function(item) { return item.customerId === id; });
    return { customerId: id, customerName: customer.name || "", phoneNumber: customer.phoneNumber || "", totalQuantity: rows.reduce(function(sum, item) { return sum + Number(item.quantity || 0); }, 0), daysSupplied: rows.filter(function(item) { return item.status !== "Not Supplied"; }).length, daysNotSupplied: rows.filter(function(item) { return item.status === "Not Supplied"; }).length, totalAmount: rows.reduce(function(sum, item) { return sum + Number(item.amount || 0); }, 0), paymentStatus: "Unpaid" };
  });
  var firstCustomer = customerMap[selectedIds[0]];
  return {
    reportType: reportType, fromDate: fromDate, toDate: toDate,
    month: Number(fromDate.slice(5, 7)) - 1, monthName: Utilities.formatDate(new Date(fromDate + "T00:00:00Z"), "UTC", "MMMM"), year: Number(fromDate.slice(0, 4)),
    vendor: publicVendor_(vendor), customer: reportType === "Individual" && firstCustomer ? frontendCustomer_(firstCustomer) : null,
    customers: customers.filter(function(item) { return selectedIds.indexOf(item.customerId) >= 0; }).map(frontendCustomer_),
    productSummary: Object.keys(productSummaryMap).map(function(key) { return productSummaryMap[key]; }),
    customerSummary: customerSummary, detailRows: detailRows, totalCustomers: selectedIds.length,
    totalQuantitySupplied: detailRows.reduce(function(sum, item) { return sum + Number(item.quantity || 0); }, 0),
    totalSuppliedDays: detailRows.filter(function(item) { return item.status !== "Not Supplied"; }).length,
    totalNotSuppliedDays: detailRows.filter(function(item) { return item.status === "Not Supplied"; }).length,
    totalAmount: totalAmount
  };
}

function generateReport_(payload) {
  var auth = requireSession_(payload, "Vendor");
  var fromDate = String(payload.fromDate || "");
  var toDate = String(payload.toDate || "");
  if (!fromDate && Number.isInteger(Number(payload.month)) && payload.year) {
    var month = Number(payload.month) + 1;
    fromDate = String(payload.year) + "-" + ("0" + month).slice(-2) + "-01";
    toDate = Utilities.formatDate(new Date(Date.UTC(Number(payload.year), month, 0)), "UTC", "yyyy-MM-dd");
  }
  if (!fromDate || !toDate || fromDate > toDate) throw new Error("Enter a valid date range.");
  var customers = readTable_("Customers").filter(function(item) { return item.vendorId === auth.user.vendorId && item.status === "Active"; });
  var selectedIds = Array.isArray(payload.customerIds) ? payload.customerIds.map(String) : payload.customerId ? [String(payload.customerId)] : customers.map(function(item) { return item.customerId; });
  if (!selectedIds.length) throw new Error("Please select at least one customer to generate the report.");
  var reportType = String(payload.reportType || "Consolidated");
  if (reportType === "Individual" && selectedIds.length !== 1) throw new Error("Select one customer for an individual report.");
  var products = readTable_("Products").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var supplies = readSuppliesForRange_(auth.user.vendorId, fromDate, toDate);
  var reportData = reportData_(auth.user, customers, products, supplies, reportType, fromDate, toDate, selectedIds);
  audit_(auth.user.vendorId, "Vendor", "REPORT_GENERATED", { fromDate: fromDate, toDate: toDate, customerCount: selectedIds.length });
  return { message: "Report generated successfully.", data: { reportData: reportData } };
}

function saveReport_(payload) {
  return withWriteLock_(function() {
    var auth = requireSession_(payload, "Vendor");
    var data = payload.reportData || {};
    if (!data.reportType || !data.fromDate || !data.toDate) throw new Error("Invalid report data.");
    var now = nowIso_();
    var report = { reportId: uuid_(), vendorId: auth.user.vendorId, reportType: data.reportType, customerIds: JSON.stringify((data.customers || []).map(function(item) { return item.id || item.customerId; })), fromDate: data.fromDate, toDate: data.toDate, totalAmount: Number(data.totalAmount || 0), paymentStatus: "Unpaid", reportDataJson: JSON.stringify(data), fileUrl: "", createdAt: now, updatedAt: now };
    appendRecord_("ReportsIndex", report);
    audit_(auth.user.vendorId, "Vendor", "REPORT_SAVED", { reportId: report.reportId });
    return { message: "Report saved successfully.", data: { report: frontendReport_(report) } };
  });
}

function frontendReport_(record) {
  var value = stripMeta_(record); value.id = value.reportId; value.reportData = parseJson_(value.reportDataJson, {}); value.customerIds = parseJson_(value.customerIds, []); value.month = value.reportData.month; value.year = value.reportData.year; value.balanceAmount = Number(value.totalAmount || 0); return value;
}

function getSavedReports_(payload, adminMode) {
  var auth = requireSession_(payload, adminMode ? "SuperAdmin" : "Vendor");
  var reports = readTable_("ReportsIndex").filter(function(item) { return adminMode ? (!payload.vendorId || item.vendorId === payload.vendorId) : item.vendorId === auth.user.vendorId; }).map(frontendReport_);
  var data = { reports: reports };
  if (adminMode) data.vendors = readTable_("Vendors").map(publicVendor_);
  return { data: data };
}

function updateReportPayment_(payload) {
  var auth = requireSession_(payload, "Vendor");
  var report = findRecord_("ReportsIndex", "reportId", payload.id || payload.reportId);
  if (!report || report.vendorId !== auth.user.vendorId) throw new Error("Report not found.");
  var status = String(payload.paymentStatus || "Unpaid");
  if (["Paid", "Unpaid", "Partially Paid"].indexOf(status) === -1) throw new Error("Invalid payment status.");
  var data = parseJson_(report.reportDataJson, {}); data.paymentStatus = status; data.paidAmount = Number(payload.paidAmount || 0); data.paymentDate = String(payload.paymentDate || ""); data.paymentMode = String(payload.paymentMode || "");
  updateRecord_("ReportsIndex", report._row, { paymentStatus: status, reportDataJson: JSON.stringify(data), updatedAt: nowIso_() });
  return { message: "Payment status updated successfully.", data: { report: frontendReport_(findRecord_("ReportsIndex", "reportId", report.reportId)) } };
}

function generateCustomerBill_(payload) {
  var auth = requireSession_(payload, "Vendor");
  var month = Number(payload.month); var year = Number(payload.year);
  if (month < 0 || month > 11 || year < 2000) throw new Error("Month and year are required.");
  var fromDate = year + "-" + ("0" + (month + 1)).slice(-2) + "-01";
  var toDate = Utilities.formatDate(new Date(Date.UTC(year, month + 1, 0)), "UTC", "yyyy-MM-dd");
  var selected = Array.isArray(payload.customerIds) ? payload.customerIds.map(String) : [];
  if (!selected.length) throw new Error("Select at least one customer.");
  var customers = readTable_("Customers").filter(function(item) { return item.vendorId === auth.user.vendorId && item.status === "Active" && selected.indexOf(item.customerId) >= 0; });
  var products = readTable_("Products").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var report = reportData_(auth.user, customers, products, readSuppliesForRange_(auth.user.vendorId, fromDate, toDate), "Consolidated", fromDate, toDate, selected);
  var paymentLine = auth.user.phonePeGPayNumber && auth.user.upiId ? "Pay via PhonePe or GPay number +91 " + auth.user.phonePeGPayNumber + " or UPI ID " + auth.user.upiId : auth.user.phonePeGPayNumber ? "Pay via PhonePe or GPay number +91 " + auth.user.phonePeGPayNumber : auth.user.upiId ? "Pay via UPI ID " + auth.user.upiId : "";
  var bills = report.customerSummary.map(function(summary) {
    var customer = customers.find(function(item) { return item.customerId === summary.customerId; }) || {};
    return Object.assign({}, summary, { customerPhone: customer.phoneNumber || "", month: month, year: year, monthName: report.monthName, shopName: auth.user.shopName, paymentLine: paymentLine, hasSupplyRecords: summary.daysSupplied + summary.daysNotSupplied > 0 });
  });
  audit_(auth.user.vendorId, "Vendor", "CUSTOMER_BILL_GENERATED", { customerCount: bills.length, month: month, year: year });
  return { message: "Bill preview generated successfully.", data: { data: bills, hasSupplyRecords: bills.some(function(item) { return item.hasSupplyRecords; }), paymentWarning: paymentLine ? "" : "Payment details missing. Please update your PhonePe/GPay number or UPI ID in Vendor Profile before sending bills." } };
}

function getVendorDashboard_(payload) {
  var auth = requireSession_(payload, "Vendor");
  var customers = readTable_("Customers").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var products = readTable_("Products").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var reports = readTable_("ReportsIndex").filter(function(item) { return item.vendorId === auth.user.vendorId; });
  var today = Utilities.formatDate(new Date(), "UTC", "yyyy-MM-dd");
  var todays = readSuppliesForRange_(auth.user.vendorId, today, today);
  return { data: { metrics: { totalCustomers: customers.length, activeCustomers: customers.filter(function(x) { return x.status === "Active"; }).length, inactiveCustomers: customers.filter(function(x) { return x.status === "Inactive"; }).length, customerLimitUsed: customers.length, totalProducts: products.length, activeProducts: products.filter(function(x) { return x.status === "Active"; }).length, inactiveProducts: products.filter(function(x) { return x.status === "Inactive"; }).length, productLimitUsed: products.length, todaysDeliveries: todays.length, monthlyRevenue: 0, pendingPayments: reports.filter(function(x) { return x.paymentStatus !== "Paid"; }).reduce(function(sum, x) { return sum + Number(x.totalAmount || 0); }, 0), reportsGenerated: reports.length }, limits: { customerLimit: Number(auth.user.customerLimit || 0), productLimit: Number(auth.user.productLimit || 0), currentCustomerCount: customers.length, currentProductCount: products.length }, emptyMessage: "No data available yet. Start by adding your customers and products." } };
}
