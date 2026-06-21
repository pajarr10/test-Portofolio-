/**
 * =====================================================================
 *  server.js
 * =====================================================================
 *  Backend Analytics Dashboard untuk Website Portfolio
 *
 *  Stack     : Node.js + Express + fs (tanpa database)
 *  Tujuan    : Hanya menambahkan backend & dashboard admin.
 *              TIDAK mengubah index.html / style.css / script.js
 *              yang sudah ada. File-file portfolio tetap di-serve
 *              apa adanya melalui express.static().
 *
 *  Cara jalan di Termux (Android):
 *    1. pkg install nodejs-lts
 *    2. npm install express
 *    3. ADMIN_KEY=rahasia123 node server.js
 *
 *  Cara deploy di Vercel:
 *    - File ini di-export sebagai module (lihat paling bawah).
 *    - Tambahkan vercel.json (lihat catatan deploy di chat).
 *    - CATATAN PENTING: Vercel serverless function memiliki filesystem
 *      READ-ONLY (kecuali folder /tmp yang bersifat sementara/ephemeral).
 *      Artinya penyimpanan ke data/visit.json TIDAK akan persist
 *      antar request di Vercel. Untuk production di Vercel, sebaiknya
 *      ganti penyimpanan ke database (contoh: Vercel KV / Postgres).
 *      Untuk Termux / VPS / hosting dengan filesystem normal, sistem
 *      ini berjalan 100% sempurna dengan fs biasa.
 * =====================================================================
 */

const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

// Key admin diambil dari environment variable.
// Jika tidak diset, fallback ke "admin123" (HARAP DIGANTI saat production!)
const ADMIN_KEY = process.env.ADMIN_KEY || "admin123";

// -----------------------------------------------------------------------
// Lokasi folder & file data
// -----------------------------------------------------------------------
const DATA_DIR = path.join(__dirname, "data");
const VISIT_FILE = path.join(DATA_DIR, "visit.json");

// Batas waktu (ms) untuk menganggap visit sebagai duplikat
const DUPLICATE_WINDOW_MS = 10 * 1000; // 10 detik

// Batas waktu (ms) untuk menganggap visitor masih "online"
const ONLINE_WINDOW_MS = 5 * 60 * 1000; // 5 menit

/**
 * Memastikan folder "data" dan file "visit.json" ada.
 * Jika belum ada, otomatis dibuat dengan isi array kosong [].
 */
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
  }
  if (!fs.existsSync(VISIT_FILE)) {
    fs.writeFileSync(VISIT_FILE, "[]", "utf-8");
  }
}
ensureDataFile();

// -----------------------------------------------------------------------
// Middleware global
// -----------------------------------------------------------------------
app.use(express.json());

// Serve semua file statis portfolio (index.html, style.css, script.js, dll)
// dari root folder project ini. File-file tersebut TIDAK disentuh sama
// sekali oleh server ini — hanya disajikan langsung apa adanya.
app.use(express.static(path.join(__dirname)));

// -----------------------------------------------------------------------
// Helper: baca & tulis data visit.json
// -----------------------------------------------------------------------

/** Membaca seluruh data visitor dari visit.json */
function readVisits() {
  ensureDataFile();
  try {
    const raw = fs.readFileSync(VISIT_FILE, "utf-8");
    return JSON.parse(raw || "[]");
  } catch (err) {
    console.error("[ERROR] Gagal membaca visit.json:", err.message);
    return [];
  }
}

/** Menulis ulang seluruh data visitor ke visit.json */
function writeVisits(visits) {
  try {
    fs.writeFileSync(VISIT_FILE, JSON.stringify(visits, null, 2), "utf-8");
  } catch (err) {
    console.error("[ERROR] Gagal menulis visit.json:", err.message);
  }
}

// -----------------------------------------------------------------------
// Helper: ambil IP publik dari request
// -----------------------------------------------------------------------

/**
 * Mengambil IP asli client. Jika server berada di belakang proxy/CDN
 * (Vercel, Nginx, dll), IP asli biasanya ada di header x-forwarded-for.
 */
function getClientIp(req) {
  const xff = req.headers["x-forwarded-for"];
  if (xff) return xff.split(",")[0].trim();
  const ip = req.socket?.remoteAddress || "0.0.0.0";
  // Bersihkan prefix IPv6-mapped-IPv4 (::ffff:127.0.0.1 -> 127.0.0.1)
  return ip.replace("::ffff:", "");
}

/** Mengecek apakah sebuah IP termasuk IP lokal/privat (tidak bisa di-geolocate) */
function isLocalIp(ip) {
  if (!ip) return true;
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "0.0.0.0" ||
    ip.startsWith("192.168.") ||
    ip.startsWith("10.") ||
    ip.startsWith("172.16.") ||
    ip.startsWith("172.17.") ||
    ip.startsWith("172.18.") ||
    ip.startsWith("172.19.")
  );
}

// -----------------------------------------------------------------------
// Helper: geolocation dari IP publik (tanpa API key, pakai ip-api.com)
// -----------------------------------------------------------------------

/**
 * Mengambil data lokasi (negara, kota, region, timezone) dari IP publik.
 * Menggunakan ip-api.com (gratis, tanpa API key, cukup untuk skala kecil).
 */
async function getGeoLocation(ip) {
  if (isLocalIp(ip)) {
    return {
      negara: "Local/Unknown",
      kota: "Local/Unknown",
      region: "Local/Unknown",
      timezone: "Unknown",
    };
  }

  try {
    const response = await fetch(
      `http://ip-api.com/json/${ip}?fields=status,country,regionName,city,timezone`
    );
    const json = await response.json();

    if (json.status === "success") {
      return {
        negara: json.country || "Unknown",
        kota: json.city || "Unknown",
        region: json.regionName || "Unknown",
        timezone: json.timezone || "Unknown",
      };
    }
  } catch (err) {
    console.error("[ERROR] Gagal mengambil geolocation:", err.message);
  }

  return { negara: "Unknown", kota: "Unknown", region: "Unknown", timezone: "Unknown" };
}

// -----------------------------------------------------------------------
// Helper: parsing User-Agent secara manual (tanpa library eksternal)
// -----------------------------------------------------------------------

/**
 * Parsing sederhana User-Agent string untuk mendapatkan:
 * browser, versi browser, OS, jenis device, dan status mobile/desktop.
 * Ditulis manual (regex) agar tidak menambah dependency baru.
 */
function parseUserAgent(ua = "") {
  ua = ua || "";

  let browser = "Unknown";
  let browserVersion = "";
  let os = "Unknown";
  let device = "Desktop";
  let isMobile = false;

  // --- Deteksi mobile / tablet / desktop ---
  if (/iPad|Tablet/i.test(ua)) {
    device = "Tablet";
    isMobile = true;
  } else if (/Mobi|Android|iPhone|iPod/i.test(ua)) {
    device = "Mobile";
    isMobile = true;
  } else {
    device = "Desktop";
    isMobile = false;
  }

  // --- Deteksi Operating System ---
  if (/Windows NT 10\.0/i.test(ua)) os = "Windows 10/11";
  else if (/Windows NT/i.test(ua)) os = "Windows";
  else if (/Mac OS X/i.test(ua)) os = "macOS";
  else if (/Android/i.test(ua)) os = "Android";
  else if (/iPhone|iPad|iPod/i.test(ua)) os = "iOS";
  else if (/Linux/i.test(ua)) os = "Linux";

  // --- Deteksi browser (urutan penting!) ---
  // Edge & Opera & Samsung Browser berbasis Chromium, jadi harus dicek
  // SEBELUM Chrome supaya tidak salah deteksi.
  let match;
  if ((match = ua.match(/Edg\/([\d.]+)/))) {
    browser = "Edge";
    browserVersion = match[1];
  } else if ((match = ua.match(/OPR\/([\d.]+)/))) {
    browser = "Opera";
    browserVersion = match[1];
  } else if ((match = ua.match(/SamsungBrowser\/([\d.]+)/))) {
    browser = "Samsung Internet";
    browserVersion = match[1];
  } else if (/Chrome\/([\d.]+)/.test(ua) && !/Edg|OPR/.test(ua)) {
    match = ua.match(/Chrome\/([\d.]+)/);
    browser = "Chrome";
    browserVersion = match[1];
  } else if (/Firefox\/([\d.]+)/.test(ua)) {
    match = ua.match(/Firefox\/([\d.]+)/);
    browser = "Firefox";
    browserVersion = match[1];
  } else if (/Version\/([\d.]+).*Safari/.test(ua)) {
    match = ua.match(/Version\/([\d.]+)/);
    browser = "Safari";
    browserVersion = match[1];
  } else if (/Safari\/([\d.]+)/.test(ua)) {
    match = ua.match(/Safari\/([\d.]+)/);
    browser = "Safari";
    browserVersion = match[1];
  }

  return { browser, browserVersion, os, device, isMobile };
}

// -----------------------------------------------------------------------
// Middleware: proteksi route admin dengan header x-admin-key
// -----------------------------------------------------------------------
function requireAdminKey(req, res, next) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_KEY) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// =========================================================================
//  POST /api/visit
//  Endpoint yang dipanggil dari sisi client (tracker script) setiap kali
//  ada pengunjung baru membuka halaman portfolio.
// =========================================================================
app.post("/api/visit", async (req, res) => {
  try {
    const ip = getClientIp(req);
    const ua = req.headers["user-agent"] || "";
    const { browser, browserVersion, os, device, isMobile } = parseUserAgent(ua);

    const body = req.body || {};
    const page = body.page || req.headers["referer"] || "/";
    const referrer = body.referrer || "Direct";
    const language =
      body.language || (req.headers["accept-language"] || "Unknown").split(",")[0];
    const screenResolution = body.screenResolution || "Unknown";

    const visits = readVisits();
    const now = Date.now();

    // ---- Cegah data duplikat: IP + halaman sama dalam window waktu tertentu ----
    const isDuplicate = visits.some((v) => {
      const sameVisitor = v.ip === ip && v.halaman === page;
      const withinWindow = now - new Date(v.timestamp).getTime() < DUPLICATE_WINDOW_MS;
      return sameVisitor && withinWindow;
    });

    if (isDuplicate) {
      return res.status(200).json({ message: "Duplicate visit, dilewati" });
    }

    // Ambil lokasi geografis dari IP publik
    const geo = await getGeoLocation(ip);

    const newVisit = {
      id: `${now}-${Math.random().toString(36).slice(2, 9)}`,
      timestamp: new Date().toISOString(),
      ip,
      negara: geo.negara,
      kota: geo.kota,
      region: geo.region,
      timezone: geo.timezone,
      browser,
      browserVersion,
      os,
      device,
      isMobile,
      language,
      screenResolution,
      halaman: page,
      referrer,
      userAgent: ua,
      online: true,
    };

    visits.push(newVisit);
    writeVisits(visits);

    res.status(201).json({ message: "Visit recorded", data: newVisit });
  } catch (err) {
    console.error("[ERROR] POST /api/visit:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// =========================================================================
//  GET /api/stats   (PROTECTED - butuh header x-admin-key)
//  Mengembalikan seluruh statistik untuk dashboard admin.
// =========================================================================
app.get("/api/stats", requireAdminKey, (req, res) => {
  try {
    const visits = readVisits();
    const now = new Date();

    // --- Hitung batas waktu hari ini / minggu ini / bulan ini ---
    const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const startOfWeek = new Date(startOfToday);
    startOfWeek.setDate(startOfToday.getDate() - startOfToday.getDay()); // Minggu sebagai awal minggu
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const onlineThreshold = new Date(now.getTime() - ONLINE_WINDOW_MS);

    const visitorHariIni = visits.filter((v) => new Date(v.timestamp) >= startOfToday).length;
    const visitorMingguIni = visits.filter((v) => new Date(v.timestamp) >= startOfWeek).length;
    const visitorBulanIni = visits.filter((v) => new Date(v.timestamp) >= startOfMonth).length;
    const onlineSekarang = visits.filter((v) => new Date(v.timestamp) >= onlineThreshold).length;
    const totalMobile = visits.filter((v) => v.isMobile).length;
    const totalDesktop = visits.filter((v) => !v.isMobile).length;

    // --- Helper untuk group-by & hitung jumlah per kategori ---
    function countBy(key) {
      const map = {};
      visits.forEach((v) => {
        const k = v[key] || "Unknown";
        map[k] = (map[k] || 0) + 1;
      });
      return map;
    }

    // --- Visitor per hari, 7 hari terakhir (untuk grafik garis) ---
    const visitorPerHari = {};
    for (let i = 6; i >= 0; i--) {
      const d = new Date();
      d.setDate(d.getDate() - i);
      const key = d.toISOString().slice(0, 10); // YYYY-MM-DD
      visitorPerHari[key] = 0;
    }
    visits.forEach((v) => {
      const key = (v.timestamp || "").slice(0, 10);
      if (key in visitorPerHari) visitorPerHari[key]++;
    });

    res.json({
      totalVisitor: visits.length,
      visitorHariIni,
      visitorMingguIni,
      visitorBulanIni,
      onlineSekarang,
      totalMobile,
      totalDesktop,
      browserList: countBy("browser"),
      osList: countBy("os"),
      negaraList: countBy("negara"),
      halamanList: countBy("halaman"),
      visitorPerHari,
      visitors: visits.slice().reverse(), // visitor terbaru ditampilkan paling atas
    });
  } catch (err) {
    console.error("[ERROR] GET /api/stats:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// =========================================================================
//  DELETE /api/clear   (PROTECTED - butuh header x-admin-key)
//  Menghapus seluruh isi data/visit.json
// =========================================================================
app.delete("/api/clear", requireAdminKey, (req, res) => {
  try {
    writeVisits([]);
    res.json({ message: "Semua data visitor berhasil dihapus" });
  } catch (err) {
    console.error("[ERROR] DELETE /api/clear:", err.message);
    res.status(500).json({ error: "Internal Server Error" });
  }
});

// -----------------------------------------------------------------------
// Jalankan server secara lokal (Termux/VPS).
// Saat dijalankan di Vercel, "require.main === module" akan false
// karena dipanggil sebagai module oleh runtime serverless-nya,
// sehingga app.listen() tidak dieksekusi dua kali.
// -----------------------------------------------------------------------
if (require.main === module) {
  app.listen(PORT, () => {
    console.log("=================================================");
    console.log(`  Server analytics berjalan di http://localhost:${PORT}`);
    console.log(`  Dashboard admin: http://localhost:${PORT}/admin.html`);
    console.log(`  ADMIN_KEY aktif: "${ADMIN_KEY}"`);
    console.log("=================================================");
  });
}

// Export app supaya bisa dipakai sebagai handler Vercel serverless function
module.exports = app;
