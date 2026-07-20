import mongoose from "mongoose";

const productSchema = new mongoose.Schema(
  {
    id: { type: String, required: true, unique: true, index: true },
    vendorId: { type: String, required: true, index: true },
    name: { type: String, required: true, trim: true },
    description: { type: String, required: true, trim: true },
    unit: { type: String, required: true, trim: true },
    quantity: { type: Number, required: true, min: 0, default: 0 },
    hsnCode: { type: String, default: "", trim: true },
    pricePerUnit: { type: Number, required: true },
    status: { type: String, enum: ["Active", "Inactive"], default: "Active" },
    createdBy: { type: String, default: "" },
    updatedBy: { type: String, default: "" },
  },
  { timestamps: true },
);

export default mongoose.models.Product || mongoose.model("Product", productSchema);
