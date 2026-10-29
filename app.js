const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
const $ = id => document.getElementById(id);
const emsg = e => String(e?.message ?? e);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const say = m => { $('cstat').textContent = m; };
window.addEventListener('error', e => say('❌ Error: ' + emsg(e)));
window.addEventListener('unhandledrejection', e => say('❌ Error: ' + emsg(e.reason)));
$('log').textContent = 'app.js v12 cargado\n';

const toBlobURL = async (url, type) => {
  const r = await fetch(url); if (!r.ok) throw new Error('no se pudo descargar ' + url);
  return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
};
let ffmpeg;
try { ffmpeg = new FFmpegWASM.FFmpeg(); }
catch (e) { say('❌ Faltan archivos de la carpeta vendor (ffmpeg.js). Revisa que se subió a GitHub.'); }
let clips = [], queue = [], mp4s = [], ready = null, logBuf = [], working = false, lock = Promise.resolve();
const run = fn => { const p = lock.then(fn); lock = p.catch(() => {}); return p; }; // una operación de FFmpeg a la vez
ffmpeg?.on('log', ({ message }) => { logBuf.push(message); $('log').textContent += message + '\n'; });

function loadFFmpeg() {
  return ready ??= (async () => {
    if (!ffmpeg) throw new Error('faltan los archivos de vendor/');
    say('Cargando FFmpeg (~30 MB, solo la primera vez)…');
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    say('');
  })();
}

// Monta el File con WORKERFS: FFmpeg lo lee bajo demanda, sin copiarlo a la RAM.
async function withMounted(file, i, fn) {
  const dir = `/in${i}`;
  await ffmpeg.createDir(dir);
  await ffmpeg.mount('WORKERFS', { files: [file] }, dir);
  try { return await fn(`${dir}/${file.name}`); }
  finally { await ffmpeg.unmount(dir); await ffmpeg.deleteDir(dir); }
}

async function probe(c, i) {
  logBuf = [];
  await withMounted(c.file, i, p => ffmpeg.exec(['-hide_banner', '-i', p], 20000)); // sale con error: es normal
  const t = logBuf.join('\n');
  const v = t.match(/Video: (\w+).*?, (\d{2,5}x\d{2,5}).*?([\d.]+) fps/);
  const a = t.match(/Audio: (\w+).*?(\d+) Hz/);
  c.vc = v?.[1]; c.ac = a?.[1];
  c.sig = `${v?.[1] ?? '?'} ${v?.[2] ?? ''} ${v?.[3] ?? ''}fps · ${a?.[1] ?? 'sin audio'} ${a?.[2] ?? ''}Hz`;
  const d = t.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (d) { c.dur = +d[1] * 3600 + +d[2] * 60 + +d[3]; if (!c.end) c.end = +c.dur.toFixed(2); }
  c.vsig = v ? `${v[1]}|${v[2]}|${v[3]}|${a?.[1]}|${a?.[2]}` : '';
}

/* ---------- Paso 1: cola de conversión y lista de MP4 ---------- */
const VIDEO_RE = /\.(mp4|avi|mkv|mov|wmv|flv|mpg|mpeg|m4v|webm|3gp|ts|mts|m2ts|vob|ogv)$/i;
function handleFiles(files) {
  for (const f of files) {
    if (!(f.type.startsWith('video/') || VIDEO_RE.test(f.name))) continue;
    if (/\.mp4$/i.test(f.name)) mp4s.push({ file: f });
    else queue.push({ file: f, state: 'wait', msg: 'En cola' });
  }
  renderLists(); processQueue();
}

function renderLists() {
  $('queue').innerHTML = queue.length
    ? queue.map(q => `<li><span>${esc(q.file.name)}</span><span class="meta">${esc(q.msg)}</span></li>`).join('')
    : '<li class="meta">Vacía</li>';
  $('mp4list').innerHTML = mp4s.length
    ? mp4s.map((m, i) => `<li><span>${esc(m.file.name)}</span><span>${m.url ? `<a href="${m.url}" download="${esc(m.file.name)}" title="Guardar copia">⬇</a> ` : ''}<a href="#" data-rm="${i}" title="Quitar">✕</a></span></li>`).join('')
    : '<li class="meta">Vacía</li>';
  $('toEditor').disabled = !mp4s.length;
}
$('mp4list').onclick = e => { const i = e.target.dataset.rm; if (i === undefined) return; e.preventDefault(); mp4s.splice(+i, 1); renderLists(); };

const ENC = ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '20', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '160k'];
async function tryConv(q, args, label) {
  const onP = ({ progress }) => { q.msg = `${label}… ${Math.round(Math.min(Math.max(progress, 0), 1) * 100)} %`; renderLists(); };
  q.msg = label + '…'; renderLists(); ffmpeg.on('progress', onP);
  try {
    const code = await withMounted(q.file, 'c', p => ffmpeg.exec(['-i', p, '-map', '0:v:0', '-map', '0:a:0?', ...args, '-movflags', '+faststart', 'out.mp4']));
    if (code !== 0) throw new Error('FFmpeg no pudo convertirlo (ver registro)');
    const data = await ffmpeg.readFile('out.mp4');
    return new File([data], q.file.name.replace(/\.[^.]+$/, '') + '.mp4', { type: 'video/mp4' });
  } finally { ffmpeg.off('progress', onP); await ffmpeg.deleteFile('out.mp4').catch(() => {}); }
}

// Si ya es H.264 (+AAC/MP3) solo se cambia el contenedor (rápido); si no, se recodifica.
async function convertOne(q) {
  q.msg = 'Analizando…'; renderLists();
  const t = { file: q.file }; await probe(t, 'q');
  const copyOk = t.vc === 'h264' && (!t.ac || ['aac', 'mp3'].includes(t.ac));
  let f = null;
  if (copyOk) f = await tryConv(q, ['-c', 'copy'], 'Copiando a MP4').catch(() => null);
  return f ?? await tryConv(q, ENC, 'Recodificando');
}

async function processQueue() {
  if (working) return; working = true;
  try {
    await loadFFmpeg();
    let q;
    while ((q = queue.find(x => x.state === 'wait'))) {
      q.state = 'work';
      try {
        const f = await run(() => convertOne(q));
        queue.splice(queue.indexOf(q), 1);
        mp4s.push({ file: f, url: URL.createObjectURL(f) });
      } catch (e) { q.state = 'err'; q.msg = '❌ ' + emsg(e); }
      renderLists();
    }
    say(queue.length ? 'Terminado, con errores (ver la cola).' : '');
  } catch (e) { say('❌ No se pudo cargar FFmpeg: ' + emsg(e)); }
  working = false;
}

$('toEditor').onclick = () => {
  const list = mp4s.map(m => m.file); mp4s = []; renderLists();
  $('editor').hidden = false; addFiles(list);
  $('editor').scrollIntoView({ behavior: 'smooth', block: 'start' });
};

/* ---------- Paso 2: editor ---------- */
async function addFiles(list) {
  for (const file of list) clips.push({ file, url: URL.createObjectURL(file), start: 0, end: 0, dur: 0, sel: true, sig: 'Analizando…', vsig: '' });
  render();
  try { await loadFFmpeg(); } catch (e) { say('❌ No se pudo cargar FFmpeg: ' + emsg(e)); return; }
  for (const c of clips.filter(c => c.sig === 'Analizando…')) {
    try { await run(() => probe(c, clips.indexOf(c))); } catch (e) { c.sig = 'No se pudo analizar: ' + emsg(e); }
    render();
  }
}

const fmt = s => new Date(s * 1000).toISOString().slice(11, 22);

function render() {
  const box = $('clips'); box.innerHTML = '';
  const base = clips[0]?.vsig;
  clips.forEach((c, i) => {
    const el = document.createElement('div'); el.className = 'clip';
    const bad = c.vsig !== base;
    el.innerHTML = `<video controls preload="metadata" src="${c.url}"></video>
      <div><h3>${i + 1}. ${esc(c.file.name)}</h3>
      <div class="meta ${bad ? 'bad' : ''}">${esc(c.sig)}${bad ? ' ⚠️ distinto al clip 1: la unión puede fallar' : ''}</div>
      <div class="row">Inicio <input type="number" step="0.1" min="0" class="s" value="${c.start}">
        <button class="ghost" data-a="ps">📍 actual</button>
        Fin <input type="number" step="0.1" min="0" class="e" value="${c.end}">
        <button class="ghost" data-a="pe">📍 actual</button></div>
      <label class="meta"><input type="checkbox" class="sel" ${c.sel ? 'checked' : ''}> Marcado para «Borrar Principio»</label>
      <div class="meta" data-i>Duración: ${fmt(Math.max(0, c.end - c.start))}</div>
      <div class="row"><button class="ghost" data-a="trim">Borrar principio</button><button class="ghost" data-a="up">↑</button><button class="ghost" data-a="dn">↓</button><button class="ghost" data-a="rm">Quitar</button></div></div>`;
    const v = el.querySelector('video'), s = el.querySelector('.s'), e = el.querySelector('.e');
    const upd = () => { c.start = +s.value; c.end = +e.value; el.querySelector('[data-i]').textContent = `Duración: ${fmt(Math.max(0, c.end - c.start))}`; };
    v.onloadedmetadata = () => { c.dur = v.duration; if (!c.end) { c.end = +v.duration.toFixed(2); e.value = c.end; upd(); } };
    v.onerror = () => { const n = document.createElement('div'); n.className = 'meta'; n.textContent = 'Sin vista previa: el navegador no reproduce este formato. Escribe los tiempos en segundos.'; v.replaceWith(n); };
    el.querySelector('.sel').onchange = ev => { c.sel = ev.target.checked; };
    s.oninput = e.oninput = upd;
    el.onclick = ev => {
      const a = ev.target.dataset.a; if (!a) return;
      if (a === 'trim') { trimStart([c]); return; }
      if ((a === 'ps' || a === 'pe') && !v.isConnected) return;
      if (a === 'ps') { s.value = v.currentTime.toFixed(2); upd(); }
      if (a === 'pe') { e.value = v.currentTime.toFixed(2); upd(); }
      if (a === 'up' && i) [clips[i - 1], clips[i]] = [clips[i], clips[i - 1]];
      if (a === 'dn' && i < clips.length - 1) [clips[i + 1], clips[i]] = [clips[i], clips[i + 1]];
      if (a === 'rm') clips.splice(i, 1);
      if (['up', 'dn', 'rm'].includes(a)) render();
    };
    box.append(el);
  });
  $('export').disabled = !clips.length;
}

function trimStart(list) {
  const t = (+$('tmin').value || 0) * 60 + (+$('tsec').value || 0), skip = []; let ok = 0;
  if (!list.length) { $('tmsg').textContent = 'No hay vídeos marcados.'; return; }
  for (const c of list) {
    if (c.sig === 'Analizando…' || (c.end && t >= c.end)) { skip.push(c.file.name); continue; }
    c.start = t; ok++;
  }
  render();
  $('tmsg').textContent = `Inicio fijado en ${fmt(t).slice(0, 8)} en ${ok} vídeo(s)` + (skip.length ? `. Omitidos (más cortos o aún analizando): ${skip.join(', ')}` : '') + '. Con copia sin recodificar, el corte real puede caer unos segundos antes.';
}
$('tapply').onclick = () => trimStart($('tscope').value === 'all' ? clips : clips.filter(c => c.sel));
$('tall').onclick = () => { clips.forEach(c => c.sel = true); render(); };
$('tnone').onclick = () => { clips.forEach(c => c.sel = false); render(); };

async function exportVideo() {
  const btn = $('export'), prog = $('prog'), st = $('status');
  if (!clips.length || !clips.every(c => c.end > c.start)) { st.textContent = 'Revisa: el fin debe ser mayor que el inicio.'; return; }
  if (clips.some(c => c.sig === 'Analizando…')) { st.textContent = 'Espera a que termine el análisis de los vídeos.'; return; }
  const bad = clips.find(c => !/^(h264|hevc|mpeg4|mpeg2video)/.test(c.sig));
  if (bad) { st.textContent = `"${bad.file.name}" tiene un códec que no se puede copiar sin recodificar.`; return; }
  // Debe llamarse dentro del clic (antes de cualquier await largo)
  let writable = null;
  if (window.showSaveFilePicker) {
    try { writable = await (await showSaveFilePicker({ suggestedName: 'final.ts', types: [{ description: 'MPEG-TS', accept: { 'video/mp2t': ['.ts'] } }] })).createWritable(); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  btn.disabled = true; prog.hidden = false; $('dl').hidden = true;
  const n = clips.length; let step = 0, offset = 0; const blobParts = [];
  const onP = ({ progress }) => { prog.value = (step + Math.min(Math.max(progress, 0), 1)) / n; };
  ffmpeg.on('progress', onP);
  const t0 = performance.now();
  await run(async () => {
    try {
      for (let i = 0; i < n; i++, step++) {
        const c = clips[i], out = `p${i}.ts`;
        st.textContent = `Recortando ${i + 1}/${n}…`;
        await withMounted(c.file, i, p => ffmpeg.exec([
          '-ss', String(c.start), '-i', p, '-t', String(c.end - c.start),
          '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
          '-avoid_negative_ts', 'make_zero', '-muxdelay', '0', '-muxpreload', '0',
          '-output_ts_offset', String(offset), '-f', 'mpegts', out]));
        logBuf = []; await ffmpeg.exec(['-hide_banner', '-i', out]);
        const m = logBuf.join('\n').match(/Duration: (\d+):(\d+):([\d.]+)/);
        offset += m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : c.end - c.start;
        const data = await ffmpeg.readFile(out);
        if (writable) await writable.write(data); else blobParts.push(data);
        await ffmpeg.deleteFile(out);           // libera la RAM de wasm tras cada clip
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (writable) { await writable.close(); st.textContent = `✅ Guardado en disco en ${secs} s`; }
      else {
        const a = $('dl'); a.href = URL.createObjectURL(new Blob(blobParts, { type: 'video/mp2t' }));
        a.download = 'final.ts'; a.hidden = false; st.textContent = `✅ Listo en ${secs} s`;
      }
    } catch (err) { try { await writable?.abort(); } catch {} st.textContent = '❌ Error: ' + emsg(err) + ' (ver registro)'; }
  });
  ffmpeg.off('progress', onP); prog.hidden = true; btn.disabled = false;
}

$('files').onchange = e => { handleFiles([...e.target.files]); e.target.value = ''; };
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = e => { e.preventDefault(); $('drop').classList.remove('over'); handleFiles([...e.dataTransfer.files]); };
$('export').onclick = exportVideo;
renderLists();
loadFFmpeg().catch(e => say('❌ No se pudo cargar FFmpeg: ' + emsg(e)));
