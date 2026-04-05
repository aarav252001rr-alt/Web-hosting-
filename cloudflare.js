const axios = require('axios');

const ZONE_ID = process.env.CF_ZONE_ID;
const TOKEN   = process.env.CF_API_TOKEN;
const DOMAIN  = process.env.DOMAIN || 'koom.site';

const cf = axios.create({
  baseURL: `https://api.cloudflare.com/client/v4/zones/${ZONE_ID}/dns_records`,
  headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json' },
});

function isMock() { return !ZONE_ID || !TOKEN || TOKEN === 'your_cf_token'; }

async function addCNAME(subdomain, target) {
  if (isMock()) { console.log(`[CF MOCK] CNAME ${subdomain}.${DOMAIN} → ${target}`); return { id: `mock_${Date.now()}` }; }
  const res = await cf.post('', { type: 'CNAME', name: `${subdomain}.${DOMAIN}`, content: target, ttl: 3600, proxied: true });
  if (!res.data.success) throw new Error(res.data.errors?.[0]?.message || 'CF error');
  return res.data.result;
}

async function addARecord(subdomain, ip) {
  if (isMock()) { console.log(`[CF MOCK] A ${subdomain}.${DOMAIN} → ${ip}`); return { id: `mock_${Date.now()}` }; }
  const res = await cf.post('', { type: 'A', name: `${subdomain}.${DOMAIN}`, content: ip, ttl: 3600, proxied: true });
  if (!res.data.success) throw new Error(res.data.errors?.[0]?.message || 'CF error');
  return res.data.result;
}

async function deleteRecord(recordId) {
  if (isMock() || !recordId || recordId.startsWith('mock_')) return true;
  const res = await cf.delete(`/${recordId}`);
  if (!res.data.success) throw new Error(res.data.errors?.[0]?.message || 'Delete failed');
  return true;
}

module.exports = { addCNAME, addARecord, deleteRecord, DOMAIN };
