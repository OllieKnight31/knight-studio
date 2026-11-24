// The words and targets of every walkthrough. tour.jsx does the showing.
//
// A step:
//   target  a CSS selector, or a function returning an element. Missing targets are
//           skipped, so a step about something that is not on screen never strands the tour.
//   title / body   what the card says
//   side    where the card sits relative to the highlight: right | left | top | bottom
//   tool    editor only — the tool to open before the step is shown
//   pad     extra space around the highlight, in px

const q = sel => document.querySelector(sel)

/** A group in the side panel, found by its heading. */
const group = heading => () => [...document.querySelectorAll('.panel .group')]
  .find(g => g.querySelector('.label')?.textContent.trim().toLowerCase().startsWith(heading.toLowerCase()))

/** A field (label + control) in the side panel, found by its label. */
const field = label => () => {
  const el = [...document.querySelectorAll('.panel .label')]
    .find(l => l.textContent.trim().toLowerCase().startsWith(label.toLowerCase()))
  return el?.closest('.field') || el?.parentElement || null
}

/** A button on the timeline toolbar, found by its tooltip title. */
const tbtn = title => () => [...document.querySelectorAll('.transport .tbtn')]
  .find(b => (b.dataset.tipTitle || '').toLowerCase().startsWith(title.toLowerCase()))

/** A button in the side panel, found by its text. */
const pbtn = text => () => [...document.querySelectorAll('.panel .btn')]
  .find(b => b.textContent.trim().toLowerCase().startsWith(text.toLowerCase()))

const panelTop = () => q('.panel .panel-head')
const panel = () => q('.panel')

export const TOURS = {
  /* ---------------------------------------------------------------- library */
  library: {
    name: 'The library',
    steps: [
      {
        target: '.topbar .btn.primary', side: 'bottom',
        title: 'Start here',
        body: 'Every video begins with a recording. Click this to choose what to capture — your screen, a single window, with or without your camera.'
      },
      {
        target: '.lib-side-scroll', side: 'right',
        title: 'Your videos, organised',
        body: '“All videos” shows everything. Add folders for each area of your business and click one to see only what is filed in it.'
      },
      {
        target: () => [...document.querySelectorAll('.lib-side .folder')].find(f => /New folder/.test(f.textContent)), side: 'right',
        title: 'Make a folder',
        body: 'Type a name and press Enter. If Google Drive is connected, the same folder is created in your Drive at the same moment.'
      },
      {
        target: '.grid .card', side: 'right',
        title: 'A recording',
        body: 'Hover to flick through it without opening it. Click to edit. Drag it onto a folder in the sidebar to file it — or use the folder button that appears in its corner.'
      },
      {
        target: '.lib-foot', side: 'right',
        title: 'Settings and Google Drive',
        body: 'Settings holds where files are saved, Google Drive, captions and a system check. The line above it tells you where your uploads are going.'
      },
      {
        target: '[data-tour="help"]', side: 'bottom',
        title: 'Lost? Come back here',
        body: 'This button replays the walkthrough for whichever screen you are on.'
      }
    ]
  },

  /* --------------------------------------------------------------- recorder */
  recorder: {
    name: 'Recording',
    steps: [
      {
        target: '.preview-frame', side: 'right',
        title: 'What will be recorded',
        body: 'A live preview of exactly what is about to be captured, with your camera in the corner if it is switched on.'
      },
      {
        target: '.perms', side: 'left',
        title: 'Permissions first',
        body: 'macOS has to allow each of these once. Screen Recording is essential; Accessibility is what makes automatic zoom work. Anything not green has an Allow button.'
      },
      {
        target: '.rec-panel', side: 'left',
        title: 'Choose your sources',
        body: 'Pick a whole display or one window, then your camera and microphone. The meter under the microphone shows whether you are loud enough before you start.'
      },
      {
        target: '.topbar .btn.primary', side: 'bottom',
        title: 'Record',
        body: 'A three-second countdown, then the app gets out of the way and a small bar appears with pause and stop. ⌘⇧8 also stops from anywhere.'
      },
      {
        target: '.rec-preview', side: 'right',
        title: 'Record in takes',
        body: 'When you stop you come back here. Record another take and it is added to the same video — so a mistake means re-doing one part, not the whole thing.'
      }
    ]
  },

  /* ------------------------------------------------------- editor: overview */
  editor: {
    name: 'The editor',
    steps: [
      {
        target: '.stage canvas', side: 'left',
        title: 'Your video',
        body: 'This is exactly what will be exported. You can drag the camera and any text directly on it to move them.'
      },
      {
        target: '.tools', side: 'right',
        title: 'The tools',
        body: 'Each one opens a different set of controls. Hover any of them for a description. Work top to bottom or jump straight to what you need.'
      },
      {
        target: panel, side: 'right',
        title: 'The controls',
        body: 'Whatever tool is selected, its controls appear here. Hover a control to see what it does. Every change shows on the video immediately.'
      },
      {
        target: '.transport', side: 'top',
        title: 'Play and edit',
        body: 'Play, split, delete, remove dead space, add a headline, undo. Space plays and pauses; ⌘Z undoes anything.'
      },
      {
        target: '.tl-scroll', side: 'top',
        title: 'The timeline',
        body: 'Your video laid out in time, with the sound drawn as a wave. Click anywhere to jump there. Below it sit your text and your zooms — drag them to move them.'
      },
      {
        target: () => [...document.querySelectorAll('.topbar .btn.primary')].find(b => b.textContent === 'Export'), side: 'bottom',
        title: 'Finish',
        body: 'When it looks right, export it as an MP4. If Google Drive is connected it uploads itself and hands you a link.'
      },
      {
        target: '[data-tour="section-help"]', side: 'right',
        title: 'A guide for every tool',
        body: 'Each tool has its own short walkthrough. It plays the first time you open the tool, and this button replays it.'
      }
    ]
  },

  /* ----------------------------------------------------------- editor tools */
  'editor:setup': {
    name: 'Setup',
    tool: 'setup',
    steps: [
      { target: field('Name'), side: 'right', title: 'Name it', body: 'This is the title in your library and the name of the exported file.' },
      { target: pbtn('Name it from'), side: 'right', title: 'Or let it name itself', body: 'Listens to what you said — or looks at the screen if you said nothing — and writes a title.' },
      { target: group('Canvas'), side: 'right', title: 'Choose the shape', body: 'Widescreen for YouTube and websites, square or 4:5 for feeds, 9:16 for Reels and Shorts. Change it any time; everything re-fits.' },
      { target: '[data-tour=templates]', side: 'right', title: 'Templates', body: 'Save how a video looks — background, camera bubble, cursor, caption style — and put it on any other video in one click, or on every new recording automatically.' }
    ]
  },

  'editor:cut': {
    name: 'Cut',
    tool: 'cut',
    steps: [
      { target: panelTop, side: 'right', title: 'Cutting happens on the timeline', body: 'This panel has the settings; the timeline below is where you actually cut. Nothing is ever destroyed — every cut can be put back.' },
      { target: '.tl-track.video', side: 'top', title: 'Trim by dragging', body: 'Each block is a section of your video. Drag the handle on either end to trim it. Click a block to select it.' },
      { target: tbtn('Split'), side: 'top', title: 'Split', body: 'Put the red playhead where you want a cut and press Split (or S). The video is now two sections you can treat separately.' },
      { target: tbtn('Delete'), side: 'top', title: 'Delete a section', body: 'Select a section and delete it. The gap closes up, and a small scissors marker is left behind — click that marker to bring the section back.' },
      { target: group('Remove dead space'), side: 'right', title: 'Remove the pauses', body: 'One click cuts out every stretch where nobody is speaking. The sliders decide how short a pause counts and how tight the cut is.' },
      { target: group('Removed from'), side: 'right', title: 'Everything you removed', body: 'A list of every cut in this clip. Restore any one of them, or all of them at once.' }
    ]
  },

  'editor:layout': {
    name: 'Layout',
    tool: 'layout',
    steps: [
      { target: '.panel .presets', side: 'right', title: 'How you and your screen share the frame', body: 'A camera bubble in the corner, side by side, screen only or camera only. Each clip can have its own layout.' },
      { target: group('Camera'), side: 'right', title: 'Shape and size the camera', body: 'Circle, rounded or square; bigger or smaller; zoom in on yourself to crop out the room; add a border.' },
      { target: '.stage canvas', side: 'left', title: 'Drag it into place', body: 'Grab the camera on the video and put it wherever you like.' },
      { target: group('Camera timing'), side: 'right', title: 'Lips and voice', body: 'The camera is lined up with your voice automatically. If one video ever looks slightly out, nudge it here.' }
    ]
  },

  'editor:zoom': {
    name: 'Zoom',
    tool: 'zoom',
    steps: [
      { target: field('Automatic zoom'), side: 'right', title: 'Zooms from your clicks', body: 'The app recorded where you clicked, and zooms in on those moments for you. Choose how eager it should be.' },
      { target: pbtn('Add zoom'), side: 'right', title: 'Add your own', body: 'Put the playhead where you want to zoom and add one. It appears on the timeline, selected and ready to adjust.' },
      { target: '.tl-track.zooms', side: 'top', title: 'Move and retime', body: 'Every zoom is a block here. Drag it to move it, drag an edge to make it longer or shorter, click it to change how far it zooms.' }
    ]
  },

  'editor:style': {
    name: 'Style',
    tool: 'style',
    steps: [
      { target: '.panel .swatches', side: 'right', title: 'The backdrop', body: 'The colour or gradient behind your recording. Pick a preset, or set your own colours just below.' },
      { target: pbtn('Use brand colours'), side: 'right', title: 'On brand in one click', body: 'Builds the background from the Ainable colours.' },
      { target: group('Frame'), side: 'right', title: 'How the recording sits', body: 'Padding is how much backdrop shows around it — zero is edge to edge. Round the corners, add a shadow or a border.' }
    ]
  },

  'editor:cursor': {
    name: 'Cursor',
    tool: 'cursor',
    steps: [
      { target: panelTop, side: 'right', title: 'A better mouse pointer', body: 'Your pointer is redrawn on top of the recording, so it can be larger and smoother than it really was.' },
      { target: field('Size'), side: 'right', title: 'Size and smoothness', body: 'Make it big enough to follow on a phone, and smooth out jittery movement.' },
      { target: group('Clicks'), side: 'right', title: 'Show your clicks', body: 'A press effect and a ripple on every click, so viewers see exactly where you pressed.' }
    ]
  },

  'editor:text': {
    name: 'Text',
    tool: 'text',
    steps: [
      { target: () => q('.panel .row'), side: 'right', title: 'Add text', body: 'A headline is a large title near the top. Text is a smaller line on a dark strip. Blur hides something private. Each one starts at the playhead.' },
      { target: '.stage canvas', side: 'left', title: 'Place it on the video', body: 'Drag the text on the video itself. The dashed outline shows which one is selected.' },
      { target: '.tl-track.text', side: 'top', title: 'Time it on the timeline', body: 'Each piece of text is a block. Drag it to change when it appears; drag an edge to change how long it stays.' },
      { target: group('On this video'), side: 'right', title: 'Edit any of them', body: 'Click one in this list to select it. Its wording, font, size, colour and position controls then appear above.' }
    ]
  },

  'editor:audio': {
    name: 'Audio',
    tool: 'audio',
    steps: [
      { target: field('Microphone'), side: 'right', title: 'Overall levels', body: 'Your voice and the computer’s own sound, set separately. Your voice is already levelled automatically; this is on top.' },
      { target: group('Selected section'), side: 'right', title: 'Volume for one part', body: 'Split the video on the timeline, click a section, and turn just that part up, down or off.' },
      { target: group('Background music'), side: 'right', title: 'Music', body: 'Choose a track and it loops quietly under the whole video. It is mixed in when you export.' }
    ]
  },

  'editor:subtitles': {
    name: 'Captions',
    tool: 'subtitles',
    steps: [
      { target: panelTop, side: 'right', title: 'Captions, and editing by text', body: 'Once a video is transcribed you can show captions on it, and cut the video simply by clicking words in the transcript.' },
      { target: () => pbtn('Transcribe')() || q('.panel .transcript'), side: 'right', title: 'Turn speech into text', body: 'Transcribing happens on this Mac — nothing is uploaded. It takes a moment the first time while the speech model downloads.' },
      { target: '.panel .transcript', side: 'right', title: 'Edit the video by editing the words', body: 'Click any word and it is cut out of the video. Shift-click a word to jump to it.' },
      { target: '[data-act=remove-fillers]', side: 'right', title: 'Remove filler words', body: 'Cuts every “um”, “uh” and “erm” out of the whole video in one press. They are highlighted in the transcript first, and one undo puts them all back.' },
      { target: pbtn('Remove pauses'), side: 'right', title: 'Tighten it up', body: 'Removes the gaps between words, and “Export SRT” saves a subtitle file for YouTube or LinkedIn.' },
      { target: group('Caption look'), side: 'right', title: 'Style the captions', body: 'Font, size, colour and position — or one word at a time, the punchy short-form style.' }
    ]
  },

  'editor:export': {
    name: 'Export',
    tool: 'export',
    steps: [
      { target: field('Frame rate'), side: 'right', title: 'Quality', body: '60 fps is smoothest for screen recordings; 30 makes a smaller file. “High” quality suits almost everything.' },
      { target: group('Google Drive'), side: 'right', title: 'Straight to Google Drive', body: 'With Drive connected, the finished video uploads into the folder it is filed in and you get a link to share.' },
      { target: '[data-tour=writeup]', side: 'right', title: 'Summary, chapters and a written SOP', body: 'Have the summary and chapters written from what you said, and turn the video into a step-by-step document with a screenshot for every step.' },
      { target: '[data-tour=share]', side: 'right', title: 'Share page', body: 'A link anyone can open to watch the video. It shows how many people watched and for how long, and gives you a code to embed the video in any page.' },
      { target: pbtn('Export MP4'), side: 'right', title: 'Export', body: 'Choose where to save it. A six-minute video takes about two minutes. When it is done you can open it, show it in Finder or copy its Drive link.' }
    ]
  }
}

/** The tours that belong to a screen, for "replay everything". */
export const TOUR_IDS = Object.keys(TOURS)
