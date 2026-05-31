// Coming-soon module stub. The studio IA (Phase 1b) ships the full 14-item nav
// up front so the information architecture is real and nothing 404s; the modules
// that land in later phases render this placeholder until then. One module, one
// registry entry — the router calls `comingSoon.render(app, '<key>')`.
//
// CSP-safe: static innerHTML + <a href="#/..."> navigation only (no inline
// <script>, no fetch). Renders on the light `.mc-studio-surface` like Home.

const ICONS = {
  deck: '<path d="M2 3h20v14H2z"/><path d="M8 21h8"/><path d="M12 17v4"/>',
  ai: '<path d="M12 2l2.4 4.8L20 8l-4 3.6L17 18l-5-2.8L7 18l1-6.4L4 8l5.6-1.2z"/>',
  edit: '<path d="M12 20h9"/><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4z"/>',
  download: '<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>',
  broadcast: '<circle cx="12" cy="12" r="2"/><path d="M16.24 7.76a6 6 0 0 1 0 8.48M7.76 16.24a6 6 0 0 1 0-8.48M19.07 4.93a10 10 0 0 1 0 14.14M4.93 19.07a10 10 0 0 1 0-14.14"/>',
  files: '<path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/>',
  audit: '<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="9" y1="15" x2="15" y2="15"/><line x1="9" y1="11" x2="13" y2="11"/>',
  schedule: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
};

const STUBS = {
  presentations: { icon: 'deck', tag: 'Phase 2', title: 'Presentations',
    desc: 'Your deck library — create, manage, preview, and broadcast presentations as first-class display content. Landing in the next build.' },
  'ai-deck': { icon: 'ai', tag: 'Phase 5', title: 'AI Deck Builder',
    desc: 'Generate a full training deck from a prompt using the local Qwen 3.6 model — instructor, command-staff, and video-wall versions, all on-prem.' },
  'slide-editor': { icon: 'edit', tag: 'Phase 3', title: 'Slide Editor',
    desc: 'Compose slides on a canvas: text, media, charts, and layout blocks with a live properties inspector and speaker notes.' },
  downloads: { icon: 'download', tag: 'Phase 7', title: 'Downloads',
    desc: 'Pull media in by URL (YouTube and more) and track exported decks (PDF / images / packages) right inside the app.' },
  files: { icon: 'files', tag: 'Phase 6', title: 'Files',
    desc: 'Browse and sync to your MBFD Nextcloud — exported decks and assets land in your own cloud folders automatically.' },
  audit: { icon: 'audit', tag: 'Phase 9', title: 'Audit Log',
    desc: 'A full activity trail: who broadcast what, where, and when — AI generations, media actions, exports, and admin changes.' },
};

export function render(app, key) {
  const s = STUBS[key] || { icon: 'deck', tag: 'Soon', title: 'Module', desc: 'Coming soon.' };
  app.innerHTML = `
    <div class="mc-studio-surface">
      <div class="mc-coming">
        <div class="mc-coming-icon">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${ICONS[s.icon] || ICONS.deck}</svg>
        </div>
        <div class="mc-coming-title">${s.title}</div>
        <div class="mc-coming-tag">${s.tag} · Coming soon</div>
        <p class="mc-coming-desc">${s.desc}</p>
        <a class="mc-coming-back" href="#/home">Back to Home</a>
      </div>
    </div>`;
}
