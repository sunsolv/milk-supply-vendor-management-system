# Google Apps Script migration status

## Preserved frontend modules

Vendor registration/OTP, vendor login, password reset, dashboard, profile, customers, products, daily supply, reports, saved reports, Send Customer Bills, WhatsApp links, PDF/Excel exports, Super Admin login, approval, rejection, status, limits, customer/product administration, and report administration remain routed through the existing React screens.

`src/api.js` is the migration boundary. When `VITE_APPS_SCRIPT_API_URL` is configured, it translates the existing REST-like calls to Apps Script actions and unwraps the standard response envelope. Without that environment variable, the legacy Express API remains available as a rollback path during migration.

## Cutover sequence

1. Import `artifacts/Milk_Supply_Vendor_Master.xlsx` into Google Drive as a native Google Spreadsheet, or let `setupMasterSpreadsheet()` create it.
2. Create the Apps Script project and deploy the backend using `google-apps-script/README.md`.
3. Run `setupMasterSpreadsheet()`.
4. Set `VITE_APPS_SCRIPT_API_URL` in the frontend hosting environment.
5. Build and deploy the frontend.
6. Complete the functional checklist below in a non-production test vendor account.
7. Export MongoDB records and transform/import them only after field-level reconciliation. Do not point real users to Apps Script until the import is verified.
8. Keep the Render service available during a short rollback window, then remove its secrets and stop it after acceptance.

## Data migration note

The repository does not contain the live MongoDB dataset, so no vendor/customer/product/supply/report records are copied automatically. This prevents accidental production-data transfer. A separate authenticated export/import run is required, with backups and record-count reconciliation.

## Acceptance checklist

- [ ] Setup creates all nine master tabs and stores master/folder IDs.
- [ ] Default/overridden Super Admin exists with a hash only.
- [ ] Registration validation and show-password controls work.
- [ ] MailApp sends OTP; response does not expose OTP.
- [ ] OTP expiry, attempt limit, cooldown, and one-time use work.
- [ ] Verification creates a Pending Approval vendor.
- [ ] Pending/Inactive/Rejected vendors cannot open the dashboard.
- [ ] Super Admin approves with customer and product limits.
- [ ] Approved vendor login and dashboard work with real data only.
- [ ] Vendor profile/payment fields update.
- [ ] Customer CRUD/status/limit rules and admin-only delete work.
- [ ] Product CRUD/status/limit rules and admin-only delete work.
- [ ] Daily supply batch save creates one row per selected active customer.
- [ ] Duplicate key writes update the existing monthly row.
- [ ] Not Supplied forces quantity and amount to zero.
- [ ] Reports read only intersecting monthly files and selected customers.
- [ ] Saved reports, PDF, and Excel exports work.
- [ ] Customer bill preview and manual WhatsApp link use current payment details.
- [ ] Back-button logout confirmation and protected routing remain intact.
- [ ] Audit logs capture sensitive business actions without secrets.
- [ ] Vendor and Super Admin theme uses the requested blue palette.
