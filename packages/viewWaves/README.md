# Ableton Live Waveform Viewer

Ableton Liveの再生状態をリアルタイムに監視し、再生中のクリップの波形・トラック名・シーン名・ファイル名を別ウィンドウ（ブラウザ）に自動追従して表示するWebアプリケーションです。

## 特徴

- **完全自動追従**: セッションビューで次のシーンをスタンバイ状態（選択状態）にしても、現在音が鳴っているクリップを検知して波形を表示し続けます。
- **マルチトラック対応**: プロジェクト内の全トラックを自動で監視。同時に複数トラックが再生された場合、自動的に画面へ追加され、**クリップの長さが短い順**にソート表示されます（先に終わるクリップほど上に来ます）。
- **再生位置の同期**: 波形上のカーソルが、Live側の再生位置（Beat）とリアルタイムで同期して動きます。
- **AbletonOSC連携**: LiveのAPI (LOM) と Node.js サーバーを OSC (Open Sound Control) プロトコルで軽量・高速に接続します。

---

## 必須環境

- Node.js (v14以上推奨)
- Ableton Live 11 / 12 (Intro / Standard / Suite いずれも可)
- [AbletonOSC](https://github.com/ideoforms/AbletonOSC) (Live側でOSC通信を行うためのMIDIリモートスクリプト)

---

## インストールと使い方

### 1. AbletonOSC の導入 (初回のみ)

Liveから外部へ情報を送信するために、AbletonOSCを手動でLiveのフォルダに配置します。

1. [AbletonOSCの最新リリース](https://github.com/ideoforms/AbletonOSC/releases/latest) から `AbletonOSC.zip` をダウンロード・解凍します。
2. 解凍した `AbletonOSC-maseter` フォルダを `AbletonOSC` にリネームし、Liveの「Remote Scripts」フォルダへコピーします。(無ければ作成してください。無いことが多いです。)
   - 例: `\Users\[ユーザー名]\Documents\Ableton\User Library\Remote Scripts\AbletonOSC`
3. Ableton Liveを再起動します。
4. Liveのメニューから「オプション」＞「環境設定」＞「**Link/Tempo/MIDI**」を開きます。
5. 「コントロールサーフェス」の空いているスロットで **AbletonOSC** を選択します。

### 2. 本アプリの起動

ターミナル（コマンドプロンプト）でこのリポジトリのフォルダを開き、以下のコマンドを実行します。

```bash
# 1. 依存ライブラリのインストール（初回のみ）
npm install

# 2. サーバーの起動
以下のいずれかの方法で起動します：
- **方法A**: フォルダ内にある `Ableton-wave.bat` をダブルクリックする（Windows限定）
- **方法B**: ターミナルで `npm start` を実行する
```

> [!NOTE]
> **Live起動時のアプリ自動立ち上げについて**
> AbletonOSC の `manager.py` （`C:\Users\[ユーザー名]\Documents\Ableton\User Library\Remote Scripts\AbletonOSC\manager.py` など）に改修を加えることで、Liveを起動した瞬間に裏で `Ableton-wave.bat` を自動起動させることが可能です。
> 
> **注意点**: AbletonOSCをGitHubから再ダウンロード・アップデートした場合は、`manager.py` が上書きされるため、自動起動のコードが消えてしまいます。アップデート後は再度スクリプトへ起動コードを追記する必要があります。

### 3. 波形の表示

1. ブラウザを開き、`http://localhost:3000` にアクセスします。
2. Live側でクリップを再生すると、ブラウザ側に自動で波形が表示され、リアルタイムにカーソルが動きます。

### 4. 別の端末（タブレット等）から表示したい場合

既定では**このPC内からのみ**アクセスできる設定（`127.0.0.1`）になっています。同じネットワーク上の別端末から波形を見たい場合は、リポジトリ直下の `config.json` で viewWaves の `httpHost` を変更してください。

```jsonc
{
  "name": "viewWaves",
  "httpPort": 3000,
  "httpHost": "0.0.0.0",   // ← 127.0.0.1 から変更する
  ...
}
```

変更後、別端末のブラウザから `http://<このPCのIPアドレス>:3000` でアクセスできます。

> [!WARNING]
> `0.0.0.0` にすると、**同じネットワーク上の誰でも**再生中クリップの一覧とプロジェクトの音声ファイルを取得できる状態になります。会場の共有Wi-Fiなど、信頼できないネットワークに接続している場合は `127.0.0.1` のままにしてください。

---

## 別環境（自宅のPCなど）で開発を再開する場合

このリポジトリを `git clone` した直後は、依存関係ファイルが含まれていません。以下の手順で環境を復元してください。

```bash
# 1. リポジトリをクローン
git clone https://github.com/[あなたのユーザー名]/[リポジトリ名].git
cd [リポジトリ名]

# 2. 依存パッケージのインストール（package.json に基づいて自動インストールされます）
npm install

# 3. サーバー起動
npm start
```

※クローン先のPCでも波形を表示させたい場合は、そのPCのAbleton Liveにも必ず「AbletonOSC」をインストール・設定してください。

---

## 技術構成

- **バックエンド**: Node.js, Express, node-osc
- **フロントエンド**: HTML, CSS (Flexbox), Socket.IO, wavesurfer.js
- **通信フロー**: `Ableton Live` <--(OSC)--> `Node.js` <--(Socket.IO / HTTP)--> `Browser`
