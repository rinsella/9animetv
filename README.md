# 9animetv mirror

SEO‑aware reverse‑proxy mirror untuk `9animetv.ing` (atau upstream lain).
Pengganti script Cloudflare Workers, bisa di‑deploy ke **Railway**, **Render**,
**Fly.io**, atau **VPS pribadi** (Node 18+ / Docker).

Script ini di-tuning khusus untuk mengatasi problem Search Console yang sering
muncul pada situs mirror:

| Masalah Search Console | Penanganan di mirror ini |
| --- | --- |
| *Duplikat, Google memilih kanonis berbeda* | Setiap halaman HTML di‑inject `<link rel="canonical">` ke domain mirror, plus `og:url` & `twitter:url` ditimpa. Semua canonical lama dihapus. |
| *Tidak ditemukan (404)* | Status code upstream diteruskan apa adanya (404 tetap 404), tidak diubah jadi 200 → tidak ada soft‑404. |
| *Halaman dengan pengalihan* | Header `Location` di‑rewrite ke domain mirror sehingga tidak ada redirect cross‑domain ke upstream. |
| *Data terstruktur Breadcrumb / tidak dapat diurai* | Setiap blok `<script type="application/ld+json">` di‑parse ulang; URL di dalamnya di‑rewrite, `BreadcrumbList` di‑heal (`@type`, `position`, `@id`); blok yang gagal parse dibuang. |
| *Sitemap & robots terlewat* | `/robots.txt` selalu memuat baris `Sitemap:` ke domain mirror. `/sitemap.xml` (dan sitemap‑index) di‑proxy + URL‑nya di‑rewrite. |
| `noindex` dari upstream | `meta robots`, `googlebot`, dan header `X-Robots-Tag: noindex` di‑strip jika `FORCE_INDEX=1` (default). |
| Hreflang ke upstream | Semua `<link rel="alternate" hreflang=…>` ke upstream dihapus agar Google tidak memakai upstream sebagai canonical alternatif. |

---

## Konfigurasi (env vars)

| Var | Default | Keterangan |
| --- | --- | --- |
| `UPSTREAM_HOST` | `9animetv.ing` | Hostname asli yang di‑mirror. |
| `UPSTREAM_PROTOCOL` | `https` | `http` / `https`. |
| `PUBLIC_HOST` | *(auto)* | Paksa hostname publik (kalau kosong, dideteksi dari header `Host` / `X-Forwarded-Host`). |
| `PUBLIC_PROTOCOL` | `https` | Protokol publik mirror. |
| `PORT` | `3000` | Port listen. Railway/Render/Fly otomatis set. |
| `FORCE_INDEX` | `1` | Hapus segala `noindex` dari upstream. |
| `EXTRA_ALIASES` | *(kosong)* | Comma list hostname tambahan di upstream yang juga harus di‑rewrite (mis. `cdn.9animetv.ing,api.9animetv.ing`). |

---

## Deploy

### 1. Railway

1. Push repo ini ke GitHub.
2. Di Railway → **New Project → Deploy from GitHub repo** → pilih repo.
3. Tambahkan env var:
   - `UPSTREAM_HOST=9animetv.ing`
   - `PUBLIC_HOST=<domain-mirror-anda>` (mis. `9animetv.example.com`)
   - `PUBLIC_PROTOCOL=https`
4. Tambahkan **Custom Domain** Railway → arahkan DNS CNAME ke target Railway.
5. Selesai. Railway membaca `railway.json` & menjalankan `node server.js`.

### 2. Render

1. Push repo, lalu di Render: **New + → Blueprint** → pilih repo.
   File `render.yaml` sudah disertakan.
2. Set `PUBLIC_HOST` setelah custom domain aktif.

### 3. Fly.io

```bash
fly launch --no-deploy --name 9animetv-mirror
fly secrets set UPSTREAM_HOST=9animetv.ing PUBLIC_HOST=<domain-anda> PUBLIC_PROTOCOL=https FORCE_INDEX=1
fly deploy
```

### 4. VPS pribadi (Docker)

```bash
git clone https://github.com/rinsella/9animetv.git
cd 9animetv
docker build -t 9animetv-mirror .
docker run -d --restart=always \
  -p 3000:3000 \
  -e UPSTREAM_HOST=9animetv.ing \
  -e PUBLIC_HOST=mirror.example.com \
  -e PUBLIC_PROTOCOL=https \
  -e FORCE_INDEX=1 \
  --name 9animetv-mirror \
  9animetv-mirror
```

Lalu pasang reverse proxy TLS (caddy / nginx). Contoh **Caddy**:

```caddyfile
mirror.example.com {
    encode gzip zstd
    reverse_proxy 127.0.0.1:3000
}
```

Caddy otomatis mengambil sertifikat Let's Encrypt.

### 5. VPS tanpa Docker

```bash
# Node 18+ wajib
nvm install 20 && nvm use 20
npm install --omit=dev
PORT=3000 UPSTREAM_HOST=9animetv.ing PUBLIC_HOST=mirror.example.com node server.js
# atau pakai pm2:
pm2 start server.js --name 9animetv-mirror
```

---

## Checklist setelah deploy (penting untuk Search Console)

1. **Verifikasi domain mirror** di Google Search Console (DNS TXT atau file).
2. Buka `https://<mirror>/robots.txt` → pastikan ada baris
   `Sitemap: https://<mirror>/sitemap.xml`.
3. Buka `https://<mirror>/sitemap.xml` → semua URL harus memakai domain mirror,
   bukan upstream. Submit sitemap tersebut di Search Console.
4. Pakai **URL Inspection** di Search Console pada beberapa halaman:
   - "User-declared canonical" harus = URL yang diuji (mirror).
   - "Indexing allowed? Yes".
5. Pakai **Rich Results Test** (https://search.google.com/test/rich-results)
   untuk memastikan BreadcrumbList valid.
6. Jika upstream menambahkan host baru (mis. CDN baru), tambahkan ke
   `EXTRA_ALIASES` agar URL‑nya juga di‑rewrite ke mirror.

---

## Catatan

- Script sengaja **tidak meng‑cache** apa pun di sisi server. Pasang Cloudflare
  (proxy mode) di depan domain mirror kalau ingin cache + DDoS protection.
- Karena `Referer` diteruskan ke upstream (untuk menghindari 403 cross‑origin),
  fitur anti‑hotlink upstream tetap jalan normal.
- `Cache-Control` dari upstream dipakai apa adanya. Tambahkan layer cache di
  depan jika perlu.