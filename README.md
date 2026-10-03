# Hermes Bot Command Center

Local MVP untuk mengamati satu bot Hermes melalui telemetry **`presence.v1`**. Tidak ada scraping UI, heartbeat sintetis, central collector, atau multi-room routing.

## Arsitektur

```text
Hermes native hooks → presence-publisher plugin → HTTP POST /observe
                                             ↓
Vite card ← SSE /events ← local collector ← TTL → unobserved
```

Collector memegang kontrak `presence.v1`: `hostId`, `roomId`, `botId`, `state`, `activity`, `updatedAt`, `pet { slug, version, url }`, serta `reason` saat tidak teramati.

## Jalankan

Buka **dua Terminal macOS terpisah**. Salin hanya isi blok perintah di bawah—jangan salin heading atau kalimat penjelasan ke shell.

Terminal pertama (collector):

```bash
cd "$HOME/Downloads/hermes-bot-command-center" && npm install && npm run collector
```

Terminal kedua (dashboard):

```bash
cd "$HOME/Downloads/hermes-bot-command-center" && npm run dev
```

Vite mem-proxy `/presence` dan `/events` ke collector loopback pada port `8787`; dashboard mengambil snapshot awal lalu menerima pembaruan lewat SSE.

## Hubungkan ke Hermes

Plugin memakai hook native `pre_gateway_dispatch`, `pre_llm_call`, `post_llm_call`, `pre_tool_call`, dan `post_tool_call`. `post_llm_call` dipetakan ke `llm:completed`/`idle`, bukan `speaking`, karena hook itu berjalan pada finalisasi turn; state `speaking` hanya boleh diterbitkan oleh hook streaming yang benar-benar tersedia. Ia mengirim event kecil ke collector melalui `PRESENCE_COLLECTOR_URL` (default `http://127.0.0.1:8787/observe`), tanpa menahan turn jika collector mati.

Salin direktori plugin ke root plugin profil Hermes yang aktif, lalu validasi sebelum me-restart session Hermes. Ganti `atlas` dengan profile target; jalankan blok ini sendiri di Terminal ketiga, tanpa menambahkan heading atau komentar:

```bash
export HERMES_HOME="$HOME/.hermes/profiles/atlas"
mkdir -p "$HERMES_HOME/plugins"
cp -R "$HOME/Downloads/hermes-bot-command-center/hermes_plugin/presence_publisher" "$HERMES_HOME/plugins/"
hermes plugins doctor "$HERMES_HOME/plugins/presence_publisher"
```

Setelah doctor menampilkan lima hook terdaftar, restart gateway dari **Terminal pengguna** (restart dapat mengganggu chat pada profile itu):

```bash
hermes gateway restart
```

Jika `HERMES_HOME` tidak diekspor, gunakan root profil yang aktif (contoh profil Vega: `~/.hermes/profiles/vega`). Konfigurasi opsional: `PRESENCE_PORT`, `PRESENCE_TTL_MS`, `PRESENCE_HOST_ID`, `PRESENCE_ROOM_ID`, `PRESENCE_BOT_ID`, dan atribut pet `PRESENCE_PET_*`.

## Verifikasi

```bash
npm test
python3 -m unittest hermes_plugin.presence_publisher.test_publisher
npm run build
```

Test collector membuktikan event hook → `presence.v1` → SSE dan TTL menghasilkan `unobserved`; test plugin membuktikan mapping lima hook native ke event collector yang diizinkan.
