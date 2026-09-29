'use strict';

const express = require('express');
const net = require('net');
const dns = require('dns').promises;
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const POLL_INTERVAL_MS = Math.max(15_000, Number(process.env.POLL_INTERVAL_MS || 60_000));
const PING_TIMEOUT_MS = Math.max(1_000, Number(process.env.PING_TIMEOUT_MS || 5_000));
const RETENTION_DAYS = Math.max(1, Number(process.env.RETENTION_DAYS || 30));
const servers = JSON.parse(fs.readFileSync(path.join(__dirname, 'servers.json'), 'utf8'));

const current = new Map();
const histories = new Map();
const records = new Map();
let pollRunning = false;

function encodeVarInt(input) {
  let value = input >>> 0;
  const out = [];
  do {
    let temp = value & 0x7f;
    value >>>= 7;
    if (value !== 0) temp |= 0x80;
    out.push(temp);
  } while (value !== 0);
  return Buffer.from(out);
}

function decodeVarInt(buffer, offset = 0) {
  let numRead = 0;
  let result = 0;
  let read;
  do {
    if (offset + numRead >= buffer.length) return null;
    read = buffer[offset + numRead];
    const value = read & 0x7f;
    result |= value << (7 * numRead);
    numRead++;
    if (numRead > 5) throw new Error('VarInt too large');
  } while ((read & 0x80) !== 0);
  return { value: result >>> 0, bytes: numRead };
}

function minecraftString(value) {
  const data = Buffer.from(value, 'utf8');
  return Buffer.concat([encodeVarInt(data.length), data]);
}

function packet(payload) {
  return Buffer.concat([encodeVarInt(payload.length), payload]);
}

async function resolveMinecraftAddress(host, explicitPort) {
  if (explicitPort) return { host, port: explicitPort };
  try {
    const records = await dns.resolveSrv(`_minecraft._tcp.${host}`);
    if (records.length) {
      records.sort((a, b) => (a.priority - b.priority) || (b.weight - a.weight));
      const record = records[0];
      return { host: record.name.replace(/\.$/, ''), port: record.port };
    }
  } catch (_) {}
  return { host, port: 25565 };
}

function flattenDescription(description) {
  if (!description) return '';
  if (typeof description === 'string') return description;
  if (Array.isArray(description)) return description.map(flattenDescription).join('');
  if (typeof description === 'object') {
    return [description.text || '', ...(description.extra || []).map(flattenDescription)].join('');
  }
  return '';
}

function stripMinecraftFormatting(text) {
  return String(text || '')
    .replace(/§[0-9A-FK-OR]/gi, '')
    .replace(/&[0-9A-FK-OR]/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
}

async function pingJava(server) {
  const target = await resolveMinecraftAddress(server.host, server.port);
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const socket = net.createConnection({ host: target.host, port: target.port });
    const chunks = [];
    let settled = false;

    const finish = (err, value) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (err) reject(err); else resolve(value);
    };

    socket.setTimeout(PING_TIMEOUT_MS, () => finish(new Error('timeout')));
    socket.once('error', (err) => finish(err));

    socket.once('connect', () => {
      const handshakePayload = Buffer.concat([
        encodeVarInt(0x00),
        encodeVarInt(-1),
        minecraftString(server.host),
        Buffer.from([(target.port >> 8) & 0xff, target.port & 0xff]),
        encodeVarInt(0x01)
      ]);
      socket.write(packet(handshakePayload));
      socket.write(packet(Buffer.from([0x00])));
    });

    socket.on('data', (chunk) => {
      chunks.push(chunk);
      const data = Buffer.concat(chunks);
      try {
        const packetLength = decodeVarInt(data, 0);
        if (!packetLength) return;
        if (data.length < packetLength.bytes + packetLength.value) return;

        let offset = packetLength.bytes;
        const packetId = decodeVarInt(data, offset);
        if (!packetId) return;
        offset += packetId.bytes;
        if (packetId.value !== 0x00) return finish(new Error('unexpected packet'));

        const strLength = decodeVarInt(data, offset);
        if (!strLength) return;
        offset += strLength.bytes;
        if (data.length < offset + strLength.value) return;

        const json = data.subarray(offset, offset + strLength.value).toString('utf8');
        const status = JSON.parse(json);
        finish(null, {
          online: true,
          players: Number(status.players?.online || 0),
          maxPlayers: Number(status.players?.max || 0),
          version: status.version?.name || 'Nieznana',
          protocol: status.version?.protocol ?? null,
          motd: stripMinecraftFormatting(flattenDescription(status.description)).slice(0, 180),
          favicon: typeof status.favicon === 'string' ? status.favicon : null,
          latency: Date.now() - startedAt,
          resolvedHost: target.host,
          resolvedPort: target.port
        });
      } catch (err) {
        finish(err);
      }
    });
  });
}

function historyPath(serverId) {
  return path.join(DATA_DIR, `${serverId}.ndjson`);
}

function recordsPath() {
  return path.join(DATA_DIR, 'records.json');
}

async function loadRecords() {
  try {
    const raw = JSON.parse(await fsp.readFile(recordsPath(), 'utf8'));
    for (const server of servers) {
      const row = raw?.[server.id];
      if (row && Number.isFinite(Number(row.players))) {
        records.set(server.id, {
          players: Number(row.players),
          ts: Number(row.ts || 0) || null
        });
      }
    }
  } catch (err) {
    if (err.code !== 'ENOENT') console.error('Rekordy:', err.message);
  }
}

async function saveRecords() {
  const out = {};
  for (const server of servers) {
    const record = records.get(server.id);
    if (record) out[server.id] = record;
  }
  const tmp = `${recordsPath()}.tmp`;
  await fsp.writeFile(tmp, JSON.stringify(out, null, 2));
  await fsp.rename(tmp, recordsPath());
}

function updateRecord(serverId, players, ts) {
  const value = Number(players || 0);
  const previous = records.get(serverId);
  if (!previous || value > previous.players) {
    records.set(serverId, { players: value, ts });
    saveRecords().catch(err => console.error('Zapis rekordu:', err.message));
  }
}

async function loadHistory(serverId) {
  const file = historyPath(serverId);
  try {
    const text = await fsp.readFile(file, 'utf8');
    const cutoff = Date.now() - RETENTION_DAYS * 86400000;
    const rows = text.split('\n')
      .filter(Boolean)
      .map(line => {
        try { return JSON.parse(line); } catch { return null; }
      })
      .filter(row => row && row.ts >= cutoff);
    histories.set(serverId, rows);
    const peakRow = rows.filter(row => row.online).reduce((best, row) => !best || row.players > best.players ? row : best, null);
    if (peakRow && !records.has(serverId)) records.set(serverId, { players: peakRow.players, ts: peakRow.ts });
  } catch (err) {
    if (err.code !== 'ENOENT') console.error(`Historia ${serverId}:`, err.message);
    histories.set(serverId, []);
  }
}

async function appendHistory(serverId, row) {
  const rows = histories.get(serverId) || [];
  rows.push(row);
  const cutoff = Date.now() - RETENTION_DAYS * 86400000;
  while (rows.length && rows[0].ts < cutoff) rows.shift();
  histories.set(serverId, rows);
  await fsp.appendFile(historyPath(serverId), `${JSON.stringify(row)}\n`);
}

async function compactHistories() {
  for (const server of servers) {
    const rows = histories.get(server.id) || [];
    const body = rows.map(row => JSON.stringify(row)).join('\n');
    await fsp.writeFile(historyPath(server.id), body ? `${body}\n` : '');
  }
}

function getStats(serverId, windowMs = 86400000) {
  const cutoff = Date.now() - windowMs;
  const rows = (histories.get(serverId) || []).filter(r => r.ts >= cutoff);
  const onlineRows = rows.filter(r => r.online);
  return {
    checks: rows.length,
    uptime: rows.length ? Math.round((onlineRows.length / rows.length) * 1000) / 10 : null,
    peak: onlineRows.length ? Math.max(...onlineRows.map(r => r.players)) : 0,
    average: onlineRows.length
      ? Math.round(onlineRows.reduce((sum, r) => sum + r.players, 0) / onlineRows.length)
      : 0
  };
}

async function pollOne(server) {
  let status;
  try {
    status = await pingJava(server);
  } catch (err) {
    status = {
      online: false,
      players: 0,
      maxPlayers: 0,
      version: null,
      protocol: null,
      motd: '',
      favicon: null,
      latency: null,
      error: err.code || err.message || 'offline'
    };
  }

  const result = {
    ...server,
    ...status,
    checkedAt: Date.now()
  };
  current.set(server.id, result);
  if (result.online) updateRecord(server.id, result.players, result.checkedAt);
  await appendHistory(server.id, {
    ts: result.checkedAt,
    online: result.online,
    players: result.players,
    maxPlayers: result.maxPlayers,
    latency: result.latency
  });
  return result;
}

async function pollAll() {
  if (pollRunning) return;
  pollRunning = true;
  try {
    const concurrency = 5;
    for (let i = 0; i < servers.length; i += concurrency) {
      await Promise.allSettled(servers.slice(i, i + concurrency).map(pollOne));
      if (i + concurrency < servers.length) await new Promise(r => setTimeout(r, 350));
    }
  } finally {
    pollRunning = false;
  }
}

function rangeToMs(value) {
  return ({ '1h': 3600000, '6h': 21600000, '24h': 86400000, '7d': 604800000, '30d': 2592000000 })[value] || 86400000;
}

function downsample(rows, maxPoints = 600) {
  if (rows.length <= maxPoints) return rows;
  const size = Math.ceil(rows.length / maxPoints);
  const out = [];
  for (let i = 0; i < rows.length; i += size) {
    const chunk = rows.slice(i, i + size);
    const online = chunk.filter(r => r.online);
    out.push({
      ts: chunk[Math.floor(chunk.length / 2)].ts,
      online: online.length > 0,
      players: online.length ? Math.round(online.reduce((s, r) => s + r.players, 0) / online.length) : 0,
      maxPlayers: online.length ? Math.max(...online.map(r => r.maxPlayers || 0)) : 0,
      latency: online.length ? Math.round(online.reduce((s, r) => s + (r.latency || 0), 0) / online.length) : null
    });
  }
  return out;
}

app.disable('x-powered-by');
app.use(express.static(path.join(__dirname, 'public'), { maxAge: '5m' }));

app.get('/health', (_req, res) => res.json({ ok: true, servers: servers.length, now: Date.now() }));

app.get('/api/servers', (_req, res) => {
  const liveRows = servers.map(server => {
    const live = current.get(server.id) || {
      ...server,
      online: false,
      players: 0,
      maxPlayers: 0,
      version: null,
      motd: '',
      latency: null,
      checkedAt: null
    };
    const record = records.get(server.id) || { players: 0, ts: null };
    return { ...live, stats24h: getStats(server.id), record };
  });

  const ranked = [...liveRows].sort((a, b) =>
    (Number(b.online) - Number(a.online)) ||
    (b.players - a.players) ||
    a.name.localeCompare(b.name)
  );
  const rankById = new Map(ranked.map((server, index) => [server.id, index + 1]));
  const payload = liveRows.map(server => ({ ...server, rank: rankById.get(server.id) }));

  res.set('Cache-Control', 'no-store');
  res.json(payload);
});

app.get('/api/history/:id', (req, res) => {
  const server = servers.find(s => s.id === req.params.id);
  if (!server) return res.status(404).json({ error: 'Nie znaleziono serwera' });
  const range = req.query.range || '24h';
  const cutoff = Date.now() - rangeToMs(range);
  const rows = (histories.get(server.id) || []).filter(r => r.ts >= cutoff);
  res.set('Cache-Control', 'no-store');
  res.json({ server, range, points: downsample(rows), stats: getStats(server.id, rangeToMs(range)) });
});

app.get('/api/summary', (_req, res) => {
  const live = [...current.values()];
  const online = live.filter(s => s.online);
  const totalPlayers = online.reduce((sum, s) => sum + s.players, 0);
  const leader = online.sort((a, b) => b.players - a.players)[0] || null;
  res.set('Cache-Control', 'no-store');
  res.json({
    totalServers: servers.length,
    onlineServers: online.length,
    totalPlayers,
    leader: leader ? { id: leader.id, name: leader.name, players: leader.players } : null,
    lastUpdate: live.length ? Math.max(...live.map(s => s.checkedAt || 0)) : null
  });
});

async function boot() {
  await fsp.mkdir(DATA_DIR, { recursive: true });
  await loadRecords();
  await Promise.all(servers.map(s => loadHistory(s.id)));
  await saveRecords();
  app.listen(PORT, '0.0.0.0', () => {
    console.log(`AMPERTRACK: http://0.0.0.0:${PORT}`);
    console.log(`Serwery: ${servers.length}, odswiezanie: ${POLL_INTERVAL_MS / 1000}s, historia: ${RETENTION_DAYS} dni`);
  });
  pollAll().catch(console.error);
  setInterval(() => pollAll().catch(console.error), POLL_INTERVAL_MS).unref();
  setInterval(() => compactHistories().catch(console.error), 6 * 60 * 60 * 1000).unref();
}

process.on('SIGTERM', async () => {
  try { await compactHistories(); await saveRecords(); } catch (_) {}
  process.exit(0);
});

boot().catch(err => {
  console.error(err);
  process.exit(1);
});
