/**
 * WAV ファイルの読み書き (外部ライブラリなし)。
 * 読み: 8/16/24/32bit PCM と 32/64bit float、WAVE_FORMAT_EXTENSIBLE に対応
 * 書き: 24bit PCM モノラル
 */
const fs = require('fs');

const FORMAT_PCM = 1;
const FORMAT_FLOAT = 3;
const FORMAT_EXTENSIBLE = 0xfffe;

/**
 * @param {Buffer} buf
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, format:number, data:Buffer}}
 */
const parseWav = (buf) => {
    if (buf.toString('ascii', 0, 4) !== 'RIFF' || buf.toString('ascii', 8, 12) !== 'WAVE') {
        throw new Error('WAV ファイルではありません');
    }
    let fmt = null;
    let data = null;
    let pos = 12;
    while (pos + 8 <= buf.length) {
        const id = buf.toString('ascii', pos, pos + 4);
        const size = buf.readUInt32LE(pos + 4);
        const body = buf.subarray(pos + 8, Math.min(buf.length, pos + 8 + size));
        if (id === 'fmt ') {
            let format = body.readUInt16LE(0);
            if (format === FORMAT_EXTENSIBLE && body.length >= 26) format = body.readUInt16LE(24);
            fmt = {
                format,
                channels: body.readUInt16LE(2),
                sampleRate: body.readUInt32LE(4),
                bitsPerSample: body.readUInt16LE(14)
            };
        } else if (id === 'data') {
            data = body;
        }
        pos += 8 + size + (size & 1);
    }
    if (!fmt || !data) throw new Error('fmt または data チャンクが見つかりません');
    return { ...fmt, data };
};

/**
 * 1 チャンネル分を -1〜1 の Float32Array で返す
 */
const readChannel = (wav, channel = 0) => {
    const width = wav.bitsPerSample / 8;
    const frameBytes = width * wav.channels;
    const n = Math.floor(wav.data.length / frameBytes);
    const out = new Float32Array(n);
    const d = wav.data;
    for (let i = 0; i < n; i++) {
        const off = i * frameBytes + channel * width;
        if (wav.format === FORMAT_FLOAT) {
            out[i] = width === 4 ? d.readFloatLE(off) : d.readDoubleLE(off);
        } else if (width === 2) {
            out[i] = d.readInt16LE(off) / 32768;
        } else if (width === 3) {
            out[i] = d.readIntLE(off, 3) / 8388608;
        } else if (width === 4) {
            out[i] = d.readInt32LE(off) / 2147483648;
        } else {
            out[i] = (d[off] - 128) / 128;
        }
    }
    return out;
};

/**
 * ヘッダーだけを読んで長さを返す (曲の WAV は大きいので全体を読まない)。WAV でなければ null
 * @returns {{sampleRate:number, channels:number, bitsPerSample:number, seconds:number}|null}
 */
const wavInfo = (filePath) => {
    const fd = fs.openSync(filePath, 'r');
    try {
        const head = Buffer.alloc(12);
        if (fs.readSync(fd, head, 0, 12, 0) < 12) return null;
        if (head.toString('ascii', 0, 4) !== 'RIFF' || head.toString('ascii', 8, 12) !== 'WAVE') return null;
        const stat = fs.fstatSync(fd);
        let pos = 12;
        let fmt = null;
        const chunk = Buffer.alloc(8);
        while (pos + 8 <= stat.size) {
            fs.readSync(fd, chunk, 0, 8, pos);
            const id = chunk.toString('ascii', 0, 4);
            const size = chunk.readUInt32LE(4);
            if (id === 'fmt ') {
                const body = Buffer.alloc(16);
                fs.readSync(fd, body, 0, 16, pos + 8);
                fmt = { channels: body.readUInt16LE(2), sampleRate: body.readUInt32LE(4), bitsPerSample: body.readUInt16LE(14) };
            } else if (id === 'data' && fmt) {
                // 書きかけのファイルでは size が実際より大きいことがあるので、ファイルの残りで抑える
                const bytes = Math.min(size, stat.size - pos - 8);
                return { ...fmt, seconds: bytes / (fmt.channels * (fmt.bitsPerSample / 8)) / fmt.sampleRate };
            }
            pos += 8 + size + (size & 1);
        }
        return null;
    } finally {
        fs.closeSync(fd);
    }
};

const readWavFile = (filePath, channel = 0) => {
    const wav = parseWav(fs.readFileSync(filePath));
    return { sampleRate: wav.sampleRate, channels: wav.channels, samples: readChannel(wav, channel) };
};

/**
 * Float32Array (-1〜1) を 24bit PCM モノラルの WAV にする
 */
const encodeWav24Mono = (samples, sampleRate) => {
    const dataBytes = samples.length * 3;
    const buf = Buffer.alloc(44 + dataBytes);
    buf.write('RIFF', 0, 'ascii');
    buf.writeUInt32LE(36 + dataBytes, 4);
    buf.write('WAVE', 8, 'ascii');
    buf.write('fmt ', 12, 'ascii');
    buf.writeUInt32LE(16, 16);
    buf.writeUInt16LE(FORMAT_PCM, 20);
    buf.writeUInt16LE(1, 22);
    buf.writeUInt32LE(sampleRate, 24);
    buf.writeUInt32LE(sampleRate * 3, 28);
    buf.writeUInt16LE(3, 32);
    buf.writeUInt16LE(24, 34);
    buf.write('data', 36, 'ascii');
    buf.writeUInt32LE(dataBytes, 40);
    for (let i = 0; i < samples.length; i++) {
        const v = Math.max(-1, Math.min(1, samples[i]));
        buf.writeIntLE(Math.round(v * 8388607), 44 + i * 3, 3);
    }
    return buf;
};

module.exports = {
    parseWav,
    readChannel,
    wavInfo,
    readWavFile,
    encodeWav24Mono
};
