# METDesk Dedicated Object Storage & Auto-Update Server

Server penyimpanan object (blob storage) mandiri yang dibuat **from scratch** berbasis Bun & TypeScript tanpa ketergantungan pada tool pihak ketiga yang berat (seperti MinIO). Dirancang khusus untuk mengunggah, meng-host, dan mengalirkan (*stream*) file installer aplikasi (**`.dmg`**, **`.exe`**, **`.zip`**, **`.pkg`**) dengan dukungan penuh **HTTP 206 Partial Content (Range Requests)**, hashing **SHA-256** otomatis, dan sinkronisasi metadata rilis (**`release.json`**).

---

## Keunggulan Built-In Object Storage vs MinIO
* **Super Ringan & Cepat**: Performa tinggi Bun native I/O dengan penggunaan RAM minimal.
* **Zero External Dependencies**: Berjalan langsung menggunakan Bun standard APIs (`Bun.serve`, `Bun.file`, `node:crypto`), tidak butuh `boto3`, cluster IAM, atau command `mc`.
* **Atomic Streaming Write**: Menulis stream chunk per chunk dengan perhitungan SHA-256 hash secara realtime langsung ke disk.
* **Resume & Chunked Download**: Mendukung penuh HTTP 206 Partial Content / Range Requests untuk unduhan stabil dan resume transfer.
* **CI/CD Native**: Cukup satu perintah `curl -T` untuk upload binary dan langsung memperbarui `release.json`.

---

## Cara Menjalankan

### Opsi A: Menggunakan Docker (1 Container Bersih)

```bash
# Jalankan container updater server
npm run update-server:docker
# atau: docker compose up -d

# Cek logs
npm run update-server:docker:logs

# Hentikan container
npm run update-server:docker:down
```

Setelah berjalan:
* **Web Admin Dashboard**: [http://localhost:3001/](http://localhost:3001/)
* **Update Metadata API**: [http://localhost:3001/updates](http://localhost:3001/updates)
* **Object Storage Endpoint**: [http://localhost:3001/storage](http://localhost:3001/storage)
* **Healthcheck & Stats**: [http://localhost:3001/health](http://localhost:3001/health)

---

### Opsi B: Menjalankan Langsung via Bun

```bash
# Menjalankan server pada port default 3001
bun run start
# atau development mode dengan auto-reload:
bun run dev

# Custom port
bun run server.ts --port 3005

# Jalankan test suite
bun test tests/
```

---

### Opsi C: Cloudflare Workers & R2 (Target DEV / Staging)

Untuk kebutuhan development jarak jauh atau testing update langsung pada aplikasi desktop client di Mac/Windows tanpa sewa VPS:

```bash
# 1. Pastikan sudah login ke Cloudflare (cukup sekali)
bunx wrangler login

# 2. Buat R2 bucket (cukup sekali)
bunx wrangler r2 bucket create metdesk-updates-dev

# 3. Jalankan preview / local dev Worker (dengan simulasi R2 lokal)
npm run update-server:worker:dev
# atau: cd update-server && bunx wrangler dev

# 4. Deploy ke Cloudflare Workers (langsung aktif dengan HTTPS publik)
npm run update-server:worker:deploy
# atau: cd update-server && bunx wrangler deploy
```

> [!TIP]
> Di environment Cloudflare Workers (Dev), binary disimpan langsung ke **Cloudflare R2** dengan **$0 Egress Fee**, dan metadata `release.json` otomatis disimpan di root bucket R2. UI Dashboard Admin tetap dapat diakses di `https://<worker-name>.<subdomain>.workers.dev/admin`.

---

## REST API Object Storage

### 1. Upload Object via Streaming (HTTP PUT) - *Direkomendasikan untuk CI/CD*
Mengalirkan binary secara langsung ke storage tanpa membebani memori server:
```bash
curl -T build/METDesk-2.3.1.dmg \
  "http://localhost:3001/storage/METDesk-2.3.1.dmg?update_release=true&platform=macos" \
  -H "X-API-Key: YOUR_AUTH_KEY"
```

**Query Parameters:**
* `update_release=true`: Otomatis pasang binary ini ke konfigurasi rilis aktif `release.json`.
* `platform=macos` atau `platform=windows`: Platform target (otomatis terdeteksi dari ekstensi `.dmg`/`.exe`).
* `version=2.3.1`: Nomor versi baru (otomatis diekstrak dari nama file jika tidak diisi).
* `summary=Perbaikan minor`: Catatan ringkasan update.

**Contoh Response:**
```json
{
  "success": true,
  "message": "Object METDesk-2.3.1.dmg successfully saved to storage",
  "object": {
    "key": "METDesk-2.3.1.dmg",
    "filename": "METDesk-2.3.1.dmg",
    "size_bytes": 31457280,
    "size_formatted": "30.00 MB",
    "sha256": "8a3f9e...b24c",
    "etag": "\"8a3f9eb24c...\"",
    "content_type": "application/x-apple-diskimage",
    "url": "http://localhost:3001/storage/METDesk-2.3.1.dmg",
    "release_updated": true
  }
}
```

### 2. Upload Object via Multipart Form (HTTP POST)
```bash
curl -X POST \
  -F "file=@build/METDesk-2.3.1.dmg" \
  "http://localhost:3001/storage?update_release=true&platform=macos" \
  -H "X-API-Key: YOUR_AUTH_KEY"
```

### 3. Download Object (HTTP GET)
```bash
# Unduh penuh
curl -O http://localhost:3001/storage/METDesk-2.3.1.dmg

# Unduh chunked dengan Range Header (HTTP 206 Partial Content)
curl -H "Range: bytes=0-1048576" http://localhost:3001/storage/METDesk-2.3.1.dmg -o chunk_1mb.part
```

### 4. Periksa Metadata Object (HTTP HEAD)
Mengembalikan ukuran file, ETag SHA-256, dan Content-Type tanpa mengunduh body:
```bash
curl -I http://localhost:3001/storage/METDesk-2.3.1.dmg
```

### 5. Hapus Object (HTTP DELETE)
```bash
curl -X DELETE "http://localhost:3001/storage/METDesk-2.3.1.dmg" \
  -H "X-API-Key: YOUR_AUTH_KEY"
```

### 6. Daftar Seluruh Object (HTTP GET)
```bash
curl http://localhost:3001/storage
```

---

## Autentikasi & Kredensial Admin

Server dilengkapi dengan sistem autentikasi untuk melindungi endpoint upload dan mutasi release:
* **Dashboard Login**: Menggunakan username dan password yang dapat dikonfigurasi melalui `.env`:
  ```env
  ADMIN_USERNAME=admin
  ADMIN_PASSWORD=admin123
  ```
* **CI/CD API Key**: Opsional melalui header `X-API-Key` atau `Authorization: Bearer <UPLOAD_AUTH_KEY>`.
* **Klien Desktop METDesk**: Endpoint publik (`GET /updates` dan `GET /storage/<filename>`) tetap dapat diakses tanpa login sehingga auto-updater aplikasi tidak terganggu.

---

## Ringkasan Seluruh Endpoint

| Method | Endpoint | Fungsi | Auth |
| :--- | :--- | :--- | :--- |
| `GET` | `/health` | Status kesehatan & statistik penggunaan storage | Public |
| `GET` | `/updates` | Metadata pembaruan aplikasi untuk AutoUpdater client | Public |
| `GET` | `/api/auth/status` | Cek status autentikasi sesi admin | Public |
| `POST` | `/api/login` | Login admin (set session cookie) | Public |
| `POST` | `/api/logout` | Logout sesi admin | Sesi Aktif |
| `PUT` | `/storage/<file>` | Stream upload binary installer langsung ke storage | Admin / API Key |
| `POST` | `/storage` | Upload binary via form multipart | Admin / API Key |
| `GET` | `/storage/<file>` | Unduh file binary fisik (HTTP 206 Range support) | Public |
| `HEAD` | `/storage/<file>` | Periksa header ukuran file & SHA-256 ETag | Public |
| `DELETE` | `/storage/<file>` | Hapus file dari storage | Admin / API Key |
| `POST` | `/api/storage/bulk-delete` | Hapus beberapa file sekaligus | Admin / API Key |
| `POST` | `/api/storage/rename` | Ganti nama file di storage (otomatis update `release.json`) | Admin / API Key |
| `POST` | `/api/storage/set-active` | Tetapkan file di storage sebagai binary rilis aktif macOS/Windows | Admin / API Key |
| `GET` | `/storage` | Daftar seluruh object yang tersimpan di storage | Public |
| `POST` | `/api/updates` | Simpan manual konfigurasi rilis `release.json` | Admin / API Key |
| `POST` | `/api/generate-binary` | Buat sample binary mountable untuk testing | Admin / API Key |
| `GET` | `/admin` (atau `/`) | Web Dashboard GUI lengkap | Public (Login view jika unauthenticated) |

---

## Web Admin Dashboard

Buka [http://localhost:3001/](http://localhost:3001/) di browser:
1. **Layar Login Aman**: Masuk menggunakan kredensial dari `.env` (`ADMIN_USERNAME` & `ADMIN_PASSWORD`).
2. **File Manager & Fast Uploader**:
   - **Ringkasan Storage**: Statistik total file, total ukuran, jumlah binary macOS/Windows, dan rilis aktif saat ini.
   - **Fast Uploader**: Drag & drop atau pilih banyak file (.dmg, .exe, .zip, .pkg, .msi) dengan antrean, opsi aksi rilis otomatis, dan progress bar streaming realtime.
   - **Browser File Modern**: Tampilan Grid Card atau Tabel List dengan filter platform (Semua, macOS, Windows, Arsip, Rilis Aktif), sorting, pencarian real-time, dan bulk action (hapus banyak file).
   - **Aksi Cepat per File**: Unduh file, salin tautan, salin checksum SHA-256, 1-Click set sebagai rilis aktif macOS/Windows, ganti nama file (rename), dan modal detail metadata lengkap.
3. **Unggah & Terbitkan Rilis Baru**: 1-Click drag-and-drop file installer (`.dmg`, `.exe`, `.zip`) + form metadata rilis (versi target, tipe minor/major, tanggal rilis, ringkasan, force update, changelog builder) dengan progress bar streaming realtime.
4. **Editor Metadata Rilis Aktif**: Edit langsung file `release.json` dengan preset (Minor v2.3.0, Major v3.0.0, Up-to-Date v2.2.7) dan live payload JSON inspector.
5. **Sample Object Generator**: Membuat dummy `.dmg` / `.exe` mountable asli untuk pengujian auto-update lokal.
6. **CI/CD Snippets**: Tombol salin perintah `curl` siap pakai untuk pipeline otomatisasi build.
