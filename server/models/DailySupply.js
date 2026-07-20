import mongoose from "mongoose";

const dailySupplySchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    vendorId: { type: String, required: true, index: true },
    customerId: { type: String, required: true, index: true },
    productId: { type: String, required: true, index: true },
    date: { type: String, required: true, index: true },
    quantity: { type: Number, required: true },
    unit: { type: String, required: true },
    rate: { type: Number, required: true },
    amount: { type: Number, required: true },
    status: {
      type: String,
      enum: ["Supplied", "Not Supplied", "Extra Supply"],
      default: "Supplied",
    },
    notes: { type: String, default: "" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

dailySupplySchema.index({ vendorId: 1, customerId: 1, productId: 1, date: 1 });

export default mongoose.models.DailySupply ||
  mongoose.model("DailySupply", dailySupplySchema);
