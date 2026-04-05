const mongoose = require('mongoose');

let isConnected = false;

async function connectDB() {
  if (isConnected) return;
  const uri = process.env.MONGO_URI;
  if (!uri) { console.error('❌ MONGO_URI missing'); process.exit(1); }
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 15000 });
  isConnected = true;
  console.log('✅ MongoDB connected');
}

// ── SCHEMAS ───────────────────────────────────────────────────────────────────

// User
const UserSchema = new mongoose.Schema({
  tgId:       { type: String, required: true, unique: true },
  username:   { type: String, default: '' },
  firstName:  { type: String, default: '' },
  plan:       { type: String, enum: ['free', 'premium'], default: 'free' },
  banned:     { type: Boolean, default: false },
  joinedAt:   { type: String, default: () => new Date().toISOString() },
  // Usage tracking
  totalSites:     { type: Number, default: 0 },
  totalBandwidth: { type: Number, default: 0 }, // bytes served
});

// Site (one user can have multiple sites)
const SiteSchema = new mongoose.Schema({
  id:           { type: String, required: true, unique: true },
  userId:       { type: String, required: true, index: true },
  userName:     { type: String, default: '' },

  // Domain config
  subdomain:    { type: String, unique: true, sparse: true }, // e.g. "ritesh" → ritesh.koom.site
  customDomain: { type: String, unique: true, sparse: true }, // e.g. "mysite.com"
  activeUrl:    { type: String, default: '' }, // which URL is live

  // Site info
  siteName:     { type: String, default: 'My Website' },
  description:  { type: String, default: '' },
  status:       { type: String, enum: ['active', 'suspended', 'building', 'pending'], default: 'pending' },

  // Storage — files stored in Telegram channel
  files: [{
    path:        String,  // web path: "index.html", "css/style.css"
    tgFileId:    String,  // Telegram file_id
    tgFilePath:  String,  // Telegram file path (for direct URL)
    size:        Number,  // bytes
    contentType: String,
    uploadedAt:  String,
  }],

  totalSize:    { type: Number, default: 0 }, // total bytes across all files
  bandwidth:    { type: Number, default: 0 }, // total bytes served this month
  visits:       { type: Number, default: 0 },

  // Cloudflare DNS record
  cfRecordId:   { type: String, default: null },

  plan:         { type: String, enum: ['free', 'premium'], default: 'free' },
  createdAt:    { type: String, default: () => new Date().toISOString() },
  updatedAt:    { type: String, default: () => new Date().toISOString() },
  lastDeployAt: { type: String, default: null },
});

// Settings (key-value)
const SettingsSchema = new mongoose.Schema({
  key:   { type: String, required: true, unique: true },
  value: mongoose.Schema.Types.Mixed,
});

const User     = mongoose.model('User',     UserSchema);
const Site     = mongoose.model('Site',     SiteSchema);
const Settings = mongoose.model('Settings', SettingsSchema);

// ── DEFAULT SETTINGS ──────────────────────────────────────────────────────────
const DEFAULTS = {
  domain:               process.env.DOMAIN || 'koom.site',
  storageChatId:        process.env.STORAGE_CHAT_ID || '',
  // Free plan limits
  free_maxSites:        1,
  free_maxSizeMB:       5,
  free_maxBandwidthMB:  500,
  // Premium plan limits
  premium_maxSites:     5,
  premium_maxSizeMB:    50,
  premium_maxBandwidthMB: 10000,
  // Bot settings
  maintenanceMode:      false,
  welcomeMsg:           '🌐 Telegram se apni website host karo — bilkul free!',
  premiumPrice:         '₹99/month',
};

async function initSettings() {
  for (const [key, value] of Object.entries(DEFAULTS)) {
    await Settings.findOneAndUpdate({ key }, { $setOnInsert: { key, value } }, { upsert: true });
  }
}

// ── USER helpers ──────────────────────────────────────────────────────────────
const getUser    = (tgId) => User.findOne({ tgId: String(tgId) }).lean();
const getAllUsers = ()     => User.find().lean();
const upsertUser = (tgId, data) => User.findOneAndUpdate(
  { tgId: String(tgId) },
  { $set: { tgId: String(tgId), ...data } },
  { upsert: true, new: true }
).lean();

// ── SITE helpers ──────────────────────────────────────────────────────────────
const getSiteById       = (id)        => Site.findOne({ id }).lean();
const getSiteBySubdomain= (sub)       => Site.findOne({ subdomain: sub }).lean();
const getSiteByDomain   = (domain)    => Site.findOne({ customDomain: domain }).lean();
const getUserSites      = (userId)    => Site.find({ userId: String(userId) }).lean();
const getAllSites        = (filter={}) => Site.find(filter).sort({ createdAt: -1 }).lean();
const createSite        = (data)      => new Site(data).save();
const updateSite        = (id, data)  => Site.findOneAndUpdate(
  { id }, { $set: { ...data, updatedAt: new Date().toISOString() } }, { new: true }
);
const deleteSite        = (id)        => Site.deleteOne({ id });

// ── SETTINGS helpers ──────────────────────────────────────────────────────────
const getSetting  = async (key) => { const d = await Settings.findOne({ key }).lean(); return d?.value ?? DEFAULTS[key]; };
const setSetting  = (key, value) => Settings.findOneAndUpdate({ key }, { key, value }, { upsert: true, new: true });

module.exports = {
  connectDB, initSettings,
  getUser, getAllUsers, upsertUser,
  getSiteById, getSiteBySubdomain, getSiteByDomain, getUserSites, getAllSites,
  createSite, updateSite, deleteSite,
  getSetting, setSetting,
  DEFAULTS,
};
