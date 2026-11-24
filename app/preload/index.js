'use strict'
const { contextBridge, ipcRenderer } = require('electron')

/** The only surface the renderer gets. Everything crosses an explicit IPC channel. */
const api = {
  devices: {
    list: () => ipcRenderer.invoke('devices:list'),
    requestPermissions: () => ipcRenderer.invoke('devices:requestPermissions')
  },
  projects: {
    list: () => ipcRenderer.invoke('projects:list'),
    create: (name, folderId) => ipcRenderer.invoke('projects:create', name, folderId),
    load: id => ipcRenderer.invoke('projects:load', id),
    save: p => ipcRenderer.invoke('projects:save', p),
    remove: id => ipcRenderer.invoke('projects:delete', id),
    reveal: id => ipcRenderer.invoke('projects:reveal', id),
    events: clipDir => ipcRenderer.invoke('clips:events', clipDir),
    thumbs: clipDir => ipcRenderer.invoke('clips:thumbs', clipDir),
    thumbsCached: clipDir => ipcRenderer.invoke('clips:thumbsCached', clipDir),
    waveform: clipDir => ipcRenderer.invoke('clips:waveform', clipDir),
    measureCamera: clipDir => ipcRenderer.invoke('clips:measureCamera', clipDir),
    retitle: (projectId, clipId) => ipcRenderer.invoke('clips:retitle', projectId, clipId),
    onFinalise: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('finalise:progress', handler)
      return () => ipcRenderer.removeListener('finalise:progress', handler)
    },
    deleteClip: (projectId, clipId) => ipcRenderer.invoke('clips:delete', projectId, clipId),
    reorderClips: (projectId, from, to) => ipcRenderer.invoke('clips:reorder', projectId, from, to)
  },
  record: {
    start: opts => ipcRenderer.invoke('record:start', opts),
    pause: () => ipcRenderer.invoke('record:pause'),
    resume: () => ipcRenderer.invoke('record:resume'),
    stop: () => ipcRenderer.invoke('record:stop'),
    state: () => ipcRenderer.invoke('record:state'),
    on: (channel, fn) => {
      const allowed = ['record:event', 'record:error', 'record:complete', 'record:failed', 'record:countdown']
      if (!allowed.includes(channel)) throw new Error(`unknown channel ${channel}`)
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on(channel, handler)
      return () => ipcRenderer.removeListener(channel, handler)
    }
  },
  exportVideo: {
    mux: args => ipcRenderer.invoke('export:mux', args),
    probe: file => ipcRenderer.invoke('export:probe', file),
    loudness: clipDir => ipcRenderer.invoke('export:loudness', clipDir),
    chooseTarget: name => ipcRenderer.invoke('export:chooseTarget', name),
    beginTemp: name => ipcRenderer.invoke('export:beginTemp', name),
    writeChunk: (token, data, position) => ipcRenderer.invoke('export:writeChunk', token, data, position),
    closeTemp: token => ipcRenderer.invoke('export:closeTemp', token),
    discardTemp: token => ipcRenderer.invoke('export:discardTemp', token)
  },
  system: {
    openPrivacy: which => ipcRenderer.invoke('system:openPrivacy', which),
    askMedia: kind => ipcRenderer.invoke('system:askMedia', kind),
    askAccessibility: () => ipcRenderer.invoke('system:askAccessibility'),
    relaunch: () => ipcRenderer.invoke('app:relaunch'),
    sources: size => ipcRenderer.invoke('sources:list', size),
    inputVolume: () => ipcRenderer.invoke('system:inputVolume'),
    setInputVolume: v => ipcRenderer.invoke('system:setInputVolume', v),
    check: () => ipcRenderer.invoke('system:check')
  },
  ui: {
    onNavigate: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('ui:navigate', handler)
      return () => ipcRenderer.removeListener('ui:navigate', handler)
    }
  },
  prefs: {
    read: () => ipcRenderer.invoke('prefs:read'),
    write: patch => ipcRenderer.invoke('prefs:write', patch)
  },
  transcribe: {
    available: () => ipcRenderer.invoke('transcribe:available'),
    read: clipDir => ipcRenderer.invoke('transcribe:read', clipDir),
    run: args => ipcRenderer.invoke('transcribe:clip', args),
    onProgress: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('transcribe:progress', handler)
      return () => ipcRenderer.removeListener('transcribe:progress', handler)
    }
  },
  settings: {
    pickDirectory: opts => ipcRenderer.invoke('settings:pickDirectory', opts),
    libraryDir: () => ipcRenderer.invoke('settings:libraryDir'),
    setLibraryDir: args => ipcRenderer.invoke('settings:setLibraryDir', args),
    onMoveProgress: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('settings:moveProgress', handler)
      return () => ipcRenderer.removeListener('settings:moveProgress', handler)
    }
  },
  library: {
    get: () => ipcRenderer.invoke('library:get'),
    createFolder: name => ipcRenderer.invoke('library:createFolder', name),
    renameFolder: (id, name) => ipcRenderer.invoke('library:renameFolder', id, name),
    deleteFolder: id => ipcRenderer.invoke('library:deleteFolder', id),
    verifyFolder: id => ipcRenderer.invoke('library:verifyFolder', id),
    moveProject: (projectId, folderId) => ipcRenderer.invoke('library:moveProject', projectId, folderId)
  },
  drive: {
    isConfigured: () => ipcRenderer.invoke('drive:isConfigured'),
    status: () => ipcRenderer.invoke('drive:status'),
    setParent: link => ipcRenderer.invoke('drive:setParent', link),
    createParent: name => ipcRenderer.invoke('drive:createParent', name),
    clearParent: () => ipcRenderer.invoke('drive:clearParent'),
    sync: () => ipcRenderer.invoke('drive:sync'),
    test: () => ipcRenderer.invoke('drive:test'),
    signIn: () => ipcRenderer.invoke('drive:signIn'),
    cancelSignIn: () => ipcRenderer.invoke('drive:cancelSignIn'),
    signOut: () => ipcRenderer.invoke('drive:signOut'),
    setClient: client => ipcRenderer.invoke('drive:setClient', client),
    upload: args => ipcRenderer.invoke('drive:upload', args),
    onProgress: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('drive:progress', handler)
      return () => ipcRenderer.removeListener('drive:progress', handler)
    }
  },
  databases: {
    status: () => ipcRenderer.invoke('databases:status'),
    save: (which, config) => ipcRenderer.invoke('databases:save', which, config),
    disconnect: which => ipcRenderer.invoke('databases:disconnect', which),
    test: which => ipcRenderer.invoke('databases:test', which),
    send: args => ipcRenderer.invoke('databases:send', args)
  },
  captions: {
    status: () => ipcRenderer.invoke('captions:status'),
    downloadModel: name => ipcRenderer.invoke('captions:downloadModel', name),
    removeModel: name => ipcRenderer.invoke('captions:removeModel', name),
    onModelProgress: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('captions:modelProgress', handler)
      return () => ipcRenderer.removeListener('captions:modelProgress', handler)
    }
  },
  ai: {
    status: () => ipcRenderer.invoke('ai:status'),
    setKey: (which, value) => ipcRenderer.invoke('ai:setKey', which, value),
    analyse: args => ipcRenderer.invoke('ai:analyse', args),
    buildSop: args => ipcRenderer.invoke('sop:build', args)
  },
  share: {
    status: () => ipcRenderer.invoke('share:status'),
    save: patch => ipcRenderer.invoke('share:save', patch),
    test: () => ipcRenderer.invoke('share:test'),
    publish: args => ipcRenderer.invoke('share:publish', args),
    forProject: projectId => ipcRenderer.invoke('share:forProject', projectId),
    unpublish: info => ipcRenderer.invoke('share:unpublish', info),
    stats: id => ipcRenderer.invoke('share:stats', id),
    onProgress: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('share:progress', handler)
      return () => ipcRenderer.removeListener('share:progress', handler)
    }
  },
  cloud: {
    status: () => ipcRenderer.invoke('cloud:status'),
    save: patch => ipcRenderer.invoke('cloud:save', patch),
    requestCode: email => ipcRenderer.invoke('cloud:requestCode', email),
    verify: (email, code) => ipcRenderer.invoke('cloud:verify', email, code),
    refresh: () => ipcRenderer.invoke('cloud:refresh'),
    signOut: () => ipcRenderer.invoke('cloud:signOut'),
    publish: args => ipcRenderer.invoke('cloud:publish', args),
    remove: id => ipcRenderer.invoke('cloud:remove', id),
    links: (id, aspect) => ipcRenderer.invoke('cloud:links', id, aspect),
    sharing: id => ipcRenderer.invoke('cloud:sharing', id),
    share: (id, emails, opts) => ipcRenderer.invoke('cloud:share', id, emails, opts),
    unshare: (id, email, folder) => ipcRenderer.invoke('cloud:unshare', id, email, folder),
    setAccess: (id, access) => ipcRenderer.invoke('cloud:setAccess', id, access),
    videos: () => ipcRenderer.invoke('cloud:videos'),
    people: () => ipcRenderer.invoke('cloud:people'),
    removePerson: email => ipcRenderer.invoke('cloud:removePerson', email),
    team: () => ipcRenderer.invoke('cloud:team'),
    setMember: (email, role) => ipcRenderer.invoke('cloud:setMember', email, role),
    removeMember: email => ipcRenderer.invoke('cloud:removeMember', email),
    renameWorkspace: name => ipcRenderer.invoke('cloud:renameWorkspace', name)
  },
  driveShare: {
    ready: () => ipcRenderer.invoke('driveShare:ready'),
    publish: args => ipcRenderer.invoke('driveShare:publish', args),
    unpublish: projectId => ipcRenderer.invoke('driveShare:unpublish', projectId),
    onChange: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('driveShare:changed', handler)
      return () => ipcRenderer.removeListener('driveShare:changed', handler)
    }
  },
  webhook: {
    status: () => ipcRenderer.invoke('webhook:status'),
    save: patch => ipcRenderer.invoke('webhook:save', patch),
    disconnect: () => ipcRenderer.invoke('webhook:disconnect'),
    test: () => ipcRenderer.invoke('webhook:test'),
    send: args => ipcRenderer.invoke('webhook:send', args)
  },
  templates: {
    list: () => ipcRenderer.invoke('templates:list'),
    save: (name, projectId) => ipcRenderer.invoke('templates:save', name, projectId),
    remove: id => ipcRenderer.invoke('templates:remove', id),
    setDefault: id => ipcRenderer.invoke('templates:setDefault', id),
    get: id => ipcRenderer.invoke('templates:get', id)
  },
  updates: {
    status: () => ipcRenderer.invoke('updates:status'),
    save: patch => ipcRenderer.invoke('updates:save', patch),
    check: () => ipcRenderer.invoke('updates:check'),
    download: () => ipcRenderer.invoke('updates:download'),
    install: () => ipcRenderer.invoke('updates:install'),
    onChange: fn => {
      const handler = (_e, payload) => fn(payload)
      ipcRenderer.on('updates:changed', handler)
      return () => ipcRenderer.removeListener('updates:changed', handler)
    }
  },
  overlay: {
    resize: size => ipcRenderer.invoke('overlay:resize', size)
  },
  files: {
    saveText: args => ipcRenderer.invoke('file:saveText', args),
    pickAudio: () => ipcRenderer.invoke('file:pickAudio')
  },
  shell: {
    open: p => ipcRenderer.invoke('shell:open', p),
    reveal: p => ipcRenderer.invoke('shell:reveal', p),
    copy: text => ipcRenderer.invoke('clipboard:write', text),
    openExternal: url => ipcRenderer.invoke('shell:openExternal', url)
  }
}

contextBridge.exposeInMainWorld('knight', api)
