import mongoose from "mongoose";

const vendorSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    vendorName: { type: String, required: true, trim: true },
    shopName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    mobileNumber: { type: String, required: true, unique: true, trim: true },
    passwordHash: { type: String, required: true },
    emailVerified: { type: Boolean, default: true },
    status: {
      type: String,
      enum: ["Pending Approval", "Active", "Inactive", "Rejected"],
      default: "Pending Approval",
    },
    customerLimit: { type: Number, default: 0 },
    productLimit: { type: Number, default: 0 },
    currentCustomerCount: { type: Number, default: 0 },
    currentProductCount: { type: Number, default: 0 },
    approvedBy: { type: String, default: "" },
    approvedAt: { type: Date },
    rejectedAt: { type: Date },
    rejectionReason: { type: String, default: "" },
    phonePeGPayNumber: { type: String, default: "" },
    upiId: { type: String, default: "" },
    shopAddress: { type: String, default: "" },
    shopLocation: { type: String, default: "" },
    fssaiNumber: { type: String, default: "" },
    resetPasswordTokenHash: { type: String, default: "" },
    resetPasswordExpiresAt: { type: Date },
  },
  { timestamps: true },
);

export default mongoose.models.Vendor || mongoose.model("Vendor", vendorSchema);
