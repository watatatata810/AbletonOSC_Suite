/**
 * 台帳 (キューリスト)。ショーごとに、どのシーンでどの開始時刻の LTC を出すかを持つ。
 *
 * 保存形式 (project_data.json):
 * {
 *   "version": 1,
 *   "active": "<ショー名>",
 *   "shows": {
 *     "<ショー名>": {
 *       "rate": "29.97DF", "tempo": 120, "levelDb": -18,
 *       "ltcTrack": "LTC", "bgmTrack": "A ch", "outputDir": "C:\\...\\LTC",
 *       "cues": [{ "scene": 12, "sceneName": "M1", "bgmTrack": "A ch", "startTC": "01:00:00;00",
 *                  "file": null, "fileSeconds": null, "fileCheck": null }]
 *     }
 *   }
 * }
 * scene は 0 始まり (AbletonOSC と同じ)。画面では 1 始まりで見せる。
 * トラックは番号ではなく名前で持つ (トラックの並べ替えに強くするため)。
 */
const fs = require('fs');
const path = require('path');
const tc = require('./timecode');

const DEFAULT_SHOW = {
    rate: '29.97DF',
    tempo: 120,
    levelDb: -18,
    ltcTrack: 'LTC',
    bgmTrack: '',
    outputDir: '',
    cues: []
};

const emptyData = () => ({ version: 1, active: '', shows: {} });

const load = (filePath) => {
    if (!fs.existsSync(filePath)) return emptyData();
    try {
        const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        return { ...emptyData(), ...data };
    } catch (err) {
        // 壊れたファイルを上書きして消さないよう、退避してから空で始める
        const broken = `${filePath}.broken-${Date.now()}`;
        fs.copyFileSync(filePath, broken);
        console.error(`[Cues] 台帳を読めませんでした。${path.basename(broken)} に退避しました:`, err.message);
        return emptyData();
    }
};

/** 書きかけで落ちても元のファイルが壊れないよう、一時ファイルに書いてから置き換える */
const save = (filePath, data) => {
    const tmp = `${filePath}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
};

const getShow = (data, name = data.active) => {
    if (!name || !data.shows[name]) return null;
    return { ...DEFAULT_SHOW, ...data.shows[name] };
};

const createShow = (data, name, settings = {}) => {
    if (!name) throw new Error('ショー名が空です');
    if (data.shows[name]) throw new Error(`同じ名前のショーがあります: ${name}`);
    data.shows[name] = { ...DEFAULT_SHOW, ...settings, cues: [] };
    data.active = name;
    return data.shows[name];
};

/**
 * 設定の検査。問題があればメッセージの一覧を返す
 */
const validateShow = (show) => {
    const errors = [];
    try {
        tc.getRate(show.rate);
    } catch (err) {
        errors.push(err.message);
        return errors;
    }
    const rate = tc.getRate(show.rate);
    const seen = new Set();
    for (const cue of show.cues) {
        if (seen.has(cue.scene)) errors.push(`シーン ${cue.scene + 1} が 2 回登録されています`);
        seen.add(cue.scene);
        try {
            const t = tc.parseTC(cue.startTC);
            if (!tc.isValidTC(t, rate)) errors.push(`シーン ${cue.scene + 1}: 存在しない時刻です (${cue.startTC})`);
        } catch (err) {
            errors.push(`シーン ${cue.scene + 1}: ${err.message}`);
        }
    }
    return errors;
};

/** シーンの台帳を追加または更新する。開始時刻やトラックが変わったら、作成済みの LTC ファイルは無効にする */
const upsertCue = (show, cue) => {
    const i = show.cues.findIndex((c) => c.scene === cue.scene);
    const prev = i >= 0 ? show.cues[i] : null;
    const next = { file: null, fileSeconds: null, fileCheck: null, ...prev, ...cue };
    if (prev && (prev.startTC !== next.startTC)) {
        next.file = null;
        next.fileSeconds = null;
        next.fileCheck = null;
    }
    if (i >= 0) show.cues[i] = next;
    else show.cues.push(next);
    show.cues.sort((a, b) => a.scene - b.scene);
    return next;
};

const removeCue = (show, scene) => {
    show.cues = show.cues.filter((c) => c.scene !== scene);
};

/**
 * シーン順に「01:00:00、02:00:00 …」と 1 時間ずつ開始時刻を振る
 * @returns {string[]} 24 時を超えたなどの警告
 */
const autoAssignHours = (show, firstHour = 1) => {
    const rate = tc.getRate(show.rate);
    const warnings = [];
    show.cues.forEach((cue, i) => {
        const h = firstHour + i;
        if (h > 23) warnings.push(`シーン ${cue.scene + 1}: 24 時を超えるため割り振れません`);
        else upsertCue(show, { scene: cue.scene, startTC: tc.formatTC({ h, m: 0, s: 0, f: 0 }, rate) });
    });
    return warnings;
};

module.exports = {
    DEFAULT_SHOW,
    emptyData,
    load,
    save,
    getShow,
    createShow,
    validateShow,
    upsertCue,
    removeCue,
    autoAssignHours
};
