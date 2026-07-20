import mongoose from "mongoose";

const reportSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    vendorId: { type: String, required: true, index: true },
    customerId: { type: String, default: "", index: true },
    reportType: { type: String, enum: ["Consolidated", "Individual"], required: true },
    month: { type: Number, required: true },
    year: { type: Number, required: true },
    reportData: { type: mongoose.Schema.Types.Mixed, required: true },
    totalAmount: { type: Number, default: 0 },
    paymentStatus: {
      type: String,
      enum: ["Paid", "Unpaid", "Partially Paid"],
      default: "Unpaid",
    },
    paidAmount: { type: Number, default: 0 },
    balanceAmount: { type: Number, default: 0 },
    paymentDate: { type: String, default: "" },
    paymentMode: { type: String, default: "" },
  },
  { timestamps: true },
);

export default mongoose.models.Report || mongoose.model("Report", reportSchema);
