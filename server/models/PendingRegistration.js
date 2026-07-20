import mongoose from "mongoose";

const pendingRegistrationSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    vendorName: { type: String, required: true, trim: true },
    shopName: { type: String, required: true, trim: true },
    email: { type: String, required: true, unique: true, lowercase: true, trim: true },
    mobileNumber: { type: String, required: true, trim: true },
    passwordHash: { type: String, required: true },
    otpHash: { type: String, required: true },
    otpExpiresAt: { type: Date, required: true },
    otpUsed: { type: Boolean, default: false },
    otpAttempts: { type: Number, default: 0 },
    lastOtpSentAt: { type: Date, required: true },
  },
  { timestamps: true },
);

export default mongoose.models.PendingRegistration ||
  mongoose.model("PendingRegistration", pendingRegistrationSchema);
