# Conventions

- Monolithic simple structure: backend is in `server.js`, frontend static files in `public/` (`app.js`, `index.html`, `style.css`).
- Communication:
  - Ableton Live -> Node.js: OSC messages
  - Node.js -> Browser: Socket.IO events (`clip_playing`, `clip_position`, `clip_stopped`, `track_name`, `scene_name`).
- No bundler for frontend. Include libraries via CDN or static serving.