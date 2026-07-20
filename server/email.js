import nodemailer from "nodemailer";

function getSmtpConfig() {
  const required = ["SMTP_HOST", "SMTP_PORT", "SMTP_USER", "SMTP_PASS", "EMAIL_FROM"];
  const missing = required.filter((key) => !process.env[key]);

  if (missing.length) {
    const error = new Error(
      `Email service is not configured. Missing: ${missing.join(", ")}.`,
    );
    error.code = "EMAIL_CONFIG_MISSING";
    throw error;
  }

  const port = Number(process.env.SMTP_PORT);
  return {
    host: process.env.SMTP_HOST,
    port,
    secure: port === 465,
    connectionTimeout: 10_000,
    greetingTimeout: 10_000,
    socketTimeout: 15_000,
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  };
}

export async function sendRegistrationOtpEmail({ to, vendorName, otp }) {
  const transporter = nodemailer.createTransport(getSmtpConfig());

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: "Your Milk Vendor Registration OTP",
    text: `Dear ${vendorName},

Your OTP for Milk Supply Vendor registration is:

${otp}

This OTP is valid for 5 minutes.

Please do not share this OTP with anyone.

Thank you,
Milk Supply Vendor Management System`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <p>Dear ${vendorName},</p>
        <p>Your OTP for Milk Supply Vendor registration is:</p>
        <p style="font-size: 28px; font-weight: 700; letter-spacing: 6px;">${otp}</p>
        <p>This OTP is valid for 5 minutes.</p>
        <p>Please do not share this OTP with anyone.</p>
        <p>Thank you,<br/>Milk Supply Vendor Management System</p>
      </div>
    `,
  });
}

export async function sendPasswordResetEmail({ to, vendorName, resetLink }) {
  const transporter = nodemailer.createTransport(getSmtpConfig());

  await transporter.sendMail({
    from: process.env.EMAIL_FROM,
    to,
    subject: "Reset your Milk Vendor account password",
    text: `Dear ${vendorName},

We received a request to reset your Milk Supply Vendor account password.

Open this secure link to set a new password:
${resetLink}

This link is valid for 30 minutes. If you did not request this, please ignore this email.

Thank you,
Milk Supply Vendor Management System`,
    html: `
      <div style="font-family: Arial, sans-serif; color: #0f172a; line-height: 1.6;">
        <p>Dear ${vendorName},</p>
        <p>We received a request to reset your Milk Supply Vendor account password.</p>
        <p>
          <a href="${resetLink}" style="display: inline-block; background: #059669; color: #ffffff; padding: 10px 14px; border-radius: 8px; text-decoration: none; font-weight: 700;">
            Reset Password
          </a>
        </p>
        <p>This link is valid for 30 minutes. If you did not request this, please ignore this email.</p>
        <p>Thank you,<br/>Milk Supply Vendor Management System</p>
      </div>
    `,
  });
}
