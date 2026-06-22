# Ableton Live Waveform Viewer

- Real-time web application to display Ableton Live's playing clips and waveforms.
- Connects to Ableton Live via AbletonOSC (Open Sound Control).
- Backend (Node.js) converts OSC to Socket.IO and serves static files.
- Frontend (Browser) uses Socket.IO to receive updates and `wavesurfer.js` to draw waveforms.
- See `mem:tech_stack` for dependencies and `mem:conventions` for code layout.