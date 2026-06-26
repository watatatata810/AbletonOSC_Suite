class WebGLWaveform {
    constructor(canvas, options = {}) {
        this.canvas = canvas;
        this.gl = canvas.getContext('webgl', { antialias: false, premultipliedAlpha: false });
        
        if (!this.gl) {
            console.error("WebGL is not supported in this browser.");
            return;
        }

        this.color = options.color || [1.0, 0.5, 0.0, 1.0]; // Default orange-ish color
        this.lods = { A: null, B: null, C: null };
        this.lengths = { A: 0, B: 0, C: 0 };
        this.sampleRates = { A: 44100, B: 44100, C: 44100 };
        this.activeLayerKey = 'A';
        this.zoom = 1.0;     // Pixels per sample
        this.offset = 0.0;   // Scroll offset in pixels

        this._initShaders();
        
        // Handle resizing
        this.resize();
        window.addEventListener('resize', () => this.resize());
    }

    _initShaders() {
        const gl = this.gl;

        const vsSource = `
            attribute float a_amplitude;
            attribute float a_index;
            
            uniform float u_zoom;
            uniform float u_offset;
            uniform float u_canvasWidth;
            
            void main() {
                // X position in pixels
                float x_px = (a_index * u_zoom) - u_offset;
                
                // Convert to clip space (-1.0 to 1.0)
                float x_clip = (x_px / u_canvasWidth) * 2.0 - 1.0;
                
                // Y position is amplitude (-1.0 to 1.0)
                float y_clip = a_amplitude;
                
                gl_Position = vec4(x_clip, y_clip, 0.0, 1.0);
            }
        `;

        const fsSource = `
            precision mediump float;
            uniform vec4 u_color;
            void main() {
                gl_FragColor = u_color;
            }
        `;

        const vertexShader = this._compileShader(gl.VERTEX_SHADER, vsSource);
        const fragmentShader = this._compileShader(gl.FRAGMENT_SHADER, fsSource);

        this.program = gl.createProgram();
        gl.attachShader(this.program, vertexShader);
        gl.attachShader(this.program, fragmentShader);
        gl.linkProgram(this.program);

        if (!gl.getProgramParameter(this.program, gl.LINK_STATUS)) {
            console.error('Unable to initialize the shader program: ' + gl.getProgramInfoLog(this.program));
        }

        gl.useProgram(this.program);

        this.locations = {
            a_amplitude: gl.getAttribLocation(this.program, 'a_amplitude'),
            a_index: gl.getAttribLocation(this.program, 'a_index'),
            u_zoom: gl.getUniformLocation(this.program, 'u_zoom'),
            u_offset: gl.getUniformLocation(this.program, 'u_offset'),
            u_canvasWidth: gl.getUniformLocation(this.program, 'u_canvasWidth'),
            u_color: gl.getUniformLocation(this.program, 'u_color')
        };
    }

    _compileShader(type, source) {
        const gl = this.gl;
        const shader = gl.createShader(type);
        gl.shaderSource(shader, source);
        gl.compileShader(shader);

        if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) {
            console.error('An error occurred compiling the shaders: ' + gl.getShaderInfoLog(shader));
            gl.deleteShader(shader);
            return null;
        }
        return shader;
    }

    resize() {
        // Resize canvas to match display size exactly to avoid blurring
        const rect = this.canvas.parentElement.getBoundingClientRect();
        this.canvas.width = rect.width;
        this.canvas.height = rect.height;
        this.gl.viewport(0, 0, this.canvas.width, this.canvas.height);
        this.render();
    }

    _createLOD(data, factor) {
        const numChunks = Math.ceil(data.length / factor);
        const amplitudes = new Float32Array(numChunks * 2);
        const indices = new Float32Array(numChunks * 2);
        
        for (let i = 0; i < numChunks; i++) {
            let min = 1.0;
            let max = -1.0;
            const start = i * factor;
            const end = Math.min(start + factor, data.length);
            for (let j = start; j < end; j++) {
                const val = data[j];
                if (val < min) min = val;
                if (val > max) max = val;
            }
            // Draw max then min to form a vertical line for the envelope
            amplitudes[i * 2] = max;
            amplitudes[i * 2 + 1] = min;
            
            indices[i * 2] = start;
            indices[i * 2 + 1] = start + (factor / 2);
        }
        
        const gl = this.gl;
        const ampBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ampBuf);
        gl.bufferData(gl.ARRAY_BUFFER, amplitudes, gl.STATIC_DRAW);
        
        const idxBuf = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf);
        gl.bufferData(gl.ARRAY_BUFFER, indices, gl.STATIC_DRAW);
        
        return { ampBuf, idxBuf, length: amplitudes.length };
    }

    /**
     * @param {Float32Array} float32Array Raw audio channel data
     * @param {number} sampleRate Audio sample rate (e.g. 44100)
     * @param {string} layerKey Target layer ('A' or 'B')
     */
    updateData(float32Array, sampleRate = 44100, layerKey = 'A') {
        const gl = this.gl;
        
        // Release old buffers if they exist for this layer to prevent memory leaks
        if (this.lods[layerKey]) {
            this.lods[layerKey].forEach(lod => {
                if (lod.ampBuf) gl.deleteBuffer(lod.ampBuf);
                if (lod.idxBuf) gl.deleteBuffer(lod.idxBuf);
            });
        }

        this.lengths[layerKey] = float32Array.length;
        this.sampleRates[layerKey] = sampleRate;

        const layerLods = [];

        // LOD 0: Original Data (for deep zoom)
        const ampBuf0 = gl.createBuffer();
        gl.bindBuffer(gl.ARRAY_BUFFER, ampBuf0);
        gl.bufferData(gl.ARRAY_BUFFER, float32Array, gl.STATIC_DRAW);
        
        const idxBuf0 = gl.createBuffer();
        const indices0 = new Float32Array(float32Array.length);
        for (let i = 0; i < float32Array.length; i++) indices0[i] = i;
        gl.bindBuffer(gl.ARRAY_BUFFER, idxBuf0);
        gl.bufferData(gl.ARRAY_BUFFER, indices0, gl.STATIC_DRAW);
        
        layerLods.push({ ampBuf: ampBuf0, idxBuf: idxBuf0, length: float32Array.length });
        
        // Generate LODs (Min/Max decimation for wide views)
        layerLods.push(this._createLOD(float32Array, 10));   // LOD 1: 10x
        layerLods.push(this._createLOD(float32Array, 100));  // LOD 2: 100x
        layerLods.push(this._createLOD(float32Array, 1000)); // LOD 3: 1000x

        this.lods[layerKey] = layerLods;

        // Only trigger render if this is the active layer
        if (layerKey === this.activeLayerKey) {
            this.render();
        }
    }

    /**
     * Set the zoom and offset.
     * @param {number} pxPerSec How many pixels represent 1 second of audio
     * @param {number} scrollLeft The current horizontal scroll position in pixels
     */
    setView(pxPerSec, scrollLeft) {
        const sampleRate = this.sampleRates[this.activeLayerKey] || 44100;
        
        // Convert pxPerSec to pxPerSample
        this.zoom = pxPerSec / sampleRate;
        this.offset = scrollLeft;
        
        this.render();
    }

    /**
     * Switch active rendering layer
     * @param {string} layerKey Active layer ('A' or 'B')
     */
    setActiveLayer(layerKey) {
        if (layerKey !== 'A' && layerKey !== 'B' && layerKey !== 'C') return;
        this.activeLayerKey = layerKey;
        this.render();
    }

    /**
     * Clear all buffers and lengths
     */
    clear() {
        const gl = this.gl;
        ['A', 'B', 'C'].forEach(layerKey => {
            if (this.lods[layerKey]) {
                this.lods[layerKey].forEach(lod => {
                    if (lod.ampBuf) gl.deleteBuffer(lod.ampBuf);
                    if (lod.idxBuf) gl.deleteBuffer(lod.idxBuf);
                });
            }
            this.lods[layerKey] = null;
            this.lengths[layerKey] = 0;
        });
        this.render();
    }

    render() {
        const gl = this.gl;
        
        // Clear canvas (always clear even if no data to draw)
        gl.clearColor(0.0, 0.0, 0.0, 0.0); // Transparent background
        gl.clear(gl.COLOR_BUFFER_BIT);

        const activeLods = this.lods[this.activeLayerKey];
        const length = this.lengths[this.activeLayerKey] || 0;
        
        if (length === 0 || !activeLods) return;

        gl.useProgram(this.program);

        // Select LOD based on zoom level to prevent GPU overdraw bottleneck
        const samplesPerPixel = 1.0 / this.zoom;
        let activeLod = activeLods[0];
        if (samplesPerPixel > 1000) activeLod = activeLods[3];
        else if (samplesPerPixel > 100) activeLod = activeLods[2];
        else if (samplesPerPixel > 50) activeLod = activeLods[1];

        // Bind Amplitude Buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, activeLod.ampBuf);
        gl.enableVertexAttribArray(this.locations.a_amplitude);
        gl.vertexAttribPointer(this.locations.a_amplitude, 1, gl.FLOAT, false, 0, 0);

        // Bind Index Buffer
        gl.bindBuffer(gl.ARRAY_BUFFER, activeLod.idxBuf);
        gl.enableVertexAttribArray(this.locations.a_index);
        gl.vertexAttribPointer(this.locations.a_index, 1, gl.FLOAT, false, 0, 0);

        // Set Uniforms
        gl.uniform1f(this.locations.u_zoom, this.zoom);
        gl.uniform1f(this.locations.u_offset, this.offset);
        gl.uniform1f(this.locations.u_canvasWidth, this.canvas.width);
        gl.uniform4fv(this.locations.u_color, this.color);

        // Draw Line Strip
        gl.drawArrays(gl.LINE_STRIP, 0, activeLod.length);
    }
}

// Make it available globally
window.WebGLWaveform = WebGLWaveform;
