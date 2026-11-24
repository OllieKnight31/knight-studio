# Knight Studio

A screen and camera recorder for macOS with a built-in editor. Record your screen and
yourself together, cut and trim the take, remove the dead space, and export a finished
MP4. Think of it as a Loom replacement that runs on your own Mac: no account, no
subscription, no watermark, and nothing is uploaded unless you connect a service yourself.

Version 0.12.0. Built with Electron and React (the app), Swift (the capture engine) and
ffmpeg (audio and export).

## What it does

- **Record** the whole screen or one window at full retina resolution, 30 or 60 fps, with
  system audio, microphone and an optional camera bubble.
- **Record in clips.** Stack several takes, drop a bad one, reorder them, edit the lot as one video.
- **Edit on a timeline.** Trim, split (`S`), delete a section, and cut every silent pause in
  one click with **Dead space**. Every cut can be put back. Your original files are never altered.
- **Auto zoom** on your clicks, with four strengths, plus manual zooms.
- **Style it.** Backgrounds, padding, rounded corners, shadow, seven canvas shapes from 16:9 to 9:16.
- **Captions** made on your Mac (no upload), with SRT export.
- **Export** MP4 at 30 or 60 fps.
- Optional extras you can ignore: Google Drive upload, Notion / Airtable / Supabase rows,
  a webhook, share pages, AI titles and write-ups. Each needs your own account or key.

## What you need

| | |
|---|---|
| Mac | Apple silicon or Intel, macOS 15 (Sequoia) or later |
| Xcode command line tools | `xcode-select --install` (free, about 10 minutes) |
| Node.js | version 20 or later, from https://nodejs.org |
| Disk space | about 2.5 GB free while building (dependencies about 550 MB, build output about 900 MB) |
| Internet | for the one-off install (about 450 MB of downloads) |

No Apple Developer account is needed.

## Install and build

Open Terminal, go into this folder, then run these one at a time:

```bash
npm run setup        # installs dependencies, fetches ffmpeg, builds the capture engine
npm run release      # builds the app and installs it into /Applications
open -a "Knight Studio"
```

`npm run setup` is the same as running `npm install`, `bash scripts/fetch-ffmpeg.sh` and
`npm run native` yourself. `npm run release` takes a few minutes and finishes by copying
**Knight Studio.app** into your Applications folder. If a copy is already open it is closed first.

During `npm run release` you will see the line "signing identity not found, using ad-hoc
signing instead". That is normal on a new Mac and the app works. See "Keeping permissions
across rebuilds" below if you plan to rebuild often.

### Just want to try it without installing?

```bash
npm run setup
npm run dev
```

This opens the app straight from the source with live reload. macOS will list it as
"Electron" in the permission panes rather than "Knight Studio".

## Permissions to grant

The first launch opens **Settings, System check**. It lists everything the app relies on
with a status dot and an **Allow** button for each permission. Grant them once, before
your first recording.

| Permission | Needed for | If you skip it |
|---|---|---|
| Screen & System Audio Recording | the recording itself | recording fails |
| Accessibility | tracking clicks for auto zoom | you get a recording with no zooms |
| Camera | the camera bubble | camera is left out, screen still records |
| Microphone | your voice | no voice track |

Camera and Microphone show a normal macOS prompt. Screen Recording and Accessibility can
only be switched on by you: the Allow button opens the right pane in System Settings,
Privacy & Security. Turn on the switch next to Knight Studio, then quit and reopen the app
when macOS asks, and press **Check again**.

Accessibility is the one people miss. Without it the app still records, but auto zoom has
nothing to work from.

## Your first recording

1. Open Knight Studio and click **New recording**.
2. Pick the screen or window, your microphone, and a camera if you want to appear.
3. Check the four permission dots are green, then press record. A short countdown runs
   and a small floating bar appears with a timer, pause and stop.
4. Press **Stop** on the floating bar (or `Cmd+Shift+8`). The take opens in the editor.
5. In the editor: drag the ends of a block to trim, press `S` to split at the playhead,
   select a section and press Delete to remove it, or click **Dead space** to cut the pauses.
6. Press `E` (or the Export tool), choose the quality, and click **Export MP4**.

Recordings are kept in `~/Movies/Knight Studio/`. Exports go to Downloads unless you choose
another folder in Settings, Files.

Shortcuts that work from any app while Knight Studio is running: `Cmd+Shift+7` records the
screen, `Cmd+Shift+8` records screen plus camera, and `Cmd+Shift+8` again stops.

In the editor: `Space` play or pause, arrow keys step a frame, `S` split, Delete removes
the selection, `Cmd+Z` undo, `Shift+Cmd+Z` redo.

## Things to know before you rely on it

- **Opens at login by default.** The installed app adds itself to your login items so the
  shortcuts always work. Turn it off in Settings, Recording.
- **Captions** download a speech model the first time (about 150 MB, or about 490 MB for the
  more accurate one). After that they work offline.
- **AI titles and write-ups** are optional and need your own Claude or Gemini API key
  (Settings, Captions & titles). Without a key, recordings are named from their opening words.
- **Google Drive upload** needs your own Google OAuth client ID and secret, pasted into
  Settings, Google Drive. There is a walkthrough video in that panel.
- **Share pages** need your own Supabase project, and a hosted copy of the `share-viewer/`
  folder. The app ships with a placeholder share address (`share.example.com`), which is not serving
  pages at the time of writing, so host the folder yourself (it is a plain static site,
  any static host works) and paste its address into Settings, Share pages.
- **"Sharing with people"** (inviting viewers by email) is switched off in this copy. It
  needs a central Supabase project: see `cloud/README.md`, then fill in `knight.cloud` in
  `package.json` and rebuild.
- **Automatic updates** are switched off in this copy (no update address is set).

## Keeping permissions across rebuilds

macOS ties the four permissions to the app's signature. With ad-hoc signing the signature
changes on every rebuild, so macOS asks again each time you run `npm run release`. To stop
that, run this once, then rebuild:

```bash
bash build/make-identity.sh    # creates a self-signed certificate in your login keychain
npm run release
```

macOS may ask for your login password while it adds the certificate.

## Troubleshooting

| Problem | Fix |
|---|---|
| `xcrun: error` or `swiftc: command not found` | Run `xcode-select --install`, then `npm run setup` again. |
| `npm run setup` fails downloading Electron | Check the connection and run it again. |
| `no node_modules/ffmpeg-static/ffmpeg` | `npm install` did not finish. Run `npm run setup` again. |
| "knightcap binary not found" | Run `npm run native`. |
| "no build at release/mac-universal" | The build step failed earlier. Scroll up for the first error, fix it, run `npm run release` again. |
| The app is installed but macOS says it cannot be opened | System Settings, Privacy & Security, scroll down, **Open Anyway**. This only happens if you copied the app from another Mac. |
| Recording fails straight away | Screen & System Audio Recording is off, or was granted to an older build. Switch it off and on again in System Settings, then reopen the app. |
| Recording works but there are no zooms | Accessibility is off. Grant it, quit and reopen the app. Older takes cannot be fixed; record again. |
| Permissions are asked for again after every rebuild | See "Keeping permissions across rebuilds". |
| A permission dot stays red after you granted it | Quit the app fully (Cmd+Q) and reopen. If it persists, remove Knight Studio from that list in System Settings and grant it again. |
| `Cmd+Shift+7` or `8` does nothing | Another app owns that shortcut, or Knight Studio is not running. Use the Dock icon menu instead. |
| No sound from the microphone | Check the level meter in the recorder. The app can also raise the macOS input volume for you. |
| Captions say the model is missing | Open Settings, Captions & titles and download it. Needs internet once. |
| Export is slow or fails | Close other heavy apps and check free disk space. Run `npm run build:renderer` then `KS_DIST=1 KS_DEBUG=1 npm start` to see the detailed log. |

To remove the app: delete it from Applications, then delete `~/Movies/Knight Studio`
(your recordings) and `~/Library/Application Support/Knight Studio` (settings, keys,
speech models).

## For developers

```
native/src/     Swift capture engine (ScreenCaptureKit, AVAssetWriter, click tracking)
app/main/       Electron main process: capture bridge, project store, ffmpeg export, integrations
app/preload/    the API the window is allowed to call
app/shared/     auto zoom and the edit model, shared by preview and export
app/renderer/   React interface: library, recorder, editor, settings
scripts/        build, sign and install helpers
build/          icons, signing helpers and the test harness
share-viewer/   the static page share links open on
cloud/          database schema for the optional sharing service
tools/          builds the tutorial videos shown in Settings
```

Useful commands:

```bash
npm run dev                  # run from source with live reload
npm run check:ipc            # every channel the window calls has a handler
node build/db-check.mjs      # Notion, Airtable and Supabase flows against a stand-in server
node build/cloud-rules.mjs   # sharing access rules (needs: brew install postgresql@17 postgrest)
npm run package              # a zip of the app to hand to someone else
```

`npm run package` produces `release/Knight-Studio-<version>-mac-universal.zip` with an
install note inside. Without an Apple Developer ID the person receiving it has to approve
it once under System Settings, Privacy & Security, Open Anyway.

The bundled ffmpeg build is GPL licensed and whisper.cpp is MIT licensed. Their licence
files are copied into the app under `Contents/Resources/licenses`.
