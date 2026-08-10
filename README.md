# RUN QUEST (Webアプリ版)

Claudeアーティファクト版から移植した、React(Vite)+ Supabase構成のWebアプリです。
ゲームロジック(EXP・レベル・モンスター・メニュー・ショップ・図鑑・クラン討伐)は
元のアーティファクト版と同じものを、そのまま移植しています。

## 変わったところ(アーティファクト版との違い)

| 項目 | アーティファクト版 | このWebアプリ版 |
|---|---|---|
| データ保存 | `window.storage`(Claude専用) | Supabase(実データベース) |
| キャラ・モンスター画像 | コードにBase64で埋め込み | `public/assets/`の実ファイル |
| クランモンスターの同時更新 | 読み込み→計算→書き込み(競合すると上書きされることがある) | Postgresの行ロックで**確実に加算される**ように改善 |

特にクランモンスターの同時更新は、以前「複数人が同時に記録すると稀にダメージが消える」と
説明していた問題ですが、このWebアプリ版では`damage_clan_monster`というデータベース関数で
アトミックに(他の操作に割り込まれずに)処理するようにしたので、その問題は解消されています。

## セットアップ手順

### ① Supabaseプロジェクトを作る

1. https://supabase.com でアカウント作成 → 「New Project」
2. プロジェクトが出来たら、左メニューの「SQL Editor」を開く
3. `supabase/schema.sql` の中身を全部コピーして貼り付け、実行(Run)
   - これで`kv_store`テーブル(プレイヤーデータ用)と`clan_state`テーブル・関数(クランモンスター用)が作られます
4. 左メニューの「Project Settings」→「API」を開き、以下をメモ
   - `Project URL`
   - `anon public` キー

### ② ローカルで動かしてみる

```bash
npm install
cp .env.example .env
# .env を開いて、①でメモしたURLとキーを貼り付ける

npm run dev
```

`http://localhost:5173` で開けます。

### ③ GitHubにpush

```bash
git init
git add .
git commit -m "Initial commit: RUN QUEST web app"
git branch -M main
git remote add origin https://github.com/<your-username>/<your-repo>.git
git push -u origin main
```

### ④ Vercelにデプロイ

1. https://vercel.com でGitHubアカウントと連携
2. 「Add New Project」→ 今pushしたリポジトリを選択
3. 環境変数(Environment Variables)に、①でメモした2つを追加
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
4. 「Deploy」

数分でURLが発行され、以降は`git push`するたびに自動で再デプロイされます。

## ディレクトリ構成

```
src/
  App.jsx              メインのアプリ本体(ゲームロジック全部)
  lib/
    supabaseClient.js  Supabaseクライアントの初期化
    storage.js         window.storage互換のプレイヤーデータ読み書き
  main.jsx / index.css エントリーポイント
public/
  assets/              キャラクター・モンスターの画像(28枚)
supabase/
  schema.sql           データベースのテーブル・関数定義
```

## Google ログインのセットアップ

Google認証を使うには、Supabase側とGoogle Cloud側、両方で設定が必要です。

### ① Google Cloud Consoleでの設定

1. https://console.cloud.google.com にアクセス(なければ新しいプロジェクトを作成)
2. 「APIとサービス」→「認証情報」→「認証情報を作成」→**「OAuthクライアントID」**
3. 初回は「OAuth同意画面」の設定を求められます。ユーザータイプは「外部」でOK。アプリ名(RUN QUESTなど)とメールアドレスだけ入れれば最低限は進められます
4. アプリケーションの種類は**「ウェブ アプリケーション」**を選択
5. 「承認済みのリダイレクトURI」に、Supabaseの認証コールバックURLを追加します。これは次の②で確認できる`https://<プロジェクトref>.supabase.co/auth/v1/callback`という形式のURLです
6. 作成すると**クライアントID**と**クライアントシークレット**が発行されるので、コピーしておく

### ② Supabase側での設定

1. Supabaseダッシュボード →「Authentication」→「Providers」
2. 一覧から**「Google」**を選んで有効化(トグルをON)
3. ①でコピーした**クライアントID**と**クライアントシークレット**を貼り付けて保存
4. 表示されている「Callback URL」を、①の手順5でGoogle側に登録してください(順番が前後してもOK、両方揃えば動きます)

### ③ 動作確認

`npm run dev`でローカルを開き、タイトル画面の「Googleでログイン」を押してみてください。Googleのログイン画面が開き、許可すると自動的にアプリに戻ってくれば成功です。

**注意**: Vercelにデプロイした本番URLでも使う場合は、①の「承認済みのリダイレクトURI」に本番URLも追加で登録するか、コールバックURL自体はSupabase側の固定URLなので通常はそのままで動きます(念のため、本番で試して弾かれた場合はGoogle Cloud側の「承認済みのJavaScript生成元」に本番URLの追加が必要になることがあります)。

## 移行後のデータについて

`supabase/migration_auth.sql`を実行すると、ログイン前のテストデータ(user_idが空の行)は誰からも読み書きできなくなります。検証初期の段階であれば、そのまま新規に始めてもらうのが一番簡単です。

