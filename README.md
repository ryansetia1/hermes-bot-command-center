# Hermes Bot Command Center

Local MVP untuk mengamati satu bot Hermes melalui telemetry **`presence.v1`**. Tidak ada scraping UI, heartbeat sintetis, central collector, atau multi-room routing.

## Arsitektur

```text
Hermes native hooks → presence-publisher plugin → HTTP POST /observe
                                             ↓
Vite card ← SSE /events ← local collector ← TTL → unobserved
```

Kontrak `presence.v1`: `hostId`, `roomId`, `botId`, `state`, `activity`, `updatedAt`, `pet { slug, version, url }`, serta `reason` saat tidak teramati. Identitas (`hostId`, `roomId`, `botId`, `pet`) **dikirim publisher di setiap event** dari profile Hermes yang aktif; collector memvalidasinya (event tanpa identitas lengkap ditolak `400`) dan tidak punya identitas default. Sebelum event pertama, `/presence` mengembalikan `unobserved` dengan identitas `null`. Lingkup MVP tetap satu bot: identitas event terakhir yang ditampilkan.

## Jalankan

Cukup jalankan satu perintah di Terminal macOS:

```bash
cd "$HOME/Downloads/hermes-bot-command-center" && npm install && npm run dashboard
```

Perintah tunggal ini secara otomatis:
- Menjalankan local presence collector (port `8787`) dan Vite dev server secara bersamaan.
- Mendeteksi dan membuka URL dashboard di browser bawaan macOS begitu server siap (bisa dinonaktifkan dengan opsi `--no-open`).
- Meneruskan sinyal `Ctrl-C` (`SIGINT`) dan `SIGTERM` secara bersih ke kedua child process, serta mencegah *orphan process* apabila salah satu proses berhenti mendadak.

*(Jika ingin menjalankan secara terpisah di terminal berbeda, gunakan `npm run collector` dan `npm run dev`.)*.

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

Jika `HERMES_HOME` tidak diekspor, gunakan root profil yang aktif (contoh profil Atlas: `~/.hermes/profiles/atlas`).

Identitas diatur lewat environment **proses Hermes (publisher)**. Default diturunkan dari nama profile aktif (basename `HERMES_HOME`, atau root profile tempat plugin terpasang):

| Variabel | Default | Contoh Atlas |
| --- | --- | --- |
| `PRESENCE_HOST_ID` | hostname mesin | `macbook-ryan` |
| `PRESENCE_ROOM_ID` | `build-room` | `build-room` |
| `PRESENCE_BOT_ID` | nama profile | `atlas` |
| `PRESENCE_PET_SLUG` | nama profile | `atlas` |
| `PRESENCE_PET_VERSION` | `1.0.0` | `1.0.0` |
| `PRESENCE_PET_URL` | `/pets/<slug>-v1.png` | `/pets/atlas-v1.png` |

`PRESENCE_PET_URL` harus path root-relative atau URL http(s). Untuk nama tampilan lain, set misalnya `PRESENCE_BOT_ID=atlas-the-conductor` di environment gateway lalu restart gateway. Collector sendiri hanya membaca `PRESENCE_PORT` dan `PRESENCE_TTL_MS`.

## Verifikasi

```bash
npm test
python3 -m unittest hermes_plugin.presence_publisher.test_publisher
npm run build
```

Test collector membuktikan identitas arbitrer dari event → `presence.v1` → SSE dan `/presence`, event tanpa identitas ditolak, dan TTL menghasilkan `unobserved`; test plugin membuktikan mapping lima hook native, default identitas per profile, override environment, POST nyata berisi identitas, dan fail-open saat collector mati.
