require('dotenv').config();
const express = require('express');
const bodyParser = require('body-parser');
const session = require('express-session');
const bcrypt = require('bcrypt');
const { google } = require('googleapis');
const Stripe = require('stripe');
const cors = require('cors');
const multer = require('multer');
const path = require('path');
const Mailjet = require('node-mailjet');

const app = express();
const PORT = process.env.PORT || 5000;

// ==================== ✅ CORS CONFIG ====================
app.use(cors({
  origin: ['https://fundasmile.net', 'https://www.fundasmile.net'], // your frontends
  credentials: true,
}));

app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

// ==================== ✅ SESSION ====================
app.use(session({
  secret: process.env.SESSION_SECRET || 'joyfundsecret',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 1000*60*60*24 } // 1 day
}));

// ==================== ✅ MAILJET ====================
const mj = Mailjet.apiConnect(
  process.env.MJ_APIKEY_PUBLIC,
  process.env.MJ_APIKEY_PRIVATE
);

// ==================== ✅ STRIPE ====================
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);

// ==================== ✅ MULTER ====================
const storage = multer.diskStorage({
  destination: function(req, file, cb){ cb(null, 'uploads/'); },
  filename: function(req, file, cb){ cb(null, Date.now() + '-' + file.originalname); }
});
const upload = multer({ storage });

// ==================== ✅ MOCK DATABASE ====================
let users = []; // { email, passwordHash, name, verified }
let campaigns = []; // { campaignId, title, description, imageUrl, goal, status, createdAt, category }
let waitlist = []; // { name, email, source, reason }
let donations = []; // { email, campaignId, amount }

// ==================== ✅ ROUTES ====================

// ----------- Sign Up -----------
app.post('/api/signup', async (req, res) => {
  const { email, password, name } = req.body;
  if (!email || !password || !name) return res.status(400).json({ success:false, message:'Missing fields' });
  if(users.find(u=>u.email===email)) return res.status(400).json({ success:false, message:'User exists' });
  const passwordHash = await bcrypt.hash(password, 10);
  users.push({ email, passwordHash, name, verified:false });
  req.session.user = { email, name };
  res.json({ success:true, message:'Signed up' });
});

// ----------- Sign In -----------
app.post('/api/signin', async (req,res)=>{
  const { email, password } = req.body;
  const user = users.find(u=>u.email===email);
  if(!user) return res.status(400).json({ success:false, message:'User not found' });
  const match = await bcrypt.compare(password, user.passwordHash);
  if(!match) return res.status(400).json({ success:false, message:'Incorrect password' });
  req.session.user = { email, name:user.name };
  res.json({ success:true });
});

// ----------- Check Session -----------
app.get('/api/check-session', (req,res)=>{
  res.json({ loggedIn: req.session.user ? true : false });
});

// ----------- Logout -----------
app.post('/api/logout', (req,res)=>{
  req.session.destroy(()=>res.json({ success:true }));
});

// ----------- Campaigns -----------
app.get('/api/campaigns', (req,res)=>{
  res.json({ success:true, campaigns });
});

app.post('/api/create-campaign', upload.single('image'), (req,res)=>{
  const user = req.session.user;
  if(!user) return res.status(401).json({ success:false, message:'Not signed in' });
  const { title, description, goal, category } = req.body;
  const campaignId = 'c' + Date.now();
  let imageUrl = req.file ? '/uploads/' + req.file.filename : '';
  campaigns.push({ campaignId, title, description, imageUrl, goal, status:'approved', createdAt: new Date(), category });
  
  // Send email via Mailjet
  mj.post("send", {'version':'v3.1'})
    .request({
      Messages:[
        {
          From: { Email: process.env.MJ_SENDER_EMAIL, Name:"JoyFund INC." },
          To: [{ Email: user.email, Name: user.name }],
          Subject: "Campaign Created!",
          TextPart: `Your campaign "${title}" has been created successfully!`
        }
      ]
    }).then(()=>{}).catch(console.error);

  res.json({ success:true, message:'Campaign created', campaignId });
});

// ----------- Waitlist -----------
app.post('/api/waitlist', (req,res)=>{
  const { name,email,source,reason } = req.body;
  waitlist.push({ name,email,source,reason });
  res.json({ success:true });
});

app.post('/api/send-waitlist-email', (req,res)=>{
  const { name,email,source,reason } = req.body;
  mj.post("send", {'version':'v3.1'})
    .request({
      Messages:[
        {
          From: { Email: process.env.MJ_SENDER_EMAIL, Name:"JoyFund INC." },
          To: [{ Email: email, Name: name }],
          Subject: "Welcome to JoyFund Waitlist!",
          TextPart: `Hi ${name},\nThanks for joining our waitlist!`
        }
      ]
    }).then(()=>res.json({ success:true })).catch(err=>res.status(500).json({ success:false, err }));
});

// ----------- Donations -----------
app.post('/api/donations', (req,res)=>{
  const user = req.session.user;
  if(!user) return res.status(401).json({ success:false, message:'Sign in required' });
  const { campaignId, amount } = req.body;
  donations.push({ email:user.email, campaignId, amount });
  res.json({ success:true });
});

app.post('/api/create-checkout-session/:campaignId', async (req,res)=>{
  const { campaignId } = req.params;
  const { amount, successUrl, cancelUrl } = req.body;
  try {
    const session = await stripe.checkout.sessions.create({
      payment_method_types: ['card'],
      mode:'payment',
      line_items: [{ price_data:{ currency:'usd', product_data:{ name:'JoyFund Donation' }, unit_amount: Math.round(amount*100) }, quantity:1 }],
      success_url: successUrl,
      cancel_url: cancelUrl
    });
    res.json({ sessionId: session.id });
  } catch(err){ console.error(err); res.status(500).json({ success:false, message: err.message }); }
});

// ----------- ID Verification -----------
app.post('/api/verify-id', upload.single('idDocument'), (req,res)=>{
  const user = req.session.user;
  if(!user) return res.status(401).json({ success:false, message:'Sign in required' });
  if(!req.file) return res.status(400).json({ success:false, message:'No file uploaded' });

  // Send email notification
  mj.post("send", {'version':'v3.1'})
    .request({
      Messages:[
        {
          From:{ Email: process.env.MJ_SENDER_EMAIL, Name:"JoyFund INC." },
          To:[{ Email: user.email, Name: user.name }],
          Subject:"ID Verification Received",
          TextPart:`Hi ${user.name},\nYour ID has been received and is under review.`
        }
      ]
    }).then(()=>res.json({ success:true })).catch(err=>res.status(500).json({ success:false, err }));
});

// ==================== ✅ STATIC FILES ====================
app.use('/uploads', express.static(path.join(__dirname, 'uploads')));

// ==================== START SERVER ====================
app.listen(PORT, ()=>console.log(`JoyFund backend running on port ${PORT}`));
