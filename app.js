const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
const $ = id => document.getElementById(id);
const emsg = e => String(e?.message ?? e);
const esc = s => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const say = m => { $('cstat').textContent = m; };
window.addEventListener('error', e => say('❌ Error: ' + emsg(e)));
window.addEventListener('unhandledrejection', e => say('❌ Error: ' + emsg(e.reason)));
$('log').textContent = 'app.js v15 cargado\n';

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

/* ---------- Paso 2: editor con diapositivas ---------- */
let cur = null, dragIdx = -1, stopFn = null, playerFor = null;
const fmt = s => new Date(Math.max(0, s) * 1000).toISOString().slice(11, 22);
const hms = s => fmt(s).slice(0, 8);

function makeThumb(c) {                       // fotograma de miniatura (si el navegador puede reproducirlo)
  return new Promise(res => {
    const v = document.createElement('video'); v.muted = true; v.preload = 'auto'; v.src = c.url;
    const done = t => { clearTimeout(to); v.removeAttribute('src'); v.load(); res(t); };
    const to = setTimeout(() => done(null), 8000);
    v.onloadeddata = () => { if (!c.end && isFinite(v.duration)) { c.end = +v.duration.toFixed(2); renderAll(); } v.currentTime = Math.min(1, (v.duration || 2) / 2); };
    v.onseeked = () => {
      try { const cv = document.createElement('canvas'); cv.width = 240; cv.height = Math.round(240 * v.videoHeight / v.videoWidth) || 135;
        cv.getContext('2d').drawImage(v, 0, 0, cv.width, cv.height); done(cv.toDataURL('image/jpeg', 0.6)); } catch { done(null); }
    };
    v.onerror = () => done(null);
  });
}

async function addFiles(list) {
  const added = [];
  for (const file of list) { const c = { file, url: URL.createObjectURL(file), start: 0, end: 0, dur: 0, mark: true, thumb: null, sig: 'Analizando…', vsig: '' }; clips.push(c); added.push(c); }
  if (!cur && clips.length) cur = clips[0];
  renderAll();
  added.forEach(c => makeThumb(c).then(t => { c.thumb = t; renderStrip(); }));
  try { await loadFFmpeg(); } catch (e) { say('❌ No se pudo cargar FFmpeg: ' + emsg(e)); return; }
  for (const c of clips.filter(c => c.sig === 'Analizando…')) {
    try { await run(() => probe(c, clips.indexOf(c))); } catch (e) { c.sig = 'No se pudo analizar: ' + emsg(e); }
    renderAll();
  }
}

function renderAll() { renderStrip(); refreshDetail(); }

function renderStrip() {
  const box = $('strip'); box.innerHTML = '';
  const base = clips[0]?.vsig;
  clips.forEach((c, i) => {
    const el = document.createElement('div'); el.className = 'slide' + (c === cur ? ' active' : ''); el.draggable = true;
    el.innerHTML = `<div class="th">${c.thumb ? `<img src="${c.thumb}" alt="">` : '🎞️'}<span class="n">${i + 1}</span></div>
      <div class="nm" title="${esc(c.file.name)}">${esc(c.file.name)}</div>
      <div class="tm">${hms(c.start)} → ${hms(c.end)}${c.vsig !== base ? ' ⚠️' : ''}</div>
      <label><input type="checkbox" ${c.mark ? 'checked' : ''}> marcado</label>`;
    const chk = el.querySelector('input');
    chk.onclick = e => e.stopPropagation();
    chk.onchange = e => { c.mark = e.target.checked; };
    el.onclick = () => select(c);
    el.ondragstart = e => { dragIdx = i; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/plain', String(i)); el.classList.add('drag'); };
    el.ondragend = () => { dragIdx = -1; renderStrip(); };
    el.ondragover = e => { e.preventDefault(); el.classList.add('over'); };
    el.ondragleave = () => el.classList.remove('over');
    el.ondrop = e => {
      e.preventDefault(); if (dragIdx < 0 || dragIdx === i) return;
      const [m] = clips.splice(dragIdx, 1); clips.splice(i, 0, m); dragIdx = -1; renderAll();
    };
    box.append(el);
  });
  $('export').disabled = !clips.length;
  $('detail').hidden = !cur;
}

function select(c) { cur = c; renderAll(); }

function refreshDetail() {
  const c = cur, p = $('player'); $('detail').hidden = !c; if (!c) return;
  if (playerFor !== c) {                      // el reproductor solo se recarga al cambiar de vídeo
    if (stopFn) p.removeEventListener('timeupdate', stopFn); stopFn = null;
    p.pause(); p.src = c.url; playerFor = c; $('dnote').textContent = '';
  }
  $('dname').textContent = `${clips.indexOf(c) + 1}. ${c.file.name}`;
  $('dsig').textContent = c.sig + (c.vsig !== clips[0]?.vsig ? ' ⚠️ distinto al clip 1: la unión puede fallar' : '');
  $('dstart').value = c.start; $('dend').value = c.end;
  $('ddur').textContent = `Duración del recorte: ${hms(c.end - c.start)}`;
}

const player = $('player');
player.onloadedmetadata = () => { if (cur && !cur.end && isFinite(player.duration)) { cur.end = +player.duration.toFixed(2); renderAll(); } };
player.onerror = () => { $('dnote').textContent = 'Sin vista previa: el navegador no reproduce este formato. Convierte a MP4 o escribe los tiempos a mano.'; };
const onTimes = () => { if (!cur) return; cur.start = +$('dstart').value; cur.end = +$('dend').value; $('ddur').textContent = `Duración del recorte: ${hms(cur.end - cur.start)}`; renderStrip(); };
$('dstart').oninput = $('dend').oninput = onTimes;
$('dps').onclick = () => { if (cur) { cur.start = +player.currentTime.toFixed(2); renderAll(); } };
$('dpe').onclick = () => { if (cur) { cur.end = +player.currentTime.toFixed(2); renderAll(); } };
$('dplay').onclick = () => {                  // reproduce solo el tramo entre Inicio y Fin
  if (!cur) return;
  if (stopFn) player.removeEventListener('timeupdate', stopFn);
  const c = cur; player.currentTime = c.start; player.play();
  stopFn = () => { if (player.currentTime >= c.end) { player.pause(); player.removeEventListener('timeupdate', stopFn); } };
  player.addEventListener('timeupdate', stopFn);
};
const move = d => { const i = clips.indexOf(cur), j = i + d; if (!cur || j < 0 || j >= clips.length) return; [clips[i], clips[j]] = [clips[j], clips[i]]; renderAll(); };
$('dleft').onclick = () => move(-1); $('dright').onclick = () => move(1);
$('drm').onclick = () => {
  const i = clips.indexOf(cur); if (i < 0) return;
  clips.splice(i, 1); cur = clips[i] ?? clips[i - 1] ?? null; playerFor = null;
  if (!cur) { player.pause(); player.removeAttribute('src'); player.load(); }
  renderAll();
};

function trimStart(list) {
  const t = (+$('tmin').value || 0) * 60 + (+$('tsec').value || 0), skip = []; let ok = 0;
  if (!list.length) { $('tmsg').textContent = 'No hay vídeos marcados.'; return; }
  for (const c of list) {
    if (c.sig === 'Analizando…' || (c.end && t >= c.end)) { skip.push(c.file.name); continue; }
    c.start = t; ok++;
  }
  renderAll();
  $('tmsg').textContent = `Inicio fijado en ${fmt(t).slice(0, 8)} en ${ok} vídeo(s)` + (skip.length ? `. Omitidos (más cortos o aún analizando): ${skip.join(', ')}` : '') + '. Con copia sin recodificar, el corte real puede caer unos segundos antes.';
}
$('dtrim').onclick = () => cur && trimStart([cur]);
$('tapply').onclick = () => trimStart($('tscope').value === 'all' ? clips : clips.filter(c => c.mark));
$('tall').onclick = () => { clips.forEach(c => c.mark = true); renderStrip(); };
$('tnone').onclick = () => { clips.forEach(c => c.mark = false); renderStrip(); };

async function exportVideo() {
  const btn = $('export'), prog = $('prog'), st = $('status'), asMp4 = $('fmt').value === 'mp4', ext = asMp4 ? 'mp4' : 'ts';
  if (!clips.length || !clips.every(c => c.end > c.start)) { st.textContent = 'Revisa: el fin debe ser mayor que el inicio.'; return; }
  if (clips.some(c => c.sig === 'Analizando…')) { st.textContent = 'Espera a que termine el análisis de los vídeos.'; return; }
  const bad = clips.find(c => !/^(h264|hevc|mpeg4|mpeg2video)/.test(c.sig));
  if (bad) { st.textContent = `"${bad.file.name}" tiene un códec que no se puede copiar sin recodificar.`; return; }
  // Debe llamarse dentro del clic (antes de cualquier await largo)
  let writable = null;
  if (window.showSaveFilePicker) {
    try { writable = await (await showSaveFilePicker({ suggestedName: 'final.' + ext, types: [asMp4 ? { description: 'MP4', accept: { 'video/mp4': ['.mp4'] } } : { description: 'MPEG-TS', accept: { 'video/mp2t': ['.ts'] } }] })).createWritable(); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  btn.disabled = true; prog.hidden = false; $('dl').hidden = true;
  const n = clips.length, steps = asMp4 ? n + 1 : n; let step = 0, offset = 0, size = 0; const blobParts = [], partFiles = [];
  const onP = ({ progress }) => { prog.value = (step + Math.min(Math.max(progress, 0), 1)) / steps; };
  ffmpeg.on('progress', onP);
  const t0 = performance.now();
  await run(async () => {
    try {
      for (let i = 0; i < n; i++, step++) {
        const c = clips[i], out = `p${i}.${ext}`;
        st.textContent = `Recortando ${i + 1}/${n}…`;
        await withMounted(c.file, i, p => ffmpeg.exec(['-ss', String(c.start), '-i', p, '-t', String(c.end - c.start),
          '-map', '0:v:0?', '-map', '0:a:0?', '-c', 'copy',
          ...(asMp4 ? ['-avoid_negative_ts', 'make_zero', out]
                    : ['-muxdelay', '0', '-muxpreload', '0', '-output_ts_offset', String(offset), '-f', 'mpegts', out])]));
        if (asMp4) {
          // La parte se saca de la memoria de FFmpeg; luego se monta como archivo para unirlas sin copiarlas.
          partFiles.push(new File([await ffmpeg.readFile(out)], out, { type: 'video/mp4' }));
        } else {
          logBuf = []; await ffmpeg.exec(['-hide_banner', '-i', out]);
          const m = logBuf.join('\n').match(/Duration: (\d+):(\d+):([\d.]+)/);
          offset += m ? +m[1] * 3600 + +m[2] * 60 + +m[3] : c.end - c.start;
          const data = await ffmpeg.readFile(out); size += data.length;
          if (writable) await writable.write(data); else blobParts.push(data);
        }
        await ffmpeg.deleteFile(out);           // libera la RAM de wasm tras cada clip
      }
      if (asMp4) {
        st.textContent = 'Uniendo en MP4…';
        await ffmpeg.createDir('/parts'); await ffmpeg.mount('WORKERFS', { files: partFiles }, '/parts');
        try {
          await ffmpeg.writeFile('list.txt', partFiles.map(f => `file '/parts/${f.name}'`).join('\n') + '\n');
          const code = await ffmpeg.exec(['-f', 'concat', '-safe', '0', '-i', 'list.txt', '-c', 'copy', 'final.mp4']);
          if (code !== 0) throw new Error('FFmpeg no pudo unir los vídeos en MP4 (¿códecs distintos?). Prueba el formato TS.');
        } finally { await ffmpeg.unmount('/parts'); await ffmpeg.deleteDir('/parts'); }
        const data = await ffmpeg.readFile('final.mp4'); size = data.length;
        await ffmpeg.deleteFile('final.mp4'); await ffmpeg.deleteFile('list.txt'); step++;
        if (writable) await writable.write(data); else blobParts.push(data);
      }
      const secs = ((performance.now() - t0) / 1000).toFixed(1), mb = (size / 1048576).toFixed(0);
      if (writable) { await writable.close(); st.textContent = `✅ Guardado en disco en ${secs} s (${mb} MB)`; }
      else {
        const a = $('dl'); a.href = URL.createObjectURL(new Blob(blobParts, { type: asMp4 ? 'video/mp4' : 'video/mp2t' }));
        a.download = 'final.' + ext; a.hidden = false; st.textContent = `✅ Listo en ${secs} s (${mb} MB)`;
      }
    } catch (err) { try { await writable?.abort(); } catch {} st.textContent = '❌ Error: ' + emsg(err) + (asMp4 ? ' (si es por memoria, prueba el formato TS)' : '') + ' (ver registro)'; }
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
