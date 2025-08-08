il || !reason) {
    return res.status(400).json({ error: 'All fields are required.' });
  }

  // Check if email is already on the waitlist
  const exists = waitlist.find(item => item.email.toLowerCase() === email.toLowerCase());
  if (exists) {
    return res.status(400).json({ error: 'Email already on waitlist.' });
  }

  // Prepare email message
  const msg = {
    to: process.env.NOTIFY_EMAIL,
    from: process.env.VERIFIED_SENDER,
    subject: 'New Waitlist Signup',
    text: `New waitlist signup:\n\nName: ${name}\nEmail: ${email}\nReason: ${reason}`,
    html: `<p>New waitlist signup:</p>
           <ul>
             <li><strong>Name:</strong> ${name}</li>
             <li><strong>Email:</strong> ${email}</li>
             <li><strong>Reason:</strong> ${reason}</li>
           </ul>`,
  };

  try {
