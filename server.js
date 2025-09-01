require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ"
};

// ===== Zoho SMTP Setup =====
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,      // e.g., admin@fundasmile.net
    pass: process.env.ZOHO_APP_PASSWORD
  }
});

// ===== Helper: Save to Sheet =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
    console.log(`Saved to ${sheetName} sheet successfully.`);
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

// ===== Helper: Send Email =====
async function sendConfirmationEmail(to, subject, text) {
  try {
    await transporter.sendMail({
      from: `"JoyFund INC." <${process.env.ZOHO_USER}>`,
      to,
      subject,
      text
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Error sending email to ${to}:`, err.message);
    throw err;
  }
}

// ===== Routes =====

// Volunteer
app.post("/submit-volunteer", async (req, res) => {
  console.log("Volunteer submission received:", req.body);
  const { name, email, city, message } = req.body;

  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      name, email, city, message, new Date().toISOString()
    ]);

    // Email to applicant
    await sendConfirmationEmail(
      email,
      "Thank you for applying as a JoyFund Volunteer!",
      `Hi ${name},\n\nThank you for your interest in volunteering with JoyFund INC. Your application has been received and our team will review it.\nA team member will contact you with next steps.\n\n- JoyFund INC. Team`
    );

    // Email to admin
    await sendConfirmationEmail(
      process.env.ZOHO_USER,
      `New Volunteer Application: ${name}`,
      `A new volunteer has applied:\n\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
    );

    res.json({ success: true, message: "Volunteer application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Street Team
app.post("/submit-streetteam", async (req, res) => {
  console.log("Street Team submission received:", req.body);
  const { name, email, city, message } = req.body;

  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [
      name, email, city, message, new Date().toISOString()
    ]);

    // Email to applicant
    await sendConfirmationEmail(
      email,
      "Thank you for joining the JoyFund Street Team!",
      `Hi ${name},\n\nThank you for joining the JoyFund INC. Street Team!\nYou can promote our mission and share information, but please remember: Street Team members are not official representatives of JoyFund INC.\n\n- JoyFund INC. Team`
    );

    // Email to admin
    await sendConfirmationEmail(
      process.env.ZOHO_USER,
      `New Street Team Application: ${name}`,
      `A new Street Team member has applied:\n\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
    );

    res.json({ success: true, message: "Street Team application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Waitlist
app.post("/api/waitlist", async (req, res) => {
  console.log("Waitlist submission received:", req.body);
  const { name, email, source, reason } = req.body;

  if (!name || !email || !reason) {
    return res.status(400).json({ success: false, message: "Name, email, and reason are required." });
  }

  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      name, email, source || "N/A", reason, new Date().toISOString()
    ]);

    // Email to applicant
    await sendConfirmationEmail(
      email,
      "Welcome to the JoyFund Waitlist!",
      `Hi ${name},\n\nThank you for joining the JoyFund waitlist!\nWe’re excited to keep you updated on our upcoming campaigns.\n\n- JoyFund INC. Team`
    );

    // Email to admin
    await sendConfirmationEmail(
      process.env.ZOHO_USER,require('dotenv').config();
const express = require("express");
const bodyParser = require("body-parser");
const cors = require("cors");
const nodemailer = require("nodemailer");
const { google } = require("googleapis");

const app = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ===== Google Sheets Setup =====
const SCOPES = ["https://www.googleapis.com/auth/spreadsheets"];
const auth = new google.auth.GoogleAuth({
  credentials: JSON.parse(process.env.GOOGLE_CREDENTIALS_JSON),
  scopes: SCOPES
});
const sheets = google.sheets({ version: "v4", auth });

// ===== Spreadsheet IDs =====
const SPREADSHEET_IDS = {
  volunteers: "1O_y1yDiYfO0RT8eGwBMtaiPWYYvSR8jIDIdZkZPlvNA",
  streetteam: "1dPz1LqQq6SKjZIwsgIpQJdQzdmlOV7YrOZJjHqC4Yg8",
  waitlist: "16EOGbmfGGsN2jOj4FVDBLgAVwcR2fKa-uK0PNVtFPPQ"
};

// ===== Zoho SMTP Setup =====
const transporter = nodemailer.createTransport({
  host: "smtp.zoho.com",
  port: 465,
  secure: true,
  auth: {
    user: process.env.ZOHO_USER,
    pass: process.env.ZOHO_APP_PASSWORD
  }
});

// ===== Helper: Save to Sheet =====
async function saveToSheet(sheetId, sheetName, values) {
  try {
    await sheets.spreadsheets.values.append({
      spreadsheetId: sheetId,
      range: `${sheetName}!A:Z`,
      valueInputOption: "RAW",
      requestBody: { values: [values] }
    });
    console.log(`Saved to ${sheetName} sheet successfully.`);
  } catch (err) {
    console.error(`Error saving to ${sheetName}:`, err.message);
    throw err;
  }
}

// ===== HTML Templates =====
function waitlistTemplate(name) {
  return `
  <!DOCTYPE html>
  <html><body style="font-family: Arial, sans-serif; background:#f7f9fc; margin:0; padding:0;">
    <table style="max-width:600px;margin:auto;background:#fff;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#4CAF50;padding:20px;text-align:center;color:#fff;">
        <h1>🎉 You're on the Waitlist!</h1></td></tr>
      <tr><td style="padding:30px;text-align:center;color:#333;">
        <p style="font-size:18px;">Hi ${name || "Friend"}!</p>
        <p>Thanks for signing up for our waitlist. You’re officially part of the movement 💚.</p>
        <p>We'll keep you updated and let you know the moment new opportunities are available.</p>
        <a href="https://fundasmile.net" style="background:#4CAF50;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Visit Our Site</a>
      </td></tr>
      <tr><td style="background:#f0f0f0;padding:15px;text-align:center;color:#666;">💌 FundASmile Team<br><a href="https://fundasmile.net" style="color:#4CAF50;">www.fundasmile.net</a></td></tr>
    </table>
  </body></html>`;
}

function volunteerTemplate(name) {
  return `
  <!DOCTYPE html>
  <html><body style="font-family: Arial, sans-serif; background:#f7f9fc; margin:0; padding:0;">
    <table style="max-width:600px;margin:auto;background:#fff;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#FF9800;padding:20px;text-align:center;color:#fff;">
        <h1>🙌 Welcome, Volunteer!</h1></td></tr>
      <tr><td style="padding:30px;text-align:center;color:#333;">
        <p style="font-size:18px;">Hi ${name || "Friend"}!</p>
        <p>Thank you for volunteering with us. Your time and energy will help bring more smiles to the world 🌍✨.</p>
        <p>We'll reach out soon with ways you can get involved. Together, we’re making a difference!</p>
        <a href="https://fundasmile.net" style="background:#FF9800;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Get Involved</a>
      </td></tr>
      <tr><td style="background:#f0f0f0;padding:15px;text-align:center;color:#666;">💌 FundASmile Team<br><a href="https://fundasmile.net" style="color:#FF9800;">www.fundasmile.net</a></td></tr>
    </table>
  </body></html>`;
}

function streetTeamTemplate(name) {
  return `
  <!DOCTYPE html>
  <html><body style="font-family: Arial, sans-serif; background:#f7f9fc; margin:0; padding:0;">
    <table style="max-width:600px;margin:auto;background:#fff;border-radius:8px;overflow:hidden;">
      <tr><td style="background:#673AB7;padding:20px;text-align:center;color:#fff;">
        <h1>🎤 You're on the Street Team!</h1></td></tr>
      <tr><td style="padding:30px;text-align:center;color:#333;">
        <p style="font-size:18px;">Hi ${name || "Friend"}!</p>
        <p>Welcome to the Street Team 🚀. You’re now part of our grassroots crew spreading joy everywhere!</p>
        <p>We'll send you updates and materials so you can help share our mission far and wide 💜.</p>
        <a href="https://fundasmile.net" style="background:#673AB7;color:#fff;padding:12px 24px;text-decoration:none;border-radius:6px;">Share the Joy</a>
      </td></tr>
      <tr><td style="background:#f0f0f0;padding:15px;text-align:center;color:#666;">💌 FundASmile Team<br><a href="https://fundasmile.net" style="color:#673AB7;">www.fundasmile.net</a></td></tr>
    </table>
  </body></html>`;
}

// ===== Helper: Send Email =====
async function sendConfirmationEmail({ to, subject, text, html }) {
  try {
    await transporter.sendMail({
      from: `"JoyFund INC." <${process.env.ZOHO_USER}>`,
      to,
      subject,
      text,
      html
    });
    console.log(`Email sent to ${to}`);
  } catch (err) {
    console.error(`Error sending email to ${to}:`, err.message);
    throw err;
  }
}

// ===== Routes =====

// Volunteer
app.post("/submit-volunteer", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.volunteers, "Volunteers", [
      name, email, city, message, new Date().toISOString()
    ]);
    // To applicant (HTML)
    await sendConfirmationEmail({
      to: email,
      subject: "Thank you for applying as a JoyFund Volunteer!",
      text: `Hi ${name}, Thank you for your interest in volunteering with JoyFund INC.`,
      html: volunteerTemplate(name)
    });
    // To admin (plain text)
    await sendConfirmationEmail({
      to: process.env.ZOHO_USER,
      subject: `New Volunteer Application: ${name}`,
      text: `A new volunteer has applied:\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
    });
    res.json({ success: true, message: "Volunteer application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Street Team
app.post("/submit-streetteam", async (req, res) => {
  const { name, email, city, message } = req.body;
  if (!name || !email || !city || !message) {
    return res.status(400).json({ success: false, error: "All fields are required." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.streetteam, "StreetTeam", [
      name, email, city, message, new Date().toISOString()
    ]);
    // To applicant (HTML)
    await sendConfirmationEmail({
      to: email,
      subject: "Thank you for joining the JoyFund Street Team!",
      text: `Hi ${name}, Thank you for joining the JoyFund INC. Street Team!`,
      html: streetTeamTemplate(name)
    });
    // To admin (plain text)
    await sendConfirmationEmail({
      to: process.env.ZOHO_USER,
      subject: `New Street Team Application: ${name}`,
      text: `A new Street Team member has applied:\nName: ${name}\nEmail: ${email}\nCity: ${city}\nMessage: ${message}`
    });
    res.json({ success: true, message: "Street Team application submitted successfully." });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// Waitlist
app.post("/api/waitlist", async (req, res) => {
  const { name, email, source, reason } = req.body;
  if (!name || !email || !reason) {
    return res.status(400).json({ success: false, message: "Name, email, and reason are required." });
  }
  try {
    await saveToSheet(SPREADSHEET_IDS.waitlist, "Waitlist", [
      name, email, source || "N/A", reason, new Date().toISOString()
    ]);
    // To applicant (HTML)
    await sendConfirmationEmail({
      to: email,
      subject: "Welcome to the JoyFund Waitlist!",
      text: `Hi ${name}, Thank you for joining the JoyFund waitlist!`,
      html: waitlistTemplate(name)
    });
    // To admin (plain text)
    await sendConfirmationEmail({
      to: process.env.ZOHO_USER,
      subject: `New Waitlist Sign-Up: ${name}`,
      text: `A new person joined the waitlist:\nName: ${name}\nEmail: ${email}\nSource: ${source || "N/A"}\nReason: ${reason}`
    });
    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));

      `New Waitlist Sign-Up: ${name}`,
      `A new person joined the waitlist:\n\nName: ${name}\nEmail: ${email}\nSource: ${source || "N/A"}\nReason: ${reason}`
    );

    res.json({ success: true, message: "Successfully joined the waitlist!" });
  } catch (err) {
    res.status(500).json({ success: false, message: err.message });
  }
});

// ===== Start Server =====
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
