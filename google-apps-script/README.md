# Google Apps Script backend

This folder replaces the Render/Express/MongoDB runtime with a standalone Google Apps Script Web App, Google Sheets, Google Drive monthly files, and `MailApp` email delivery. The existing React UI remains the client.

## Architecture

- `Code.gs` — `doGet`, `doPost`, JSON envelope, and action routing.
- `Config.gs` — schema, `setupMasterSpreadsheet()`, sheet helpers, settings cache, locks, and audit logs.
- `Security.gs` — salted iterative SHA-256 password hashes, token hashes, sessions, and role checks.
- `Auth.gs` — registration OTP, verification, vendor/admin login, logout, and password reset.
- `Data.gs` — vendor profile, customer, and product actions with ownership and limit enforcement.
- `SupplyReports.gs` — month-wise daily supply files, duplicate-safe batch upsert, reports, saved reports, dashboard, and customer bills.
- `Admin.gs` — Super Admin dashboard, vendor approval/rejection, status, and limits.

## First deployment

1. Create a standalone project at <https://script.google.com/>.
2. Add each `.gs` file from this directory and replace the default manifest with `appsscript.json`.
3. In **Project Settings → Script Properties**, add:
   - `MASTER_SPREADSHEET_ID`: ID of the imported master Google Spreadsheet. You may omit this to let setup create a new master file.
   - `DEFAULT_ADMIN_EMAIL`: production Super Admin email.
   - `DEFAULT_ADMIN_PASSWORD`: one-time initial password. Remove this property after setup and change the account password before real use.
   - `FRONTEND_URL`: deployed frontend origin, without a trailing slash.
4. Run `setupMasterSpreadsheet()` once from the editor and approve the requested Sheets, Drive, and email permissions.
5. Confirm the function returns the master spreadsheet URL and daily-supply folder ID.
6. Deploy → **New deployment** → **Web app**:
   - Execute as: **Me**
   - Who has access: **Anyone** (the API enforces its own hashed sessions and roles)
7. Copy the `/exec` Web App URL into the frontend build environment as `VITE_APPS_SCRIPT_API_URL`.
8. Rebuild and redeploy the frontend.

Use a new deployment version after changing Apps Script code. Do not expose the `/dev` test URL to the frontend.

## Initial Super Admin

If Script Properties are not overridden, setup creates:

- Email: `admin@milkapp.com`
- Initial password: `Admin@123`

Only a salted hash is written to `SuperAdmins`. These public defaults are bootstrap values, not suitable for ongoing business use. Override them before setup and rotate the password immediately.

## Master tabs

`SuperAdmins`, `Vendors`, `Customers`, `Products`, `OTP`, `Sessions`, `ReportsIndex`, `AuditLogs`, and `Settings` are created idempotently with the required headers.

## Monthly daily supply files

The first write for a month creates `DailySupply_YYYY_MM` inside `MilkSupply_DailySupply_Data`. A single `DailySupply` tab stores that month only. Writes hold a script lock and upsert on:

`vendorId + customerId + productId + date`

Reports calculate the months intersecting the requested date range and read only those files.

## API request

All calls use one Web App URL:

```json
{
  "action": "saveDailySupply",
  "payload": {
    "token": "session-token",
    "date": "2026-06-24",
    "customerIds": ["customer-id"],
    "productId": "product-id",
    "quantity": 1.5,
    "status": "Supplied",
    "notes": ""
  }
}
```

The frontend sends this as `text/plain;charset=utf-8` to avoid a CORS preflight that Apps Script Web Apps cannot answer with custom headers. Tokens remain inside the JSON payload and are stored only as hashes in Sheets.

## Operational safety

- Protect the master spreadsheet and monthly folder from direct vendor access.
- Keep the Apps Script project and master spreadsheet owned by a dedicated Workspace account.
- Review `AuditLogs` and remove expired `OTP`/`Sessions` rows on a schedule.
- Monitor Apps Script, MailApp, Sheets, and Drive quotas for the actual Workspace edition.
- Back up the master spreadsheet and monthly folder regularly.
- For concurrent growth beyond Apps Script/Sheets quotas, plan a managed database migration rather than increasing sheet scans indefinitely.
