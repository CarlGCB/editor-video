const CORE = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
const $ = id => document.getElementById(id);
const emsg = e => String(e?.message ?? e);
const say = m => { const el = document.getElementById('status'); if (el) el.textContent = m; };
window.addEventListener('error', e => say('❌ Error: ' + emsg(e)));
window.addEventListener('unhandledrejection', e => say('❌ Error: ' + emsg(e.reason)));
document.getElementById('log').textContent = 'app.js v7 cargado\n';
const toBlobURL = async (url, type) => {
  const r = await fetch(url); if (!r.ok) throw new Error('no se pudo descargar ' + url);
  return URL.createObjectURL(new Blob([await r.arrayBuffer()], { type }));
};
let ffmpeg;
try { ffmpeg = new FFmpegWASM.FFmpeg(); }
catch (e) { $('status').textContent = '❌ Faltan archivos de la carpeta vendor (ffmpeg.js). Revisa que se subió a GitHub.'; }
let clips = [], ready = null, logBuf = [];

ffmpeg?.on('log', ({ message }) => { logBuf.push(message); $('log').textContent += message + '\n'; });

function loadFFmpeg() {
  return ready ??= (async () => {
    if (!ffmpeg) throw new Error('faltan los archivos de vendor/');
    $('status').textContent = 'Cargando FFmpeg (~30 MB, solo la primera vez)…';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${CORE}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${CORE}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    $('status').textContent = '';
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
  c.sig = `${v?.[1] ?? '?'} ${v?.[2] ?? ''} ${v?.[3] ?? ''}fps · ${a?.[1] ?? 'sin audio'} ${a?.[2] ?? ''}Hz`;
  const d = t.match(/Duration: (\d+):(\d+):([\d.]+)/);
  if (d) { c.dur = +d[1] * 3600 + +d[2] * 60 + +d[3]; if (!c.end) c.end = +c.dur.toFixed(2); }
  c.vsig = v ? `${v[1]}|${v[2]}|${v[3]}|${a?.[1]}|${a?.[2]}` : '';
}

async function addFiles(list) {
  for (const file of list) clips.push({ file, url: URL.createObjectURL(file), start: 0, end: 0, dur: 0, sig: 'Analizando…', vsig: '' });
  render();
  try { await loadFFmpeg(); } catch (e) { $('status').textContent = '❌ No se pudo cargar FFmpeg: ' + emsg(e); return; }
  for (const c of clips.filter(c => c.sig === 'Analizando…')) {
    try { await probe(c, clips.indexOf(c)); } catch (e) { c.sig = 'No se pudo analizar: ' + emsg(e); }
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
      <div><h3>${i + 1}. ${c.file.name}</h3>
      <div class="meta ${bad ? 'bad' : ''}">${c.sig}${bad ? ' ⚠️ distinto al clip 1: la unión puede fallar' : ''}</div>
      <div class="row">Inicio <input type="number" step="0.1" min="0" class="s" value="${c.start}">
        <button class="ghost" data-a="ps">📍 actual</button>
        Fin <input type="number" step="0.1" min="0" class="e" value="${c.end}">
        <button class="ghost" data-a="pe">📍 actual</button></div>
      <div class="meta" data-i>Duración: ${fmt(Math.max(0, c.end - c.start))}</div>
      <div class="row"><button class="ghost" data-a="up">↑</button><button class="ghost" data-a="dn">↓</button><button class="ghost" data-a="rm">Quitar</button></div></div>`;
    const v = el.querySelector('video'), s = el.querySelector('.s'), e = el.querySelector('.e');
    const upd = () => { c.start = +s.value; c.end = +e.value; el.querySelector('[data-i]').textContent = `Duración: ${fmt(Math.max(0, c.end - c.start))}`; };
    v.onloadedmetadata = () => { c.dur = v.duration; if (!c.end) { c.end = +v.duration.toFixed(2); e.value = c.end; upd(); } };
    v.onerror = () => { const n = document.createElement('div'); n.className = 'meta'; n.textContent = 'Sin vista previa: el navegador no reproduce este formato. Escribe los tiempos en segundos.'; v.replaceWith(n); };
    s.oninput = e.oninput = upd;
    el.onclick = ev => {
      const a = ev.target.dataset.a; if (!a) return;
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

async function exportVideo() {
  const btn = $('export'), prog = $('prog');
  if (!clips.length || !clips.every(c => c.end > c.start)) { $('status').textContent = 'Revisa: el fin debe ser mayor que el inicio.'; return; }
  const bad = clips.find(c => !/^(h264|hevc|mpeg4|mpeg2video)/.test(c.sig));
  if (bad) { $('status').textContent = `"${bad.file.name}" tiene un códec que no se puede copiar sin recodificar (se admiten H.264, H.265, MPEG-4/Xvid y MPEG-2).`; return; }
  // Debe llamarse dentro del clic (antes de cualquier await largo)
  let writable = null;
  if (window.showSaveFilePicker) {
    try { writable = await (await showSaveFilePicker({ suggestedName: 'final.ts', types: [{ description: 'MPEG-TS', accept: { 'video/mp2t': ['.ts'] } }] })).createWritable(); }
    catch (e) { if (e.name === 'AbortError') return; }
  }
  btn.disabled = true; prog.hidden = false; $('dl').hidden = true;
  const n = clips.length; let step = 0, offset = 0; const blobParts = [];
  ffmpeg.on('progress', ({ progress }) => { prog.value = (step + Math.min(Math.max(progress, 0), 1)) / n; });
  const t0 = performance.now();
  try {
    for (let i = 0; i < n; i++, step++) {
      const c = clips[i], out = `p${i}.ts`;
      $('status').textContent = `Recortando ${i + 1}/${n}…`;
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
    if (writable) { await writable.close(); $('status').textContent = `✅ Guardado en disco en ${((performance.now() - t0) / 1000).toFixed(1)} s`; }
    else {
      const a = $('dl'); a.href = URL.createObjectURL(new Blob(blobParts, { type: 'video/mp2t' }));
      a.download = 'final.ts'; a.hidden = false;
      $('status').textContent = `✅ Listo en ${((performance.now() - t0) / 1000).toFixed(1)} s`;
    }
  } catch (err) { try { await writable?.abort(); } catch {} $('status').textContent = '❌ Error: ' + emsg(err) + ' (ver registro)'; }
  prog.hidden = true; btn.disabled = false;
}

$('files').onchange = e => { const l = [...e.target.files]; say(`Recibido: ${l.length} archivo(s)`); addFiles(l); e.target.value = ''; };
$('drop').ondragover = e => { e.preventDefault(); $('drop').classList.add('over'); };
$('drop').ondragleave = () => $('drop').classList.remove('over');
$('drop').ondrop = e => { e.preventDefault(); $('drop').classList.remove('over'); addFiles([...e.dataTransfer.files].filter(f => f.type.startsWith('video/'))); };
$('export').onclick = exportVideo;
loadFFmpeg().catch(e => $('status').textContent = '❌ No se pudo cargar FFmpeg: ' + emsg(e));


// ---- Conversor a MP4 (se inserta solo, sin tocar index.html) ----
(() => {
  const st = document.createElement('style');
  st.textContent = '#cmode{padding:8px;border-radius:6px;border:1px solid var(--mut);background:transparent;color:inherit}#cmode option{background:var(--card)}';
  document.head.append(st);
  const sec = document.createElement('section'); sec.className = 'clip';
  sec.innerHTML = `<div style="grid-column:1/-1"><h2 style="margin:0 0 8px;font-size:1.1rem">🔄 Convertir vídeo a MP4</h2>
    <div class="meta">«Rápido» solo cambia el contenedor (segundos, sin perder calidad), pero el navegador puede seguir sin reproducirlo. «Recodificar» lo pasa a H.264 (se reproduce en todas partes) pero es lento: prueba antes con un trozo corto.</div>
    <div class="row"><input type="file" id="cfile" accept="video/*,.avi,.mkv,.wmv,.flv">
      <select id="cmode"><option value="copy">Rápido (copiar)</option><option value="enc">Recodificar H.264 (lento)</option></select>
      <button id="cgo" disabled>Convertir</button></div>
    <div class="row"><progress id="cprog" value="0" max="1" hidden></progress><span id="cstat" class="meta"></span></div>
    <a id="cdl" class="dl" hidden>⬇️ Descargar MP4</a></div>`;
  document.querySelector('main').insertBefore(sec, document.querySelector('details'));
  const g = id => document.getElementById(id);
  let file = null;
  g('cfile').onchange = e => { file = e.target.files[0] || null; g('cgo').disabled = !file; g('cdl').hidden = true; g('cstat').textContent = ''; };
  g('cgo').onclick = async () => {
    if (!file) return;
    const outName = file.name.replace(/\.[^.]+$/, '') + '.mp4';
    let writable = null;
    if (window.showSaveFilePicker) {
      try { writable = await (await showSaveFilePicker({ suggestedName: outName, types: [{ description: 'MP4', accept: { 'video/mp4': ['.mp4'] } }] })).createWritable(); }
      catch (e) { if (e.name === 'AbortError') return; }
    }
    const go = g('cgo'), pr = g('cprog'), stat = g('cstat');
    go.disabled = true; g('cdl').hidden = true; pr.hidden = false; pr.value = 0;
    const onP = ({ progress }) => { pr.value = Math.min(Math.max(progress, 0), 1); stat.textContent = `Convirtiendo… ${(pr.value * 100).toFixed(0)} %`; };
    const t0 = performance.now();
    try {
      await loadFFmpeg();
      ffmpeg.on('progress', onP);
      stat.textContent = 'Convirtiendo…';
      const args = g('cmode').value === 'copy'
        ? ['-c', 'copy']
        : ['-c:v', 'libx264', '-preset', 'ultrafast', '-crf', '23', '-pix_fmt', 'yuv420p', '-c:a', 'aac', '-b:a', '128k'];
      const code = await withMounted(file, 'c', p => ffmpeg.exec(['-i', p, '-map', '0:v:0', '-map', '0:a:0?', ...args, '-movflags', '+faststart', 'out.mp4']));
      if (code !== 0) throw new Error('FFmpeg no pudo convertirlo. Si usaste «Rápido», prueba «Recodificar» (ver registro).');
      const data = await ffmpeg.readFile('out.mp4'); await ffmpeg.deleteFile('out.mp4');
      const secs = ((performance.now() - t0) / 1000).toFixed(1);
      if (writable) { await writable.write(data); await writable.close(); writable = null; stat.textContent = `✅ Guardado en ${secs} s (${(data.length / 1e6).toFixed(0)} MB)`; }
      else { const a = g('cdl'); a.href = URL.createObjectURL(new Blob([data.buffer], { type: 'video/mp4' })); a.download = outName; a.hidden = false; stat.textContent = `✅ Listo en ${secs} s (${(data.length / 1e6).toFixed(0)} MB)`; }
    } catch (err) { try { await writable?.abort(); } catch {} stat.textContent = '❌ ' + emsg(err); }
    ffmpeg?.off('progress', onP); pr.hidden = true; go.disabled = false;
  };
})();
