import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { saveAs } from "file-saver";
import { jsPDF } from "jspdf";
import autoTable from "jspdf-autotable";
import * as XLSX from "xlsx";
import { apiRequest } from "./api.js";
import {
  ArrowLeft,
  Download,
  Edit3,
  Eye,
  FileSpreadsheet,
  CheckCircle2,
  Clock3,
  LayoutDashboard,
  Lock,
  LogOut,
  Mail,
  Milk,
  Package,
  Phone,
  Plus,
  ReceiptText,
  Send,
  ShieldCheck,
  Store,
  Trash2,
  Truck,
  UserPlus,
  Users,
  Wallet,
  X,
} from "lucide-react";

const AUTH_TOKEN_KEY = "milk-phase1-token";
const ADMIN_TOKEN_KEY = "milk-super-admin-token";
const OTP_EXPIRY_SECONDS = 5 * 60;
const RESEND_SECONDS = 60;
const PROTECTED_VENDOR_SCREENS = new Set([
  "dashboard",
  "profile",
  "customers",
  "products",
  "daily-supply",
  "send-customer-bills",
  "reports",
]);

function classNames(...classes) {
  return classes.filter(Boolean).join(" ");
}

function formatCurrency(value) {
  return new Intl.NumberFormat("en-IN", {
    style: "currency",
    currency: "INR",
    maximumFractionDigits: 0,
  }).format(Number(value || 0));
}

function formatBillNumber(value) {
  return Number(value || 0).toLocaleString("en-IN", {
    maximumFractionDigits: 2,
  });
}

function formatTimer(totalSeconds = 0) {
  const safeSeconds = Math.max(0, Number(totalSeconds || 0));
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

function isValidEmail(value = "") {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(String(value).trim());
}

function mobileDigits(value = "") {
  return String(value).replace(/\D/g, "").slice(0, 10);
}

function dateParts(value) {
  if (!value) return null;
  const text = String(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const [year, month, day] = text.split("-");
    return { day, month, year };
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return {
    day: String(date.getDate()).padStart(2, "0"),
    month: String(date.getMonth() + 1).padStart(2, "0"),
    year: String(date.getFullYear()),
    hours: String(date.getHours()).padStart(2, "0"),
    minutes: String(date.getMinutes()).padStart(2, "0"),
  };
}

function formatDate(value) {
  const parts = dateParts(value);
  return parts ? `${parts.day}-${parts.month}-${parts.year}` : "-";
}

function formatDateTime(value) {
  const parts = dateParts(value);
  if (!parts) return "-";
  return parts.hours ? `${parts.day}-${parts.month}-${parts.year} ${parts.hours}:${parts.minutes}` : formatDate(value);
}

function parseDisplayDate(value = "") {
  const match = String(value).trim().match(/^(\d{2})-(\d{2})-(\d{4})$/);
  if (!match) return "";
  const [, day, month, year] = match;
  const date = new Date(Number(year), Number(month) - 1, Number(day));
  if (
    date.getFullYear() !== Number(year) ||
    date.getMonth() !== Number(month) - 1 ||
    date.getDate() !== Number(day)
  ) {
    return "";
  }
  return `${year}-${month}-${day}`;
}

function latestSupplyTimestamp(item = {}) {
  const timestamp = new Date(item.updatedAt || item.createdAt || 0).getTime();
  return Number.isFinite(timestamp) ? timestamp : 0;
}

function dedupeSupplyEntries(items = []) {
  const latestByKey = new Map();
  items.forEach((item) => {
    const hasUniqueFields = item.vendorId && item.customerId && item.productId && item.date;
    const key = hasUniqueFields
      ? [item.vendorId, item.customerId, item.productId, item.date].join("|")
      : item.id || `${item.customerId || ""}|${item.productId || ""}|${item.date || ""}`;
    const current = latestByKey.get(key);
    if (!current || latestSupplyTimestamp(item) >= latestSupplyTimestamp(current)) {
      latestByKey.set(key, item);
    }
  });
  return Array.from(latestByKey.values());
}

function slugify(value = "report") {
  return String(value || "report")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "report";
}

function passwordRuleState(value = "") {
  return {
    minLength: value.length >= 8,
    capital: /[A-Z]/.test(value),
    number: /\d/.test(value),
    symbol: /[@!#%&*]/.test(value),
  };
}

function passwordPolicyMessage(value = "") {
  const rules = passwordRuleState(value);
  if (!rules.minLength) return "Password must be at least 8 characters.";
  if (!rules.capital) return "Password must contain at least one capital letter.";
  if (!rules.number) return "Password must contain at least one number.";
  if (!rules.symbol) return "Password must contain at least one symbol: @!#%&*.";
  return "";
}

function passwordIsStrongEnough(value = "") {
  return !passwordPolicyMessage(value);
}

function passwordsMatch(password = "", confirmPassword = "") {
  return Boolean(password) && Boolean(confirmPassword) && password === confirmPassword;
}

const PRODUCT_UNITS = ["Liters", "Kgs", "Gms", "ML", "Packets", "Bottles", "Pieces", "Other"];
const SUPPLY_STATUSES = ["Supplied", "Not Supplied", "Extra Supply"];
const PAYMENT_STATUSES = ["Paid", "Unpaid", "Partially Paid"];
const PAYMENT_MODES = ["Cash", "UPI", "PhonePe", "GPay", "Bank Transfer", "Other"];
const MONTH_NAMES = Array.from({ length: 12 }, (_, month) =>
  new Date(2024, month, 1).toLocaleString("en-IN", { month: "long" }),
);

function currentReportPeriod() {
  const now = new Date();
  return { month: now.getMonth(), year: now.getFullYear() };
}

function currentReportDateRange() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return {
    fromDate: `${year}-${month}-01`,
    toDate: `${year}-${month}-${day}`,
  };
}

function reportPeriodLabel(reportData) {
  if (reportData?.fromDate && reportData?.toDate) {
    return `${formatDate(reportData.fromDate)} to ${formatDate(reportData.toDate)}`;
  }
  if (reportData?.periodText) return reportData.periodText;
  return `${reportData?.monthName || ""} ${reportData?.year || ""}`.trim();
}

function reportFilename(reportData, extension) {
  const month = slugify(reportPeriodLabel(reportData) || reportData?.monthName || "period");
  const year = reportData?.year || new Date().getFullYear();
  if (reportData?.reportType === "Individual") {
    return `milk-report-${slugify(reportData?.customer?.name || "customer")}-${month}-${year}.${extension}`;
  }
  return `milk-consolidated-report-${slugify(reportData?.vendor?.shopName || "vendor")}-${month}-${year}.${extension}`;
}

function reportTitle(reportData) {
  const period = reportPeriodLabel(reportData);
  return reportData?.reportType === "Individual"
    ? `Individual Customer Report - ${period}`
    : `Consolidated Milk Supply Report - ${period}`;
}

function exportReportPdf(reportData, notify) {
  if (!reportData) {
    notify("Generate or select a report first.", "error");
    return;
  }

  const doc = new jsPDF({ orientation: "landscape" });
  doc.setFontSize(15);
  doc.text(reportTitle(reportData), 14, 16);
  doc.setFontSize(10);
  doc.text(`Vendor: ${reportData.vendor?.shopName || "-"} (${reportData.vendor?.vendorName || "-"})`, 14, 24);
  if (reportData.reportType === "Individual") {
    doc.text(`Report Period: ${reportPeriodLabel(reportData)}`, 14, 31);
    doc.text(`Customer: ${reportData.customer?.name || "-"} | Phone: +91 ${reportData.customer?.phoneNumber || "-"}`, 14, 38);
    doc.text(`Payment: ${reportData.vendor?.phonePeGPayNumber ? `+91 ${reportData.vendor.phonePeGPayNumber}` : "-"} | UPI: ${reportData.vendor?.upiId || "-"}`, 14, 45);
  } else {
    doc.text(`Report Period: ${reportPeriodLabel(reportData)}`, 14, 31);
    doc.text(`Total customers: ${reportData.totalCustomers || 0} | Grand total: ${formatCurrency(reportData.totalAmount || 0)}`, 14, 38);
  }

  const summaryRows =
    reportData.reportType === "Individual"
      ? (reportData.productSummary || []).map((row) => [
          row.productName,
          row.unit,
          row.totalQuantity,
          formatCurrency(row.rate),
          row.daysSupplied,
          row.daysNotSupplied,
          formatCurrency(row.totalAmount),
        ])
      : (reportData.customerSummary || []).map((row) => [
          row.customerName,
          `+91 ${row.phoneNumber || ""}`,
          row.productName,
          row.totalQuantity,
          row.unit,
          row.daysSupplied,
          row.daysNotSupplied,
          formatCurrency(row.totalAmount),
          row.paymentStatus || "Unpaid",
        ]);

  autoTable(doc, {
    startY: reportData.reportType === "Individual" ? 51 : 44,
    head:
      reportData.reportType === "Individual"
        ? [["Product", "Unit", "Quantity", "Rate", "Supplied", "Not supplied", "Amount"]]
        : [["Customer", "Phone", "Product", "Quantity", "Unit", "Supplied", "Not supplied", "Amount", "Payment"]],
    body: summaryRows,
    styles: { fontSize: 8 },
    headStyles: { fillColor: [5, 150, 105] },
  });

  autoTable(doc, {
    startY: doc.lastAutoTable.finalY + 8,
    head:
      reportData.reportType === "Individual"
        ? [["Date", "Product", "Quantity", "Unit", "Rate", "Status", "Amount"]]
        : [["Date", "Customer", "Product", "Quantity", "Unit", "Rate", "Status", "Amount"]],
    body: (reportData.detailRows || []).map((row) =>
      reportData.reportType === "Individual"
        ? [formatDate(row.date), row.productName, row.quantity, row.unit, formatCurrency(row.rate), row.status, formatCurrency(row.amount)]
        : [formatDate(row.date), row.customerName, row.productName, row.quantity, row.unit, formatCurrency(row.rate), row.status, formatCurrency(row.amount)],
    ),
    styles: { fontSize: 8 },
    headStyles: { fillColor: [15, 23, 42] },
  });

  doc.save(reportFilename(reportData, "pdf"));
  notify("PDF downloaded successfully.");
}

function exportReportExcel(reportData, notify) {
  if (!reportData) {
    notify("Generate or select a report first.", "error");
    return;
  }

  const workbook = XLSX.utils.book_new();
  const commonSummary = [
    ["Vendor name", reportData.vendor?.vendorName || ""],
    ["Vendor shop name", reportData.vendor?.shopName || ""],
    ["Report period", reportPeriodLabel(reportData)],
    ["Month", reportData.monthName || ""],
    ["Year", reportData.year || ""],
    ["Total amount", Number(reportData.totalAmount || 0)],
  ];

  if (reportData.reportType === "Individual") {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ...commonSummary,
        ["Customer name", reportData.customer?.name || ""],
        ["Customer phone", reportData.customer?.phoneNumber || ""],
        ["Customer address", reportData.customer?.address || ""],
        ["Total supplied days", reportData.totalSuppliedDays || 0],
        ["Total not supplied days", reportData.totalNotSuppliedDays || 0],
      ]),
      "Monthly Summary",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(reportData.productSummary || []),
      "Product-wise Summary",
    );
  } else {
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.aoa_to_sheet([
        ...commonSummary,
        ["Total customers", reportData.totalCustomers || 0],
        ["Total supplied days", reportData.totalSuppliedDays || 0],
        ["Total not supplied days", reportData.totalNotSuppliedDays || 0],
      ]),
      "Summary",
    );
    XLSX.utils.book_append_sheet(
      workbook,
      XLSX.utils.json_to_sheet(reportData.customerSummary || []),
      "Customer-wise Summary",
    );
  }

  XLSX.utils.book_append_sheet(
    workbook,
    XLSX.utils.json_to_sheet(reportData.detailRows || []),
    "Date-wise Supply Details",
  );
  const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
  saveAs(new Blob([bytes], { type: "application/octet-stream" }), reportFilename(reportData, "xlsx"));
  notify("Excel downloaded successfully.");
}

function buildWhatsAppMessage(reportData, paymentStatus = "Unpaid") {
  const productLines = (reportData.productSummary || [])
    .map(
      (item) =>
        `Product: ${item.productName}\nQuantity: ${item.totalQuantity} ${item.unit}\nDays Supplied: ${item.daysSupplied}\nDays Not Supplied: ${item.daysNotSupplied}\nAmount: ${formatCurrency(item.totalAmount)}`,
    )
    .join("\n\n");

  return `Dear ${reportData.customer?.name || "Customer"},\n\nYour milk and dairy product supply details for ${reportData.monthName} ${reportData.year} are:\n\n${productLines || "No supply entries found for this period."}\n\nTotal Amount Payable: ${formatCurrency(reportData.totalAmount || 0)}\nPayment Status: ${paymentStatus}\n\nKindly make the payment to PhonePe or GPay number ${
    reportData.vendor?.phonePeGPayNumber ? `+91 ${reportData.vendor.phonePeGPayNumber}` : "-"
  } or UPI ID ${reportData.vendor?.upiId || "-"}.\n\nThank you,\n${reportData.vendor?.shopName || "Milk Supply Vendor"}`;
}

function openWhatsAppBill(reportData, paymentStatus, notify) {
  if (!reportData || reportData.reportType !== "Individual") {
    notify("WhatsApp bill is available for individual customer reports only.", "error");
    return;
  }
  const phoneNumber = mobileDigits(reportData.customer?.phoneNumber || "");
  if (phoneNumber.length !== 10) {
    notify("Customer phone number must be a valid 10-digit mobile number.", "error");
    return;
  }
  const url = `https://wa.me/91${phoneNumber}?text=${encodeURIComponent(buildWhatsAppMessage(reportData, paymentStatus))}`;
  window.open(url, "_blank", "noopener,noreferrer");
  notify("WhatsApp message opened successfully.");
}

function buildCustomerBillMessage(bill) {
  const totalQuantity = bill.totalQuantitySupplied ?? bill.totalQuantity ?? 0;
  const totalAmount = bill.totalAmountPayable ?? bill.totalAmount ?? 0;
  return `Dear ${bill.customerName || "Customer"},

Your milk and dairy product supply details for ${bill.month} ${bill.year} are:

Total Quantity Supplied: ${formatBillNumber(totalQuantity)}
Days Supplied: ${bill.daysSupplied || 0}
Days Not Supplied: ${bill.daysNotSupplied || 0}
Total Amount Payable: ₹${formatBillNumber(totalAmount)}
Payment Status: ${bill.paymentLine || "Please update payment details in Vendor Profile"}

Thank you,
${bill.shopName || "Milk Supply Vendor"}`;
}

function openCustomerBillWhatsApp(bill, notify) {
  if (!bill.paymentLine) {
    notify("Payment details missing. Please update your PhonePe/GPay number or UPI ID in Vendor Profile before sending bills.", "error");
    return;
  }
  const phoneNumber = mobileDigits(bill.customerPhone || "");
  if (phoneNumber.length !== 10) {
    notify("Customer phone number is invalid. Please update customer details.", "error");
    return;
  }
  const url = `https://wa.me/91${phoneNumber}?text=${encodeURIComponent(buildCustomerBillMessage(bill))}`;
  window.open(url, "_blank", "noopener,noreferrer");
  notify("WhatsApp bill message opened successfully.");
}

function useStoredToken(storageKey = AUTH_TOKEN_KEY) {
  const [token, setTokenState] = useState(() => localStorage.getItem(storageKey) || "");

  const setToken = useCallback((value) => {
    setTokenState(value);
    if (value) {
      localStorage.setItem(storageKey, value);
    } else {
      localStorage.removeItem(storageKey);
    }
  }, [storageKey]);

  return [token, setToken];
}

function useAppPath() {
  const [path, setPath] = useState(window.location.pathname || "/");

  useEffect(() => {
    const onPopState = () => setPath(window.location.pathname || "/");
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const navigate = useCallback((nextPath) => {
    const normalizedPath = nextPath || "/";
    window.history.pushState({}, "", normalizedPath);
    setPath(normalizedPath);
  }, []);

  return [path.replace(/\/+$/, "") || "/", navigate];
}

function Button({
  children,
  icon: Icon,
  variant = "primary",
  type = "button",
  className,
  ...props
}) {
  const variants = {
    primary: "bg-brandPrimary text-white hover:bg-brandPrimary focus:ring-brandAccent",
    secondary:
      "border border-slate-200 bg-white text-slate-700 hover:bg-slate-50 focus:ring-slate-400",
    subtle: "bg-slate-100 text-slate-700 hover:bg-slate-200 focus:ring-slate-400",
    danger: "bg-red-600 text-white hover:bg-red-700 focus:ring-red-500",
  };

  return (
    <button
      type={type}
      className={classNames(
        "inline-flex min-h-10 items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-semibold transition focus:outline-none focus:ring-2 focus:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
        variants[variant],
        className,
      )}
      {...props}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0" /> : null}
      {children ? <span>{children}</span> : null}
    </button>
  );
}

function Field({ label, hint, children }) {
  return (
    <label className="block">
      <span className="text-sm font-semibold text-slate-800">{label}</span>
      <div className="mt-2">{children}</div>
      {hint ? <span className="mt-1 block text-xs font-medium text-slate-500">{hint}</span> : null}
    </label>
  );
}

function Input({ className, ...props }) {
  return (
    <input
      className={classNames(
        "min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-brandAccent focus:ring-2 focus:ring-brandLight",
        className,
      )}
      {...props}
    />
  );
}

function TextArea({ className, ...props }) {
  return (
    <textarea
      className={classNames(
        "min-h-24 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition placeholder:text-slate-400 focus:border-brandAccent focus:ring-2 focus:ring-brandLight",
        className,
      )}
      {...props}
    />
  );
}

function Select({ className, children, ...props }) {
  return (
    <select
      className={classNames(
        "min-h-11 w-full rounded-lg border border-slate-200 bg-white px-3 py-2 text-sm text-slate-950 outline-none transition focus:border-brandAccent focus:ring-2 focus:ring-brandLight",
        className,
      )}
      {...props}
    >
      {children}
    </select>
  );
}

function MobileInput({ value, onChange, required = true }) {
  return (
    <div className="flex min-h-11 overflow-hidden rounded-lg border border-slate-200 bg-white focus-within:border-brandAccent focus-within:ring-2 focus-within:ring-brandLight">
      <span className="flex items-center border-r border-slate-200 bg-slate-50 px-3 text-sm font-bold text-slate-700">
        +91
      </span>
      <input
        className="min-h-11 w-full bg-white px-3 py-2 text-sm text-slate-950 outline-none placeholder:text-slate-400"
        inputMode="numeric"
        maxLength={10}
        value={value}
        onChange={(event) => onChange(mobileDigits(event.target.value))}
        placeholder="9876543210"
        required={required}
      />
    </div>
  );
}

function ShowPasswordControl({ checked, onChange }) {
  return (
    <label className="mt-2 inline-flex items-center gap-2 text-sm font-semibold text-slate-700">
      <input
        type="checkbox"
        className="h-4 w-4 rounded border-slate-300 text-brandPrimary focus:ring-brandAccent"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Show Password
    </label>
  );
}

function PasswordRequirements({ password, confirmPassword }) {
  const rules = passwordRuleState(password);
  const items = [
    ["Minimum 8 characters", rules.minLength],
    ["One capital letter required", rules.capital],
    ["One number required", rules.number],
    ["One symbol required: @ ! # % & *", rules.symbol],
  ];
  const showMatchMessage = Boolean(password || confirmPassword);
  const matched = passwordsMatch(password, confirmPassword);

  return (
    <div className="rounded-lg border border-slate-200 bg-slate-50 p-3">
      <div className="grid gap-2 text-xs font-semibold">
        {items.map(([label, valid]) => (
          <p key={label} className={valid ? "text-brandPrimary" : "text-slate-500"}>
            {valid ? "Pass:" : "Need:"} {label}
          </p>
        ))}
      </div>
      {showMatchMessage ? (
        <p className={classNames("mt-2 text-xs font-bold", matched ? "text-brandPrimary" : "text-red-700")}>
          {matched ? "Password matched." : "Password and Confirm Password do not match."}
        </p>
      ) : null}
    </div>
  );
}

function ToastStack({ toasts, dismissToast }) {
  return (
    <div className="fixed right-4 top-4 z-50 grid w-[calc(100%-2rem)] max-w-sm gap-3">
      {toasts.map((toast) => (
        <div
          key={toast.id}
          className={classNames(
            "flex items-start gap-3 rounded-lg border bg-white p-3 shadow-lg",
            toast.type === "error" ? "border-red-200" : "border-brandLight",
          )}
        >
          <div
            className={classNames(
              "rounded-lg p-2",
              toast.type === "error" ? "bg-red-50 text-red-700" : "bg-brandBg text-brandPrimary",
            )}
          >
            {toast.type === "error" ? <X className="h-4 w-4" /> : <CheckCircle2 className="h-4 w-4" />}
          </div>
          <p className="min-w-0 flex-1 text-sm font-semibold text-slate-800">{toast.message}</p>
          <button
            type="button"
            className="rounded-md p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            onClick={() => dismissToast(toast.id)}
            aria-label="Dismiss notification"
          >
            <X className="h-4 w-4" />
          </button>
        </div>
      ))}
    </div>
  );
}

function Shell({ children }) {
  return (
    <div className="min-h-screen bg-brandBg/40 text-brandDark">
      <header className="border-b border-brandAccent bg-brandDark text-white">
        <div className="mx-auto flex max-w-6xl items-center justify-between px-4 py-4 sm:px-6">
          <div className="flex items-center gap-3">
            <div className="rounded-lg bg-brandPrimary p-2 text-white">
              <Milk className="h-5 w-5" />
            </div>
            <div>
              <p className="text-sm font-bold text-white">Milk Supply</p>
              <p className="text-xs font-medium text-brandLight">Vendor Management System</p>
            </div>
          </div>
          <div className="hidden items-center gap-2 text-xs font-bold uppercase tracking-wide text-brandPrimary sm:flex">
            <ShieldCheck className="h-4 w-4" />
            Phase 1
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6 sm:px-6 lg:py-10">{children}</main>
    </div>
  );
}

function AuthPanel({ title, subtitle, icon: Icon, children }) {
  return (
    <section className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:p-6">
      <div className="mb-6 flex items-start gap-3">
        <div className="rounded-lg bg-brandBg p-3 text-brandPrimary ring-1 ring-brandLight">
          <Icon className="h-6 w-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-950">{title}</h1>
          <p className="mt-1 text-sm leading-6 text-slate-600">{subtitle}</p>
        </div>
      </div>
      {children}
    </section>
  );
}

function LogoutConfirmationModal({ onConfirm, onCancel }) {
  return (
    <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 px-4">
      <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
        <div className="flex items-start gap-3">
          <div className="rounded-lg bg-red-50 p-3 text-red-700">
            <LogOut className="h-5 w-5" />
          </div>
          <div>
            <h2 className="text-lg font-bold text-slate-950">Logout Confirmation</h2>
            <p className="mt-2 text-sm leading-6 text-slate-600">Are you sure you want to logout?</p>
          </div>
        </div>
        <div className="mt-5 grid gap-3 sm:grid-cols-2">
          <Button variant="danger" icon={LogOut} onClick={onConfirm}>
            Yes, Logout
          </Button>
          <Button variant="secondary" onClick={onCancel}>
            No, Stay Here
          </Button>
        </div>
      </div>
    </div>
  );
}

function LandingPage({ onRegister, onLogin }) {
  return (
    <div className="grid gap-8 lg:grid-cols-[1.1fr_0.9fr] lg:items-center">
      <section>
        <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">
          Phase 1 application
        </p>
        <h1 className="mt-3 text-4xl font-bold text-slate-950 sm:text-5xl">
          Milk Supply Vendor Management System
        </h1>
        <p className="mt-4 max-w-2xl text-base leading-7 text-slate-600">
          Register your vendor account with email OTP verification, login with your
          registered email and password, and start from a clean dashboard with no
          preloaded business data.
        </p>
        <div className="mt-6 flex flex-col gap-3 sm:flex-row">
          <Button icon={UserPlus} onClick={onRegister}>
            Vendor Register
          </Button>
          <Button variant="secondary" icon={Store} onClick={onLogin}>
            Vendor Login
          </Button>
        </div>
      </section>
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">Phase 1 includes</h2>
        <div className="mt-4 grid gap-3">
          {[
            ["Email OTP", "OTP is sent through SMTP and never shown on screen.", Mail],
            ["Secure Password", "Passwords and OTPs are stored as hashes.", Lock],
            ["Protected Dashboard", "Only logged-in vendors can view their dashboard.", LayoutDashboard],
            ["No Dummy Data", "Metrics stay zero until the vendor creates real records.", Package],
          ].map(([title, text, Icon]) => (
            <div key={title} className="flex gap-3 rounded-lg border border-slate-200 p-3">
              <div className="rounded-lg bg-slate-100 p-2 text-slate-700">
                <Icon className="h-4 w-4" />
              </div>
              <div>
                <p className="text-sm font-bold text-slate-950">{title}</p>
                <p className="mt-1 text-xs leading-5 text-slate-500">{text}</p>
              </div>
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}

function RegistrationPage({ onBack, onRegistered, notify }) {
  const [step, setStep] = useState("form");
  const [form, setForm] = useState({
    vendorName: "",
    shopName: "",
    email: "",
    mobileNumber: "",
    password: "",
    confirmPassword: "",
  });
  const [otp, setOtp] = useState("");
  const [otpEmail, setOtpEmail] = useState("");
  const [otpTimer, setOtpTimer] = useState(0);
  const [resendTimer, setResendTimer] = useState(0);
  const [loading, setLoading] = useState(false);
  const [showPasswords, setShowPasswords] = useState(false);

  useEffect(() => {
    if (step !== "otp") return undefined;
    const timer = window.setInterval(() => {
      setOtpTimer((value) => Math.max(0, value - 1));
      setResendTimer((value) => Math.max(0, value - 1));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [step]);

  const updateForm = (field, value) => {
    setForm((current) => ({ ...current, [field]: value }));
  };

  const validateForm = () => {
    const email = form.email.trim().toLowerCase();
    if (!form.vendorName.trim()) return "Vendor name is required.";
    if (!form.shopName.trim()) return "Shop name is required.";
    if (!isValidEmail(email)) return "Enter a valid email address.";
    if (mobileDigits(form.mobileNumber).length !== 10) {
      return "Enter a valid 10 digit mobile number.";
    }
    const passwordMessage = passwordPolicyMessage(form.password);
    if (passwordMessage) return passwordMessage;
    if (form.password !== form.confirmPassword) {
      return "Password and Confirm Password do not match.";
    }
    return "";
  };

  const sendOtp = async (event) => {
    event.preventDefault();
    const validationMessage = validateForm();
    if (validationMessage) {
      notify(validationMessage, "error");
      return;
    }

    setLoading(true);
    try {
      const email = form.email.trim().toLowerCase();
      const payload = {
        ...form,
        email,
        mobileNumber: mobileDigits(form.mobileNumber),
      };
      const response = await apiRequest("/api/vendor/register/send-otp", {
        method: "POST",
        body: payload,
      });
      setOtpEmail(email);
      setOtp("");
      setOtpTimer(OTP_EXPIRY_SECONDS);
      setResendTimer(RESEND_SECONDS);
      setStep("otp");
      notify(response.message || "OTP sent successfully.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const resendOtp = async () => {
    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/register/resend-otp", {
        method: "POST",
        body: { email: otpEmail },
      });
      setOtp("");
      setOtpTimer(OTP_EXPIRY_SECONDS);
      setResendTimer(RESEND_SECONDS);
      notify(response.message || "OTP resent successfully.");
    } catch (error) {
      if (error.payload?.retryAfterSeconds) {
        setResendTimer(error.payload.retryAfterSeconds);
      }
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  const verifyOtp = async (event) => {
    event.preventDefault();
    if (!/^\d{6}$/.test(otp)) {
      notify("Enter the 6 digit OTP.", "error");
      return;
    }

    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/register/verify-otp", {
        method: "POST",
        body: { email: otpEmail, otp },
      });
      notify("OTP verified successfully.");
      notify(`${response.message}. Please login.`);
      onRegistered(otpEmail);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  if (step === "otp") {
    return (
      <AuthPanel
        title="Verify Email OTP"
        subtitle="OTP has been sent to your email address. Please check your inbox."
        icon={Mail}
      >
        <div className="mb-5 rounded-lg border border-brandLight bg-brandBg p-4">
          <p className="text-sm font-bold text-slate-950">Email address</p>
          <p className="mt-1 break-words text-sm font-semibold text-brandPrimary">{otpEmail}</p>
          <div className="mt-3 flex items-center gap-2 text-sm font-semibold text-slate-700">
            <Clock3 className="h-4 w-4 text-brandPrimary" />
            OTP expires in {formatTimer(otpTimer)}
          </div>
        </div>
        <form className="space-y-4" onSubmit={verifyOtp}>
          <Field label="Enter OTP" hint="Enter the 6 digit OTP received in your email.">
            <Input
              value={otp}
              onChange={(event) => setOtp(event.target.value.replace(/\D/g, "").slice(0, 6))}
              inputMode="numeric"
              maxLength={6}
              placeholder="6 digit OTP"
              required
            />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Button type="submit" icon={CheckCircle2} disabled={loading || otpTimer === 0}>
              Verify OTP
            </Button>
            <Button
              variant="secondary"
              icon={Send}
              onClick={resendOtp}
              disabled={loading || resendTimer > 0}
            >
              {resendTimer > 0 ? `Resend in ${formatTimer(resendTimer)}` : "Resend OTP"}
            </Button>
          </div>
          <Button variant="subtle" icon={ArrowLeft} onClick={() => setStep("form")} className="w-full">
            Edit Registration Details
          </Button>
        </form>
      </AuthPanel>
    );
  }

  return (
    <AuthPanel
      title="Vendor Registration"
      subtitle="Create your vendor account. An OTP will be sent only to the entered email address."
      icon={UserPlus}
    >
      <form className="grid gap-4" onSubmit={sendOtp}>
        <Field label="Vendor name">
          <Input
            value={form.vendorName}
            onChange={(event) => updateForm("vendorName", event.target.value)}
            placeholder="Vendor name"
            required
          />
        </Field>
        <Field label="Shop name">
          <Input
            value={form.shopName}
            onChange={(event) => updateForm("shopName", event.target.value)}
            placeholder="Shop name"
            required
          />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Email address">
            <Input
              type="email"
              value={form.email}
              onChange={(event) => updateForm("email", event.target.value)}
              placeholder="vendor@example.com"
              required
            />
          </Field>
          <Field label="Mobile number" hint="Enter 10 digits after +91.">
            <MobileInput
              value={form.mobileNumber}
              onChange={(value) => updateForm("mobileNumber", value)}
            />
          </Field>
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Password" hint="Minimum 8 characters with capital letter, number, and @!#%&*.">
            <Input
              type={showPasswords ? "text" : "password"}
              value={form.password}
              onChange={(event) => updateForm("password", event.target.value)}
              placeholder="Create password"
              required
            />
          </Field>
          <Field label="Confirm Password">
            <Input
              type={showPasswords ? "text" : "password"}
              value={form.confirmPassword}
              onChange={(event) => updateForm("confirmPassword", event.target.value)}
              placeholder="Confirm password"
              required
            />
          </Field>
        </div>
        <ShowPasswordControl checked={showPasswords} onChange={setShowPasswords} />
        <PasswordRequirements password={form.password} confirmPassword={form.confirmPassword} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Button type="submit" icon={Send} disabled={loading} aria-busy={loading}>
            {loading ? "Sending OTP..." : "Register and Send OTP"}
          </Button>
          <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}

function LoginPage({ onBack, onLogin, onPendingApproval, onForgotPassword, prefillEmail, notify }) {
  const [email, setEmail] = useState(prefillEmail || "");
  const [password, setPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    setEmail(prefillEmail || "");
  }, [prefillEmail]);

  const submit = async (event) => {
    event.preventDefault();
    if (!isValidEmail(email)) {
      notify("Enter a valid email address.", "error");
      return;
    }

    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/login", {
        method: "POST",
        body: { email: email.trim().toLowerCase(), password },
      });
      notify(response.message || "Login successful.");
      onLogin(response);
    } catch (error) {
      if (error.payload?.status === "Pending Approval") {
        notify("Your account is pending approval.", "error");
        onPendingApproval?.(email.trim().toLowerCase());
        return;
      }
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPanel
      title="Vendor Login"
      subtitle="Login using the email address and password used during registration."
      icon={Store}
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Registered email address">
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="vendor@example.com"
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type={showPassword ? "text" : "password"}
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter password"
            required
          />
        </Field>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
          <ShowPasswordControl checked={showPassword} onChange={setShowPassword} />
          <button
            type="button"
            className="text-left text-sm font-bold text-brandPrimary hover:text-brandPrimary"
            onClick={onForgotPassword}
          >
            Forgot Password?
          </button>
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Button type="submit" icon={Lock} disabled={loading}>
            Login
          </Button>
          <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
            Back
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}

function ForgotPasswordPage({ onBack, notify }) {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [sent, setSent] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    const normalizedEmail = email.trim().toLowerCase();
    if (!isValidEmail(normalizedEmail)) {
      notify("Enter a valid email address.", "error");
      return;
    }

    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/forgot-password", {
        method: "POST",
        body: { email: normalizedEmail },
      });
      setSent(true);
      notify(response.message || "Password reset link has been sent to your email.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPanel
      title="Forgot Password"
      subtitle="Enter your registered vendor email address to receive a password reset link."
      icon={Mail}
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Email">
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="vendor@example.com"
            required
          />
        </Field>
        {sent ? (
          <div className="rounded-lg border border-brandLight bg-brandBg p-3 text-sm font-semibold text-brandPrimary">
            Password reset link has been sent to your email.
          </div>
        ) : null}
        <div className="grid gap-3 sm:grid-cols-2">
          <Button type="submit" icon={Send} disabled={loading}>
            Send Reset Link
          </Button>
          <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
            Back to Login
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}

function ResetPasswordPage({ onBack, notify }) {
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPasswords, setShowPasswords] = useState(false);
  const [loading, setLoading] = useState(false);
  const token = new URLSearchParams(window.location.search).get("token") || "";
  const passwordReady = passwordIsStrongEnough(password) && passwordsMatch(password, confirmPassword);

  const submit = async (event) => {
    event.preventDefault();
    if (!token) {
      notify("Invalid or expired reset link.", "error");
      return;
    }
    const passwordMessage = passwordPolicyMessage(password);
    if (passwordMessage) {
      notify(passwordMessage, "error");
      return;
    }
    if (password !== confirmPassword) {
      notify("Password and Confirm Password do not match.", "error");
      return;
    }

    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/reset-password", {
        method: "POST",
        body: { token, password, confirmPassword },
      });
      notify(response.message || "Password has been reset successfully.");
      onBack();
    } catch (error) {
      notify(error.payload?.detail || error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPanel
      title="Reset Password"
      subtitle="Set a new secure password for your vendor account."
      icon={Lock}
    >
      {!token ? (
        <div className="mb-4 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
          Invalid or expired reset link.
        </div>
      ) : null}
      <form className="space-y-4" onSubmit={submit}>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="New Password">
            <Input
              type={showPasswords ? "text" : "password"}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="New password"
              required
            />
          </Field>
          <Field label="Confirm Password">
            <Input
              type={showPasswords ? "text" : "password"}
              value={confirmPassword}
              onChange={(event) => setConfirmPassword(event.target.value)}
              placeholder="Confirm password"
              required
            />
          </Field>
        </div>
        <ShowPasswordControl checked={showPasswords} onChange={setShowPasswords} />
        <PasswordRequirements password={password} confirmPassword={confirmPassword} />
        <div className="grid gap-3 sm:grid-cols-2">
          <Button type="submit" icon={Lock} disabled={loading || !token || !passwordReady}>
            Reset Password
          </Button>
          <Button variant="secondary" icon={ArrowLeft} onClick={onBack}>
            Back to Login
          </Button>
        </div>
      </form>
    </AuthPanel>
  );
}

function MetricCard({ label, value, icon: Icon }) {
  return (
    <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-medium text-slate-500">{label}</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">{value}</p>
        </div>
        <div className="rounded-lg bg-brandBg p-2 text-brandPrimary ring-1 ring-brandLight">
          <Icon className="h-5 w-5" />
        </div>
      </div>
    </article>
  );
}

function DashboardPage({ vendor, dashboard, onLogout, onNavigate }) {
  const metrics = dashboard?.metrics || {};
  const limits = dashboard?.limits || {};
  const currentCustomerCount = Number(limits.currentCustomerCount || vendor?.currentCustomerCount || 0);
  const customerLimit = Number(limits.customerLimit || vendor?.customerLimit || 0);
  const currentProductCount = Number(limits.currentProductCount || vendor?.currentProductCount || 0);
  const productLimit = Number(limits.productLimit || vendor?.productLimit || 0);
  const customerLimitReached = currentCustomerCount >= customerLimit;
  const productLimitReached = currentProductCount >= productLimit;
  const cards = useMemo(
    () => [
      ["Total Customers", metrics.totalCustomers || 0, Users],
      ["Active Customers", metrics.activeCustomers || 0, CheckCircle2],
      ["Inactive Customers", metrics.inactiveCustomers || 0, X],
      ["Customer Limit Used", metrics.customerLimitUsed || 0, Users],
      ["Total Products", metrics.totalProducts || 0, Package],
      ["Active Products", metrics.activeProducts || 0, CheckCircle2],
      ["Inactive Products", metrics.inactiveProducts || 0, X],
      ["Product Limit Used", metrics.productLimitUsed || 0, Package],
      ["Today's Deliveries", metrics.todaysDeliveries || 0, Truck],
      ["Monthly Revenue", formatCurrency(metrics.monthlyRevenue || 0), Wallet],
      ["Pending Payments", formatCurrency(metrics.pendingPayments || 0), ReceiptText],
      ["Reports Generated", metrics.reportsGenerated || 0, LayoutDashboard],
    ],
    [metrics],
  );

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Vendor Dashboard</p>
          <h1 className="mt-1 text-2xl font-bold text-slate-950">{vendor?.shopName}</h1>
          <p className="mt-1 text-sm text-slate-600">
            {vendor?.vendorName} · {vendor?.email} · +91 {vendor?.mobileNumber}
          </p>
        </div>
        <Button variant="secondary" icon={LogOut} onClick={onLogout}>
          Logout
        </Button>
      </section>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, Icon]) => (
          <MetricCard key={label} label={label} value={value} icon={Icon} />
        ))}
      </section>

      <section className="grid gap-4 lg:grid-cols-2">
        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-bold text-slate-950">Customer limit usage</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">
            {currentCustomerCount} / {customerLimit}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            You have used {currentCustomerCount} out of {customerLimit} customer slots.
          </p>
        </article>
        <article className="rounded-lg border border-slate-200 bg-white p-4 shadow-sm">
          <p className="text-sm font-bold text-slate-950">Product limit usage</p>
          <p className="mt-2 text-2xl font-bold text-slate-950">
            {currentProductCount} / {productLimit}
          </p>
          <p className="mt-2 text-sm text-slate-600">
            You have used {currentProductCount} out of {productLimit} product slots.
          </p>
        </article>
      </section>

      {Number(metrics.totalCustomers || 0) === 0 || Number(metrics.totalProducts || 0) === 0 ? (
        <section className="grid gap-4 lg:grid-cols-2">
          {Number(metrics.totalCustomers || 0) === 0 ? (
            <EmptyState icon={Users} title="No customers added yet." text="Add customers to start recording supply." />
          ) : null}
          {Number(metrics.totalProducts || 0) === 0 ? (
            <EmptyState icon={Package} title="No products added yet." text="Add products before creating daily supply entries." />
          ) : null}
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">Quick actions</h2>
        <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <Button
            variant="secondary"
            icon={Plus}
            onClick={() => onNavigate("/vendor/customers")}
            disabled={customerLimitReached}
          >
            Add Customer
          </Button>
          <Button
            variant="secondary"
            icon={Package}
            onClick={() => onNavigate("/vendor/products")}
            disabled={productLimitReached}
          >
            Add Product
          </Button>
          <Button variant="secondary" icon={Truck} onClick={() => onNavigate("/vendor/daily-supply")}>
            Update Daily Supply
          </Button>
          <Button variant="secondary" icon={ReceiptText} onClick={() => onNavigate("/vendor/reports")}>
            Generate Report
          </Button>
          <Button variant="secondary" icon={ReceiptText} onClick={() => onNavigate("/vendor/reports/saved")}>
            View Saved Reports
          </Button>
          <Button variant="secondary" icon={Send} onClick={() => onNavigate("/vendor/send-customer-bills")}>
            Send Customer Bills
          </Button>
          <Button variant="secondary" icon={Wallet} onClick={() => onNavigate("/vendor/profile")}>
            Profile
          </Button>
        </div>
        {customerLimitReached ? (
          <p className="mt-3 text-sm font-semibold text-red-700">
            Customer limit reached. Please contact Super Admin to increase your limit.
          </p>
        ) : null}
        {productLimitReached ? (
          <p className="mt-3 text-sm font-semibold text-red-700">
            Product limit reached. Please contact Super Admin to increase your limit.
          </p>
        ) : null}
      </section>
    </div>
  );
}

function ApprovalPendingPage({ email, onLogin }) {
  return (
    <section className="mx-auto max-w-2xl rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
      <div className="mx-auto flex h-12 w-12 items-center justify-center rounded-lg bg-brandBg text-brandPrimary">
        <Clock3 className="h-6 w-6" />
      </div>
      <h1 className="mt-4 text-2xl font-bold text-slate-950">Approval pending</h1>
      <p className="mt-2 text-sm leading-6 text-slate-600">
        Your registration is completed and your email is verified. Your account is
        currently pending Super Admin approval. You will be able to access your
        dashboard after approval.
      </p>
      {email ? <p className="mt-3 text-sm font-semibold text-slate-700">{email}</p> : null}
      <Button icon={Store} onClick={onLogin} className="mt-5">
        Back to Vendor Login
      </Button>
    </section>
  );
}

function EmptyState({ icon: Icon = Package, title, text }) {
  return (
    <div className="rounded-lg border border-dashed border-slate-300 bg-white p-6 text-center">
      <Icon className="mx-auto h-8 w-8 text-slate-400" />
      <p className="mt-3 text-sm font-bold text-slate-800">{title}</p>
      {text ? <p className="mt-1 text-sm text-slate-500">{text}</p> : null}
    </div>
  );
}

function customerFormFrom(record = {}) {
  return {
    name: record.name || "",
    email: record.email || "",
    phoneNumber: mobileDigits(record.phoneNumber || ""),
    address: record.address || "",
    status: record.status || "Active",
    vendorId: record.vendorId || "",
  };
}

function productFormFrom(record = {}) {
  return {
    name: record.name || "",
    description: record.description || "",
    unit: record.unit || "Liters",
    quantity: record.quantity ?? "",
    hsnCode: record.hsnCode || "",
    pricePerUnit: record.pricePerUnit ?? "",
    status: record.status || "Active",
    vendorId: record.vendorId || "",
  };
}

function validateCustomerForm(form) {
  if (!form.name.trim()) return "Name is required.";
  if (mobileDigits(form.phoneNumber).length !== 10) {
    return "Phone number must be a valid 10-digit Indian mobile number.";
  }
  if (!form.address.trim()) return "Address is required.";
  if (form.email.trim() && !isValidEmail(form.email)) return "Enter a valid customer email address.";
  return "";
}

function validateProductForm(form) {
  if (!form.name.trim()) return "Product name is required.";
  if (!form.description.trim()) return "Product description is required.";
  if (!form.unit.trim()) return "Product unit is required.";
  if (form.quantity === "" || !Number.isFinite(Number(form.quantity)) || Number(form.quantity) < 0) {
    return "Quantity should be a number greater than or equal to 0.";
  }
  if (!Number.isFinite(Number(form.pricePerUnit)) || Number(form.pricePerUnit) <= 0) {
    return "Price should be a positive number.";
  }
  return "";
}

function CustomerFields({ form, setForm, vendorOptions = [], showVendor = false }) {
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  return (
    <div className="grid gap-4">
      {showVendor ? (
        <Field label="Vendor">
          <Select value={form.vendorId} onChange={(event) => update("vendorId", event.target.value)} required>
            <option value="">Select vendor</option>
            {vendorOptions.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.shopName} - {vendor.vendorName}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Customer name">
          <Input value={form.name} onChange={(event) => update("name", event.target.value)} required />
        </Field>
        <Field label="Email" hint="Optional">
          <Input type="email" value={form.email} onChange={(event) => update("email", event.target.value)} />
        </Field>
      </div>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Phone number" hint="Enter 10 digits after +91.">
          <MobileInput value={form.phoneNumber} onChange={(value) => update("phoneNumber", value)} />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(event) => update("status", event.target.value)}>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </Select>
        </Field>
      </div>
      <Field label="Address">
        <TextArea value={form.address} onChange={(event) => update("address", event.target.value)} required />
      </Field>
    </div>
  );
}

function ProductFields({ form, setForm, vendorOptions = [], showVendor = false }) {
  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  return (
    <div className="grid gap-4">
      {showVendor ? (
        <Field label="Vendor">
          <Select value={form.vendorId} onChange={(event) => update("vendorId", event.target.value)} required>
            <option value="">Select vendor</option>
            {vendorOptions.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.shopName} - {vendor.vendorName}
              </option>
            ))}
          </Select>
        </Field>
      ) : null}
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Product name">
          <Input value={form.name} onChange={(event) => update("name", event.target.value)} required />
        </Field>
        <Field label="Product unit">
          <Select value={form.unit} onChange={(event) => update("unit", event.target.value)} required>
            {PRODUCT_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {unit}
              </option>
            ))}
          </Select>
        </Field>
      </div>
      <Field label="Product description">
        <TextArea value={form.description} onChange={(event) => update("description", event.target.value)} required />
      </Field>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Quantity">
          <Input
            type="number"
            min="0"
            step="0.01"
            value={form.quantity}
            onChange={(event) => update("quantity", event.target.value)}
            required
          />
        </Field>
        <Field label="HSN Code" hint="Optional">
          <Input value={form.hsnCode} onChange={(event) => update("hsnCode", event.target.value)} />
        </Field>
        <Field label="Price per unit">
          <Input
            type="number"
            min="0.01"
            step="0.01"
            value={form.pricePerUnit}
            onChange={(event) => update("pricePerUnit", event.target.value)}
            required
          />
        </Field>
        <Field label="Status">
          <Select value={form.status} onChange={(event) => update("status", event.target.value)}>
            <option value="Active">Active</option>
            <option value="Inactive">Inactive</option>
          </Select>
        </Field>
      </div>
    </div>
  );
}

function VendorCustomersPage({ token, vendor, path, onNavigate, onRefresh, notify }) {
  const [customers, setCustomers] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewRecord, setViewRecord] = useState(null);
  const [form, setForm] = useState(customerFormFrom());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/customers", { token });
      setCustomers(response.customers || []);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (path === "/vendor/customers/add") {
      setEditing(null);
      setViewRecord(null);
      setForm(customerFormFrom());
      setFormOpen(true);
    }
  }, [path]);

  useEffect(() => {
    if (path === "/vendor/customers/add") return;
    const editId = path.match(/^\/vendor\/customers\/([^/]+)\/edit$/)?.[1];
    const viewId = path.match(/^\/vendor\/customers\/([^/]+)$/)?.[1];
    if (editId) {
      const record = customers.find((item) => item.id === editId);
      if (record) {
        setEditing(record);
        setViewRecord(null);
        setForm(customerFormFrom(record));
        setFormOpen(true);
      }
    } else if (viewId) {
      setViewRecord(customers.find((item) => item.id === viewId) || null);
      setFormOpen(false);
    }
  }, [customers, path]);

  const customerLimit = Number(vendor?.customerLimit || 0);
  const used = customers.length;
  const limitReached = used >= customerLimit;
  const filtered = customers.filter((customer) =>
    [customer.name, customer.email, customer.phoneNumber, customer.address]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const submit = async (event) => {
    event.preventDefault();
    const validation = validateCustomerForm(form);
    if (validation) {
      notify(validation, "error");
      return;
    }
    setSaving(true);
    try {
      const payload = {
        ...form,
        email: form.email.trim(),
        phoneNumber: mobileDigits(form.phoneNumber),
      };
      const response = await apiRequest(
        editing ? `/api/vendor/customers/${editing.id}` : "/api/vendor/customers",
        { method: editing ? "PATCH" : "POST", token, body: payload },
      );
      notify(response.message || "Customer saved successfully.");
      setFormOpen(false);
      setEditing(null);
      onNavigate("/vendor/customers");
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (customer) => {
    const nextStatus = customer.status === "Active" ? "Inactive" : "Active";
    try {
      const response = await apiRequest(`/api/vendor/customers/${customer.id}/status`, {
        method: "PATCH",
        token,
        body: { status: nextStatus },
      });
      notify(response.message || "Customer status updated.");
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Customer Management</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">Customers</h1>
            <p className="mt-2 text-sm font-semibold text-slate-700">
              You have used {used} out of {customerLimit} customer slots.
            </p>
            {limitReached ? (
              <p className="mt-2 text-sm font-semibold text-red-700">
                Customer limit reached. Please contact Super Admin to increase your limit.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/dashboard")}>
              Dashboard
            </Button>
            <Button
              icon={Plus}
              disabled={limitReached}
              onClick={() => onNavigate("/vendor/customers/add")}
            >
              Add Customer
            </Button>
          </div>
        </div>
      </section>

      {formOpen ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-950">{editing ? "Edit Customer" : "Add Customer"}</h2>
            <Button
              variant="subtle"
              icon={X}
              onClick={() => {
                setFormOpen(false);
                setEditing(null);
                onNavigate("/vendor/customers");
              }}
            >
              Close
            </Button>
          </div>
          <form className="space-y-5" onSubmit={submit}>
            <CustomerFields form={form} setForm={setForm} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Button type="submit" disabled={saving}>
                {editing ? "Update Customer" : "Save Customer"}
              </Button>
              <Button variant="secondary" onClick={() => onNavigate("/vendor/customers")}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {viewRecord ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-950">{viewRecord.name}</h2>
              <p className="mt-1 text-sm text-slate-500">+91 {viewRecord.phoneNumber}</p>
            </div>
            <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/customers")}>
              Back
            </Button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              ["Email", viewRecord.email || "-"],
              ["Status", viewRecord.status],
              ["Address", viewRecord.address],
              ["Created date", formatDateTime(viewRecord.createdAt)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between">
          <Field label="Search customers">
            <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, email, phone, address" />
          </Field>
        </div>
        {loading ? (
          <p className="mt-4 text-sm font-semibold text-slate-600">Loading customers...</p>
        ) : filtered.length ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[980px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Customer name</th>
                    <th className="px-4 py-3">Email</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Address</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created date</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filtered.map((customer) => (
                    <tr key={customer.id}>
                      <td className="px-4 py-3 font-semibold text-slate-950">{customer.name}</td>
                      <td className="px-4 py-3 text-slate-600">{customer.email || "-"}</td>
                      <td className="px-4 py-3 text-slate-600">+91 {customer.phoneNumber}</td>
                      <td className="px-4 py-3 text-slate-600">{customer.address}</td>
                      <td className="px-4 py-3">
                        <span className={classNames("rounded-full px-2.5 py-1 text-xs font-bold ring-1", statusBadgeClass(customer.status))}>
                          {customer.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(customer.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="subtle" icon={Eye} onClick={() => onNavigate(`/vendor/customers/${customer.id}`)}>
                            View
                          </Button>
                          <Button variant="secondary" icon={Edit3} onClick={() => onNavigate(`/vendor/customers/${customer.id}/edit`)}>
                            Edit
                          </Button>
                          <Button variant="secondary" onClick={() => updateStatus(customer)}>
                            Mark {customer.status === "Active" ? "Inactive" : "Active"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState icon={Users} title="No customers added yet." text="Add a customer to start recording daily supply." />
          </div>
        )}
      </section>
    </div>
  );
}

function VendorProductsPage({ token, vendor, path, onNavigate, onRefresh, notify }) {
  const [products, setProducts] = useState([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewRecord, setViewRecord] = useState(null);
  const [form, setForm] = useState(productFormFrom());
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/products", { token });
      setProducts(response.products || []);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    if (path === "/vendor/products/add") {
      setEditing(null);
      setViewRecord(null);
      setForm(productFormFrom());
      setFormOpen(true);
    }
  }, [path]);

  useEffect(() => {
    if (path === "/vendor/products/add") return;
    const editId = path.match(/^\/vendor\/products\/([^/]+)\/edit$/)?.[1];
    const viewId = path.match(/^\/vendor\/products\/([^/]+)$/)?.[1];
    if (editId) {
      const record = products.find((item) => item.id === editId);
      if (record) {
        setEditing(record);
        setViewRecord(null);
        setForm(productFormFrom(record));
        setFormOpen(true);
      }
    } else if (viewId) {
      setViewRecord(products.find((item) => item.id === viewId) || null);
      setFormOpen(false);
    }
  }, [path, products]);

  const productLimit = Number(vendor?.productLimit || 0);
  const used = products.length;
  const limitReached = used >= productLimit;
  const filtered = products.filter((product) =>
    [product.name, product.description, product.unit, product.quantity, product.hsnCode]
      .join(" ")
      .toLowerCase()
      .includes(search.trim().toLowerCase()),
  );

  const submit = async (event) => {
    event.preventDefault();
    const validation = validateProductForm(form);
    if (validation) {
      notify(validation, "error");
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest(
        editing ? `/api/vendor/products/${editing.id}` : "/api/vendor/products",
        {
          method: editing ? "PATCH" : "POST",
          token,
          body: {
            ...form,
            quantity: Number(form.quantity),
            pricePerUnit: Number(form.pricePerUnit),
          },
        },
      );
      notify(response.message || "Product saved successfully.");
      setFormOpen(false);
      setEditing(null);
      onNavigate("/vendor/products");
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (product) => {
    const nextStatus = product.status === "Active" ? "Inactive" : "Active";
    try {
      const response = await apiRequest(`/api/vendor/products/${product.id}/status`, {
        method: "PATCH",
        token,
        body: { status: nextStatus },
      });
      notify(response.message || "Product status updated.");
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Product Management</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">Products</h1>
            <p className="mt-2 text-sm font-semibold text-slate-700">
              You have used {used} out of {productLimit} product slots.
            </p>
            {limitReached ? (
              <p className="mt-2 text-sm font-semibold text-red-700">
                Product limit reached. Please contact Super Admin to increase your limit.
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/dashboard")}>
              Dashboard
            </Button>
            <Button icon={Plus} disabled={limitReached} onClick={() => onNavigate("/vendor/products/add")}>
              Add Product
            </Button>
          </div>
        </div>
      </section>

      {formOpen ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-5 flex items-center justify-between gap-3">
            <h2 className="text-lg font-bold text-slate-950">{editing ? "Edit Product" : "Add Product"}</h2>
            <Button variant="subtle" icon={X} onClick={() => onNavigate("/vendor/products")}>
              Close
            </Button>
          </div>
          <form className="space-y-5" onSubmit={submit}>
            <ProductFields form={form} setForm={setForm} />
            <div className="grid gap-3 sm:grid-cols-2">
              <Button type="submit" disabled={saving}>
                {editing ? "Update Product" : "Save Product"}
              </Button>
              <Button variant="secondary" onClick={() => onNavigate("/vendor/products")}>
                Cancel
              </Button>
            </div>
          </form>
        </section>
      ) : null}

      {viewRecord ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-950">{viewRecord.name}</h2>
              <p className="mt-1 text-sm text-slate-500">{formatCurrency(viewRecord.pricePerUnit)} per {viewRecord.unit}</p>
            </div>
            <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/products")}>
              Back
            </Button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {[
              ["Product Name", viewRecord.name],
              ["Product Quantity", viewRecord.quantity ?? 0],
              ["Unit", viewRecord.unit],
              ["Price", formatCurrency(viewRecord.pricePerUnit)],
              ["Description", viewRecord.description],
              ["HSN Code", viewRecord.hsnCode || "-"],
              ["Status", viewRecord.status],
              ["Created Date", formatDateTime(viewRecord.createdAt)],
            ].map(([label, value]) => (
              <div key={label} className="rounded-lg border border-slate-200 p-4">
                <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <Field label="Search products">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Name, unit, quantity, HSN code" />
        </Field>
        {loading ? (
          <p className="mt-4 text-sm font-semibold text-slate-600">Loading products...</p>
        ) : filtered.length ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1120px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Product Name</th>
                    <th className="px-4 py-3">Product Quantity</th>
                    <th className="px-4 py-3">Unit</th>
                    <th className="px-4 py-3">Price</th>
                    <th className="px-4 py-3">Description</th>
                    <th className="px-4 py-3">HSN Code</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Created Date</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filtered.map((product) => (
                    <tr key={product.id}>
                      <td className="px-4 py-3 font-semibold text-slate-950">{product.name}</td>
                      <td className="px-4 py-3 text-slate-600">{product.quantity ?? 0}</td>
                      <td className="px-4 py-3 text-slate-600">{product.unit}</td>
                      <td className="px-4 py-3 text-slate-600">{formatCurrency(product.pricePerUnit)}</td>
                      <td className="px-4 py-3 text-slate-600">{product.description}</td>
                      <td className="px-4 py-3 text-slate-600">{product.hsnCode || "-"}</td>
                      <td className="px-4 py-3">
                        <span className={classNames("rounded-full px-2.5 py-1 text-xs font-bold ring-1", statusBadgeClass(product.status))}>
                          {product.status}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-slate-600">{formatDate(product.createdAt)}</td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap gap-2">
                          <Button variant="subtle" icon={Eye} onClick={() => onNavigate(`/vendor/products/${product.id}`)}>
                            View
                          </Button>
                          <Button variant="secondary" icon={Edit3} onClick={() => onNavigate(`/vendor/products/${product.id}/edit`)}>
                            Edit
                          </Button>
                          <Button variant="secondary" onClick={() => updateStatus(product)}>
                            Mark {product.status === "Active" ? "Inactive" : "Active"}
                          </Button>
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState icon={Package} title="No products added yet." text="Add products before recording daily supply." />
          </div>
        )}
      </section>
    </div>
  );
}

function VendorProfilePage({ token, vendor, onNavigate, onRefresh, notify }) {
  const [profile, setProfile] = useState(vendor || null);
  const [form, setForm] = useState({
    shopName: "",
    phonePeGPayNumber: "",
    upiId: "",
    shopAddress: "",
    shopLocation: "",
    fssaiNumber: "",
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [editing, setEditing] = useState(false);

  const applyProfile = (record = {}) => {
    setProfile(record);
    setForm({
      shopName: record.shopName || "",
      phonePeGPayNumber: mobileDigits(record.phonePeGPayNumber || ""),
      upiId: record.upiId || "",
      shopAddress: record.shopAddress || record.address || "",
      shopLocation: record.shopLocation || "",
      fssaiNumber: record.fssaiNumber || record.fssaiRegistrationNumber || "",
    });
  };

  const loadProfile = useCallback(async () => {
    setLoading(true);
    try {
      const response = await apiRequest("/api/vendor/profile", { token });
      applyProfile(response.vendor || {});
    } catch (error) {
      notify(error.message, "error");
      applyProfile(vendor || {});
    } finally {
      setLoading(false);
    }
  }, [token, vendor]);

  useEffect(() => {
    loadProfile();
  }, [loadProfile]);

  useEffect(() => {
    if (vendor && !profile) applyProfile(vendor);
  }, [vendor]);

  const update = (field, value) => setForm((current) => ({ ...current, [field]: value }));
  const submit = async (event) => {
    event.preventDefault();
    if (!form.shopName.trim()) {
      notify("Shop name is required.", "error");
      return;
    }
    if (form.phonePeGPayNumber && mobileDigits(form.phonePeGPayNumber).length !== 10) {
      notify("PhonePe / GPay number should be a valid 10-digit mobile number.", "error");
      return;
    }
    if (form.upiId.trim() && !/^[a-zA-Z0-9.\-_]{2,}@[a-zA-Z]{2,}$/.test(form.upiId.trim())) {
      notify("Enter a valid UPI ID.", "error");
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest("/api/vendor/profile", {
        method: "PATCH",
        token,
        body: {
          ...form,
          shopName: form.shopName.trim(),
          phonePeGPayNumber: mobileDigits(form.phonePeGPayNumber),
          upiId: form.upiId.trim(),
        },
      });
      applyProfile(response.vendor || {});
      notify(response.message || "Profile updated successfully.");
      setEditing(false);
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const cancelEdit = () => {
    applyProfile(profile || vendor || {});
    setEditing(false);
  };
  const profileText = (value) => String(value || "").trim() || "Not updated yet";
  const details = {
    basic: [
      ["Vendor Name", profileText(profile?.vendorName)],
      ["Email Address", profileText(profile?.email)],
      ["Mobile Number", profile?.mobileNumber ? `+91 ${profile.mobileNumber}` : "Not updated yet"],
      ["Account Status", profileText(profile?.status)],
    ],
    shop: [
      ["Shop Name", profileText(profile?.shopName)],
      ["Address", profileText(profile?.shopAddress || profile?.address)],
      ["Shop Location", profileText(profile?.shopLocation)],
      ["FSSAI Registration Number", profileText(profile?.fssaiNumber || profile?.fssaiRegistrationNumber)],
    ],
    payment: [
      [
        "PhonePe / GPay Number",
        profile?.phonePeGPayNumber ? `+91 ${profile.phonePeGPayNumber}` : "Not updated yet",
      ],
      ["UPI ID", profileText(profile?.upiId)],
    ],
  };
  const renderDetailSection = (title, items) => (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <h2 className="text-lg font-bold text-slate-950">{title}</h2>
      <div className="mt-4 grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
        {items.map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 bg-slate-50 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">{label}</p>
            <p className="mt-1 break-words text-sm font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
    </section>
  );

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Vendor Profile</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">{profile?.shopName || vendor?.shopName}</h1>
            <p className="mt-1 text-sm text-slate-600">{profile?.vendorName || vendor?.vendorName} · {profile?.email || vendor?.email} · +91 {profile?.mobileNumber || vendor?.mobileNumber}</p>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/dashboard")}>
              Dashboard
            </Button>
            {!editing ? (
              <Button icon={Edit3} onClick={() => setEditing(true)} disabled={loading}>
                Edit Profile
              </Button>
            ) : null}
          </div>
        </div>
      </section>
      {loading ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <p className="text-sm font-semibold text-slate-600">Loading vendor profile...</p>
        </section>
      ) : !editing ? (
        <>
          {renderDetailSection("Basic Details", details.basic)}
          {renderDetailSection("Shop Details", details.shop)}
          {renderDetailSection("Payment Details", details.payment)}
        </>
      ) : (
        <form className="grid gap-6" onSubmit={submit}>
          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-950">Basic Details</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Vendor Name">
                <Input value={profile?.vendorName || ""} readOnly className="bg-slate-50 text-slate-600" />
              </Field>
              <Field label="Email Address">
                <Input value={profile?.email || ""} readOnly className="bg-slate-50 text-slate-600" />
              </Field>
              <Field label="Mobile Number">
                <Input value={profile?.mobileNumber ? `+91 ${profile.mobileNumber}` : ""} readOnly className="bg-slate-50 text-slate-600" />
              </Field>
              <Field label="Account Status">
                <Input value={profile?.status || ""} readOnly className="bg-slate-50 text-slate-600" />
              </Field>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-950">Shop Details</h2>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="Shop Name">
                <Input value={form.shopName} onChange={(event) => update("shopName", event.target.value)} required />
              </Field>
              <Field label="FSSAI Registration Number">
                <Input value={form.fssaiNumber} onChange={(event) => update("fssaiNumber", event.target.value)} />
              </Field>
              <Field label="Address">
                <TextArea value={form.shopAddress} onChange={(event) => update("shopAddress", event.target.value)} />
              </Field>
              <Field label="Shop Location">
                <TextArea value={form.shopLocation} onChange={(event) => update("shopLocation", event.target.value)} />
              </Field>
            </div>
          </section>

          <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-lg font-bold text-slate-950">Payment Details</h2>
            <p className="mt-1 text-sm font-semibold text-slate-500">
              Add PhonePe/GPay number or UPI ID to send customer bills through WhatsApp.
            </p>
            <div className="mt-4 grid gap-4 sm:grid-cols-2">
              <Field label="PhonePe / GPay Number" hint="Optional, enter 10 digits after +91.">
                <MobileInput value={form.phonePeGPayNumber} onChange={(value) => update("phonePeGPayNumber", value)} required={false} />
              </Field>
              <Field label="UPI ID" hint="Optional, for example shopname@ybl.">
                <Input value={form.upiId} onChange={(event) => update("upiId", event.target.value)} placeholder="shopname@ybl" />
              </Field>
            </div>
          </section>

          <div className="flex flex-wrap gap-2">
            <Button type="submit" icon={CheckCircle2} disabled={saving || loading}>
              Save Changes
            </Button>
            <Button variant="secondary" onClick={cancelEdit} disabled={saving}>
              Cancel
            </Button>
          </div>
        </form>
      )}
    </div>
  );
}

function VendorDailySupplyPage({ token, onNavigate, notify }) {
  const today = new Date().toISOString().slice(0, 10);
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [supplies, setSupplies] = useState([]);
  const [loading, setLoading] = useState(true);
  const [editing, setEditing] = useState(null);
  const [saving, setSaving] = useState(false);
  const [filters, setFilters] = useState({ date: "", customerId: "", productId: "", status: "" });
  const [selectedCustomerIds, setSelectedCustomerIds] = useState([]);
  const [customerSearch, setCustomerSearch] = useState("");
  const [dateText, setDateText] = useState(formatDate(today));
  const [form, setForm] = useState({
    date: today,
    customerId: "",
    productId: "",
    quantity: "",
    status: "Supplied",
    notes: "",
  });

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [customerResponse, productResponse, supplyResponse] = await Promise.all([
        apiRequest("/api/vendor/customers", { token }),
        apiRequest("/api/vendor/products", { token }),
        apiRequest("/api/vendor/daily-supply", { token }),
      ]);
      setCustomers(customerResponse.customers || []);
      setProducts(productResponse.products || []);
      setSupplies(supplyResponse.supplies || []);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const updateForm = (field, value) => {
    setForm((current) => ({
      ...current,
      [field]: value,
      ...(field === "status" && value === "Not Supplied" ? { quantity: "0" } : {}),
    }));
  };
  const updateDateText = (value) => {
    const cleaned = value.replace(/[^\d-]/g, "").slice(0, 10);
    setDateText(cleaned);
    const parsed = parseDisplayDate(cleaned);
    if (parsed) updateForm("date", parsed);
  };
  const activeCustomers = customers.filter((customer) => customer.status === "Active");
  const activeProducts = products.filter((product) => product.status === "Active");
  const missingSupplySetup = activeCustomers.length === 0 || activeProducts.length === 0;
  const searchedActiveCustomers = activeCustomers.filter((customer) =>
    [customer.name, customer.phoneNumber, customer.email]
      .join(" ")
      .toLowerCase()
      .includes(customerSearch.trim().toLowerCase()),
  );
  const selectedActiveCustomerIds = selectedCustomerIds.filter((id) =>
    activeCustomers.some((customer) => customer.id === id),
  );
  const selectedCustomerCount = selectedActiveCustomerIds.length;
  const allActiveCustomersSelected =
    activeCustomers.length > 0 && selectedActiveCustomerIds.length === activeCustomers.length;
  const selectedProduct = products.find((product) => product.id === form.productId);
  const amountPreview =
    form.status === "Not Supplied" ? 0 : Number(form.quantity || 0) * Number(selectedProduct?.pricePerUnit || 0);
  const filteredSupplies = dedupeSupplyEntries(supplies).filter((supply) => {
    if (filters.date && supply.date !== filters.date) return false;
    if (filters.customerId && supply.customerId !== filters.customerId) return false;
    if (filters.productId && supply.productId !== filters.productId) return false;
    if (filters.status && supply.status !== filters.status) return false;
    return true;
  });

  const submit = async (event) => {
    event.preventDefault();
    if (missingSupplySetup) {
      notify("Please add customers and products before updating daily supply.", "error");
      return;
    }
    const parsedDate = parseDisplayDate(dateText);
    const customerIds = selectedActiveCustomerIds;
    if (!parsedDate) {
      notify("Please select a date.", "error");
      return;
    }
    if (!customerIds.length) {
      notify("Please select at least one customer.", "error");
      return;
    }
    if (!form.productId) {
      notify("Please select a product.", "error");
      return;
    }
    if (form.status === "Supplied" && String(form.quantity).trim() === "") {
      notify("Please enter quantity.", "error");
      return;
    }
    if (form.status === "Supplied" && (!Number.isFinite(Number(form.quantity)) || Number(form.quantity) <= 0)) {
      notify("Quantity must be greater than 0 for supplied status.", "error");
      return;
    }
    setSaving(true);
    try {
      const response = await apiRequest(
        editing ? `/api/vendor/daily-supply/${editing.id}` : "/api/vendor/daily-supply",
        {
          method: editing ? "PATCH" : "POST",
          token,
          body: editing
            ? { ...form, customerId: customerIds[0], date: parsedDate, quantity: Number(form.quantity || 0) }
            : {
                date: parsedDate,
                customerIds,
                productId: form.productId,
                quantity: Number(form.quantity || 0),
                status: form.status,
                notes: form.notes,
              },
        },
      );
      notify(
        response.message ||
          (customerIds.length === 1
            ? "Supply entry saved successfully."
            : `Supply entries saved successfully for ${customerIds.length} customers.`),
      );
      setEditing(null);
      setForm({ date: parsedDate, customerId: "", productId: "", quantity: "", status: "Supplied", notes: "" });
      setDateText(formatDate(parsedDate));
      setSelectedCustomerIds([]);
      setCustomerSearch("");
      await load();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const startEdit = (supply) => {
    setEditing(supply);
    setForm({
      date: supply.date,
      customerId: supply.customerId,
      productId: supply.productId,
      quantity: String(supply.quantity ?? ""),
      status: supply.status === "Not Supplied" ? "Not Supplied" : "Supplied",
      notes: supply.notes || "",
    });
    setDateText(formatDate(supply.date));
    setSelectedCustomerIds([supply.customerId]);
  };

  const supplyExportRows = filteredSupplies.map((supply) => ({
    Date: formatDate(supply.date),
    "Customer Name": supply.customerName,
    "Product Name": supply.productName,
    Quantity: supply.quantity,
    Unit: supply.unit,
    Rate: Number(supply.rate || 0),
    Amount: Number(supply.amount || 0),
    Status: supply.status,
    Notes: supply.notes || "",
  }));
  const supplyExportDate = formatDate(filters.date || form.date || today);

  const downloadSupplyExcel = () => {
    if (!supplyExportRows.length) {
      notify("No supply entries available to download.", "error");
      return;
    }
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.json_to_sheet(supplyExportRows), "Supply Entries");
    const bytes = XLSX.write(workbook, { bookType: "xlsx", type: "array" });
    saveAs(new Blob([bytes], { type: "application/octet-stream" }), `daily-supply-entries-${supplyExportDate}.xlsx`);
    notify("Excel downloaded successfully.");
  };

  const downloadSupplyPdf = () => {
    if (!supplyExportRows.length) {
      notify("No supply entries available to download.", "error");
      return;
    }
    const doc = new jsPDF({ orientation: "landscape" });
    doc.setFontSize(15);
    doc.text("Daily Supply Entries", 14, 16);
    autoTable(doc, {
      startY: 24,
      head: [["Date", "Customer Name", "Product Name", "Quantity", "Unit", "Rate", "Amount", "Status", "Notes"]],
      body: supplyExportRows.map((row) => [
        row.Date,
        row["Customer Name"],
        row["Product Name"],
        row.Quantity,
        row.Unit,
        formatCurrency(row.Rate),
        formatCurrency(row.Amount),
        row.Status,
        row.Notes,
      ]),
      styles: { fontSize: 8 },
      headStyles: { fillColor: [5, 150, 105] },
    });
    doc.save(`daily-supply-entries-${supplyExportDate}.pdf`);
    notify("PDF downloaded successfully.");
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Daily Supply Update</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">Daily Supply Entry</h1>
          </div>
          <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/dashboard")}>
            Dashboard
          </Button>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">{editing ? "Edit Supply Entry" : "Add Supply Entry"}</h2>
        {!loading && !activeCustomers.length ? (
          <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
            No active customers available. Please add or activate customers before updating daily supply.
          </div>
        ) : null}
        {!loading && !activeProducts.length ? (
          <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
            No active products available. Please add or activate products before updating daily supply.
          </div>
        ) : null}
        <form className="mt-5 grid gap-4" onSubmit={submit}>
          <Field label="Select Date" hint="Use DD-MM-YYYY format.">
            <Input
              value={dateText}
              onChange={(event) => updateDateText(event.target.value)}
              inputMode="numeric"
              maxLength={10}
              placeholder="DD-MM-YYYY"
              required
            />
          </Field>

          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div>
                <p className="text-sm font-bold text-slate-950">Customer Selection List</p>
                <p className="mt-1 text-sm font-semibold text-brandPrimary">
                  Selected Customers: {selectedCustomerCount}
                </p>
              </div>
              {!editing && activeCustomers.length ? (
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brandPrimary"
                    checked={allActiveCustomersSelected}
                    onChange={(event) =>
                      setSelectedCustomerIds(event.target.checked ? activeCustomers.map((customer) => customer.id) : [])
                    }
                  />
                  Select All Customers
                </label>
              ) : null}
            </div>
            {!activeCustomers.length ? (
              <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
                No active customers available. Please add or activate customers before updating daily supply.
              </div>
            ) : null}
            {activeCustomers.length ? (
              <div className="mt-4 grid gap-3">
                <Field label="Search active customers">
                  <Input
                    value={customerSearch}
                    onChange={(event) => setCustomerSearch(event.target.value)}
                    placeholder="Search by name, phone, or email"
                  />
                </Field>
                <div className="max-h-72 overflow-auto rounded-lg border border-slate-200 bg-white p-2 scrollbar-soft">
                  {searchedActiveCustomers.length ? (
                    <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                      {searchedActiveCustomers.map((customer) => (
                        <label
                          key={customer.id}
                          className="flex items-start gap-3 rounded-lg border border-slate-200 p-3 text-sm font-semibold text-slate-700"
                        >
                          <input
                            type="checkbox"
                            className="mt-1 h-4 w-4 rounded border-slate-300 text-brandPrimary"
                            checked={selectedActiveCustomerIds.includes(customer.id)}
                            onChange={(event) =>
                              setSelectedCustomerIds((current) => {
                                if (editing) return event.target.checked ? [customer.id] : [];
                                return event.target.checked
                                  ? [...new Set([...current, customer.id])]
                                  : current.filter((id) => id !== customer.id);
                              })
                            }
                          />
                          <span>
                            <span className="block text-slate-950">{customer.name}</span>
                            <span className="block text-xs text-slate-500">+91 {customer.phoneNumber}</span>
                            {customer.address ? (
                              <span className="mt-1 block text-xs text-slate-500">{customer.address}</span>
                            ) : null}
                          </span>
                        </label>
                      ))}
                    </div>
                  ) : (
                    <p className="p-3 text-sm font-semibold text-slate-500">No active customers match your search.</p>
                  )}
                </div>
              </div>
            ) : null}
          </section>

          <Field label="Select Product">
            <Select value={form.productId} onChange={(event) => updateForm("productId", event.target.value)} required>
              <option value="">Select product</option>
              {activeProducts.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name} - {product.quantity ?? 0} {product.unit} - {formatCurrency(product.pricePerUnit)}
                </option>
              ))}
            </Select>
          </Field>

          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Update Quantity">
              <Input
                type="number"
                min="0"
                step="0.01"
                value={form.quantity}
                disabled={form.status === "Not Supplied"}
                onChange={(event) => updateForm("quantity", event.target.value)}
                required={form.status !== "Not Supplied"}
              />
            </Field>
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-slate-500">Rate</p>
              <p className="mt-1 text-sm font-semibold text-slate-950">
                {selectedProduct ? `${formatCurrency(selectedProduct.pricePerUnit)} / ${selectedProduct.unit}` : "-"}
              </p>
            </div>
            <div className="rounded-lg border border-brandLight bg-brandBg p-4">
              <p className="text-xs font-bold uppercase tracking-wide text-brandPrimary">Amount</p>
              <p className="mt-1 text-sm font-semibold text-brandDark">{formatCurrency(amountPreview)}</p>
              {!editing ? <p className="mt-1 text-xs font-semibold text-brandPrimary">Per selected customer</p> : null}
            </div>
          </div>
          <Field label="Supply Status">
            <Select value={form.status} onChange={(event) => updateForm("status", event.target.value)}>
              {["Supplied", "Not Supplied"].map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Notes" hint="Optional">
            <TextArea value={form.notes} onChange={(event) => updateForm("notes", event.target.value)} />
          </Field>
          <div className="grid gap-3 sm:grid-cols-2 lg:w-1/2">
            <Button type="submit" icon={Truck} disabled={saving || loading || missingSupplySetup}>
              Submit
            </Button>
            {editing ? (
              <Button
                variant="secondary"
                onClick={() => {
                  setEditing(null);
                  setForm({ date: today, customerId: "", productId: "", quantity: "", status: "Supplied", notes: "" });
                  setDateText(formatDate(today));
                  setSelectedCustomerIds([]);
                }}
              >
                Cancel Edit
              </Button>
            ) : null}
          </div>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-bold text-slate-950">Supply Entries</h2>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={FileSpreadsheet} onClick={downloadSupplyExcel}>
              Download Excel
            </Button>
            <Button variant="secondary" icon={Download} onClick={downloadSupplyPdf}>
              Download PDF
            </Button>
          </div>
        </div>
        <div className="mt-4 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
          <Field label="Filter by date">
            <Input type="date" value={filters.date} onChange={(event) => setFilters((current) => ({ ...current, date: event.target.value }))} />
          </Field>
          <Field label="Filter by customer">
            <Select value={filters.customerId} onChange={(event) => setFilters((current) => ({ ...current, customerId: event.target.value }))}>
              <option value="">All customers</option>
              {customers.map((customer) => (
                <option key={customer.id} value={customer.id}>
                  {customer.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Filter by product">
            <Select value={filters.productId} onChange={(event) => setFilters((current) => ({ ...current, productId: event.target.value }))}>
              <option value="">All products</option>
              {products.map((product) => (
                <option key={product.id} value={product.id}>
                  {product.name}
                </option>
              ))}
            </Select>
          </Field>
          <Field label="Filter by status">
            <Select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
              <option value="">All statuses</option>
              {SUPPLY_STATUSES.map((status) => (
                <option key={status} value={status}>
                  {status}
                </option>
              ))}
            </Select>
          </Field>
        </div>
        {loading ? (
          <p className="mt-4 text-sm font-semibold text-slate-600">Loading supply entries...</p>
        ) : filteredSupplies.length ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Date</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Quantity</th>
                    <th className="px-4 py-3">Unit</th>
                    <th className="px-4 py-3">Status</th>
                    <th className="px-4 py-3">Rate</th>
                    <th className="px-4 py-3">Amount</th>
                    <th className="px-4 py-3">Notes</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {filteredSupplies.map((supply) => (
                    <tr key={supply.id}>
                      <td className="px-4 py-3 text-slate-600">{formatDate(supply.date)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-950">{supply.customerName}</td>
                      <td className="px-4 py-3 text-slate-600">{supply.productName}</td>
                      <td className="px-4 py-3 text-slate-600">{supply.quantity}</td>
                      <td className="px-4 py-3 text-slate-600">{supply.unit}</td>
                      <td className="px-4 py-3 text-slate-600">{supply.status}</td>
                      <td className="px-4 py-3 text-slate-600">{formatCurrency(supply.rate)}</td>
                      <td className="px-4 py-3 font-semibold text-slate-950">{formatCurrency(supply.amount)}</td>
                      <td className="px-4 py-3 text-slate-600">{supply.notes || "-"}</td>
                      <td className="px-4 py-3">
                        <Button variant="secondary" icon={Edit3} onClick={() => startEdit(supply)}>
                          Edit
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState icon={Truck} title="No daily supply entries found." text="Save an entry to make it available for billing reports." />
          </div>
        )}
      </section>
    </div>
  );
}

function VendorSendCustomerBillsPage({ token, vendor, onNavigate, notify }) {
  const period = currentReportPeriod();
  const [customers, setCustomers] = useState([]);
  const [profile, setProfile] = useState(vendor || null);
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState([]);
  const [bills, setBills] = useState([]);
  const [generated, setGenerated] = useState(false);
  const [noSupplyRecords, setNoSupplyRecords] = useState(false);
  const [paymentWarning, setPaymentWarning] = useState("");
  const [filters, setFilters] = useState({ month: period.month, year: period.year });
  const yearOptions = Array.from({ length: 7 }, (_, index) => period.year - 3 + index);

  const loadSetup = useCallback(async () => {
    setLoading(true);
    try {
      const [customerResponse, profileResponse] = await Promise.all([
        apiRequest("/api/vendor/customers", { token }),
        apiRequest("/api/vendor/profile", { token }),
      ]);
      setCustomers(customerResponse.customers || []);
      setProfile(profileResponse.vendor || vendor || null);
    } catch (error) {
      notify(error.message, "error");
      setProfile(vendor || null);
    } finally {
      setLoading(false);
    }
  }, [token, vendor]);

  useEffect(() => {
    loadSetup();
  }, [loadSetup]);

  const activeCustomers = useMemo(() => customers.filter((customer) => customer.status === "Active"), [customers]);
  const activeCustomerIds = useMemo(() => new Set(activeCustomers.map((customer) => customer.id)), [activeCustomers]);
  const selectedActiveCustomerIds = useMemo(
    () => selectedCustomerIds.filter((id) => activeCustomerIds.has(id)),
    [selectedCustomerIds, activeCustomerIds],
  );
  const allActiveCustomersSelected =
    activeCustomers.length > 0 && selectedActiveCustomerIds.length === activeCustomers.length;
  const paymentPhone = mobileDigits(profile?.phonePeGPayNumber || "");
  const validPaymentPhone = paymentPhone.length === 10 ? paymentPhone : "";
  const paymentUpiId = String(profile?.upiId || "").trim();
  const paymentDetailsMissing = !loading && !validPaymentPhone && !paymentUpiId;

  const resetPreview = () => {
    setBills([]);
    setGenerated(false);
    setNoSupplyRecords(false);
    setPaymentWarning("");
  };

  const generatePreview = async (event) => {
    event.preventDefault();
    if (!activeCustomers.length) {
      notify("No active customers available.", "error");
      return;
    }
    if (!selectedActiveCustomerIds.length) {
      notify("Select at least one customer.", "error");
      return;
    }
    if (paymentDetailsMissing) {
      notify("Payment details missing. Please update your PhonePe/GPay number or UPI ID in Vendor Profile before sending bills.", "error");
      return;
    }

    setGenerating(true);
    try {
      const params = new URLSearchParams({
        month: String(Number(filters.month)),
        year: String(Number(filters.year)),
      });
      const response = await apiRequest(`/api/vendor/customer-bills?${params.toString()}`, {
        token,
        body: { customerIds: selectedActiveCustomerIds },
      });
      const previewBills = response.data || [];
      setBills(response.hasSupplyRecords ? previewBills : []);
      setGenerated(true);
      setNoSupplyRecords(!response.hasSupplyRecords);
      setPaymentWarning(response.paymentWarning || "");
      if (response.paymentWarning) {
        notify(response.paymentWarning, "error");
      } else if (response.hasSupplyRecords) {
        notify(response.message || "Bill preview generated successfully.");
      }
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setGenerating(false);
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Customer Billing</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">Send Customer Bills</h1>
          </div>
          <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/dashboard")}>
            Dashboard
          </Button>
        </div>
      </section>

      {paymentDetailsMissing || paymentWarning ? (
        <section className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
            <p>{paymentWarning || "Payment details missing. Please update your PhonePe/GPay number or UPI ID in Vendor Profile before sending bills."}</p>
            <Button variant="secondary" icon={Wallet} onClick={() => onNavigate("/vendor/profile")}>
              Update Profile
            </Button>
          </div>
        </section>
      ) : null}

      {!paymentDetailsMissing ? (
        <section className="rounded-lg border border-brandLight bg-brandBg p-4">
          <p className="text-sm font-bold text-brandDark">Payment Details</p>
          <div className="mt-2 grid gap-2 text-sm font-semibold text-brandPrimary sm:grid-cols-2">
            {validPaymentPhone ? <p>PhonePe / GPay: +91 {validPaymentPhone}</p> : null}
            {paymentUpiId ? <p>UPI ID: {paymentUpiId}</p> : null}
          </div>
        </section>
      ) : null}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <form className="grid gap-5" onSubmit={generatePreview}>
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Select Month">
              <Select
                value={filters.month}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, month: Number(event.target.value) }));
                  resetPreview();
                }}
              >
                {MONTH_NAMES.map((name, month) => (
                  <option key={name} value={month}>
                    {name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Select Year">
              <Select
                value={filters.year}
                onChange={(event) => {
                  setFilters((current) => ({ ...current, year: Number(event.target.value) }));
                  resetPreview();
                }}
              >
                {yearOptions.map((year) => (
                  <option key={year} value={year}>
                    {year}
                  </option>
                ))}
              </Select>
            </Field>
          </div>

          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-bold text-slate-950">Select Customer / Customers</p>
                <p className="mt-1 text-sm font-semibold text-brandPrimary">
                  Selected Customers: {selectedActiveCustomerIds.length}
                </p>
              </div>
              {activeCustomers.length ? (
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brandPrimary"
                    checked={allActiveCustomersSelected}
                    onChange={(event) => {
                      setSelectedCustomerIds(event.target.checked ? activeCustomers.map((customer) => customer.id) : []);
                      resetPreview();
                    }}
                  />
                  Select All
                </label>
              ) : null}
            </div>

            {loading ? (
              <p className="mt-4 text-sm font-semibold text-slate-600">Loading customers...</p>
            ) : activeCustomers.length ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {activeCustomers.map((customer) => (
                  <label
                    key={customer.id}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm font-semibold text-slate-700"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-brandPrimary"
                      checked={selectedActiveCustomerIds.includes(customer.id)}
                      onChange={(event) => {
                        setSelectedCustomerIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, customer.id])]
                            : current.filter((id) => id !== customer.id),
                        );
                        resetPreview();
                      }}
                    />
                    <span>
                      <span className="block text-slate-950">{customer.name}</span>
                      <span className="block text-xs text-slate-500">+91 {customer.phoneNumber}</span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
                No active customers available.
              </div>
            )}
          </section>

          <Button type="submit" icon={ReceiptText} disabled={loading || generating || !activeCustomers.length || paymentDetailsMissing}>
            Generate Bill Preview
          </Button>
        </form>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
          <h2 className="text-lg font-bold text-slate-950">WhatsApp Message Preview</h2>
          {generated && bills.length ? (
            <p className="text-sm font-semibold text-brandPrimary">{bills.length} bill preview{bills.length === 1 ? "" : "s"}</p>
          ) : null}
        </div>

        {!generated ? (
          <div className="mt-4">
            <EmptyState icon={Send} title="No bill preview generated yet." text="Select customers and generate a preview." />
          </div>
        ) : noSupplyRecords ? (
          <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
            No supply records found for the selected month.
          </div>
        ) : bills.length ? (
          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            {bills.map((bill) => {
              const customerPhoneInvalid = mobileDigits(bill.customerPhone || "").length !== 10;
              return (
                <article key={bill.customerId} className="rounded-lg border border-slate-200 p-4">
                  <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
                    <div>
                      <p className="text-sm font-bold text-slate-950">{bill.customerName}</p>
                      <p className="mt-1 text-xs font-semibold text-slate-500">+91 {bill.customerPhone || "-"}</p>
                    </div>
                    <p className="text-sm font-bold text-brandPrimary">₹{formatBillNumber(bill.totalAmountPayable ?? bill.totalAmount)}</p>
                  </div>
                  {customerPhoneInvalid ? (
                    <div className="mt-3 rounded-lg border border-red-200 bg-red-50 p-3 text-sm font-semibold text-red-700">
                      Customer phone number is invalid. Please update customer details.
                    </div>
                  ) : null}
                  <pre className="mt-3 whitespace-pre-wrap rounded-lg border border-slate-200 bg-slate-50 p-3 text-sm leading-6 text-slate-800">
                    {buildCustomerBillMessage(bill)}
                  </pre>
                  <Button
                    icon={Send}
                    className="mt-3 w-full sm:w-auto"
                    onClick={() => openCustomerBillWhatsApp(bill, notify)}
                  >
                    Send via WhatsApp
                  </Button>
                </article>
              );
            })}
          </div>
        ) : null}
      </section>
    </div>
  );
}

function ReportPreview({ reportData }) {
  if (!reportData) return null;
  const summaryRows = reportData.reportType === "Individual" ? reportData.productSummary || [] : reportData.customerSummary || [];
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Report Preview</p>
          <h2 className="mt-1 text-xl font-bold text-slate-950">{reportTitle(reportData)}</h2>
          <p className="mt-1 text-sm text-slate-600">
            {reportData.vendor?.shopName} · Total amount {formatCurrency(reportData.totalAmount || 0)}
          </p>
        </div>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">Supplied days</p>
            <p className="mt-1 font-bold text-slate-950">{reportData.totalSuppliedDays || 0}</p>
          </div>
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-xs font-bold uppercase text-slate-500">Not supplied</p>
            <p className="mt-1 font-bold text-slate-950">{reportData.totalNotSuppliedDays || 0}</p>
          </div>
        </div>
      </div>
      {reportData.reportType === "Individual" && reportData.customer ? (
        <div className="mt-4 rounded-lg border border-brandLight bg-brandBg p-4">
          <p className="text-sm font-bold text-brandDark">{reportData.customer.name}</p>
          <p className="mt-1 text-sm text-brandPrimary">+91 {reportData.customer.phoneNumber} · {reportData.customer.address}</p>
          <p className="mt-1 text-sm text-brandPrimary">
            Payment options: {reportData.vendor?.phonePeGPayNumber ? `+91 ${reportData.vendor.phonePeGPayNumber}` : "-"} · {reportData.vendor?.upiId || "-"}
          </p>
        </div>
      ) : null}
      <div className="mt-5 overflow-hidden rounded-lg border border-slate-200">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[920px] text-left text-sm">
            <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
              <tr>
                {reportData.reportType === "Individual" ? (
                  <>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Unit</th>
                    <th className="px-4 py-3">Quantity</th>
                    <th className="px-4 py-3">Rate</th>
                    <th className="px-4 py-3">Days supplied</th>
                    <th className="px-4 py-3">Days not supplied</th>
                    <th className="px-4 py-3">Amount</th>
                  </>
                ) : (
                  <>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Phone</th>
                    <th className="px-4 py-3">Product</th>
                    <th className="px-4 py-3">Quantity</th>
                    <th className="px-4 py-3">Unit</th>
                    <th className="px-4 py-3">Days supplied</th>
                    <th className="px-4 py-3">Days not supplied</th>
                    <th className="px-4 py-3">Amount</th>
                  </>
                )}
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {summaryRows.map((row, index) => (
                <tr key={`${row.customerId || row.productId}-${index}`}>
                  {reportData.reportType === "Individual" ? (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-950">{row.productName}</td>
                      <td className="px-4 py-3 text-slate-600">{row.unit}</td>
                      <td className="px-4 py-3 text-slate-600">{row.totalQuantity}</td>
                      <td className="px-4 py-3 text-slate-600">{formatCurrency(row.rate)}</td>
                      <td className="px-4 py-3 text-slate-600">{row.daysSupplied}</td>
                      <td className="px-4 py-3 text-slate-600">{row.daysNotSupplied}</td>
                      <td className="px-4 py-3 font-semibold text-slate-950">{formatCurrency(row.totalAmount)}</td>
                    </>
                  ) : (
                    <>
                      <td className="px-4 py-3 font-semibold text-slate-950">{row.customerName}</td>
                      <td className="px-4 py-3 text-slate-600">+91 {row.phoneNumber}</td>
                      <td className="px-4 py-3 text-slate-600">{row.productName}</td>
                      <td className="px-4 py-3 text-slate-600">{row.totalQuantity}</td>
                      <td className="px-4 py-3 text-slate-600">{row.unit}</td>
                      <td className="px-4 py-3 text-slate-600">{row.daysSupplied}</td>
                      <td className="px-4 py-3 text-slate-600">{row.daysNotSupplied}</td>
                      <td className="px-4 py-3 font-semibold text-slate-950">{formatCurrency(row.totalAmount)}</td>
                    </>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <h3 className="mt-6 text-base font-bold text-slate-950">Date-wise Supply Details</h3>
      <div className="mt-3 max-h-96 overflow-auto rounded-lg border border-slate-200 scrollbar-soft">
        <table className="w-full min-w-[940px] text-left text-sm">
          <thead className="sticky top-0 bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
            <tr>
              <th className="px-4 py-3">Date</th>
              {reportData.reportType !== "Individual" ? <th className="px-4 py-3">Customer</th> : null}
              <th className="px-4 py-3">Product</th>
              <th className="px-4 py-3">Quantity</th>
              <th className="px-4 py-3">Unit</th>
              <th className="px-4 py-3">Rate</th>
              <th className="px-4 py-3">Status</th>
              <th className="px-4 py-3">Amount</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200 bg-white">
            {(reportData.detailRows || []).map((row, index) => (
              <tr key={`${row.date}-${row.customerId}-${row.productId}-${index}`}>
                <td className="px-4 py-3 text-slate-600">{formatDate(row.date)}</td>
                {reportData.reportType !== "Individual" ? <td className="px-4 py-3 text-slate-600">{row.customerName}</td> : null}
                <td className="px-4 py-3 text-slate-600">{row.productName}</td>
                <td className="px-4 py-3 text-slate-600">{row.quantity}</td>
                <td className="px-4 py-3 text-slate-600">{row.unit}</td>
                <td className="px-4 py-3 text-slate-600">{formatCurrency(row.rate)}</td>
                <td className="px-4 py-3 text-slate-600">{row.status}</td>
                <td className="px-4 py-3 font-semibold text-slate-950">{formatCurrency(row.amount)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function VendorReportsPage({ token, path, onNavigate, notify }) {
  const period = currentReportPeriod();
  const dateRange = currentReportDateRange();
  const [customers, setCustomers] = useState([]);
  const [products, setProducts] = useState([]);
  const [reports, setReports] = useState([]);
  const [reportData, setReportData] = useState(null);
  const [emptyReportMessage, setEmptyReportMessage] = useState("");
  const [loading, setLoading] = useState(true);
  const [generating, setGenerating] = useState(false);
  const [selectedCustomerIds, setSelectedCustomerIds] = useState([]);
  const [fromDateText, setFromDateText] = useState(formatDate(dateRange.fromDate));
  const [toDateText, setToDateText] = useState(formatDate(dateRange.toDate));
  const [paymentReport, setPaymentReport] = useState(null);
  const [paymentForm, setPaymentForm] = useState({
    paymentStatus: "Unpaid",
    paidAmount: "",
    paymentDate: "",
    paymentMode: "",
  });
  const [filters, setFilters] = useState({
    reportType: "Consolidated",
    month: period.month,
    year: period.year,
    productId: "",
    status: "",
  });

  const selectedReportId = path.match(/^\/vendor\/reports\/([^/]+)$/)?.[1];
  const selectedSavedReport = selectedReportId && selectedReportId !== "saved"
    ? reports.find((report) => report.id === selectedReportId)
    : null;
  const activeReportData = selectedSavedReport?.reportData || reportData;

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [customerResponse, productResponse, reportResponse] = await Promise.all([
        apiRequest("/api/vendor/customers", { token }),
        apiRequest("/api/vendor/products", { token }),
        apiRequest("/api/vendor/reports", { token }),
      ]);
      const nextCustomers = customerResponse.customers || [];
      const activeCustomerIds = nextCustomers
        .filter((customer) => customer.status === "Active")
        .map((customer) => customer.id);
      setCustomers(nextCustomers);
      setSelectedCustomerIds((current) =>
        current.length ? current.filter((id) => activeCustomerIds.includes(id)) : activeCustomerIds,
      );
      setProducts(productResponse.products || []);
      setReports(reportResponse.reports || []);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    load();
  }, [load]);

  const activeCustomers = useMemo(() => customers.filter((customer) => customer.status === "Active"), [customers]);
  const activeCustomerIds = useMemo(() => new Set(activeCustomers.map((customer) => customer.id)), [activeCustomers]);
  const selectedActiveCustomerIds = useMemo(
    () => selectedCustomerIds.filter((id) => activeCustomerIds.has(id)),
    [selectedCustomerIds, activeCustomerIds],
  );
  const allActiveCustomersSelected =
    activeCustomers.length > 0 && selectedActiveCustomerIds.length === activeCustomers.length;
  const updateFromDateText = (value) => {
    const cleaned = value.replace(/[^\d-]/g, "").slice(0, 10);
    setFromDateText(cleaned);
    setEmptyReportMessage("");
  };
  const updateToDateText = (value) => {
    const cleaned = value.replace(/[^\d-]/g, "").slice(0, 10);
    setToDateText(cleaned);
    setEmptyReportMessage("");
  };

  const generate = async (event) => {
    event.preventDefault();
    if (!activeCustomers.length) {
      notify("No active customers available for report generation.", "error");
      return;
    }
    if (!selectedActiveCustomerIds.length) {
      notify("Please select at least one customer to generate the report.", "error");
      return;
    }
    const fromDate = parseDisplayDate(fromDateText);
    const toDate = parseDisplayDate(toDateText);
    if (!fromDate || !toDate) {
      notify("From Date and To Date are required.", "error");
      return;
    }
    if (fromDate > toDate) {
      notify("From Date cannot be later than To Date.", "error");
      return;
    }
    if (filters.reportType === "Individual" && selectedActiveCustomerIds.length !== 1) {
      notify("Select one customer for an individual report.", "error");
      return;
    }
    setGenerating(true);
    setEmptyReportMessage("");
    try {
      const response = await apiRequest("/api/vendor/reports/generate", {
        method: "POST",
        token,
        body: {
          ...filters,
          month: new Date(`${fromDate}T00:00:00`).getMonth(),
          year: new Date(`${fromDate}T00:00:00`).getFullYear(),
          customerIds: selectedActiveCustomerIds,
          customerId: filters.reportType === "Individual" ? selectedActiveCustomerIds[0] : "",
          fromDate,
          toDate,
        },
      });
      setReportData(response.reportData);
      setEmptyReportMessage(
        response.reportData?.detailRows?.length
          ? ""
          : "No supply records found for the selected customers and date range.",
      );
      notify(response.message || "Report generated successfully.");
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setGenerating(false);
    }
  };

  const saveReport = async () => {
    if (!reportData) {
      notify("Generate a report before saving.", "error");
      return;
    }
    try {
      const response = await apiRequest("/api/vendor/reports/save", {
        method: "POST",
        token,
        body: { reportData },
      });
      notify(response.message || "Report saved successfully.");
      await load();
      onNavigate(`/vendor/reports/${response.report.id}`);
    } catch (error) {
      notify(error.message, "error");
    }
  };

  const openPayment = (report) => {
    setPaymentReport(report);
    setPaymentForm({
      paymentStatus: report.paymentStatus || "Unpaid",
      paidAmount: report.paidAmount || "",
      paymentDate: report.paymentDate || "",
      paymentMode: report.paymentMode || "",
    });
  };

  const updatePayment = async (event) => {
    event.preventDefault();
    try {
      const response = await apiRequest(`/api/vendor/reports/${paymentReport.id}/payment-status`, {
        method: "PATCH",
        token,
        body: { ...paymentForm, paidAmount: Number(paymentForm.paidAmount || 0) },
      });
      notify(response.message || "Payment status updated successfully.");
      setPaymentReport(null);
      await load();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  return (
    <div className="space-y-6">
      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div>
            <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Reports and Billing</p>
            <h1 className="mt-1 text-2xl font-bold text-slate-950">Monthly Reports</h1>
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/vendor/dashboard")}>
              Dashboard
            </Button>
            <Button variant="secondary" icon={ReceiptText} onClick={() => onNavigate("/vendor/reports/saved")}>
              Saved Reports
            </Button>
          </div>
        </div>
      </section>

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">Generate Report</h2>
        {!loading && !activeCustomers.length ? (
          <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
            No active customers available for report generation.
          </div>
        ) : null}
        <form className="mt-5 grid gap-4" onSubmit={generate}>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Report type">
              <Select
                value={filters.reportType}
                onChange={(event) =>
                  setFilters((current) => ({
                    ...current,
                    reportType: event.target.value,
                  }))
                }
              >
                <option value="Consolidated">All Customers Consolidated Report</option>
                <option value="Individual">Individual Customer Report</option>
              </Select>
            </Field>
            <Field label="From Date" hint="Use DD-MM-YYYY format.">
              <Input
                value={fromDateText}
                onChange={(event) => updateFromDateText(event.target.value)}
                inputMode="numeric"
                maxLength={10}
                placeholder="DD-MM-YYYY"
                required
              />
            </Field>
            <Field label="To Date" hint="Use DD-MM-YYYY format.">
              <Input
                value={toDateText}
                onChange={(event) => updateToDateText(event.target.value)}
                inputMode="numeric"
                maxLength={10}
                placeholder="DD-MM-YYYY"
                required
              />
            </Field>
          </div>
          <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            <Field label="Product" hint="Optional">
              <Select value={filters.productId} onChange={(event) => setFilters((current) => ({ ...current, productId: event.target.value }))}>
                <option value="">All products</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Status" hint="Optional">
              <Select value={filters.status} onChange={(event) => setFilters((current) => ({ ...current, status: event.target.value }))}>
                <option value="">All statuses</option>
                {SUPPLY_STATUSES.map((status) => (
                  <option key={status} value={status}>
                    {status}
                  </option>
                ))}
              </Select>
            </Field>
          </div>
          <section className="rounded-lg border border-slate-200 bg-slate-50 p-4">
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <p className="text-sm font-bold text-slate-950">Customer Selection</p>
                <p className="mt-1 text-sm font-semibold text-brandPrimary">
                  Selected Customers: {selectedActiveCustomerIds.length}
                </p>
              </div>
              {activeCustomers.length ? (
                <label className="flex items-center gap-2 text-sm font-bold text-slate-700">
                  <input
                    type="checkbox"
                    className="h-4 w-4 rounded border-slate-300 text-brandPrimary"
                    checked={allActiveCustomersSelected}
                    onChange={(event) =>
                      setSelectedCustomerIds(event.target.checked ? activeCustomers.map((customer) => customer.id) : [])
                    }
                  />
                  Select All Customers
                </label>
              ) : null}
            </div>
            {loading ? (
              <p className="mt-4 text-sm font-semibold text-slate-600">Loading customers...</p>
            ) : activeCustomers.length ? (
              <div className="mt-4 grid gap-2 sm:grid-cols-2 lg:grid-cols-3">
                {activeCustomers.map((customer) => (
                  <label
                    key={customer.id}
                    className="flex items-start gap-3 rounded-lg border border-slate-200 bg-white p-3 text-sm font-semibold text-slate-700"
                  >
                    <input
                      type="checkbox"
                      className="mt-1 h-4 w-4 rounded border-slate-300 text-brandPrimary"
                      checked={selectedActiveCustomerIds.includes(customer.id)}
                      onChange={(event) =>
                        setSelectedCustomerIds((current) =>
                          event.target.checked
                            ? [...new Set([...current, customer.id])]
                            : current.filter((id) => id !== customer.id),
                        )
                      }
                    />
                    <span>
                      <span className="block text-slate-950">{customer.name}</span>
                      <span className="block text-xs text-slate-500">
                        {customer.phoneNumber ? `+91 ${customer.phoneNumber}` : "Phone not updated"}
                      </span>
                    </span>
                  </label>
                ))}
              </div>
            ) : (
              <div className="mt-4 rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
                No active customers available for report generation.
              </div>
            )}
          </section>
          <div className="flex flex-wrap gap-2">
            <Button type="submit" icon={ReceiptText} disabled={generating || loading || !activeCustomers.length}>
              Generate Report
            </Button>
            <Button variant="secondary" icon={Download} onClick={() => exportReportPdf(activeReportData, notify)}>
              PDF
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportReportExcel(activeReportData, notify)}>
              Excel
            </Button>
            <Button variant="secondary" icon={CheckCircle2} onClick={saveReport} disabled={!reportData}>
              Save Report
            </Button>
            {activeReportData?.reportType === "Individual" ? (
              <Button
                variant="secondary"
                icon={Send}
                onClick={() => openWhatsAppBill(activeReportData, selectedSavedReport?.paymentStatus || "Unpaid", notify)}
              >
                WhatsApp Bill
              </Button>
            ) : null}
          </div>
        </form>
      </section>

      {activeReportData ? (
        <>
          {emptyReportMessage && activeReportData === reportData ? (
            <section className="rounded-lg border border-orange-200 bg-orange-50 p-4 text-sm font-semibold text-orange-800">
              {emptyReportMessage}
            </section>
          ) : null}
          <ReportPreview reportData={activeReportData} />
        </>
      ) : (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <EmptyState
            icon={ReceiptText}
            title="Select customers and date range, then click Generate Report."
          />
        </section>
      )}

      <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
        <h2 className="text-lg font-bold text-slate-950">Saved Reports</h2>
        {loading ? (
          <p className="mt-4 text-sm font-semibold text-slate-600">Loading saved reports...</p>
        ) : reports.length ? (
          <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
            <div className="overflow-x-auto">
              <table className="w-full min-w-[1080px] text-left text-sm">
                <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                  <tr>
                    <th className="px-4 py-3">Report type</th>
                    <th className="px-4 py-3">Customer</th>
                    <th className="px-4 py-3">Month</th>
                    <th className="px-4 py-3">Year</th>
                    <th className="px-4 py-3">Total amount</th>
                    <th className="px-4 py-3">Payment</th>
                    <th className="px-4 py-3">Created date</th>
                    <th className="px-4 py-3">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200">
                  {reports.map((report) => {
                    const data = report.reportData || {};
                    return (
                      <tr key={report.id}>
                        <td className="px-4 py-3 font-semibold text-slate-950">{report.reportType}</td>
                        <td className="px-4 py-3 text-slate-600">{data.customer?.name || "-"}</td>
                        <td className="px-4 py-3 text-slate-600">{data.monthName || report.month}</td>
                        <td className="px-4 py-3 text-slate-600">{report.year}</td>
                        <td className="px-4 py-3 font-semibold text-slate-950">{formatCurrency(report.totalAmount)}</td>
                        <td className="px-4 py-3 text-slate-600">
                          {report.paymentStatus || "Unpaid"} · Balance {formatCurrency(report.balanceAmount ?? report.totalAmount)}
                        </td>
                        <td className="px-4 py-3 text-slate-600">{formatDate(report.createdAt)}</td>
                        <td className="px-4 py-3">
                          <div className="flex flex-wrap gap-2">
                            <Button variant="subtle" icon={Eye} onClick={() => onNavigate(`/vendor/reports/${report.id}`)}>
                              View
                            </Button>
                            <Button variant="secondary" icon={Download} onClick={() => exportReportPdf(data, notify)}>
                              PDF
                            </Button>
                            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportReportExcel(data, notify)}>
                              Excel
                            </Button>
                            {report.reportType === "Individual" ? (
                              <Button variant="secondary" icon={Send} onClick={() => openWhatsAppBill(data, report.paymentStatus, notify)}>
                                WhatsApp
                              </Button>
                            ) : null}
                            <Button variant="secondary" icon={Wallet} onClick={() => openPayment(report)}>
                              Payment
                            </Button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        ) : (
          <div className="mt-4">
            <EmptyState icon={ReceiptText} title="No saved reports yet." text="Generate and save a report to track billing." />
          </div>
        )}
      </section>

      {paymentReport ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 px-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">Update Payment Status</h2>
                <p className="mt-1 text-sm text-slate-600">Total amount {formatCurrency(paymentReport.totalAmount)}</p>
              </div>
              <button type="button" className="rounded-md p-1 text-slate-500 hover:bg-slate-100" onClick={() => setPaymentReport(null)}>
                <X className="h-5 w-5" />
              </button>
            </div>
            <form className="mt-5 grid gap-4" onSubmit={updatePayment}>
              <Field label="Payment status">
                <Select value={paymentForm.paymentStatus} onChange={(event) => setPaymentForm((current) => ({ ...current, paymentStatus: event.target.value }))}>
                  {PAYMENT_STATUSES.map((status) => (
                    <option key={status} value={status}>
                      {status}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-4 sm:grid-cols-2">
                <Field label="Paid amount">
                  <Input type="number" min="0" step="0.01" value={paymentForm.paidAmount} onChange={(event) => setPaymentForm((current) => ({ ...current, paidAmount: event.target.value }))} />
                </Field>
                <Field label="Payment date">
                  <Input type="date" value={paymentForm.paymentDate} onChange={(event) => setPaymentForm((current) => ({ ...current, paymentDate: event.target.value }))} />
                </Field>
              </div>
              <Field label="Payment mode">
                <Select value={paymentForm.paymentMode} onChange={(event) => setPaymentForm((current) => ({ ...current, paymentMode: event.target.value }))}>
                  <option value="">Select mode</option>
                  {PAYMENT_MODES.map((mode) => (
                    <option key={mode} value={mode}>
                      {mode}
                    </option>
                  ))}
                </Select>
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Button type="submit">Save Payment</Button>
                <Button variant="secondary" onClick={() => setPaymentReport(null)}>
                  Cancel
                </Button>
              </div>
            </form>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function AdminRecordsPage({ type, token, routePath, notify, onRefresh }) {
  const isCustomers = type === "customers";
  const [records, setRecords] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [formOpen, setFormOpen] = useState(false);
  const [editing, setEditing] = useState(null);
  const [viewRecord, setViewRecord] = useState(null);
  const [deleteTarget, setDeleteTarget] = useState(null);
  const [saving, setSaving] = useState(false);
  const [form, setForm] = useState(isCustomers ? customerFormFrom() : productFormFrom());

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (vendorFilter) params.set("vendorId", vendorFilter);
    try {
      const response = await apiRequest(`/api/super-admin/${type}?${params.toString()}`, { token });
      setRecords(response[type] || []);
      setVendors(response.vendors || []);
    } catch (error) {
      notify(error.message, "error");
    }
  }, [search, token, type, vendorFilter]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const detailId = routePath.match(new RegExp(`^/super-admin/${type}/([^/]+)$`))?.[1];
    if (detailId) setViewRecord(records.find((record) => record.id === detailId) || null);
  }, [records, routePath, type]);

  const selectedVendor = vendors.find((vendor) => vendor.id === form.vendorId);
  const selectedVendorReachedLimit = selectedVendor
    ? isCustomers
      ? Number(selectedVendor.currentCustomerCount || 0) >= Number(selectedVendor.customerLimit || 0)
      : Number(selectedVendor.currentProductCount || 0) >= Number(selectedVendor.productLimit || 0)
    : false;

  const openCreate = () => {
    setEditing(null);
    setViewRecord(null);
    setForm(isCustomers ? customerFormFrom() : productFormFrom());
    setFormOpen(true);
  };

  const openEdit = (record) => {
    setEditing(record);
    setViewRecord(null);
    setForm(isCustomers ? customerFormFrom(record) : productFormFrom(record));
    setFormOpen(true);
  };

  const submit = async (event) => {
    event.preventDefault();
    if (!form.vendorId && !editing) {
      notify("Please select a vendor.", "error");
      return;
    }
    const validation = isCustomers ? validateCustomerForm(form) : validateProductForm(form);
    if (validation) {
      notify(validation, "error");
      return;
    }
    if (!editing && selectedVendorReachedLimit) {
      notify(
        isCustomers
          ? "Vendor customer limit reached. Please increase vendor limit before adding customer."
          : "Vendor product limit reached. Please increase vendor limit before adding product.",
        "error",
      );
      return;
    }
    setSaving(true);
    try {
      const body = isCustomers
        ? { ...form, phoneNumber: mobileDigits(form.phoneNumber) }
        : { ...form, quantity: Number(form.quantity), pricePerUnit: Number(form.pricePerUnit) };
      const response = await apiRequest(
        editing ? `/api/super-admin/${type}/${editing.id}` : `/api/super-admin/${type}`,
        { method: editing ? "PATCH" : "POST", token, body },
      );
      notify(response.message || `${isCustomers ? "Customer" : "Product"} saved successfully.`);
      setFormOpen(false);
      setEditing(null);
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (record) => {
    const nextStatus = record.status === "Active" ? "Inactive" : "Active";
    try {
      const response = await apiRequest(`/api/super-admin/${type}/${record.id}/status`, {
        method: "PATCH",
        token,
        body: { status: nextStatus },
      });
      notify(response.message || "Status updated successfully.");
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  const confirmDelete = async () => {
    try {
      const response = await apiRequest(`/api/super-admin/${type}/${deleteTarget.id}`, {
        method: "DELETE",
        token,
      });
      notify(response.message || "Record deleted successfully.");
      setDeleteTarget(null);
      await load();
      await onRefresh?.();
    } catch (error) {
      notify(error.message, "error");
    }
  };

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Super Admin</p>
          <h2 className="mt-1 text-xl font-bold text-slate-950">{isCustomers ? "Customer Records" : "Product Records"}</h2>
          <p className="mt-1 text-sm text-slate-500">
            View and manage {isCustomers ? "customers" : "products"} created across all vendors.
          </p>
        </div>
        <Button icon={Plus} onClick={openCreate}>
          Add {isCustomers ? "Customer" : "Product"}
        </Button>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Field label="Search">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder={isCustomers ? "Name, email, phone" : "Name, unit, quantity, HSN code"} />
        </Field>
        <Field label="Filter by vendor">
          <Select value={vendorFilter} onChange={(event) => setVendorFilter(event.target.value)}>
            <option value="">All vendors</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.shopName} - {vendor.vendorName}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {formOpen ? (
        <form className="mt-5 rounded-lg border border-slate-200 bg-slate-50 p-4" onSubmit={submit}>
          <div className="mb-4 flex items-center justify-between gap-3">
            <h3 className="text-base font-bold text-slate-950">
              {editing ? "Edit" : "Add"} {isCustomers ? "Customer" : "Product"}
            </h3>
            <Button variant="subtle" icon={X} onClick={() => setFormOpen(false)}>
              Close
            </Button>
          </div>
          {isCustomers ? (
            <CustomerFields form={form} setForm={setForm} vendorOptions={vendors} showVendor={!editing} />
          ) : (
            <ProductFields form={form} setForm={setForm} vendorOptions={vendors} showVendor={!editing} />
          )}
          {selectedVendorReachedLimit && !editing ? (
            <p className="mt-3 text-sm font-semibold text-red-700">
              {isCustomers
                ? "Vendor customer limit reached. Please increase vendor limit before adding customer."
                : "Vendor product limit reached. Please increase vendor limit before adding product."}
            </p>
          ) : null}
          <div className="mt-5 grid gap-3 sm:grid-cols-2 lg:w-1/2">
            <Button type="submit" disabled={saving || (!editing && selectedVendorReachedLimit)}>
              Save
            </Button>
            <Button variant="secondary" onClick={() => setFormOpen(false)}>
              Cancel
            </Button>
          </div>
        </form>
      ) : null}

      {viewRecord ? (
        <div className="mt-5 rounded-lg border border-brandLight bg-brandBg p-4">
          <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div>
              <h3 className="text-base font-bold text-brandDark">{viewRecord.name}</h3>
              <p className="mt-1 text-sm text-brandPrimary">
                {viewRecord.vendorShopName || "-"} · {viewRecord.vendorName || "-"}
              </p>
            </div>
            <Button variant="secondary" onClick={() => setViewRecord(null)}>
              Close
            </Button>
          </div>
          <div className="mt-4 grid gap-3 sm:grid-cols-2">
            {(isCustomers
              ? [
                  ["Email", viewRecord.email || "-"],
                  ["Phone", `+91 ${viewRecord.phoneNumber}`],
                  ["Address", viewRecord.address],
                  ["Status", viewRecord.status],
                ]
              : [
                  ["Product Name", viewRecord.name],
                  ["Product Quantity", viewRecord.quantity ?? 0],
                  ["Unit", viewRecord.unit],
                  ["Price", formatCurrency(viewRecord.pricePerUnit)],
                  ["Description", viewRecord.description],
                  ["HSN Code", viewRecord.hsnCode || "-"],
                  ["Status", viewRecord.status],
                ]
            ).map(([label, value]) => (
              <div key={label} className="rounded-lg border border-brandLight bg-white/70 p-3">
                <p className="text-xs font-bold uppercase tracking-wide text-brandPrimary">{label}</p>
                <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
              </div>
            ))}
          </div>
        </div>
      ) : null}

      {records.length ? (
        <div className="mt-5 overflow-hidden rounded-lg border border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1120px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">{isCustomers ? "Customer name" : "Product Name"}</th>
                  <th className="px-4 py-3">{isCustomers ? "Email" : "Product Quantity"}</th>
                  <th className="px-4 py-3">{isCustomers ? "Phone" : "Unit"}</th>
                  {!isCustomers ? <th className="px-4 py-3">Price</th> : null}
                  <th className="px-4 py-3">{isCustomers ? "Address" : "Description"}</th>
                  {!isCustomers ? <th className="px-4 py-3">HSN Code</th> : null}
                  <th className="px-4 py-3">Status</th>
                  <th className="px-4 py-3">Vendor name</th>
                  <th className="px-4 py-3">Vendor shop</th>
                  <th className="px-4 py-3">Created date</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {records.map((record) => (
                  <tr key={record.id}>
                    <td className="px-4 py-3 font-semibold text-slate-950">{record.name}</td>
                    <td className="px-4 py-3 text-slate-600">{isCustomers ? record.email || "-" : record.quantity ?? 0}</td>
                    <td className="px-4 py-3 text-slate-600">{isCustomers ? `+91 ${record.phoneNumber}` : record.unit}</td>
                    {!isCustomers ? (
                      <td className="px-4 py-3 text-slate-600">{formatCurrency(record.pricePerUnit)}</td>
                    ) : null}
                    <td className="px-4 py-3 text-slate-600">{isCustomers ? record.address : record.description}</td>
                    {!isCustomers ? (
                      <td className="px-4 py-3 text-slate-600">{record.hsnCode || "-"}</td>
                    ) : null}
                    <td className="px-4 py-3">
                      <span className={classNames("rounded-full px-2.5 py-1 text-xs font-bold ring-1", statusBadgeClass(record.status))}>
                        {record.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-slate-600">{record.vendorName || "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{record.vendorShopName || "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{formatDate(record.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="subtle" icon={Eye} onClick={() => setViewRecord(record)}>
                          View
                        </Button>
                        <Button variant="secondary" icon={Edit3} onClick={() => openEdit(record)}>
                          Edit
                        </Button>
                        <Button variant="secondary" onClick={() => updateStatus(record)}>
                          Mark {record.status === "Active" ? "Inactive" : "Active"}
                        </Button>
                        <Button variant="danger" icon={Trash2} onClick={() => setDeleteTarget(record)}>
                          Delete
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <EmptyState icon={isCustomers ? Users : Package} title={isCustomers ? "No customers found." : "No products found."} />
        </div>
      )}

      {deleteTarget ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 px-4">
          <div className="w-full max-w-md rounded-lg bg-white p-5 shadow-xl">
            <h3 className="text-lg font-bold text-slate-950">Confirm delete</h3>
            <p className="mt-2 text-sm leading-6 text-slate-600">
              Delete {deleteTarget.name}? This action is available only to Super Admin.
            </p>
            <div className="mt-5 grid gap-3 sm:grid-cols-2">
              <Button variant="danger" icon={Trash2} onClick={confirmDelete}>
                Delete
              </Button>
              <Button variant="secondary" onClick={() => setDeleteTarget(null)}>
                Cancel
              </Button>
            </div>
          </div>
        </div>
      ) : null}
    </section>
  );
}

function AdminReportsPage({ token, notify }) {
  const [reports, setReports] = useState([]);
  const [vendors, setVendors] = useState([]);
  const [search, setSearch] = useState("");
  const [vendorFilter, setVendorFilter] = useState("");
  const [loading, setLoading] = useState(true);
  const [viewReport, setViewReport] = useState(null);

  const load = useCallback(async () => {
    const params = new URLSearchParams();
    if (search.trim()) params.set("search", search.trim());
    if (vendorFilter) params.set("vendorId", vendorFilter);
    setLoading(true);
    try {
      const response = await apiRequest(`/api/super-admin/reports?${params.toString()}`, { token });
      setReports(response.reports || []);
      setVendors(response.vendors || []);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  }, [search, token, vendorFilter]);

  useEffect(() => {
    load();
  }, [load]);

  return (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">Super Admin</p>
          <h2 className="mt-1 text-xl font-bold text-slate-950">Saved Reports</h2>
          <p className="mt-1 text-sm text-slate-500">View reports generated by vendors across the system.</p>
        </div>
      </div>

      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        <Field label="Search reports">
          <Input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Vendor, customer, payment status" />
        </Field>
        <Field label="Filter by vendor">
          <Select value={vendorFilter} onChange={(event) => setVendorFilter(event.target.value)}>
            <option value="">All vendors</option>
            {vendors.map((vendor) => (
              <option key={vendor.id} value={vendor.id}>
                {vendor.shopName} - {vendor.vendorName}
              </option>
            ))}
          </Select>
        </Field>
      </div>

      {viewReport ? (
        <div className="mt-5">
          <div className="mb-3 flex flex-wrap justify-end gap-2">
            <Button variant="secondary" icon={Download} onClick={() => exportReportPdf(viewReport.reportData, notify)}>
              PDF
            </Button>
            <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportReportExcel(viewReport.reportData, notify)}>
              Excel
            </Button>
            <Button variant="secondary" icon={X} onClick={() => setViewReport(null)}>
              Close Preview
            </Button>
          </div>
          <ReportPreview reportData={viewReport.reportData} />
        </div>
      ) : null}

      {loading ? (
        <p className="mt-5 text-sm font-semibold text-slate-600">Loading reports...</p>
      ) : reports.length ? (
        <div className="mt-5 overflow-hidden rounded-lg border border-slate-200">
          <div className="overflow-x-auto">
            <table className="w-full min-w-[1080px] text-left text-sm">
              <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
                <tr>
                  <th className="px-4 py-3">Report type</th>
                  <th className="px-4 py-3">Vendor</th>
                  <th className="px-4 py-3">Customer</th>
                  <th className="px-4 py-3">Month</th>
                  <th className="px-4 py-3">Year</th>
                  <th className="px-4 py-3">Total amount</th>
                  <th className="px-4 py-3">Payment</th>
                  <th className="px-4 py-3">Created date</th>
                  <th className="px-4 py-3">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200">
                {reports.map((report) => (
                  <tr key={report.id}>
                    <td className="px-4 py-3 font-semibold text-slate-950">{report.reportType}</td>
                    <td className="px-4 py-3 text-slate-600">{report.vendorShopName || report.vendorName || "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{report.customerName || "-"}</td>
                    <td className="px-4 py-3 text-slate-600">{report.reportData?.monthName || report.month}</td>
                    <td className="px-4 py-3 text-slate-600">{report.year}</td>
                    <td className="px-4 py-3 font-semibold text-slate-950">{formatCurrency(report.totalAmount)}</td>
                    <td className="px-4 py-3 text-slate-600">{report.paymentStatus || "Unpaid"}</td>
                    <td className="px-4 py-3 text-slate-600">{formatDate(report.createdAt)}</td>
                    <td className="px-4 py-3">
                      <div className="flex flex-wrap gap-2">
                        <Button variant="subtle" icon={Eye} onClick={() => setViewReport(report)}>
                          View
                        </Button>
                        <Button variant="secondary" icon={Download} onClick={() => exportReportPdf(report.reportData, notify)}>
                          PDF
                        </Button>
                        <Button variant="secondary" icon={FileSpreadsheet} onClick={() => exportReportExcel(report.reportData, notify)}>
                          Excel
                        </Button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      ) : (
        <div className="mt-5">
          <EmptyState icon={ReceiptText} title="No reports found." />
        </div>
      )}
    </section>
  );
}

function SuperAdminLoginPage({ onLogin, notify }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);

  const submit = async (event) => {
    event.preventDefault();
    if (!isValidEmail(email)) {
      notify("Enter a valid admin email address.", "error");
      return;
    }

    setLoading(true);
    try {
      const response = await apiRequest("/api/super-admin/login", {
        method: "POST",
        body: { email: email.trim().toLowerCase(), password },
      });
      notify(response.message || "Super Admin login successful.");
      onLogin(response);
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthPanel
      title="Super Admin Login"
      subtitle="Use the separate admin credentials configured in the server environment."
      icon={ShieldCheck}
    >
      <form className="space-y-4" onSubmit={submit}>
        <Field label="Admin email address">
          <Input
            type="email"
            value={email}
            onChange={(event) => setEmail(event.target.value)}
            placeholder="admin@example.com"
            required
          />
        </Field>
        <Field label="Password">
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder="Enter admin password"
            required
          />
        </Field>
        <Button type="submit" icon={Lock} disabled={loading} className="w-full">
          Login as Super Admin
        </Button>
      </form>
    </AuthPanel>
  );
}

function statusBadgeClass(status) {
  const classes = {
    "Pending Approval": "bg-orange-50 text-orange-700 ring-orange-100",
    Active: "bg-brandBg text-brandPrimary ring-brandLight",
    Inactive: "bg-slate-100 text-slate-700 ring-slate-200",
    Rejected: "bg-red-50 text-red-700 ring-red-100",
  };
  return classes[status] || "bg-slate-100 text-slate-700 ring-slate-200";
}

function SuperAdminDashboard({
  admin,
  dashboard,
  token,
  routePath,
  onLogout,
  onRefresh,
  onNavigate,
  notify,
}) {
  const metrics = dashboard?.metrics || {};
  const vendors = dashboard?.vendors || [];
  const pendingVendors = dashboard?.pendingVendors || [];
  const isPendingVendorRoute = routePath === "/super-admin/vendors/pending";
  const isCustomerRoute = routePath.startsWith("/super-admin/customers");
  const isProductRoute = routePath.startsWith("/super-admin/products");
  const isReportsRoute = routePath.startsWith("/super-admin/reports");
  const isRecordRoute = isCustomerRoute || isProductRoute || isReportsRoute;
  const routeVendorId = isPendingVendorRoute
    ? ""
    : routePath.match(/^\/super-admin\/vendors\/([^/]+)/)?.[1];
  const routeVendor = vendors.find((vendor) => vendor.id === routeVendorId);
  const [actionVendor, setActionVendor] = useState(null);
  const [actionMode, setActionMode] = useState("");
  const [customerLimit, setCustomerLimit] = useState("");
  const [productLimit, setProductLimit] = useState("");
  const [rejectionReason, setRejectionReason] = useState("");
  const [saving, setSaving] = useState(false);

  const cards = [
    ["Total Vendors", metrics.totalVendors || 0, Store],
    ["Pending Approval Vendors", metrics.pendingApprovalVendors || 0, Clock3],
    ["Active Vendors", metrics.activeVendors || 0, CheckCircle2],
    ["Inactive Vendors", metrics.inactiveVendors || 0, X],
    ["Rejected Vendors", metrics.rejectedVendors || 0, X],
    ["Total Customers", metrics.totalCustomers || 0, Users],
    ["Total Products", metrics.totalProducts || 0, Package],
    ["Total Reports", metrics.totalReports || 0, ReceiptText],
    ["Pending Payment Amount", formatCurrency(metrics.pendingPaymentAmount || 0), Wallet],
    ["Total Approved Customers Limit", metrics.totalApprovedCustomersLimit || 0, Users],
    ["Total Approved Products Limit", metrics.totalApprovedProductsLimit || 0, Package],
  ];

  const openAction = (vendor, mode) => {
    setActionVendor(vendor);
    setActionMode(mode);
    setCustomerLimit(String(vendor.customerLimit || ""));
    setProductLimit(String(vendor.productLimit || ""));
    setRejectionReason(vendor.rejectionReason || "");
  };

  const closeAction = () => {
    setActionVendor(null);
    setActionMode("");
    setCustomerLimit("");
    setProductLimit("");
    setRejectionReason("");
  };

  const submitApprove = async (event) => {
    event.preventDefault();
    if (!customerLimit) {
      notify("Customer limit is required.", "error");
      return;
    }
    if (!productLimit) {
      notify("Product limit is required.", "error");
      return;
    }

    setSaving(true);
    try {
      const response = await apiRequest(
        `/api/super-admin/vendors/${actionVendor.id}/approve`,
        {
          method: "POST",
          token,
          body: { customerLimit, productLimit },
        },
      );
      notify(response.message || "Vendor approved successfully.");
      closeAction();
      await onRefresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const submitReject = async (event) => {
    event.preventDefault();
    setSaving(true);
    try {
      const response = await apiRequest(`/api/super-admin/vendors/${actionVendor.id}/reject`, {
        method: "POST",
        token,
        body: { rejectionReason },
      });
      notify(response.message || "Vendor rejected successfully.");
      closeAction();
      await onRefresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const submitLimits = async (event) => {
    event.preventDefault();
    if (!customerLimit) {
      notify("Customer limit is required.", "error");
      return;
    }
    if (!productLimit) {
      notify("Product limit is required.", "error");
      return;
    }

    setSaving(true);
    try {
      const response = await apiRequest(
        `/api/super-admin/vendors/${actionVendor.id}/limits`,
        {
          method: "PATCH",
          token,
          body: { customerLimit, productLimit },
        },
      );
      notify(response.message || "Vendor limits updated successfully.");
      closeAction();
      await onRefresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const updateStatus = async (vendor, status) => {
    setSaving(true);
    try {
      const response = await apiRequest(`/api/super-admin/vendors/${vendor.id}/status`, {
        method: "PATCH",
        token,
        body: { status },
      });
      notify(response.message || "Vendor status updated successfully.");
      await onRefresh();
    } catch (error) {
      notify(error.message, "error");
    } finally {
      setSaving(false);
    }
  };

  const visibleVendors = isPendingVendorRoute ? pendingVendors : vendors;
  const pageTitle =
    isPendingVendorRoute ? "Vendor Approval Requests" : "Vendor List";

  const actionButtons = (vendor) => (
    <div className="flex flex-wrap gap-2">
      <Button variant="subtle" onClick={() => onNavigate(`/super-admin/vendors/${vendor.id}`)}>
        View
      </Button>
      {vendor.status === "Pending Approval" || vendor.status === "Inactive" || vendor.status === "Rejected" ? (
        <Button variant="secondary" onClick={() => openAction(vendor, "approve")}>
          Approve
        </Button>
      ) : null}
      {vendor.status !== "Rejected" ? (
        <Button variant="danger" onClick={() => openAction(vendor, "reject")}>
          Reject
        </Button>
      ) : null}
      {vendor.status === "Active" ? (
        <Button variant="secondary" onClick={() => updateStatus(vendor, "Inactive")} disabled={saving}>
          Make Inactive
        </Button>
      ) : null}
      {vendor.status === "Inactive" ? (
        <Button variant="secondary" onClick={() => updateStatus(vendor, "Active")} disabled={saving}>
          Make Active
        </Button>
      ) : null}
      {vendor.status === "Active" ? (
        <Button variant="secondary" onClick={() => openAction(vendor, "limits")}>
          Edit Limits
        </Button>
      ) : null}
    </div>
  );

  const vendorTable = (rows) =>
    rows.length ? (
      <div className="mt-4 overflow-hidden rounded-lg border border-slate-200">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[1080px] text-left text-sm">
            <thead className="bg-slate-50 text-xs font-bold uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-4 py-3">Vendor name</th>
                <th className="px-4 py-3">Shop name</th>
                <th className="px-4 py-3">Email</th>
                <th className="px-4 py-3">Mobile</th>
                <th className="px-4 py-3">Status</th>
                <th className="px-4 py-3">Customer limit</th>
                <th className="px-4 py-3">Product limit</th>
                <th className="px-4 py-3">Registered date</th>
                <th className="px-4 py-3">Actions</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200">
              {rows.map((vendor) => (
                <tr key={vendor.id}>
                  <td className="px-4 py-3 font-semibold text-slate-950">{vendor.vendorName}</td>
                  <td className="px-4 py-3 text-slate-600">{vendor.shopName}</td>
                  <td className="px-4 py-3 text-slate-600">{vendor.email}</td>
                  <td className="px-4 py-3 text-slate-600">+91 {vendor.mobileNumber}</td>
                  <td className="px-4 py-3">
                    <span
                      className={classNames(
                        "rounded-full px-2.5 py-1 text-xs font-bold ring-1",
                        statusBadgeClass(vendor.status),
                      )}
                    >
                      {vendor.status}
                    </span>
                  </td>
                  <td className="px-4 py-3 text-slate-600">{vendor.customerLimit || 0}</td>
                  <td className="px-4 py-3 text-slate-600">{vendor.productLimit || 0}</td>
                  <td className="px-4 py-3 text-slate-600">
                    {vendor.createdAt ? new Date(vendor.createdAt).toLocaleDateString("en-IN") : "-"}
                  </td>
                  <td className="px-4 py-3">{actionButtons(vendor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    ) : (
      <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-center">
        <Store className="mx-auto h-8 w-8 text-slate-400" />
        <p className="mt-3 text-sm font-semibold text-slate-700">No vendors found.</p>
      </div>
    );

  const detailPage = routeVendor ? (
    <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h2 className="text-xl font-bold text-slate-950">Vendor Details</h2>
          <p className="mt-1 text-sm text-slate-500">{routeVendor.email}</p>
        </div>
        <Button variant="secondary" icon={ArrowLeft} onClick={() => onNavigate("/super-admin/vendors")}>
          Back to Vendors
        </Button>
      </div>
      <div className="mt-5 grid gap-4 lg:grid-cols-2">
        {[
          ["Vendor name", routeVendor.vendorName],
          ["Shop name", routeVendor.shopName],
          ["Email", routeVendor.email],
          ["Mobile number", `+91 ${routeVendor.mobileNumber}`],
          ["Registration date", routeVendor.createdAt ? new Date(routeVendor.createdAt).toLocaleString("en-IN") : "-"],
          ["Email verified", routeVendor.emailVerified ? "Yes" : "No"],
          ["Current status", routeVendor.status],
          ["Customer limit", routeVendor.customerLimit || 0],
          ["Product limit", routeVendor.productLimit || 0],
          ["PhonePe / GPay number", routeVendor.phonePeGPayNumber ? `+91 ${routeVendor.phonePeGPayNumber}` : "-"],
          ["UPI ID", routeVendor.upiId || "-"],
          ["Shop address", routeVendor.shopAddress || "-"],
          ["Shop location", routeVendor.shopLocation || "-"],
          ["FSSAI details", routeVendor.fssaiNumber || "-"],
          ["Approved by", routeVendor.approvedBy || "-"],
          ["Approved date", routeVendor.approvedAt ? new Date(routeVendor.approvedAt).toLocaleString("en-IN") : "-"],
          ["Rejection reason", routeVendor.rejectionReason || "-"],
        ].map(([label, value]) => (
          <div key={label} className="rounded-lg border border-slate-200 p-4">
            <p className="text-xs font-bold uppercase tracking-wide text-slate-500">{label}</p>
            <p className="mt-1 text-sm font-semibold text-slate-950">{value}</p>
          </div>
        ))}
      </div>
      <div className="mt-5">{actionButtons(routeVendor)}</div>
    </section>
  ) : null;

  return (
    <div className="space-y-6">
      <section className="flex flex-col gap-4 rounded-lg border border-slate-200 bg-white p-5 shadow-sm sm:flex-row sm:items-center sm:justify-between">
        <div>
          <p className="text-sm font-bold uppercase tracking-wide text-brandPrimary">
            Super Admin
          </p>
          <h1 className="mt-1 text-2xl font-bold text-slate-950">
            {admin?.name || "Super Admin Dashboard"}
          </h1>
          <p className="mt-1 text-sm text-slate-600">{admin?.email}</p>
        </div>
        <Button variant="secondary" icon={LogOut} onClick={onLogout}>
          Logout
        </Button>
      </section>

      <nav className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={() => onNavigate("/super-admin/dashboard")}>
          Dashboard
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("/super-admin/vendors/pending")}>
          Pending Approvals
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("/super-admin/vendors")}>
          All Vendors
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("/super-admin/customers")}>
          Customers
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("/super-admin/products")}>
          Products
        </Button>
        <Button variant="secondary" onClick={() => onNavigate("/super-admin/reports")}>
          Reports
        </Button>
      </nav>

      <section className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(([label, value, Icon]) => (
          <MetricCard key={label} label={label} value={value} icon={Icon} />
        ))}
      </section>

      {isCustomerRoute ? (
        <AdminRecordsPage
          type="customers"
          token={token}
          routePath={routePath}
          notify={notify}
          onRefresh={onRefresh}
        />
      ) : null}

      {isProductRoute ? (
        <AdminRecordsPage
          type="products"
          token={token}
          routePath={routePath}
          notify={notify}
          onRefresh={onRefresh}
        />
      ) : null}

      {isReportsRoute ? <AdminReportsPage token={token} notify={notify} /> : null}

      {!isRecordRoute && routeVendorId ? detailPage : null}

      {!isRecordRoute && !routeVendorId && routePath === "/super-admin/dashboard" ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex flex-col gap-1 sm:flex-row sm:items-end sm:justify-between">
            <div>
              <h2 className="text-lg font-bold text-slate-950">New Vendor Registration Requests</h2>
              <p className="mt-1 text-sm text-slate-500">
                Newly registered vendors waiting for Super Admin approval.
              </p>
            </div>
            <Button variant="secondary" onClick={() => onNavigate("/super-admin/vendors/pending")}>
              View all requests
            </Button>
          </div>
          <div className="mt-4 flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => onNavigate("/super-admin/vendors/pending")}>
              Vendor Approval Requests
            </Button>
            <Button variant="secondary" onClick={() => onNavigate("/super-admin/vendors")}>
              View Vendors
            </Button>
            <Button variant="secondary" onClick={() => onNavigate("/super-admin/customers")}>
              View Customers
            </Button>
            <Button variant="secondary" onClick={() => onNavigate("/super-admin/products")}>
              View Products
            </Button>
            <Button variant="secondary" onClick={() => onNavigate("/super-admin/reports")}>
              View Reports
            </Button>
          </div>
          {pendingVendors.length ? (
          <div className="mt-4 grid gap-3">
            {pendingVendors.map((vendor) => (
              <article key={vendor.id} className="rounded-lg border border-slate-200 p-4">
                <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
                  <div>
                    <p className="font-semibold text-slate-950">{vendor.vendorName}</p>
                    <p className="mt-1 text-sm text-slate-600">
                      {vendor.shopName} · {vendor.email} · +91 {vendor.mobileNumber}
                    </p>
                    <p className="mt-1 text-xs font-semibold text-orange-700">
                      Status: Pending Approval · Registered{" "}
                      {vendor.createdAt ? new Date(vendor.createdAt).toLocaleString("en-IN") : "-"}
                    </p>
                  </div>
                  {actionButtons(vendor)}
                </div>
              </article>
            ))}
          </div>
        ) : (
          <div className="mt-4 rounded-lg border border-dashed border-slate-300 p-6 text-center">
            <Clock3 className="mx-auto h-8 w-8 text-slate-400" />
            <p className="mt-3 text-sm font-semibold text-slate-700">
              No pending approval requests.
            </p>
          </div>
        )}
        </section>
      ) : null}

      {!isRecordRoute && !routeVendorId && routePath !== "/super-admin/dashboard" ? (
        <section className="rounded-lg border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-lg font-bold text-slate-950">{pageTitle}</h2>
          <p className="mt-1 text-sm text-slate-500">
            Only real vendors created through registration are listed.
          </p>
          {vendorTable(visibleVendors)}
        </section>
      ) : null}

      {actionVendor ? (
        <div className="fixed inset-0 z-40 flex items-center justify-center bg-slate-950/40 px-4">
          <div className="w-full max-w-lg rounded-lg bg-white p-5 shadow-xl">
            <div className="flex items-start justify-between gap-3">
              <div>
                <h2 className="text-lg font-bold text-slate-950">
                  {actionMode === "reject"
                    ? "Reject Vendor"
                    : actionMode === "limits"
                      ? "Edit Limits"
                      : "Approve Vendor"}
                </h2>
                <p className="mt-1 text-sm text-slate-600">
                  {actionVendor.vendorName} · {actionVendor.shopName}
                </p>
              </div>
              <button
                type="button"
                className="rounded-md p-1 text-slate-500 hover:bg-slate-100"
                onClick={closeAction}
                aria-label="Close"
              >
                <X className="h-5 w-5" />
              </button>
            </div>

            {actionMode === "reject" ? (
              <form className="mt-5 space-y-4" onSubmit={submitReject}>
                <Field label="Rejection reason" hint="Optional">
                  <TextArea
                    value={rejectionReason}
                    onChange={(event) => setRejectionReason(event.target.value)}
                    placeholder="Reason for rejection"
                  />
                </Field>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button type="submit" variant="danger" disabled={saving}>
                    Reject
                  </Button>
                  <Button variant="secondary" onClick={closeAction}>
                    Cancel
                  </Button>
                </div>
              </form>
            ) : (
              <form
                className="mt-5 space-y-4"
                onSubmit={actionMode === "limits" ? submitLimits : submitApprove}
              >
                <div className="grid gap-4 sm:grid-cols-2">
                  <Field label="Customer limit">
                    <Input
                      type="number"
                      min="1"
                      value={customerLimit}
                      onChange={(event) => setCustomerLimit(event.target.value)}
                      required
                    />
                  </Field>
                  <Field label="Product limit">
                    <Input
                      type="number"
                      min="1"
                      value={productLimit}
                      onChange={(event) => setProductLimit(event.target.value)}
                      required
                    />
                  </Field>
                </div>
                <div className="grid gap-3 sm:grid-cols-2">
                  <Button type="submit" disabled={saving}>
                    {actionMode === "limits" ? "Save Limits" : "Approve Vendor"}
                  </Button>
                  <Button variant="secondary" onClick={closeAction}>
                    Cancel
                  </Button>
                </div>
              </form>
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function SuperAdminApp({ path, navigate }) {
  const [token, setToken] = useStoredToken(ADMIN_TOKEN_KEY);
  const [admin, setAdmin] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [booting, setBooting] = useState(Boolean(token));
  const [toasts, setToasts] = useState([]);

  const notify = (message, type = "success") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((items) => [...items, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 4200);
  };

  const dismissToast = (id) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  };

  const loadAdminDashboard = async (authToken = token) => {
    const response = await apiRequest("/api/super-admin/dashboard", { token: authToken });
    setDashboard(response);
  };

  useEffect(() => {
    if (!token) {
      setBooting(false);
      return;
    }

    let active = true;
    Promise.all([
      apiRequest("/api/super-admin/me", { token }),
      apiRequest("/api/super-admin/dashboard", { token }),
    ])
      .then(([meResponse, dashboardResponse]) => {
        if (!active) return;
        setAdmin(meResponse.admin);
        setDashboard(dashboardResponse);
      })
      .catch(() => {
        if (!active) return;
        setToken("");
        setAdmin(null);
        setDashboard(null);
      })
      .finally(() => {
        if (active) setBooting(false);
      });

    return () => {
      active = false;
    };
  }, [setToken, token]);

  const login = async (response) => {
    setToken(response.token);
    setAdmin(response.admin);
    await loadAdminDashboard(response.token);
    navigate("/super-admin/dashboard");
  };

  const logout = () => {
    apiRequest("/api/super-admin/logout", { method: "POST", token }).catch(() => {});
    setToken("");
    setAdmin(null);
    setDashboard(null);
    navigate("/super-admin/login");
    notify("Logout successful.");
  };

  const adminRoute = path === "/super-admin" ? "/super-admin/login" : path;

  let page;
  if (booting) {
    page = (
      <section className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
        <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-brandPrimary border-t-transparent" />
        <p className="mt-4 text-sm font-semibold text-slate-600">Loading admin session...</p>
      </section>
    );
  } else if (token && admin) {
    page = (
      <SuperAdminDashboard
        admin={admin}
        dashboard={dashboard}
        token={token}
        routePath={adminRoute === "/super-admin/login" ? "/super-admin/dashboard" : adminRoute}
        onLogout={logout}
        onRefresh={() => loadAdminDashboard(token)}
        onNavigate={navigate}
        notify={notify}
      />
    );
  } else {
    page = <SuperAdminLoginPage onLogin={login} notify={notify} />;
  }

  return (
    <>
      <Shell>{page}</Shell>
      <ToastStack toasts={toasts} dismissToast={dismissToast} />
    </>
  );
}

function vendorPathToScreen(path) {
  if (path === "/") return "landing";
  if (path === "/vendor/register") return "register";
  if (path === "/vendor/login") return "login";
  if (path === "/vendor/forgot-password") return "forgot-password";
  if (path === "/vendor/reset-password") return "reset-password";
  if (path === "/vendor/dashboard") return "dashboard";
  if (path === "/vendor/approval-pending") return "approval-pending";
  if (path === "/vendor/profile") return "profile";
  if (path.startsWith("/vendor/customers")) return "customers";
  if (path.startsWith("/vendor/products")) return "products";
  if (path === "/vendor/supply" || path.startsWith("/vendor/daily-supply")) return "daily-supply";
  if (path.startsWith("/vendor/send-customer-bills")) return "send-customer-bills";
  if (path.startsWith("/vendor/reports")) return "reports";
  return "landing";
}

function VendorApp({ path, navigate }) {
  const [screen, setScreen] = useState(() => vendorPathToScreen(path));
  const [token, setToken] = useStoredToken();
  const [vendor, setVendor] = useState(null);
  const [dashboard, setDashboard] = useState(null);
  const [prefillEmail, setPrefillEmail] = useState("");
  const [toasts, setToasts] = useState([]);
  const [booting, setBooting] = useState(Boolean(token));
  const [showBackLogoutConfirm, setShowBackLogoutConfirm] = useState(false);
  const protectedPathRef = useRef(path);
  const backLogoutOpenRef = useRef(false);
  const skipBackGuardRef = useRef(false);

  useEffect(() => {
    setScreen(vendorPathToScreen(path));
  }, [path]);

  useEffect(() => {
    if (PROTECTED_VENDOR_SCREENS.has(screen)) {
      protectedPathRef.current = path;
    }
  }, [path, screen]);

  useEffect(() => {
    backLogoutOpenRef.current = showBackLogoutConfirm;
  }, [showBackLogoutConfirm]);

  useEffect(() => {
    if (!token || !vendor || !PROTECTED_VENDOR_SCREENS.has(screen)) return undefined;

    protectedPathRef.current = path;
    window.history.pushState({ vendorBackGuard: true }, "", path);

    const handleProtectedBack = (event) => {
      if (skipBackGuardRef.current) return;
      if (!PROTECTED_VENDOR_SCREENS.has(vendorPathToScreen(protectedPathRef.current))) return;

      event.preventDefault?.();
      event.stopImmediatePropagation?.();
      window.history.pushState({ vendorBackGuard: true }, "", protectedPathRef.current);
      if (!backLogoutOpenRef.current) {
        setShowBackLogoutConfirm(true);
      }
    };

    window.addEventListener("popstate", handleProtectedBack, true);
    return () => window.removeEventListener("popstate", handleProtectedBack, true);
  }, [path, screen, token, vendor]);

  const notify = (message, type = "success") => {
    const id = `${Date.now()}-${Math.random()}`;
    setToasts((items) => [...items, { id, message, type }]);
    window.setTimeout(() => {
      setToasts((items) => items.filter((item) => item.id !== id));
    }, 4200);
  };

  const dismissToast = (id) => {
    setToasts((items) => items.filter((item) => item.id !== id));
  };

  const loadDashboard = async (authToken = token) => {
    const response = await apiRequest("/api/vendor/dashboard", { token: authToken });
    setDashboard(response);
  };

  const refreshVendorSession = async (authToken = token) => {
    const [meResponse, dashboardResponse] = await Promise.all([
      apiRequest("/api/vendor/me", { token: authToken }),
      apiRequest("/api/vendor/dashboard", { token: authToken }),
    ]);
    setVendor(meResponse.vendor);
    setDashboard(dashboardResponse);
  };

  useEffect(() => {
    if (!token) {
      setBooting(false);
      return;
    }

    let active = true;
    Promise.all([
      apiRequest("/api/vendor/me", { token }),
      apiRequest("/api/vendor/dashboard", { token }),
    ])
      .then(([meResponse, dashboardResponse]) => {
        if (!active) return;
        setVendor(meResponse.vendor);
        setDashboard(dashboardResponse);
        setScreen(vendorPathToScreen(path));
        if (path === "/vendor/login" || path === "/") {
          navigate("/vendor/dashboard");
        }
      })
      .catch(() => {
        if (!active) return;
        setToken("");
        setVendor(null);
        setDashboard(null);
      })
      .finally(() => {
        if (active) setBooting(false);
      });

    return () => {
      active = false;
    };
  }, [navigate, path, setToken, token]);

  const login = async (response) => {
    setToken(response.token);
    setVendor(response.vendor);
    await loadDashboard(response.token);
    navigate("/vendor/dashboard");
  };

  const logout = ({ redirectTo = "/", message = "Logout successful." } = {}) => {
    apiRequest("/api/vendor/logout", { method: "POST", token }).catch(() => {});
    setToken("");
    setVendor(null);
    setDashboard(null);
    navigate(redirectTo);
    notify(message);
  };

  const confirmBackLogout = () => {
    skipBackGuardRef.current = true;
    setShowBackLogoutConfirm(false);
    logout({ redirectTo: "/vendor/login", message: "Logged out successfully." });
    window.setTimeout(() => {
      skipBackGuardRef.current = false;
    }, 0);
  };

  const cancelBackLogout = () => {
    setShowBackLogoutConfirm(false);
    window.history.pushState({ vendorBackGuard: true }, "", protectedPathRef.current || path);
  };

  const onRegistered = (email) => {
    setPrefillEmail(email);
    navigate("/vendor/approval-pending");
  };

  const page = (() => {
    if (booting) {
      return (
        <section className="mx-auto max-w-xl rounded-lg border border-slate-200 bg-white p-6 text-center shadow-sm">
          <div className="mx-auto h-8 w-8 animate-spin rounded-full border-2 border-brandPrimary border-t-transparent" />
          <p className="mt-4 text-sm font-semibold text-slate-600">Loading secure session...</p>
        </section>
      );
    }

    if (screen === "register") {
      return (
        <RegistrationPage
          onBack={() => navigate("/")}
          onRegistered={onRegistered}
          notify={notify}
        />
      );
    }

    if (screen === "login") {
      return (
        <LoginPage
          onBack={() => navigate("/")}
          onLogin={login}
          onPendingApproval={(email) => {
            setPrefillEmail(email);
            navigate("/vendor/approval-pending");
          }}
          onForgotPassword={() => navigate("/vendor/forgot-password")}
          prefillEmail={prefillEmail}
          notify={notify}
        />
      );
    }

    if (screen === "forgot-password") {
      return (
        <ForgotPasswordPage
          onBack={() => navigate("/vendor/login")}
          notify={notify}
        />
      );
    }

    if (screen === "reset-password") {
      return (
        <ResetPasswordPage
          onBack={() => navigate("/vendor/login")}
          notify={notify}
        />
      );
    }

    if (screen === "dashboard") {
      if (!token || !vendor) {
        return (
          <LoginPage
            onBack={() => navigate("/")}
            onLogin={login}
            onPendingApproval={(email) => {
              setPrefillEmail(email);
              navigate("/vendor/approval-pending");
            }}
            onForgotPassword={() => navigate("/vendor/forgot-password")}
            prefillEmail={prefillEmail}
            notify={notify}
          />
        );
      }
      return (
        <DashboardPage
          vendor={vendor}
          dashboard={dashboard}
          onLogout={logout}
          onNavigate={navigate}
        />
      );
    }

    if (screen === "approval-pending") {
      return (
        <ApprovalPendingPage
          email={prefillEmail}
          onLogin={() => navigate("/vendor/login")}
        />
      );
    }

    if (["profile", "customers", "products", "daily-supply", "send-customer-bills", "reports"].includes(screen)) {
      if (!token || !vendor) {
        return (
          <LoginPage
            onBack={() => navigate("/")}
            onLogin={login}
            onPendingApproval={(email) => {
              setPrefillEmail(email);
              navigate("/vendor/approval-pending");
            }}
            onForgotPassword={() => navigate("/vendor/forgot-password")}
            prefillEmail={prefillEmail}
            notify={notify}
          />
        );
      }
      if (screen === "profile") {
        return (
          <VendorProfilePage
            token={token}
            vendor={vendor}
            onNavigate={navigate}
            onRefresh={() => refreshVendorSession(token)}
            notify={notify}
          />
        );
      }
      if (screen === "customers") {
        return (
          <VendorCustomersPage
            token={token}
            vendor={vendor}
            path={path}
            onNavigate={navigate}
            onRefresh={() => refreshVendorSession(token)}
            notify={notify}
          />
        );
      }
      if (screen === "products") {
        return (
          <VendorProductsPage
            token={token}
            vendor={vendor}
            path={path}
            onNavigate={navigate}
            onRefresh={() => refreshVendorSession(token)}
            notify={notify}
          />
        );
      }
      if (screen === "daily-supply") {
        return (
          <VendorDailySupplyPage
            token={token}
            onNavigate={navigate}
            notify={notify}
          />
        );
      }
      if (screen === "send-customer-bills") {
        return (
          <VendorSendCustomerBillsPage
            token={token}
            vendor={vendor}
            onNavigate={navigate}
            notify={notify}
          />
        );
      }
      if (screen === "reports") {
        return (
          <VendorReportsPage
            token={token}
            path={path}
            onNavigate={navigate}
            notify={notify}
          />
        );
      }
    }

    return (
      <LandingPage
        onRegister={() => navigate("/vendor/register")}
        onLogin={() => navigate("/vendor/login")}
      />
    );
  })();

  return (
    <>
      <Shell>{page}</Shell>
      {showBackLogoutConfirm ? (
        <LogoutConfirmationModal onConfirm={confirmBackLogout} onCancel={cancelBackLogout} />
      ) : null}
      <ToastStack toasts={toasts} dismissToast={dismissToast} />
    </>
  );
}

export default function App() {
  const [path, navigate] = useAppPath();
  if (path.startsWith("/super-admin")) {
    return <SuperAdminApp path={path} navigate={navigate} />;
  }
  return <VendorApp path={path} navigate={navigate} />;
}
