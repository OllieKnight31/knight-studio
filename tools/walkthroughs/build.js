// Builds the narrated tutorial videos shown in Settings beside each connection.
//
//   node tools/walkthroughs/build.js                 all videos
//   node tools/walkthroughs/build.js sheets slack    only these videos
//
// Voice (VOICE=…):
//   kokoro: default when installed. A natural neural voice that runs on this machine: no
//             key, no account, no cost. Set up once with tools/walkthroughs/setup-voice.sh.
//             KOKORO_VOICE picks the speaker (default bm_fable; also af_heart, am_michael, bf_emma, bm_george, …).
//   gemini: Google Gemini AI voice. Needs GOOGLE_API_KEY (environment or ~/.claude/.env) with credit.
//   say: the built-in Mac voice. Always available, but robotic; the fallback only.
//
// For each scene in scenes.js it draws the frame as HTML, photographs it twice in headless
// Chrome (the highlight ring in two sizes, so it pulses), has the voice read the narration,
// and stitches picture + sound with ffmpeg. Output per video, in public/walkthroughs/:
//   <id>.mp4   the video        <id>.jpg   poster frame        <id>.vtt   captions
//
// Narration audio is cached by (voice, text), so changing a picture or re-running costs
// nothing; only new or reworded lines are sent to the voice.

const { spawn, spawnSync } = require('child_process');
const crypto = require('crypto');
const fs = require('fs');
const os = require('os');
const path = require('path');

const HERE = __dirname;
const OUT = path.join(HERE, '..', '..', 'public', 'walkthroughs');   // Vite copies public/ into the app
const WORK = path.join(HERE, '.work');
const CACHE = path.join(HERE, '.cache');
const KOKORO_DIR = process.env.KOKORO_DIR || path.join(os.homedir(), '.cache', 'eod-walkthrough-voice');
const KOKORO_PY = path.join(KOKORO_DIR, 'venv', 'bin', 'python');
const KOKORO_VOICE = process.env.KOKORO_VOICE || 'bm_fable';      // "Fable", British male, the house voice
const KOKORO_SPEED = process.env.KOKORO_SPEED || '1.0';
const VOICE = (process.env.VOICE || (fs.existsSync(KOKORO_PY) ? 'kokoro' : 'say')).toLowerCase();
const MAC_VOICE = process.env.MAC_VOICE || 'Samantha';
const GEMINI_VOICE = process.env.GEMINI_VOICE || 'Kore';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-2.5-flash-preview-tts';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = 1280, H = 720;
const PAD = 0.55;            // seconds of quiet after each line

const FFMPEG = fs.existsSync(path.join(HERE, '..', '..', 'vendor', 'bin', 'ffmpeg')) ? path.join(HERE, '..', '..', 'vendor', 'bin', 'ffmpeg') : 'ffmpeg';
const duration = (file) => {
  const r = spawnSync(FFMPEG, ['-hide_banner', '-i', file], { encoding: 'utf8' });
  const m = /Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/.exec(r.stderr || '');
  if (!m) throw new Error(`could not read the length of ${file}`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
};
const videos = require('./scenes.js');
const only = process.argv.slice(2);
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(`${cmd} failed: ${(r.stderr || '').split('\n').slice(-4).join(' ')}`);
  return r.stdout;
};

// ── Frames ──────────────────────────────────────────────────────────────────
const css = fs.readFileSync(path.join(HERE, 'frame.css'), 'utf8');
function frameHtml(video, frame, index, total) {
  const top = `<div class="top"><b>${video.title}</b><span class="step">${frame.kind === 'step' ? `Step <i>${frame.n}</i> of ${video.scenes.length}` : ''}</span></div>`;
  let body;
  if (frame.kind === 'step') {
    body = `<div class="stage">${frame.html}</div><div class="cap"><div class="n">${frame.n}</div><div class="t">${frame.cap}</div></div>`;
  } else {
    body = `<div class="title">${frame.k ? `<div class="k">${frame.k}</div>` : '<div class="k">Done</div>'}<h1>${frame.h1}</h1>`
      + (frame.p ? `<p>${frame.p}</p>` : '') + (frame.list ? `<ul>${frame.list.map(l => `<li>${l}</li>`).join('')}</ul>` : '') + '</div>';
  }
  const prog = `<div class="prog" style="width:${Math.round(((index + 1) / total) * 100)}%"></div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${top}${body}${prog}</body></html>`;
}

// ── Voice ───────────────────────────────────────────────────────────────────
// Spell out acronyms and odd tokens for the voices that would otherwise read them as words.
// Gemini doesn't need this.
const SPELL = [[/\bAPI\b/g, 'A P I'], [/\bJSON\b/g, 'jay son'], [/\bOAuth2\b/g, 'oh auth two'], [/\bOAuth\b/g, 'oh auth'], [/\bURL\b/g, 'U R L'], [/\bCRM\b/g, 'C R M'],
  [/\bIDs\b/g, 'I Dees'], [/\bID\b/g, 'I D'], [/\bSQL\b/g, 'S Q L'], [/\bSupabase\b/g, 'Soopa base'], [/\bxoxb\b/g, 'x o x b'], [/\bpit-/g, 'p i t dash'], [/\bapi_/g, 'a p i underscore'],
  [/sheets\.new/g, 'sheets dot new'], [/\/invite/g, 'slash invite']];
const spellOut = (text) => SPELL.reduce((t, [re, to]) => t.replace(re, to), text);

// Kokoro runs as one long-lived Python process so the model loads once per build.
let kokoro = null;
function kokoroSay(text, out) {
  if (!kokoro) {
    const proc = spawn(KOKORO_PY, [path.join(HERE, 'kokoro_tts.py'), path.join(KOKORO_DIR, 'kokoro-v1.0.onnx'), path.join(KOKORO_DIR, 'voices-v1.0.bin'), KOKORO_VOICE, KOKORO_SPEED],
      { stdio: ['pipe', 'pipe', 'pipe'] });
    let buffer = '', errors = '';
    const waiting = [];
    proc.stdout.on('data', (chunk) => {
      buffer += chunk;
      let nl;
      while ((nl = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, nl); buffer = buffer.slice(nl + 1);
        if (line.startsWith('ok ') && waiting.length) waiting.shift().resolve();
      }
    });
    proc.stderr.on('data', (c) => { errors = (errors + c).slice(-600); });
    proc.on('exit', (code) => { for (const w of waiting.splice(0)) w.reject(new Error(`Kokoro voice stopped (${code}): ${errors.trim().split('\n').pop()}`)); kokoro = null; });
    kokoro = { proc, waiting };
  }
  return new Promise((resolve, reject) => {
    kokoro.waiting.push({ resolve, reject });
    kokoro.proc.stdin.write(JSON.stringify({ text, out }) + '\n');
  });
}

function geminiKey() {
  if (process.env.GOOGLE_API_KEY) return process.env.GOOGLE_API_KEY;
  try {
    const m = /^(?:export\s+)?GOOGLE_API_KEY\s*=\s*["']?([^"'\n]+)["']?/m.exec(fs.readFileSync(path.join(os.homedir(), '.claude', '.env'), 'utf8'));
    return m ? m[1] : '';
  } catch { return ''; }
}

async function speak(text) {
  const tag = VOICE === 'gemini' ? `gemini:${GEMINI_MODEL}:${GEMINI_VOICE}` : VOICE === 'kokoro' ? `kokoro:${KOKORO_VOICE}:${KOKORO_SPEED}` : `say:${MAC_VOICE}`;
  const file = path.join(CACHE, crypto.createHash('sha1').update(`${tag}|${text}`).digest('hex') + '.wav');
  if (fs.existsSync(file)) return file;

  if (VOICE === 'gemini') {
    const key = geminiKey();
    if (!key) throw new Error('VOICE=gemini needs GOOGLE_API_KEY');
    for (let attempt = 0; ; attempt++) {
      const resp = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-goog-api-key': key },
        body: JSON.stringify({
          contents: [{ parts: [{ text: `Say in a clear, warm, unhurried tone, like a helpful colleague: ${text}` }] }],
          generationConfig: { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: GEMINI_VOICE } } } },
        }),
      });
      const data = await resp.json().catch(() => ({}));
      const part = data.candidates?.[0]?.content?.parts?.find(p => p.inlineData)?.inlineData;
      if (part) {
        const pcm = path.join(WORK, 'tts.pcm');
        fs.writeFileSync(pcm, Buffer.from(part.data, 'base64'));
        run(FFMPEG, ['-loglevel', 'error', '-y', '-f', 's16le', '-ar', '24000', '-ac', '1', '-i', pcm, file]);
        return file;
      }
      if (resp.status === 429 && attempt < 6) { await sleep(15000 * (attempt + 1)); continue; }   // rate limit, wait and retry
      throw new Error(`Gemini voice failed (${resp.status}): ${(data.error?.message || 'no audio returned').slice(0, 200)}`);
    }
  }

  if (VOICE === 'kokoro') {
    const raw = path.join(WORK, 'tts.wav');
    await kokoroSay(spellOut(text), raw);
    // a touch of loudness normalisation so every line sits at the same level
    run(FFMPEG, ['-loglevel', 'error', '-y', '-i', raw, '-af', 'loudnorm=I=-17:TP=-1.5:LRA=11', '-ar', '24000', '-ac', '1', file]);
    return file;
  }

  const aiff = path.join(WORK, 'tts.aiff');
  run('say', ['-v', MAC_VOICE, '-r', '172', '-o', aiff, spellOut(text)]);
  run(FFMPEG, ['-loglevel', 'error', '-y', '-i', aiff, '-ar', '24000', '-ac', '1', file]);
  return file;
}


const vttTime = (s) => { const ms = Math.round(s * 1000); const p = (n, l = 2) => String(n).padStart(l, '0'); return `${p(Math.floor(ms / 3600000))}:${p(Math.floor(ms / 60000) % 60)}:${p(Math.floor(ms / 1000) % 60)}.${p(ms % 1000, 3)}`; };

// ── Headless Chrome, driven over its debugging port ─────────────────────────
async function withChrome(fn) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'walkthrough-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, `--user-data-dir=${profile}`, `--window-size=${W},${H}`, '--hide-scrollbars', 'about:blank'], { stdio: 'ignore' });
  try {
    let targets;
    for (let i = 0; i < 480 && !targets; i++)   // a busy machine can take 30s+ to start Chrome
      { try { targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); } catch { await sleep(250); } }
    if (!targets) throw new Error('Chrome did not start');
    const ws = new WebSocket(targets.find(t => t.type === 'page').webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = rej; });
    let id = 0; const waiting = {};
    ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting[d.id]) { waiting[d.id](d); delete waiting[d.id]; } };
    const send = (method, params = {}) => new Promise(r => { const i = ++id; waiting[i] = r; ws.send(JSON.stringify({ id: i, method, params })); });
    await send('Page.enable');
    await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: false });
    const shoot = async (file) => {
      let r;
      for (let attempt = 0; attempt < 4; attempt++) {
        r = await send('Page.captureScreenshot', { format: 'png' });
        if (r.result) break;
        await sleep(700);
      }
      if (!r.result) throw new Error(`screenshot failed: ${JSON.stringify(r.error)}`);
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
    };
    await fn({
      // photograph one frame in both highlight states
      async frame(html, base) {
        const page = `${base}.html`;
        fs.writeFileSync(page, html);
        await send('Page.navigate', { url: 'file://' + page });
        await sleep(350);
        await shoot(`${base}_0.png`);
        await send('Runtime.evaluate', { expression: "document.body.classList.add('pulse')" });
        await sleep(80);
        await shoot(`${base}_1.png`);
      },
    });
    ws.close();
  } finally {
    chrome.kill();
    // Chrome may still be flushing its profile; cleaning up is best-effort and must never
    // hide a real error from the build.
    await sleep(600);
    try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* leave it for the OS */ }
  }
}

// ── Build ───────────────────────────────────────────────────────────────────
(async () => {
  for (const dir of [OUT, WORK, CACHE]) fs.mkdirSync(dir, { recursive: true });
  const todo = videos.filter(v => !only.length || only.includes(v.id));
  if (!todo.length) { console.error(`No such video. Known: ${videos.map(v => v.id).join(', ')}`); process.exit(1); }
  console.log(`Voice: ${VOICE === 'gemini' ? `Gemini (${GEMINI_VOICE})` : VOICE === 'kokoro' ? `Kokoro (${KOKORO_VOICE})` : `Mac (${MAC_VOICE})`}`);

  // One browser per video, and a couple of retries: a long-lived headless tab can drop out
  // from under us ("Not attached to an active page") on a busy machine. Narration is cached,
  // so a retry only re-photographs the frames.
  const buildVideo = async (video, chrome) => {
    const frames = [
      { kind: 'title', ...video.intro },
      ...video.scenes.map((s, i) => ({ kind: 'step', n: i + 1, ...s })),
      { kind: 'title', ...video.outro },
    ];
    const dir = path.join(WORK, video.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });

    const clips = [], cues = [];
    let clock = 0;
    for (const [i, frame] of frames.entries()) {
      const base = path.join(dir, `f${String(i).padStart(2, '0')}`);
      await chrome.frame(frameHtml(video, frame, i, frames.length), base);
      const audio = await speak(frame.say);
      const length = duration(audio) + PAD;
      // two stills alternating twice a second = the pulsing ring; scaled down from 2× for crisp text
      run(FFMPEG, ['-loglevel', 'error', '-y', '-framerate', '2', '-loop', '1', '-i', `${base}_%d.png`, '-i', audio,
        '-vf', `scale=${W}:${H}:flags=lanczos,fade=t=in:st=0:d=0.25`, '-af', 'apad', '-t', length.toFixed(2),
        '-r', '10', '-c:v', 'libx264', '-preset', 'slow', '-crf', '24', '-tune', 'stillimage', '-pix_fmt', 'yuv420p',
        '-c:a', 'aac', '-b:a', '72k', '-ar', '44100', '-ac', '1', `${base}.mp4`]);
      clips.push(`${base}.mp4`);
      cues.push(`${vttTime(clock + 0.05)} --> ${vttTime(clock + length - 0.15)}\n${frame.say}`);
      clock += length;
    }

    const list = path.join(dir, 'list.txt');
    fs.writeFileSync(list, clips.map(c => `file '${c}'`).join('\n'));
    run(FFMPEG, ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', '-movflags', '+faststart', path.join(OUT, `${video.id}.mp4`)]);
    run(FFMPEG, ['-loglevel', 'error', '-y', '-i', path.join(dir, 'f00_0.png'), '-vf', `scale=${W}:${H}:flags=lanczos`, '-q:v', '4', path.join(OUT, `${video.id}.jpg`)]);
    fs.writeFileSync(path.join(OUT, `${video.id}.vtt`), `WEBVTT\n\n${cues.join('\n\n')}\n`);
    const mb = fs.statSync(path.join(OUT, `${video.id}.mp4`)).size / 1048576;
    console.log(`  ${video.id.padEnd(16)} ${frames.length} frames  ${Math.round(clock)}s  ${mb.toFixed(1)} MB`);
  };
  for (const video of todo) {
    for (let attempt = 1; ; attempt++) {
      try { await withChrome((chrome) => buildVideo(video, chrome)); break; }
      catch (e) {
        if (attempt >= 3) throw new Error(`${video.id}: ${e.message}`);
        console.log(`  ${video.id}: ${e.message}, retrying (${attempt}/2)`);
      }
    }
  }

  // What the settings page needs to know: which videos exist, how long, which voice.
  const manifest = Object.fromEntries(videos.filter(v => fs.existsSync(path.join(OUT, `${v.id}.mp4`)))
    .map(v => [v.id, { title: v.title, seconds: Math.round(duration(path.join(OUT, `${v.id}.mp4`))) }]));
  fs.writeFileSync(path.join(OUT, 'index.json'), JSON.stringify({ voice: VOICE, videos: manifest }, null, 2) + '\n');
  if (kokoro) kokoro.proc.stdin.end();
  try { fs.rmSync(WORK, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* harmless */ }
  console.log(`Done → ${path.relative(process.cwd(), OUT)}`);
})().catch((e) => { console.error('✗ ' + e.message); if (kokoro) kokoro.proc.kill(); process.exit(1); });
