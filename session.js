const axios = require('axios');

// Set HASTEBIN_TOKEN in your environment (Render dashboard > Environment).
// Never hardcode tokens in source files.
const token = process.env.HASTEBIN_TOKEN || '';

function authHeaders(extra = {}) {
  return token ? { Authorization: `Bearer ${token}`, ...extra } : { ...extra };
}

async function create(data) {
  try {
    const response = await axios({
      method: 'post',
      url: 'https://hastebin.com/documents',
      headers: authHeaders({ 'Content-Type': 'application/json' }),
      data: JSON.stringify({ content: data }),
    });
    return { id: response.data.key };
  } catch (error) {
    throw new Error(`Error creating document: ${error.message}`);
  }
}

async function get(key) {
  if (!key) throw new Error('Missing key');
  try {
    const response = await axios({
      method: 'get',
      url: `https://hastebin.com/raw/${encodeURIComponent(key)}`,
      headers: authHeaders(),
    });
    return response.data;
  } catch (error) {
    throw new Error(`Error getting document: ${error.message}`);
  }
}

module.exports = { create, get };
