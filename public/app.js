const state = { servers: [], sort: 'players', search: '', selected: null, range: '24h' };
const $ = s => document.querySelector(s);
const grid = $('#serverGrid');
const modal = $('#modal');

function esc(value='') { const d = document.createElement('div'); d.textContent = value; return d.innerHTML; }
function fmt(n) { return Number(n || 0).toLocaleString('pl-PL'); }
function ago(ts) {
  if (!ts) return 'brak danych';
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 5) return 'teraz'; if (s < 60) return `${s}s temu`; return `${Math.floor(s/60)} min temu`;
}

async function getJSON(url) { const r = await fetch(url, { cache: 'no-store' }); if (!r.ok) throw new Error(await r.text()); return r.json(); }

function iconMarkup(s) {
  return s.favicon ? `<img alt="" src="${s.favicon}">` : esc((s.name || '?').slice(0,1));
}

function renderServers() {
  const q = state.search.trim().toLowerCase();
  let list = state.servers.filter(s => !q || s.name.toLowerCase().includes(q) || s.host.toLowerCase().includes(q));
  list.sort((a,b) => {
    if (state.sort === 'name') return a.name.localeCompare(b.name);
    if (state.sort === 'uptime') return (b.stats24h?.uptime ?? -1) - (a.stats24h?.uptime ?? -1);
    return (b.online - a.online) || (b.players - a.players);
  });
  grid.innerHTML = list.map(s => {
    const pct = s.maxPlayers > 0 ? Math.min(100, s.players / s.maxPlayers * 100) : 0;
    const uptime = s.stats24h?.uptime == null ? '—' : `${s.stats24h.uptime}%`;
    return `<article class="server-card ${s.online ? 'online' : 'offline'}" data-id="${s.id}">
      <div class="card-top"><div class="server-icon">${iconMarkup(s)}</div><div class="server-title"><strong>${esc(s.name)}</strong><small>${esc(s.host)}</small></div><div class="rank-badge">#${s.rank ?? '—'}</div><i class="status-dot"></i></div>
      <div class="player-line"><div class="players"><strong>${s.online ? fmt(s.players) : 'OFF'}</strong>${s.online ? `<span>/ ${fmt(s.maxPlayers)}</span>` : ''}</div><div class="ping">${s.latency != null ? `${s.latency} ms` : 'offline'}</div></div>
      <div class="bar"><i style="width:${pct}%"></i></div>
      <div class="card-meta"><span>REKORD: ${fmt(s.record?.players || 0)}</span><span>PEAK 24H: ${fmt(s.stats24h?.peak || 0)}</span><span>UPTIME: ${uptime}</span></div>
    </article>`;
  }).join('') || `<div style="color:#8490a1;padding:30px 0">Nie znaleziono serwera.</div>`;
  document.querySelectorAll('.server-card').forEach(el => el.addEventListener('click', () => openServer(el.dataset.id)));
}

async function refresh() {
  try {
    const [servers, summary] = await Promise.all([getJSON('/api/servers'), getJSON('/api/summary')]);
    state.servers = servers;
    $('#totalPlayers').textContent = fmt(summary.totalPlayers);
    $('#onlineServers').textContent = `${summary.onlineServers}/${summary.totalServers}`;
    $('#leader').textContent = summary.leader ? `${summary.leader.name.replace(/\.(PL|GG)$/i,'')} · ${fmt(summary.leader.players)}` : '—';
    $('#updateText').textContent = `Aktualizacja: ${ago(summary.lastUpdate)}`;
    renderServers();
    if (state.selected) {
      const live = servers.find(s => s.id === state.selected.id);
      if (live) state.selected = live;
    }
  } catch (e) { $('#updateText').textContent = 'Błąd pobierania danych'; }
}

function setModalInfo(s) {
  $('#modalName').textContent = s.name;
  $('#modalHost').textContent = s.host;
  $('#modalPlayers').textContent = s.online ? fmt(s.players) : 'OFF';
  $('#modalRank').textContent = s.rank ? `#${s.rank}` : '—';
  $('#detailRecord').textContent = fmt(s.record?.players || 0);
  $('#detailPing').textContent = s.latency != null ? `${s.latency} ms` : '—';
  $('#modalMotd').textContent = s.motd || '';
  $('#modalStatus').textContent = s.online ? '● ONLINE' : '● OFFLINE';
  $('#modalStatus').style.color = s.online ? 'var(--accent)' : 'var(--danger)';
  $('#modalIcon').innerHTML = iconMarkup(s);
}

async function openServer(id) {
  const s = state.servers.find(x => x.id === id); if (!s) return;
  state.selected = s; state.range = '24h';
  setModalInfo(s);
  modal.classList.remove('hidden'); modal.setAttribute('aria-hidden','false');
  document.body.style.overflow = 'hidden';
  document.querySelectorAll('#ranges button').forEach(b => b.classList.toggle('active', b.dataset.range === state.range));
  await loadHistory();
}

async function loadHistory() {
  if (!state.selected) return;
  const data = await getJSON(`/api/history/${state.selected.id}?range=${state.range}`);
  $('#detailPeak').textContent = fmt(data.stats.peak);
  $('#detailAvg').textContent = fmt(data.stats.average);
  $('#detailUptime').textContent = data.stats.uptime == null ? '—' : `${data.stats.uptime}%`;
  drawChart(data.points);
}

function drawChart(points) {
  const canvas = $('#chart'), empty = $('#chartEmpty');
  const rect = canvas.getBoundingClientRect();
  const dpr = Math.min(window.devicePixelRatio || 1, 2);
  canvas.width = Math.max(1, rect.width * dpr); canvas.height = Math.max(1, rect.height * dpr);
  const ctx = canvas.getContext('2d'); ctx.setTransform(dpr,0,0,dpr,0,0);
  const w = rect.width, h = rect.height, pad = {l:44,r:14,t:14,b:28};
  ctx.clearRect(0,0,w,h);
  if (!points || points.length < 2) { empty.classList.remove('hidden'); return; }
  empty.classList.add('hidden');
  const vals = points.map(p => p.online ? p.players : 0); const max = Math.max(10, ...vals); const minTs = points[0].ts, maxTs = points[points.length-1].ts || minTs+1;
  const x = ts => pad.l + ((ts-minTs)/(maxTs-minTs || 1))*(w-pad.l-pad.r); const y = v => h-pad.b-(v/max)*(h-pad.t-pad.b);
  ctx.font='10px system-ui';ctx.fillStyle='#657185';ctx.strokeStyle='#202936';ctx.lineWidth=1;
  for(let i=0;i<=4;i++){const v=Math.round(max*(1-i/4));const yy=pad.t+(h-pad.t-pad.b)*(i/4);ctx.beginPath();ctx.moveTo(pad.l,yy);ctx.lineTo(w-pad.r,yy);ctx.stroke();ctx.fillText(fmt(v),4,yy+3)}
  const grad=ctx.createLinearGradient(0,pad.t,0,h-pad.b);grad.addColorStop(0,'rgba(85,183,255,.32)');grad.addColorStop(1,'rgba(85,183,255,0)');
  ctx.beginPath();points.forEach((p,i)=>{const xx=x(p.ts),yy=y(p.online?p.players:0);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.lineTo(x(maxTs),h-pad.b);ctx.lineTo(x(minTs),h-pad.b);ctx.closePath();ctx.fillStyle=grad;ctx.fill();
  ctx.beginPath();points.forEach((p,i)=>{const xx=x(p.ts),yy=y(p.online?p.players:0);i?ctx.lineTo(xx,yy):ctx.moveTo(xx,yy)});ctx.strokeStyle='#73c7ff';ctx.lineWidth=2;ctx.stroke();
  const ticks=4;ctx.fillStyle='#657185';for(let i=0;i<=ticks;i++){const ts=minTs+(maxTs-minTs)*(i/ticks);const d=new Date(ts);const label=state.range.includes('d')?d.toLocaleDateString('pl-PL',{day:'2-digit',month:'2-digit'}):d.toLocaleTimeString('pl-PL',{hour:'2-digit',minute:'2-digit'});const xx=x(ts);ctx.fillText(label,Math.max(0,xx-16),h-8)}
}

$('#search').addEventListener('input', e => { state.search=e.target.value; renderServers(); });
document.querySelectorAll('.sorts button').forEach(b => b.addEventListener('click',()=>{state.sort=b.dataset.sort;document.querySelectorAll('.sorts button').forEach(x=>x.classList.toggle('active',x===b));renderServers()}));
$('#closeModal').addEventListener('click', closeModal);modal.addEventListener('click', e => { if(e.target===modal) closeModal(); });document.addEventListener('keydown',e=>{if(e.key==='Escape')closeModal()});
function closeModal(){modal.classList.add('hidden');modal.setAttribute('aria-hidden','true');document.body.style.overflow='';state.selected=null}
document.querySelectorAll('#ranges button').forEach(b=>b.addEventListener('click',async()=>{state.range=b.dataset.range;document.querySelectorAll('#ranges button').forEach(x=>x.classList.toggle('active',x===b));await loadHistory()}));
window.addEventListener('resize',()=>{if(state.selected)loadHistory()});
refresh();setInterval(refresh,15_000);
