import nodemailer from 'nodemailer';

const transporter = nodemailer.createTransport({
  host: "in-v3.mailjet.com",
  port: 587,
  auth: {
    user: process.env.MJ_APIKEY_PUBLIC,
    pass: process.env.MJ_APIKEY_PRIVATE
  }
});

export const sendEmail = async ({ to, subject, html }) => {
  try {
    const info = await transporter.sendMail({
      from: process.env.EMAIL_FROM,
      to,
      subject,
      html
    });
    console.log("Email sent:", info.messageId);
    return true;
  } catch (err) {
    console.error("Email error:", err);
    return false;
  }
};
