require('dotenv').config();

const http        = require('http');
const TelegramBot = require('node-telegram-bot-api');
const { v4: uuidv4 } = require('uuid');
const cron        = require('node-cron');
const db          = require('./database');
const storage     = require('./storage');
const cf          = require('./cloudflare');

// ── CONFIG ────────────────────────────────────────────────────────────────────
const TOKEN    = process.env.BOT_TOKEN;
const ADMIN_ID = String(process.env.ADMIN_ID || '');
if (!TOKEN)    { console.error('❌ BOT_TOKEN missing'); process.exit(1); }
if (!ADMIN_ID) { console.error('❌ ADMIN_ID missing');  process.exit(1); }

const WORKER_SECRET = process.env.WORKER_SECRET || 'change-this-secret';

// ── HTTP SERVER (Render Web Service + Worker API) ─────────────────────────────
const urlMod = require('url');
http.createServer(async (req, res) => {
  const parsed = urlMod.parse(req.url, true);
  const path   = parsed.pathname;
  const query  = parsed.query;

  if (path === '/' || path === '/health') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, service: 'WebHost Bot' }));
  }

  // ── Worker API: GET /serve?host=ritesh.koom.site&path=/about.html&secret=xxx
  if (path === '/serve') {
    if (query.secret !== WORKER_SECRET) {
      res.writeHead(401); return res.end(JSON.stringify({ ok: false, error: 'Unauthorized' }));
    }

    const host     = query.host || '';  // ritesh.koom.site OR mysite.com
    const reqPath  = query.path || '/';
    const domain   = await db.getSetting('domain');

    // Find site by subdomain or custom domain
    let site;
    if (host.endsWith('.' + domain)) {
      const sub = host.replace('.' + domain, '');
      site = await db.getSiteBySubdomain(sub);
    } else {
      site = await db.getSiteByDomain(host);
    }

    if (!site || site.status !== 'active') {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'Site not found' }));
    }

    try {
      const file = await storage.serveFile(site, reqPath);
      if (!file) {
        res.writeHead(404, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({ ok: false, error: 'File not found' }));
      }

      // Track bandwidth + visits
      await db.updateSite(site.id, {
        visits:    (site.visits || 0) + 1,
        bandwidth: (site.bandwidth || 0) + (file.size || 0),
      });

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        telegramUrl: file.telegramUrl,
        contentType: file.contentType,
        size: file.size,
      }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: e.message }));
    }
  }

  res.writeHead(404); res.end('Not found');
}).listen(process.env.PORT || 3000, () => console.log('✅ HTTP server started'));

// ── BOT ───────────────────────────────────────────────────────────────────────
const bot = new TelegramBot(TOKEN, { polling: true });
let dbReady = false;

// ── SESSION ───────────────────────────────────────────────────────────────────
const sessions = {};
const getSession   = (id) => sessions[String(id)] || {};
const setSession   = (id, d) => { sessions[String(id)] = d; };
const clearSession = (id) => { delete sessions[String(id)]; };

// ── HELPERS ───────────────────────────────────────────────────────────────────
const isAdmin = (id) => String(id) === ADMIN_ID;

async function send(chatId, text, extra = {}) {
  try { return await bot.sendMessage(chatId, text, { parse_mode: 'Markdown', ...extra }); }
  catch (e) { console.error('send error:', e.message); }
}

async function sendAdmin(text, extra = {}) { return send(ADMIN_ID, text, extra); }

function fmtBytes(bytes) {
  if (!bytes) return '0 B';
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
  return (bytes / 1024 / 1024).toFixed(2) + ' MB';
}

async function getPlanLimits(plan) {
  const [sites, sizeMB, bwMB] = await Promise.all([
    db.getSetting(plan + '_maxSites'),
    db.getSetting(plan + '_maxSizeMB'),
    db.getSetting(plan + '_maxBandwidthMB'),
  ]);
  return { maxSites: sites, maxSizeMB: sizeMB, maxBandwidthMB: bwMB };
}

async function getStorageChatId() {
  return await db.getSetting('storageChatId') || ADMIN_ID;
}

// ── MAIN MENU ─────────────────────────────────────────────────────────────────
async function mainMenu(userId) {
  const user = await db.getUser(userId);
  const isPremium = user?.plan === 'premium';
  const btns = [
    [{ text: '🚀 New Website', callback_data: 'new_site' },
     { text: '🌐 My Websites', callback_data: 'my_sites' }],
    [{ text: '📊 Stats',       callback_data: 'my_stats' },
     { text: '⬆️ Upgrade',     callback_data: 'upgrade'  }],
    [{ text: '❓ Help',        callback_data: 'help'     },
     { text: '👤 Profile',     callback_data: 'profile'  }],
  ];
  if (isPremium) btns[1][1] = { text: '👑 Premium', callback_data: 'premium_info' };
  if (isAdmin(userId)) btns.push([{ text: '⚙️ Admin Panel', callback_data: 'admin' }]);
  return { reply_markup: { inline_keyboard: btns } };
}

// ── COMMANDS ──────────────────────────────────────────────────────────────────

bot.onText(/\/start/, async (msg) => {
  if (!dbReady) return;
  try {
    const { id, first_name, username } = msg.from;
    await db.upsertUser(id, { username: username || '', firstName: first_name || '' });

    if ((await db.getUser(id))?.banned && !isAdmin(id))
      return send(msg.chat.id, '🚫 Aapko ban kar diya gaya hai.');
    if (await db.getSetting('maintenanceMode') && !isAdmin(id))
      return send(msg.chat.id, '🔧 Bot maintenance mein hai. Baad mein aana.');

    const domain  = await db.getSetting('domain');
    const welcome = await db.getSetting('welcomeMsg');
    const menu    = await mainMenu(id);

    await send(msg.chat.id,
      `🌐 *WebHost Bot*\n\nNamaste *${first_name}*! 👋\n\n${welcome}\n\n` +
      `✅ Free mein host karo apni website on \`*.${domain}\`\n` +
      `👑 Premium pe custom domain bhi milega!\n\n` +
      `_/help — sab commands dekho_`,
      menu
    );
  } catch (e) { console.error('/start:', e.message); }
});

bot.onText(/\/help/,    async (msg) => { if (!dbReady) return; await showHelp(msg.chat.id, msg.from.id); });
bot.onText(/\/new/,     async (msg) => { if (!dbReady) return; await startNewSite(msg.chat.id, msg.from.id); });
bot.onText(/\/sites/,   async (msg) => { if (!dbReady) return; await showMySites(msg.chat.id, msg.from.id); });
bot.onText(/\/stats/,   async (msg) => { if (!dbReady) return; await showMyStats(msg.chat.id, msg.from.id); });
bot.onText(/\/upgrade/, async (msg) => { if (!dbReady) return; await showUpgrade(msg.chat.id, msg.from.id); });
bot.onText(/\/cancel/,  async (msg) => {
  if (!dbReady) return;
  clearSession(msg.from.id);
  const menu = await mainMenu(msg.from.id);
  await send(msg.chat.id, '✅ Cancel ho gaya.', menu);
});
bot.onText(/\/admin/,   async (msg) => { if (!dbReady || !isAdmin(msg.from.id)) return; await showAdminPanel(msg.chat.id); });

// ── CALLBACK QUERIES ──────────────────────────────────────────────────────────
bot.on('callback_query', async (query) => {
  const { data, message, from } = query;
  const chatId = message.chat.id;
  const userId = from.id;
  try {
    await bot.answerCallbackQuery(query.id).catch(() => {});
    await db.upsertUser(userId, { username: from.username || '', firstName: from.first_name || '' });

    const user = await db.getUser(userId);
    if (user?.banned && !isAdmin(userId)) return send(chatId, '🚫 Banned.');

    // ── Main nav ──────────────────────────────────────────────────────────────
    if (data === 'main_menu') { const m = await mainMenu(userId); return send(chatId, '🏠 Main Menu:', m); }
    if (data === 'help')        return showHelp(chatId, userId);
    if (data === 'profile')     return showProfile(chatId, userId);
    if (data === 'my_stats')    return showMyStats(chatId, userId);
    if (data === 'upgrade')     return showUpgrade(chatId, userId);
    if (data === 'premium_info') return showPremiumInfo(chatId, userId);
    if (data === 'new_site')    return startNewSite(chatId, userId);
    if (data === 'my_sites')    return showMySites(chatId, userId);

    // ── New site flow ─────────────────────────────────────────────────────────
    if (data === 'sub_auto')    return handleAutoSubdomain(chatId, userId);
    if (data === 'sub_custom')  return promptCustomSubdomain(chatId, userId);
    if (data === 'confirm_site') return confirmNewSite(chatId, userId);
    if (data === 'cancel_site') { clearSession(userId); const m = await mainMenu(userId); return send(chatId, '❌ Cancelled.', m); }

    // ── Site management ───────────────────────────────────────────────────────
    if (data.startsWith('site_'))    return showSiteDetail(chatId, userId, data.replace('site_', ''));
    if (data.startsWith('deploy_'))  return startDeploy(chatId, userId, data.replace('deploy_', ''));
    if (data.startsWith('rename_'))  return startRename(chatId, userId, data.replace('rename_', ''));
    if (data.startsWith('custom_domain_')) return startCustomDomain(chatId, userId, data.replace('custom_domain_', ''));
    if (data.startsWith('del_confirm_')) return doDeleteSite(chatId, userId, data.replace('del_confirm_', ''));
    if (data.startsWith('delete_'))  return confirmDeleteSite(chatId, userId, data.replace('delete_', ''));
    if (data.startsWith('toggle_'))  return toggleSite(chatId, userId, data.replace('toggle_', ''));
    if (data.startsWith('analytics_')) return showSiteAnalytics(chatId, userId, data.replace('analytics_', ''));

    // ── Admin ─────────────────────────────────────────────────────────────────
    if (!isAdmin(userId)) return;
    if (data === 'admin')              return showAdminPanel(chatId);
    if (data === 'admin_sites')        return adminAllSites(chatId);
    if (data === 'admin_users')        return adminAllUsers(chatId);
    if (data === 'admin_stats')        return adminStats(chatId);
    if (data === 'admin_settings')     return adminSettings(chatId);
    if (data === 'admin_maintenance')  return toggleMaintenance(chatId);
    if (data.startsWith('admin_ban_'))   return adminBan(chatId, data.replace('admin_ban_', ''));
    if (data.startsWith('admin_unban_')) return adminUnban(chatId, data.replace('admin_unban_', ''));
    if (data.startsWith('admin_suspend_')) return adminSuspendSite(chatId, data.replace('admin_suspend_', ''));
    if (data.startsWith('admin_premium_')) return adminGivePremium(chatId, data.replace('admin_premium_', ''));
    if (data.startsWith('admin_free_'))   return adminRevokePremium(chatId, data.replace('admin_free_', ''));

  } catch (e) {
    console.error('callback error [' + data + ']:', e.message);
    send(chatId, `❌ Error: ${e.message}`).catch(() => {});
  }
});

// ── MESSAGE HANDLER ───────────────────────────────────────────────────────────
bot.on('message', async (msg) => {
  if (!msg.from || !dbReady) return;
  const userId  = msg.from.id;
  const chatId  = msg.chat.id;
  const session = getSession(userId);

  try {
    // ── FILE UPLOAD ───────────────────────────────────────────────────────────
    if (msg.document && session.step === 'uploading') {
      const doc      = msg.document;
      const siteId   = session.data.siteId;
      const site     = await db.getSiteById(siteId);
      if (!site || site.userId !== String(userId)) return;

      const fname = doc.file_name || 'index.html';
      const ext   = fname.split('.').pop().toLowerCase();
      const allowed = ['zip', 'html', 'htm'];
      if (!allowed.includes(ext)) {
        return send(chatId, '❌ Sirf `.zip`, `.html` ya `.htm` file bhejo.\n\n_ZIP mein poora website folder hona chahiye._');
      }

      const user     = await db.getUser(userId);
      const limits   = await getPlanLimits(user?.plan || 'free');
      const maxBytes = limits.maxSizeMB * 1024 * 1024;

      if ((doc.file_size || 0) > maxBytes) {
        return send(chatId, `❌ File bahut badi hai!\nAapka limit: *${limits.maxSizeMB}MB*\nFile size: *${fmtBytes(doc.file_size)}*\n\n${user?.plan === 'free' ? '👑 Premium pe 50MB tak upload kar sakte ho!' : ''}`);
      }

      clearSession(userId);
      const statusMsg = await send(chatId, '⏳ *Uploading...*\n\nFiles Telegram storage mein ja rahi hain...');

      // Download from user's message
      const tgInfo = await storage.getTgFileInfo(doc.file_id);
      const dlUrl  = `https://api.telegram.org/file/bot${TOKEN}/${tgInfo.file_path}`;
      const axios  = require('axios');
      const dlRes  = await axios.get(dlUrl, { responseType: 'arraybuffer' });
      const buffer = Buffer.from(dlRes.data);

      const storageChatId = await getStorageChatId();

      // Process (extract if zip, upload each file to storage channel)
      let processedFiles;
      try {
        processedFiles = await storage.processUpload(buffer, fname, storageChatId);
      } catch (e) {
        return send(chatId, `❌ Upload failed: ${e.message}`);
      }

      const totalSize = processedFiles.reduce((s, f) => s + (f.size || 0), 0);

      // Update site in DB
      await db.updateSite(siteId, {
        files:        processedFiles.map(f => ({ ...f, tgFilePath: null, uploadedAt: new Date().toISOString() })),
        totalSize,
        status:       'active',
        lastDeployAt: new Date().toISOString(),
      });

      const freshSite = await db.getSiteById(siteId);
      const liveUrl   = freshSite.customDomain
        ? `https://${freshSite.customDomain}`
        : `https://${freshSite.subdomain}.${await db.getSetting('domain')}`;

      const fileList = processedFiles.slice(0, 8).map(f => `• \`${f.path}\``).join('\n');

      await send(chatId,
        `🎉 *Website Live Ho Gayi!*\n\n` +
        `🌐 URL: ${liveUrl}\n\n` +
        `📁 *Files (${processedFiles.length}):*\n${fileList}${processedFiles.length > 8 ? '\n_...aur bhi_' : ''}\n\n` +
        `💾 Size: \`${fmtBytes(totalSize)}\`\n` +
        `⏱ Deploy time: ${new Date().toLocaleTimeString('en-IN')}\n\n` +
        `_Site ko open hone mein 30-60 sec lag sakte hain._`,
        {
          parse_mode: 'Markdown',
          disable_web_page_preview: true,
          reply_markup: { inline_keyboard: [
            [{ text: '🔗 Open Website', url: liveUrl }],
            [{ text: '📊 Analytics', callback_data: `analytics_${siteId}` },
             { text: '⚙️ Manage',    callback_data: `site_${siteId}` }],
            [{ text: '🏠 Main Menu', callback_data: 'main_menu' }],
          ]},
        }
      );
      return;
    }

    if (!msg.text || msg.text.startsWith('/')) return;
    const text = msg.text.trim();
    if (!session.step) return;

    console.log(`MSG user:${userId} step:${session.step} text:${text.slice(0, 30)}`);

    // ── STEP: custom subdomain input ──────────────────────────────────────────
    if (session.step === 'enter_subdomain') {
      const sub = text.toLowerCase().replace(/[^a-z0-9-]/g, '').slice(0, 30);
      if (sub.length < 3) return send(chatId, '❌ Kam se kam 3 characters chahiye.');
      if (/^-|-$/.test(sub)) return send(chatId, '❌ Hyphen start ya end mein nahi ho sakta.');

      const exists = await db.getSiteBySubdomain(sub);
      if (exists) return send(chatId, `❌ \`${sub}.${await db.getSetting('domain')}\` already le li gayi hai.\n\nDusra naam try karo.`);

      setSession(userId, { ...session, data: { ...session.data, subdomain: sub } });
      return confirmSiteSetup(chatId, userId);
    }

    // ── STEP: site rename ─────────────────────────────────────────────────────
    if (session.step === 'renaming') {
      const { siteId } = session.data;
      if (text.length < 2) return send(chatId, '❌ Name bahut chhota hai.');
      clearSession(userId);
      await db.updateSite(siteId, { siteName: text.slice(0, 50) });
      const menu = await mainMenu(userId);
      return send(chatId, `✅ Site rename ho gayi: *${text}*`, menu);
    }

    // ── STEP: custom domain input ─────────────────────────────────────────────
    if (session.step === 'custom_domain') {
      const { siteId } = session.data;
      const domain = text.toLowerCase().trim().replace(/^https?:\/\//, '').replace(/\/$/, '');

      if (!/^[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$/.test(domain))
        return send(chatId, '❌ Valid domain daalo.\nExample: `mysite.com` ya `blog.mysite.com`');

      const exists = await db.getSiteByDomain(domain);
      if (exists) return send(chatId, `❌ \`${domain}\` already kisi aur site se linked hai.`);

      clearSession(userId);

      // Get bot's Render URL for CNAME target
      const renderUrl = (process.env.RENDER_URL || 'your-bot.onrender.com').replace(/^https?:\/\//, '');

      await db.updateSite(siteId, { customDomain: domain });
      return send(chatId,
        `✅ *Custom Domain Set Ho Gaya!*\n\n` +
        `Domain: \`${domain}\`\n\n` +
        `*Ab yeh DNS record add karo:*\n\n` +
        `\`\`\`\nType:  CNAME\nName:  ${domain.split('.')[0]}\nValue: ${renderUrl}\nTTL:   Auto\n\`\`\`\n\n` +
        `_Ya agar root domain hai (mysite.com):_\n` +
        `\`\`\`\nType:  A\nName:  @\nValue: [Render IP]\n\`\`\`\n\n` +
        `⏱ DNS propagation: 5 min – 48 hours\n` +
        `🔍 Check: whatsmydns.net`,
        { parse_mode: 'Markdown', disable_web_page_preview: true }
      );
    }

    // ── Admin steps ───────────────────────────────────────────────────────────
    if (session.step === 'admin_welcome' && isAdmin(userId)) {
      clearSession(userId);
      await db.setSetting('welcomeMsg', text);
      return send(chatId, `✅ Welcome message updated!`);
    }

    if (session.step === 'admin_set_storage' && isAdmin(userId)) {
      clearSession(userId);
      const chatId2 = text.trim();
      await db.setSetting('storageChatId', chatId2);
      return send(chatId, `✅ Storage Chat ID set: \`${chatId2}\``);
    }

    if (session.step === 'admin_broadcast' && isAdmin(userId)) {
      clearSession(userId);
      return doBroadcast(chatId, text);
    }

  } catch (e) { console.error('message handler error:', e.message); }
});

// ── FEATURE FUNCTIONS ─────────────────────────────────────────────────────────

async function showHelp(chatId, userId) {
  const domain = await db.getSetting('domain');
  const menu   = await mainMenu(userId);
  await send(chatId,
    `❓ *WebHost Bot Help*\n\n` +
    `Host your website on \`*.${domain}\` — free!\n\n` +
    `*Commands:*\n` +
    `/new — Naya website banao\n` +
    `/sites — Apni websites dekho\n` +
    `/stats — Apni stats dekho\n` +
    `/upgrade — Premium plan\n` +
    `/cancel — Cancel karo\n\n` +
    `*How to host:*\n` +
    `1️⃣ /new se naya site banao\n` +
    `2️⃣ Subdomain choose karo\n` +
    `3️⃣ ZIP ya HTML file bhejo\n` +
    `4️⃣ Site live ho jayegi! 🎉\n\n` +
    `*Supported files:*\n` +
    `HTML, CSS, JS, Images, Fonts\n` +
    `(ZIP mein pack karke bhejo)\n\n` +
    `*Free plan:* 1 site, 5MB, 500MB bandwidth\n` +
    `*Premium:* 5 sites, 50MB, 10GB bandwidth + custom domain`,
    menu
  );
}

async function showProfile(chatId, userId) {
  const [user, sites] = await Promise.all([db.getUser(userId), db.getUserSites(userId)]);
  const limits = await getPlanLimits(user?.plan || 'free');
  const menu   = await mainMenu(userId);
  const totalBw = sites.reduce((s, x) => s + (x.bandwidth || 0), 0);
  await send(chatId,
    `👤 *Profile*\n\n` +
    `🆔 ID: \`${userId}\`\n` +
    `📛 @${user?.username || 'N/A'}\n` +
    `👑 Plan: *${(user?.plan || 'free').toUpperCase()}*\n\n` +
    `🌐 Sites: ${sites.length}/${limits.maxSites}\n` +
    `💾 Max size: ${limits.maxSizeMB}MB per site\n` +
    `📡 Bandwidth used: ${fmtBytes(totalBw)} / ${limits.maxBandwidthMB}MB\n` +
    `📅 Joined: ${user?.joinedAt?.split('T')[0] || 'N/A'}`,
    menu
  );
}

async function showMyStats(chatId, userId) {
  const sites = await db.getUserSites(userId);
  if (!sites.length) {
    const menu = await mainMenu(userId);
    return send(chatId, '📊 Koi website nahi hai abhi.\n\n/new se banao!', menu);
  }
  let msg = `📊 *My Stats*\n\n`;
  for (const s of sites) {
    msg += `🌐 *${s.siteName || s.subdomain}*\n`;
    msg += `├ 👁 Visits: ${s.visits || 0}\n`;
    msg += `├ 📡 Bandwidth: ${fmtBytes(s.bandwidth || 0)}\n`;
    msg += `├ 💾 Size: ${fmtBytes(s.totalSize || 0)}\n`;
    msg += `└ 📁 Files: ${s.files?.length || 0}\n\n`;
  }
  await send(chatId, msg, await mainMenu(userId));
}

async function showUpgrade(chatId, userId) {
  const user  = await db.getUser(userId);
  const price = await db.getSetting('premiumPrice');
  const menu  = await mainMenu(userId);

  if (user?.plan === 'premium') {
    return send(chatId,
      `👑 *Aap already Premium hain!*\n\n` +
      `✅ 5 websites\n✅ 50MB per site\n✅ 10GB bandwidth\n✅ Custom domain support`,
      menu
    );
  }

  await send(chatId,
    `👑 *Premium Plan — ${price}*\n\n` +
    `*Free vs Premium:*\n\n` +
    `| Feature | Free | Premium |\n` +
    `|---------|------|---------|\n` +
    `| Sites | 1 | 5 |\n` +
    `| Size | 5MB | 50MB |\n` +
    `| Bandwidth | 500MB | 10GB |\n` +
    `| Custom Domain | ❌ | ✅ |\n` +
    `| Priority Support | ❌ | ✅ |\n\n` +
    `*Payment ke liye admin se contact karo:*\n` +
    `Admin: @${process.env.ADMIN_USERNAME || 'admin'}`,
    menu
  );
}

async function showPremiumInfo(chatId, userId) {
  const menu = await mainMenu(userId);
  await send(chatId, `👑 *Aap Premium User Hain!*\n\n✅ 5 sites\n✅ 50MB/site\n✅ 10GB bandwidth\n✅ Custom domain\n✅ Priority support`, menu);
}

// ── NEW SITE FLOW ─────────────────────────────────────────────────────────────

async function startNewSite(chatId, userId) {
  const user   = await db.getUser(userId);
  const plan   = user?.plan || 'free';
  const limits = await getPlanLimits(plan);
  const sites  = await db.getUserSites(userId);

  if (sites.length >= limits.maxSites) {
    const menu = await mainMenu(userId);
    return send(chatId,
      `❌ Aapki site limit reach ho gayi! (*${sites.length}/${limits.maxSites}*)\n\n` +
      (plan === 'free' ? `👑 Premium pe 5 sites bana sakte ho! /upgrade` : `Purani site delete karo.`),
      menu
    );
  }

  clearSession(userId);
  setSession(userId, { step: 'choosing_subdomain', data: {} });

  const domain = await db.getSetting('domain');
  await send(chatId,
    `🚀 *Naya Website Banao*\n\n` +
    `Apna subdomain kaise chahiye?`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '🎲 Auto Generate', callback_data: 'sub_auto' }],
        [{ text: '✏️ Custom Choose', callback_data: 'sub_custom' }],
        [{ text: '❌ Cancel',        callback_data: 'cancel_site' }],
      ]},
    }
  );
}

async function handleAutoSubdomain(chatId, userId) {
  const session = getSession(userId);
  const user    = await db.getUser(userId);
  const domain  = await db.getSetting('domain');

  // Generate from username or random
  const base = (user?.username || 'site').toLowerCase().replace(/[^a-z0-9]/g, '') || 'site';
  let sub   = base;
  let tries = 0;
  while (await db.getSiteBySubdomain(sub) && tries < 10) {
    sub = base + Math.floor(Math.random() * 9000 + 1000);
    tries++;
  }

  setSession(userId, { ...session, data: { ...session.data, subdomain: sub } });
  return confirmSiteSetup(chatId, userId);
}

async function promptCustomSubdomain(chatId, userId) {
  const session = getSession(userId);
  const domain  = await db.getSetting('domain');
  setSession(userId, { ...session, step: 'enter_subdomain' });
  await send(chatId,
    `✏️ *Custom Subdomain*\n\nApna subdomain naam daalo:\n\n` +
    `📌 Rules:\n• Sirf lowercase letters, numbers, hyphen\n• 3 se 30 characters\n• Example: \`mysite\`, \`ritesh-blog\`\n\n` +
    `Aapko milega: \`naam.${domain}\`\n\n/cancel to stop.`
  );
}

async function confirmSiteSetup(chatId, userId) {
  const session = getSession(userId);
  const domain  = await db.getSetting('domain');
  const sub     = session.data.subdomain;

  setSession(userId, { ...session, step: 'confirming' });

  await send(chatId,
    `✅ *Confirm Site Setup:*\n\n` +
    `🌐 URL: \`https://${sub}.${domain}\`\n\n` +
    `Site banane ke baad file upload karna hoga.`,
    {
      parse_mode: 'Markdown',
      reply_markup: { inline_keyboard: [
        [{ text: '✅ Create Site', callback_data: 'confirm_site' }],
        [{ text: '❌ Cancel',     callback_data: 'cancel_site'  }],
      ]},
    }
  );
}

async function confirmNewSite(chatId, userId) {
  const session = getSession(userId);
  const sub     = session.data.subdomain;
  if (!sub) return startNewSite(chatId, userId);
  clearSession(userId);

  const domain = await db.getSetting('domain');
  const user   = await db.getUser(userId);
  const siteId = uuidv4();

  await db.createSite({
    id: siteId, userId: String(userId),
    userName: user?.username || user?.firstName || '',
    subdomain: sub, activeUrl: `https://${sub}.${domain}`,
    siteName: `${sub}'s website`, status: 'pending',
    plan: user?.plan || 'free', files: [],
  });

  setSession(userId, { step: 'uploading', data: { siteId } });

  await send(chatId,
    `✅ *Site Created!*\n\n` +
    `🌐 \`https://${sub}.${domain}\`\n\n` +
    `📁 *Ab apni website files bhejo:*\n\n` +
    `• *ZIP file* — poora website folder (recommended)\n` +
    `• *Single HTML file* — ek page website\n\n` +
    `⚠️ ZIP mein \`index.html\` zaroor hona chahiye (homepage).\n\n` +
    `_Max size: ${(await getPlanLimits(user?.plan || 'free')).maxSizeMB}MB_\n\n` +
    `/cancel to stop.`
  );
}

// ── MY SITES ──────────────────────────────────────────────────────────────────

async function showMySites(chatId, userId) {
  const sites = await db.getUserSites(userId);
  if (!sites.length) {
    const menu = await mainMenu(userId);
    return send(chatId,
      `🌐 *Meri Websites*\n\nAbhi koi website nahi hai.\n\n🚀 Abhi banao!`,
      { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
        [{ text: '🚀 New Website', callback_data: 'new_site' }],
        [{ text: '🏠 Main Menu',  callback_data: 'main_menu' }],
      ]}}
    );
  }

  const domain = await db.getSetting('domain');
  const btns = sites.map(s => [{
    text: `${s.status === 'active' ? '🟢' : s.status === 'suspended' ? '🔴' : '🟡'} ${s.siteName || s.subdomain}.${domain}`,
    callback_data: `site_${s.id}`,
  }]);
  btns.push([{ text: '🚀 New Website', callback_data: 'new_site' },
             { text: '🏠 Menu',        callback_data: 'main_menu' }]);

  await send(chatId, `🌐 *Meri Websites* (${sites.length})`, {
    parse_mode: 'Markdown',
    reply_markup: { inline_keyboard: btns },
  });
}

async function showSiteDetail(chatId, userId, siteId) {
  const site   = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const domain = await db.getSetting('domain');
  const liveUrl = site.customDomain ? `https://${site.customDomain}` : `https://${site.subdomain}.${domain}`;
  const user   = await db.getUser(userId);

  const statusIcon = { active: '🟢', suspended: '🔴', pending: '🟡', building: '⚙️' }[site.status] || '⚪';

  const btns = [
    [{ text: '📤 Upload / Redeploy', callback_data: `deploy_${siteId}` }],
    [{ text: '📊 Analytics',         callback_data: `analytics_${siteId}` },
     { text: '✏️ Rename',            callback_data: `rename_${siteId}` }],
  ];

  if (user?.plan === 'premium') {
    btns.push([{ text: '🔗 Custom Domain', callback_data: `custom_domain_${siteId}` }]);
  }

  if (site.status === 'active') {
    btns.push([{ text: '🔗 Open Site', url: liveUrl }]);
  }

  btns.push([
    { text: site.status === 'active' ? '⏸ Suspend' : '▶️ Activate', callback_data: `toggle_${siteId}` },
    { text: '🗑️ Delete', callback_data: `delete_${siteId}` },
  ]);
  btns.push([{ text: '◀ Back', callback_data: 'my_sites' }]);

  await send(chatId,
    `${statusIcon} *${site.siteName}*\n\n` +
    `🌐 URL: \`${liveUrl}\`\n` +
    (site.customDomain ? `🔗 Custom: \`${site.customDomain}\`\n` : '') +
    `📁 Files: ${site.files?.length || 0}\n` +
    `💾 Size: ${fmtBytes(site.totalSize || 0)}\n` +
    `👁 Visits: ${site.visits || 0}\n` +
    `📡 Bandwidth: ${fmtBytes(site.bandwidth || 0)}\n` +
    `📅 Last deploy: ${site.lastDeployAt?.split('T')[0] || 'Never'}\n` +
    `⚡ Status: \`${site.status.toUpperCase()}\``,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: btns } }
  );
}

async function showSiteAnalytics(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const domain  = await db.getSetting('domain');
  const liveUrl = site.customDomain ? `https://${site.customDomain}` : `https://${site.subdomain}.${domain}`;

  await send(chatId,
    `📊 *Analytics — ${site.siteName}*\n\n` +
    `🌐 URL: \`${liveUrl}\`\n\n` +
    `👁 Total Visits: *${site.visits || 0}*\n` +
    `📡 Bandwidth Used: *${fmtBytes(site.bandwidth || 0)}*\n` +
    `💾 Storage Used: *${fmtBytes(site.totalSize || 0)}*\n` +
    `📁 Total Files: *${site.files?.length || 0}*\n` +
    `📅 Created: ${site.createdAt?.split('T')[0]}\n` +
    `🔄 Last Deploy: ${site.lastDeployAt?.split('T')[0] || 'Never'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '◀ Back', callback_data: `site_${siteId}` }],
    ]}}
  );
}

async function startDeploy(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const user   = await db.getUser(userId);
  const limits = await getPlanLimits(user?.plan || 'free');

  setSession(userId, { step: 'uploading', data: { siteId } });
  await send(chatId,
    `📤 *Redeploy — ${site.siteName}*\n\n` +
    `Apni website files bhejo:\n\n` +
    `• *ZIP file* — poora website (recommended)\n` +
    `• *Single HTML file* — ek page\n\n` +
    `⚠️ ZIP mein \`index.html\` zaroor hona chahiye.\n` +
    `_Max size: ${limits.maxSizeMB}MB_\n\n` +
    `/cancel to stop.`
  );
}

async function startRename(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  setSession(userId, { step: 'renaming', data: { siteId } });
  await send(chatId, `✏️ Site ka naya naam daalo:\n_(Current: "${site.siteName}")_\n\n/cancel to stop.`);
}

async function startCustomDomain(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const user = await db.getUser(userId);
  if (user?.plan !== 'premium') return send(chatId, '❌ Custom domain sirf Premium users ke liye hai.\n\n/upgrade');

  setSession(userId, { step: 'custom_domain', data: { siteId } });
  await send(chatId,
    `🔗 *Custom Domain*\n\nApna domain daalo:\n_(Example: \`mysite.com\` ya \`blog.mysite.com\`)_\n\n` +
    `⚠️ \`https://\` mat daalo, sirf domain naam.\n\n/cancel to stop.`
  );
}

async function toggleSite(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const newStatus = site.status === 'active' ? 'suspended' : 'active';
  await db.updateSite(siteId, { status: newStatus });
  await send(chatId, `${newStatus === 'active' ? '🟢 Site active ho gayi!' : '🔴 Site suspend ho gayi.'}`);
  return showSiteDetail(chatId, userId, siteId);
}

async function confirmDeleteSite(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  const domain  = await db.getSetting('domain');
  await send(chatId,
    `⚠️ *Delete Karo?*\n\n\`${site.subdomain}.${domain}\`\n\n*Yeh undo nahi ho sakta!*\nSaari files aur data delete ho jayega.`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [[
      { text: '🗑️ Haan, Delete Karo', callback_data: `del_confirm_${siteId}` },
      { text: '❌ Cancel',            callback_data: `site_${siteId}` },
    ]]}}
  );
}

async function doDeleteSite(chatId, userId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site || site.userId !== String(userId)) return send(chatId, '❌ Not found.');
  if (site.cfRecordId) { try { await cf.deleteRecord(site.cfRecordId); } catch {} }
  await db.deleteSite(siteId);
  const menu = await mainMenu(userId);
  await send(chatId, `✅ \`${site.subdomain}\` delete ho gaya!`, menu);
}

// ── ADMIN FUNCTIONS ───────────────────────────────────────────────────────────

async function showAdminPanel(chatId) {
  const [sites, users] = await Promise.all([db.getAllSites(), db.getAllUsers()]);
  const active   = sites.filter(s => s.status === 'active').length;
  const premium  = users.filter(u => u.plan === 'premium').length;
  const maintenance = await db.getSetting('maintenanceMode');

  await send(chatId,
    `⚙️ *Admin Panel*\n\n` +
    `📊 Sites: ${sites.length} (🟢 ${active} active)\n` +
    `👥 Users: ${users.length} (👑 ${premium} premium)\n` +
    `🔧 Maintenance: ${maintenance ? 'ON' : 'OFF'}`,
    { parse_mode: 'Markdown', reply_markup: { inline_keyboard: [
      [{ text: '🌐 All Sites', callback_data: 'admin_sites' },
       { text: '👥 All Users', callback_data: 'admin_users' }],
      [{ text: '📊 Stats',     callback_data: 'admin_stats' },
       { text: '⚙️ Settings',  callback_data: 'admin_settings' }],
      [{ text: `${maintenance ? '✅ Disable' : '🔧 Enable'} Maintenance`, callback_data: 'admin_maintenance' }],
      [{ text: '🏠 Menu', callback_data: 'main_menu' }],
    ]}}
  );
}

async function adminAllSites(chatId) {
  const sites  = await db.getAllSites();
  const domain = await db.getSetting('domain');
  if (!sites.length) return send(chatId, '📋 Koi site nahi.');
  const list = sites.slice(0, 20).map(s =>
    `${s.status === 'active' ? '🟢' : '🔴'} \`${s.subdomain}.${domain}\` — ${s.userName}`
  ).join('\n');
  await send(chatId, `📋 *All Sites (${sites.length})*\n\n${list}`);
}

async function adminAllUsers(chatId) {
  const users = await db.getAllUsers();
  if (!users.length) return send(chatId, '👥 Koi user nahi.');
  const list = users.slice(0, 20).map(u =>
    `${u.banned ? '🚫' : u.plan === 'premium' ? '👑' : '✅'} @${u.username || u.firstName} \`${u.tgId}\``
  ).join('\n');
  await send(chatId, `👥 *Users (${users.length})*\n\n${list}\n\n_Reply: /ban ID ya /premium ID_`);
}

async function adminStats(chatId) {
  const [sites, users] = await Promise.all([db.getAllSites(), db.getAllUsers()]);
  const totalBw = sites.reduce((s, x) => s + (x.bandwidth || 0), 0);
  const totalSz = sites.reduce((s, x) => s + (x.totalSize || 0), 0);
  await send(chatId,
    `📊 *Admin Stats*\n\n` +
    `🌐 Total Sites: ${sites.length}\n` +
    `🟢 Active: ${sites.filter(s => s.status === 'active').length}\n` +
    `👥 Users: ${users.length}\n` +
    `👑 Premium: ${users.filter(u => u.plan === 'premium').length}\n` +
    `🚫 Banned: ${users.filter(u => u.banned).length}\n\n` +
    `💾 Total Storage: ${fmtBytes(totalSz)}\n` +
    `📡 Total Bandwidth: ${fmtBytes(totalBw)}`
  );
}

async function adminSettings(chatId) {
  const [price, welcome, storageChatId, maintenance] = await Promise.all([
    db.getSetting('premiumPrice'), db.getSetting('welcomeMsg'),
    db.getSetting('storageChatId'), db.getSetting('maintenanceMode'),
  ]);
  setSession(ADMIN_ID, { step: null });
  await send(chatId,
    `⚙️ *Settings*\n\n` +
    `💰 Premium Price: ${price}\n` +
    `📦 Storage Chat ID: \`${storageChatId || 'Not set'}\`\n` +
    `🔧 Maintenance: ${maintenance ? 'ON' : 'OFF'}\n\n` +
    `*Edit commands (reply with value):*\n` +
    `/set_welcome — Welcome message\n` +
    `/set_storage — Storage channel ID\n` +
    `/set_price — Premium price\n` +
    `/broadcast — Message all users`
  );
}

async function toggleMaintenance(chatId) {
  const c = await db.getSetting('maintenanceMode');
  await db.setSetting('maintenanceMode', !c);
  await send(chatId, `🔧 Maintenance: *${!c ? 'ON' : 'OFF'}*`);
}

async function adminBan(chatId, userId) {
  await db.upsertUser(userId, { banned: true });
  await send(chatId, `🚫 User \`${userId}\` banned.`);
  bot.sendMessage(userId, '🚫 Aapko ban kar diya gaya.').catch(() => {});
}

async function adminUnban(chatId, userId) {
  await db.upsertUser(userId, { banned: false });
  await send(chatId, `✅ User \`${userId}\` unbanned.`);
}

async function adminGivePremium(chatId, userId) {
  await db.upsertUser(userId, { plan: 'premium' });
  await send(chatId, `👑 User \`${userId}\` ko Premium diya gaya!`);
  bot.sendMessage(userId, '🎉 *Congratulations!* Aapko Premium plan mil gaya! /sites pe jaake enjoy karo 👑', { parse_mode: 'Markdown' }).catch(() => {});
}

async function adminRevokePremium(chatId, userId) {
  await db.upsertUser(userId, { plan: 'free' });
  await send(chatId, `✅ User \`${userId}\` ka Premium revoke ho gaya.`);
}

async function adminSuspendSite(chatId, siteId) {
  const site = await db.getSiteById(siteId);
  if (!site) return send(chatId, '❌ Not found.');
  const newStatus = site.status === 'active' ? 'suspended' : 'active';
  await db.updateSite(siteId, { status: newStatus });
  await send(chatId, `${newStatus === 'active' ? '🟢' : '🔴'} Site ${newStatus}.`);
}

// Extra admin commands
bot.onText(/\/ban (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await adminBan(msg.chat.id, match[1].trim());
});

bot.onText(/\/unban (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await adminUnban(msg.chat.id, match[1].trim());
});

bot.onText(/\/premium (.+)/, async (msg, match) => {
  if (!isAdmin(msg.from.id)) return;
  await adminGivePremium(msg.chat.id, match[1].trim());
});

bot.onText(/\/set_welcome/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  setSession(msg.from.id, { step: 'admin_welcome' });
  await send(msg.chat.id, '📝 Naya welcome message type karo:');
});

bot.onText(/\/set_storage/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  setSession(msg.from.id, { step: 'admin_set_storage' });
  await send(msg.chat.id, '📦 Storage channel/group ka Chat ID daalo:\n_(Bot ko wahan admin hona chahiye)_');
});

bot.onText(/\/broadcast/, async (msg) => {
  if (!isAdmin(msg.from.id)) return;
  setSession(msg.from.id, { step: 'admin_broadcast' });
  await send(msg.chat.id, '📢 Broadcast message type karo:\n\n/cancel to stop.');
});

async function doBroadcast(chatId, text) {
  const users = await db.getAllUsers();
  let sent = 0, failed = 0;
  await send(chatId, `📤 Sending to ${users.length} users...`);
  for (const u of users) {
    try { await bot.sendMessage(u.tgId, text, { parse_mode: 'Markdown' }); sent++; await new Promise(r => setTimeout(r, 40)); }
    catch { failed++; }
  }
  await send(chatId, `✅ Done! Sent: ${sent} | Failed: ${failed}`);
}

// ── DAILY CRON ────────────────────────────────────────────────────────────────
cron.schedule('0 9 * * *', async () => {
  try {
    const [sites, users] = await Promise.all([db.getAllSites(), db.getAllUsers()]);
    await sendAdmin(
      `📊 *Daily Report*\n\n` +
      `🌐 Sites: ${sites.length} (${sites.filter(s => s.status === 'active').length} active)\n` +
      `👥 Users: ${users.length}\n` +
      `📅 ${new Date().toLocaleDateString('en-IN')}`
    );
  } catch {}
});

// ── STARTUP ───────────────────────────────────────────────────────────────────
(async () => {
  try {
    await db.connectDB();
    await db.initSettings();
    bot.on('polling_error', (e) => console.error('Polling:', e.code, e.message));
    dbReady = true;
    console.log(`✅ WebHost Bot ready!`);
  } catch (e) {
    console.error('❌ Startup failed:', e.message);
    process.exit(1);
  }
})();

process.on('unhandledRejection', (e) => console.error('Unhandled:', e?.message));
