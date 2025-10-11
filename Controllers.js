const nodemailer = require('nodemailer');

exports.sendVerificationEmail = async (req, res) => {
  const { email } = req.body;

  if (!email) return res.status(400).json({ message: 'Email is required.' });

  try {
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASS,
      },
    });

    await transporter.sendMail({
      from: `"FunDMe" <${process.env.EMAIL_USER}>`,
      to: email,
      subject: 'Verify Your Email',
      text: 'Click here to verify your email: https://your-fundme.com/verify',
    });

    res.status(200).json({ message: 'Verification email sent!' });
  } catch (error) {
    res.status(500).json({ message: 'Email failed to send.' });
  }
};
