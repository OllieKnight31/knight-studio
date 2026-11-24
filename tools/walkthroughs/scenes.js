// The tutorial videos, as data. One entry per video; each scene is one narrated frame.
//
//   say:  what the voice reads (also the captions). Written naturally; build.js spells
//         out acronyms for voices that need it.
//   cap:  the one-line instruction under the picture (<em> = emphasised)
//   html: the picture — a simplified ILLUSTRATION of the screen (never a copy of the real
//         site), with class "hl" on the thing to press
//
// The steps here must match the written guides in app/renderer/views/Databases.jsx and
// the Google Drive tab. Change one, change the other, then rebuild:
//   node tools/walkthroughs/build.js            all videos
//   node tools/walkthroughs/build.js notion     just one

const dots = '<div class="dots"><i></i><i></i><i></i></div>';
const win = (url, body, cls = '') => `<div class="win ${cls}"><div class="bar">${dots}<div class="url">${url}</div></div><div class="body">${body}</div></div>`;
const side = (brand, items, on) => `<div class="side"><div class="brand">${brand}</div>${items.map((t, i) => `<div class="it${i === on ? ' on' : ''}">${t}</div>`).join('')}</div>`;
const main = (h2, sub, inner) => `<div class="main"><h2>${h2}</h2>${sub ? `<div class="sub">${sub}</div>` : ''}${inner}<div class="tag">illustration</div></div>`;
const fld = (label, value, cls = '') => `<div class="fld"><label>${label}</label><div class="inp ${cls}">${value}</div></div>`;
const btn = (text, cls = '', tip = '') => `<span class="btn ${cls}"${tip ? ` data-tip="${tip}"` : ''}>${text}</span>`;
const row = (...kids) => `<div class="row">${kids.join('')}</div>`;
const chk = (t) => `<span class="chk"><i>✓</i>${t}</span>`;
const modal = (title, inner) => `<div class="modal"><div><h3>${title}</h3>${inner}</div></div>`;
const step = (ok, name) => `<div class="li"><b>${ok ? '✓' : '○'} ${name}</b><span>${ok ? 'passed' : ''}</span></div>`;

// Our own Settings window, simplified.
const TABS = ['Files', 'Google Drive', 'Databases', 'Share pages', 'Webhook', 'Captions &amp; titles', 'Recording', 'System check', 'Updates'];
const sett = (tab, heading, sub, inner) => win('<b>Settings</b>', side('Settings', TABS, TABS.indexOf(tab)) + main(heading, sub, inner), 'app');

module.exports = [
  // ─────────────────────────────── Google Drive ──────────────────────────────
  {
    id: 'drive', title: 'Connect Google Drive',
    intro: { k: 'Tutorial · about 2 minutes', h1: 'Connect Google Drive', p: 'Every exported video uploads itself, filed in Drive the same way it is filed in your library.',
      say: 'This tutorial connects Google Drive, so every video you export uploads itself and comes back with a link you can share. It takes about two minutes.' },
    scenes: [
      { cap: 'Open <em>Settings</em> and choose Google Drive',
        say: 'Open Settings with the cog at the bottom left, and choose Google Drive.',
        html: sett('Google Drive', 'Google Drive', 'Exported videos upload themselves', row(btn('Connect Google Drive', 'pri hl', 'Click'))) },
      { cap: 'Pick your Google account and press <em>Allow</em>',
        say: 'Press Connect Google Drive. Your browser opens on Google’s own sign-in page. Pick your account, and press Allow. The app can only see the folders and files it creates itself, never the rest of your Drive.',
        html: win('accounts.google.com/<b>signin</b>', main('Choose an account', 'to continue to the app', `<div class="li hl" data-tip="Choose yours"><b>you@yourcompany.com</b><span>Google Account</span></div><div class="li">Use another account</div>${row(btn('Allow', 'pri hl', 'Then click'), btn('Cancel'))}`)) },
      { cap: 'Name the <em>parent folder</em> and press Create',
        say: 'Back in the app, give the parent folder a name and press Create parent folder. Everything the app uploads goes inside this one folder. You can move or rename it in Drive later, and the app keeps following it.',
        html: sett('Google Drive', 'Parent folder', 'Everything goes inside one folder in your Drive', '<div class="note">Connected as <b>you@yourcompany.com</b></div>' + fld('Create it in My Drive', 'Company Videos', 'hl') + row(btn('Create parent folder', 'pri hl', 'Click'))) },
      { cap: 'Press <em>Test Google Drive now</em>',
        say: 'Now press Test Google Drive now. It creates a folder, uploads a file, reads it back, and removes both. Six ticks means it is working.',
        html: sett('Google Drive', 'Test the connection', 'Does for real what an export does', row(btn('Test Google Drive now', 'pri hl', 'Click')) + step(true, 'Sign in to Google') + step(true, 'Find the parent folder') + step(true, 'Create a folder inside it') + step(true, 'Upload a file into that folder')) },
      { cap: 'Make a folder in the library. It <em>appears in Drive</em> too',
        say: 'Finally, make a folder in your library. A green message confirms the same folder now exists in Google Drive, with a button to open it. Videos you file there upload into it when you export.',
        html: win('<b>Library</b>', side('Library', ['All videos', 'Not in a folder', 'Sales', '<span class="hl">+ New folder</span>'], 2) + main('Sales', '0 videos', '<div class="note">✓ “Sales” is in Google Drive, inside “Company Videos”. Checked just now.</div>' + row(btn('Open in Drive', 'hl'))), 'app') },
    ],
    outro: { h1: 'Google Drive is connected', list: ['Exports upload themselves', 'Library folders are mirrored in Drive', 'Each export gives you a link to share'],
      say: 'That is Google Drive connected. Every export now uploads itself into the matching folder, and gives you a link to share.' },
  },

  // ────────────────────────────────── Notion ─────────────────────────────────
  {
    id: 'notion', title: 'Connect Notion',
    intro: { k: 'Tutorial · about 4 minutes', h1: 'Connect Notion', p: 'Every exported video becomes a row in a Notion database you choose, with its link, length, folder and transcript.',
      say: 'This tutorial connects Notion, so every video you export is added to a Notion database of your choice, with its link, length, folder and transcript. It takes about four minutes, and you only do it once.' },
    scenes: [
      { cap: 'Open <em>notion.so/profile/integrations</em> and press New integration',
        say: 'First, open Notion’s integrations page from the link in the guide, and press New integration.',
        html: win('www.notion.so/<b>profile/integrations</b>', side('Notion', ['Integrations'], 0) + main('Integrations', 'Connect other tools to your workspace', row(btn('+ New integration', 'pri hl', 'Click')))) },
      { cap: 'Name it, choose your <em>workspace</em>, and Save',
        say: 'Give it a name, such as Video Library. Choose the workspace your database lives in, leave the type as Internal, and press Save.',
        html: win('www.notion.so/<b>profile/integrations</b>', side('Notion', ['Integrations'], 0) + main('New integration', '', fld('Integration name', 'Video Library') + fld('Associated workspace', 'Your Company ▾') + fld('Type', 'Internal') + row(btn('Save', 'pri hl', 'Click')))) },
      { cap: 'Press Show, then <em>copy</em> the Internal Integration Secret',
        say: 'On the next page, find Internal Integration Secret. Press Show, then Copy.',
        html: win('www.notion.so/<b>profile/integrations</b>', side('Notion', ['Configuration', 'Access'], 0) + main('Video Library', 'Configuration', fld('Internal Integration Secret', 'ntn_••••••••••••••••••••••••', 'hl') + row(btn('Show'), btn('Copy', 'hl', 'Click')))) },
      { cap: 'Paste it into <em>Integration secret</em> in the app',
        say: 'Back in the app, open Settings, then Databases, and paste it into the box called Integration secret.',
        html: sett('Databases', 'Notion', 'Add every exported video to a Notion database', fld('Integration secret', 'ntn_••••••••••••••••••••••••', 'hl') + fld('Database link', 'Paste the link to your Notion database', 'ph')) },
      { cap: 'In Notion, open your database as a <em>full page</em>',
        say: 'Now go to Notion and open the database you want your videos in. If you do not have one yet, make a new page and choose Table. Open it as a full page, not inside another page.',
        html: win('www.notion.so/<b>Video-Library-0123…cdef</b>', main('Video Library', 'Table', `<div class="grid">${Array.from({ length: 28 }, (_, i) => `<div>${i === 1 ? 'Name' : ''}</div>`).join('')}</div>`)) },
      { cap: 'Press <em>•••</em> → Connections → add your integration',
        say: 'This is the step people miss. Press the three dots at the top right, choose Connections, and add the integration you just made. Without this, Notion will not let the app see the database.',
        html: win('www.notion.so/<b>Video-Library-0123…cdef</b>', main('Video Library', 'Table', `${row(btn('Share'), btn('•••', 'hl'))}<div class="menu"><div>Copy link</div><div class="hl">Connections</div><div>Lock database</div></div> <div class="menu"><div class="hl" data-tip="Add your integration">Video Library</div></div>`)) },
      { cap: '<em>Copy the link</em> to the database',
        say: 'Then copy the link to the database. Press the three dots again and choose Copy link, or copy the address from your browser.',
        html: win('<span class="hl" data-tip="Copy this address">www.notion.so/yourcompany/<b>Video-Library-0123456789abcdef…</b></span>', main('Video Library', 'Table', `<div class="grid">${Array.from({ length: 28 }, (_, i) => `<div>${i === 1 ? 'Name' : ''}</div>`).join('')}</div>`)) },
      { cap: 'Paste it into <em>Database link</em>, Save, then Test connection',
        say: 'Paste that link into Database link, press Save, and then Test connection. The app adds the columns it needs for you, adds a test video, and removes it again. Five ticks means it is working.',
        html: sett('Databases', 'Notion', 'Add every exported video to a Notion database', fld('Database link', 'https://www.notion.so/yourcompany/Video-Library-0123…', 'hl') + row(btn('Save'), btn('Test connection', 'pri hl', 'Click')) + step(true, 'Sign in to Notion') + step(true, 'Find the database') + step(true, 'Check its columns')) },
    ],
    outro: { h1: 'Notion is connected', list: ['Every export adds a row to your database', 'Columns are created for you', 'The transcript goes inside each page'],
      say: 'That is Notion connected. From now on, every video you export appears in your database, with its link, its length, the folder it is filed in, and the full transcript inside the page.' },
  },

  // ───────────────────────────────── Airtable ────────────────────────────────
  {
    id: 'airtable', title: 'Connect Airtable',
    intro: { k: 'Tutorial · about 4 minutes', h1: 'Connect Airtable', p: 'Every exported video becomes a record in an Airtable table you choose.',
      say: 'This tutorial connects Airtable, so every video you export is added as a record in a table of your choice. It takes about four minutes.' },
    scenes: [
      { cap: 'Open <em>airtable.com/create/tokens</em> and press Create token',
        say: 'First, open Airtable’s tokens page from the link in the guide, and press Create new token.',
        html: win('airtable.com/<b>create/tokens</b>', side('Builder Hub', ['Personal access tokens'], 0) + main('Personal access tokens', 'A token is a password for one app', row(btn('Create new token', 'pri hl', 'Click')))) },
      { cap: 'Name it and add <em>three scopes</em>',
        say: 'Give the token a name. Then press Add a scope three times, and add these: data records write, schema bases read, and schema bases write. The last one lets the app create the columns for you.',
        html: win('airtable.com/<b>create/tokens/new</b>', side('Builder Hub', ['Personal access tokens'], 0) + main('Create token', '', fld('Name', 'Video Library') + '<div class="li"><span class="chip">data.records:write</span></div><div class="li"><span class="chip">schema.bases:read</span></div><div class="li"><span class="chip">schema.bases:write</span></div>' + row(btn('+ Add a scope', 'hl')))) },
      { cap: 'Under Access, <em>add the base</em> your table is in',
        say: 'Under Access, press Add a base, and choose the base your table lives in. The token only works for the bases you add here.',
        html: win('airtable.com/<b>create/tokens/new</b>', side('Builder Hub', ['Personal access tokens'], 0) + main('Create token', 'Access', row(btn('+ Add a base', 'hl', 'Click')) + '<div class="menu"><div class="hl" data-tip="Choose yours">Company Videos</div><div>Sales CRM</div><div>All current and future bases</div></div>')) },
      { cap: 'Press Create token and <em>copy it</em>. It is shown only once',
        say: 'Press Create token. Airtable shows the token once only, so copy it now.',
        html: win('airtable.com/<b>create/tokens</b>', main('Personal access tokens', '', modal('Your token has been created', fld('Token', 'pat••••••••••••••.••••••••••••••••', 'hl') + '<div class="note warn">Copy it now. You will not be able to see it again.</div>' + row(btn('Copy', 'pri hl', 'Click'), btn('Done'))))) },
      { cap: 'Paste it into <em>Access token</em> in the app',
        say: 'Back in the app, open Settings, then Databases, and paste it into Access token under Airtable.',
        html: sett('Databases', 'Airtable', 'Add every exported video to an Airtable table', fld('Access token', 'pat••••••••••••••.••••••••••••••••', 'hl') + fld('Table link', 'Paste the address of your table', 'ph')) },
      { cap: 'Open your table and <em>copy the address</em> from the browser',
        say: 'Now open the table you want your videos in, and copy the whole address from the top of your browser. It contains the base and the table.',
        html: win('<span class="hl" data-tip="Copy this address">airtable.com/<b>appAbC…/tblXyZ…</b>/viw…</span>', main('Videos', 'Grid view', `<div class="grid">${Array.from({ length: 28 }, (_, i) => `<div>${i === 1 ? 'Name' : ''}</div>`).join('')}</div>`)) },
      { cap: 'Paste it into <em>Table link</em>, Save, then Test connection',
        say: 'Paste it into Table link, press Save, and then Test connection. The app adds the columns it needs, adds a test record, and removes it again. Five ticks means it is working.',
        html: sett('Databases', 'Airtable', 'Add every exported video to an Airtable table', fld('Table link', 'https://airtable.com/appAbC…/tblXyZ…', 'hl') + row(btn('Save'), btn('Test connection', 'pri hl', 'Click')) + step(true, 'Sign in to Airtable') + step(true, 'Find the table') + step(true, 'Check its columns')) },
    ],
    outro: { h1: 'Airtable is connected', list: ['Every export adds a record to your table', 'Columns are created for you', 'Each record links to the video'],
      say: 'That is Airtable connected. Every video you export now appears as a record in your table, with a link to the video, its length, its folder and its transcript.' },
  },

  // ───────────────────────────────── Supabase ────────────────────────────────
  {
    id: 'supabase', title: 'Connect Supabase',
    intro: { k: 'Tutorial · about 5 minutes', h1: 'Connect Supabase', p: 'Every exported video becomes a row in your Supabase database, and the video file itself can be stored there too.',
      say: 'This tutorial connects Supabase, so every video you export is added as a row in your own database. Supabase can also store the video file itself. It takes about five minutes.' },
    scenes: [
      { cap: 'Open your project → <em>Project Settings</em> → API',
        say: 'First, open your project in Supabase. Go to Project Settings, and choose A P I.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/settings/api', side('Project Settings', ['General', '<span class="hl">API</span>', 'Database', 'Storage'], 1) + main('API settings', 'How apps talk to your project', fld('Project URL', 'https://abcdefgh.supabase.co'))) },
      { cap: '<em>Copy the Project URL</em> and paste it into the app',
        say: 'Copy the Project U R L. In the app, open Settings, then Databases, and paste it into Project address under Supabase.',
        html: sett('Databases', 'Supabase', 'Add every exported video to your Supabase database', fld('Project address', 'https://abcdefgh.supabase.co', 'hl') + fld('Key', 'Paste the service_role key', 'ph') + fld('Table name', 'videos')) },
      { cap: 'Reveal and copy the <em>service_role</em> key',
        say: 'Back in Supabase, on the same page, find the key called service role. Press Reveal, then Copy. This key can write to your database, which is why the app keeps it only on this computer and never shows it again.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/settings/api', side('Project Settings', ['General', 'API', 'Database', 'Storage'], 1) + main('Project API keys', 'Keys for talking to your project', '<div class="li"><b>anon</b><span>public</span></div><div class="li hl"><b>service_role</b><span>secret · ••••••••••••</span></div>' + row(btn('Reveal'), btn('Copy', 'hl', 'Click')))) },
      { cap: 'Paste it into <em>Key</em>, and press Save',
        say: 'Paste it into Key in the app, leave the table name as videos unless you want a different one, and press Save.',
        html: sett('Databases', 'Supabase', 'Add every exported video to your Supabase database', fld('Project address', 'https://abcdefgh.supabase.co') + fld('Key', '••••••••••••••••••••••••••••', 'hl') + fld('Table name', 'videos') + row(btn('Save', 'pri hl', 'Click'))) },
      { cap: 'Press <em>Copy the table setup</em>',
        say: 'Your database needs a table to hold the videos. Press Copy the table setup. It copies a few lines that create that table.',
        html: sett('Databases', 'Supabase', 'The table your videos go into', '<div class="code">create table if not exists public.videos (\n  id uuid primary key default gen_random_uuid(),\n  title text, video_url text, duration_seconds numeric, …\n);</div>' + row(btn('Copy the table setup', 'pri hl', 'Click'))) },
      { cap: 'In Supabase, open <em>SQL Editor</em>, paste, and press Run',
        say: 'In Supabase, open the S Q L Editor from the left menu. Paste what you copied, and press Run. It says Success. You only ever do this once.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/sql/new', side('Supabase', ['Table Editor', '<span class="hl">SQL Editor</span>', 'Storage'], 1) + main('New query', '', '<div class="code">create table if not exists public.videos (\n  id uuid primary key default gen_random_uuid(),\n  title text, video_url text, …\n);</div>' + row(btn('Run', 'grn hl', 'Click'), '<span class="ok">Success. No rows returned</span>'))) },
      { cap: 'Back in the app, press <em>Test connection</em>',
        say: 'Back in the app, press Test connection. It finds the table, adds a test video, and removes it again. Four ticks means it is working.',
        html: sett('Databases', 'Supabase', 'Add every exported video to your Supabase database', row(btn('Test connection', 'pri hl', 'Click')) + step(true, 'Reach the project') + step(true, 'Find the table') + step(true, 'Add a test video') + step(true, 'Remove the test video')) },
      { cap: 'Optional: <em>store the video file</em> in Supabase too',
        say: 'One optional extra. To keep the video file itself in Supabase, open Storage, create a bucket called videos, and make it public. Then, in the app, switch on Store the video file too. Large videos may need the upload limit raised in Storage settings.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/storage/buckets', side('Supabase', ['Table Editor', 'SQL Editor', '<span class="hl">Storage</span>'], 2) + main('Storage', 'Buckets hold files', modal('Create a new bucket', fld('Name of bucket', 'videos', 'hl') + row(chk('Public bucket')) + row(btn('Create bucket', 'grn hl', 'Click'))))) },
    ],
    outro: { h1: 'Supabase is connected', list: ['Every export adds a row to your table', 'The video file can be stored there too', 'Your key never leaves this computer'],
      say: 'That is Supabase connected. Every video you export now appears as a row in your own database, ready for anything you want to build on top of it.' },
  },

  // ─────────────────────────────── Share pages ───────────────────────────────
  {
    id: 'share', title: 'Set up share pages',
    intro: { k: 'Tutorial · about 4 minutes', h1: 'Set up share pages', p: 'A link anyone can open to watch a video, with chapters and a transcript, that counts views and watch time and can be embedded anywhere.',
      say: 'This tutorial sets up share pages. A share page is a link anyone can open to watch your video. It counts how many people watched and for how long, and it can be embedded in any web page. Your videos and your numbers stay in your own Supabase project. It takes about four minutes, and you need Supabase connected first.' },
    scenes: [
      { cap: 'Open <em>Settings</em> and choose Share pages',
        say: 'Open Settings, and choose Share pages. The first step should already say connected. If it does not, connect Supabase under Databases first, then come back.',
        html: sett('Share pages', 'Share pages', 'A link to watch, with view counts', step(true, 'Connect Supabase') + step(false, 'Create a public storage bucket') + step(false, 'Copy the public key') + step(false, 'Run the table setup')) },
      { cap: 'In Supabase, open <em>Storage</em> and press New bucket',
        say: 'In Supabase, open Storage from the left menu, and press New bucket.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/storage/buckets', side('Supabase', ['Table Editor', 'SQL Editor', '<span class="hl">Storage</span>'], 2) + main('Storage', 'Buckets hold files', row(btn('New bucket', 'grn hl', 'Click')))) },
      { cap: 'Name it <em>videos</em>, switch on Public bucket, and create it',
        say: 'Call it videos. Switch on Public bucket. This matters, because it is what lets other people play the video from your link. Then press Create bucket.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/storage/buckets', side('Supabase', ['Table Editor', 'SQL Editor', 'Storage'], 2) + main('Storage', 'Buckets hold files', modal('Create a new bucket', fld('Name of bucket', 'videos', 'hl') + row('<span class="chk hl"><i>✓</i>Public bucket</span>') + row(btn('Create bucket', 'grn hl', 'Click'))))) },
      { cap: 'Project Settings → API → copy the <em>anon public</em> key',
        say: 'Next, go to Project Settings, then A P I. Copy the key labelled anon public. Newer projects call it the publishable key. This is the key that is meant to be public. Do not copy the service role key here.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/settings/api', side('Project Settings', ['General', 'API', 'Database', 'Storage'], 1) + main('Project API keys', 'Keys for talking to your project', '<div class="li hl"><b>anon</b><span>public · eyJhbGciOi…</span></div><div class="li"><b>service_role</b><span>secret</span></div>' + row(btn('Copy', 'hl', 'Click')))) },
      { cap: 'Type the bucket name, paste the <em>public key</em>, and Save',
        say: 'Back in the app, type videos into Storage bucket, paste the key into Public key, and press Save.',
        html: sett('Share pages', 'Share pages', 'A link to watch, with view counts', fld('Storage bucket', 'videos') + fld('Public key', 'eyJhbGciOi…', 'hl') + row(btn('Save', 'pri hl', 'Click'))) },
      { cap: 'Press <em>Copy the table setup</em>',
        say: 'Now press Copy the table setup. It includes the view counter. If you ran an earlier version when you connected Supabase, run it again. It only adds what is missing.',
        html: sett('Share pages', 'Share pages', 'The view counter lives in your database', '<div class="code">create table if not exists public.video_views (\n  video text, session text, seconds numeric, …\n);\ncreate or replace function public.ks_record_view( … )</div>' + row(btn('Copy the table setup', 'pri hl', 'Click'))) },
      { cap: 'In Supabase, open <em>SQL Editor</em>, paste, and press Run',
        say: 'In Supabase, open the S Q L Editor, paste what you copied, and press Run. It says Success.',
        html: win('supabase.com/dashboard/project/<b>abcdefgh</b>/sql/new', side('Supabase', ['Table Editor', '<span class="hl">SQL Editor</span>', 'Storage'], 1) + main('New query', '', '<div class="code">create table if not exists public.video_views (\n  video text, session text, seconds numeric, …\n);</div>' + row(btn('Run', 'grn hl', 'Click'), '<span class="ok">Success. No rows returned</span>'))) },
      { cap: 'Back in the app, press <em>Test share pages</em>',
        say: 'Back in the app, press Test share pages. It stores a file, opens it the way a stranger would, counts a test view, reads the numbers back, checks the public key cannot see anything it should not, and cleans up. Seven ticks means it is working.',
        html: sett('Share pages', 'Share pages', 'Working, and counting views', row(btn('Test share pages', 'pri hl', 'Click')) + step(true, 'Store a file anyone can open') + step(true, 'Count a view') + step(true, 'Read the numbers back') + step(true, 'Check the public key is safe to publish')) },
      { cap: 'Export a video, then <em>Copy link</em> or Copy embed code',
        say: 'That is the setup done. From now on, when you export a video, the Export panel gives you its link. Press Copy link to send it to someone, or Copy embed code to put the video in a web page. Views and average watch time appear right there.',
        html: win('<b>Export</b>', main('Share page', 'A link anyone can open', '<div class="code">https://share.example.com/?p=abcdefgh&amp;b=videos&amp;v=k3J9xPq2Lm</div>' + row(btn('Copy link', 'pri hl', 'Click'), btn('Copy embed code'), btn('Open')) + '<div class="li"><b>12 views</b><span>average watch time 1:04 · 62% watched</span></div>'), 'app') },
    ],
    outro: { h1: 'Share pages are ready', list: ['Every export gets a link to send', 'Views and watch time are counted', 'Embed the video in any page'],
      say: 'Share pages are ready. Every video you export now gets a link you can send, a count of who watched, and a code to embed it anywhere.' },
  },

  // ───────────────────────────────── Webhook ─────────────────────────────────
  {
    id: 'webhook', title: 'Connect a webhook',
    intro: { k: 'Tutorial · about 3 minutes', h1: 'Connect a webhook', p: 'Tell Zapier, Make, n8n or any other tool the moment a video is exported, so it can carry on from there.',
      say: 'This tutorial connects a webhook. A webhook tells another tool the moment you export a video, so that tool can carry on from there: post it in Slack, add it to your C R M, or email it to a client. This example uses Zapier. Make and n 8 n work the same way. It takes about three minutes.' },
    scenes: [
      { cap: 'In Zapier, press <em>Create</em> and start a new Zap',
        say: 'In Zapier, press Create, and start a new Zap.',
        html: win('zapier.com/app/zaps', side('Zapier', ['Home', '<span class="hl">Zaps</span>', 'Tables'], 1) + main('Zaps', 'Automations', row(btn('Create', 'pri hl', 'Click')))) },
      { cap: 'For the trigger, choose <em>Webhooks by Zapier</em> → Catch Hook',
        say: 'For the trigger, search for Webhooks by Zapier, and choose the event called Catch Hook.',
        html: win('zapier.com/editor', main('Trigger', 'What starts this Zap', fld('App', 'Webhooks by Zapier', 'hl') + fld('Trigger event', 'Catch Hook', 'hl') + row(btn('Continue', 'pri')))) },
      { cap: '<em>Copy</em> the webhook address Zapier gives you',
        say: 'Zapier now shows a webhook address. It starts with hooks dot zapier dot com. Press Copy.',
        html: win('zapier.com/editor', main('Your webhook URL', 'Send requests to this address', fld('Webhook URL', 'https://hooks.zapier.com/hooks/catch/123456/abcdef/', 'hl') + row(btn('Copy', 'hl', 'Click')))) },
      { cap: 'In the app: <em>Settings → Webhook</em>, paste it, and Save',
        say: 'In the app, open Settings, and choose Webhook. Paste the address into Webhook address, and press Save. Leave the signing secret empty unless your tool asks for one.',
        html: sett('Webhook', 'Webhook', 'Tell another tool when a video is exported', fld('Webhook address', 'https://hooks.zapier.com/hooks/catch/123456/abcdef/', 'hl') + fld('Signing secret (optional)', 'Leave empty unless your tool asks for one', 'ph') + row(btn('Save', 'pri hl', 'Click'))) },
      { cap: 'Press <em>Send a test</em>',
        say: 'Press Send a test. The app sends a sample video, with every field filled in: the title, the links, the summary, the chapters, and the transcript.',
        html: sett('Webhook', 'Webhook', 'Working', row(btn('Send a test', 'pri hl', 'Click')) + step(true, 'Send a sample video')) },
      { cap: 'Back in Zapier, press <em>Test trigger</em> to see the sample',
        say: 'Back in Zapier, press Test trigger. The sample video appears, with all of its fields. That is what Zapier will receive after every export.',
        html: win('zapier.com/editor', main('Test trigger', 'We found a request', '<div class="li hl"><b>video title</b><span>Connection test — sample video</span></div><div class="li"><b>video shareLink</b><span>https://…</span></div><div class="li"><b>video summary</b><span>A sample summary…</span></div>' + row(btn('Continue with selected record', 'pri')))) },
      { cap: 'Add the <em>action</em> you want, then publish the Zap',
        say: 'Now add whatever should happen next. For example, a Slack message that includes the title and the share link. Then publish the Zap. From now on, every export triggers it.',
        html: win('zapier.com/editor', main('Action', 'What happens next', fld('App', 'Slack — Send Channel Message') + fld('Message', 'New video: {{video title}} — {{video shareLink}}', 'hl') + row(btn('Publish', 'pri hl', 'Click')))) },
    ],
    outro: { h1: 'The webhook is connected', list: ['Every export is announced automatically', 'Title, links, summary, chapters and transcript are included', 'Switch it off per video in the Export panel'],
      say: 'That is the webhook connected. Every video you export is now announced to your other tools automatically.' },
  },
];
