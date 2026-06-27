// ============================================================
// CafePOS Lisans Sunucusu - Ana API
// ============================================================

require('dotenv').config();
const express = require('express');
const db = require('./database');

const app = express();
const PORT = process.env.PORT || 4000;
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'change-this-secret-in-production';

app.use(express.json());

// ─── IP adresini al ─────────────────────────────────────────
function getClientIp(req) {
    return req.headers['x-forwarded-for']?.split(',')[0]?.trim()
        || req.socket?.remoteAddress
        || 'unknown';
}

// ─── Admin kimlik doğrulama middleware ───────────────────────
function requireAdmin(req, res, next) {
    const secret = req.headers['x-admin-secret'] || req.query.secret;
    if (secret !== ADMIN_SECRET) {
        return res.status(401).json({ error: 'Yetkisiz erişim.' });
    }
    next();
}

// ════════════════════════════════════════════════════════════
// PUBLIC ENDPOINTS (CafePOS tarafından çağrılır)
// ════════════════════════════════════════════════════════════

// POST /verify — Lisans doğrulama
// CafePOS her başlangıçta bunu çağırır
app.post('/verify', async (req, res) => {
    const { license_key, mac_address } = req.body;
    const ip = getClientIp(req);

    if (!license_key || !mac_address) {
        return res.status(400).json({ 
            valid: false, 
            reason: 'Eksik parametreler (license_key, mac_address gerekli).' 
        });
    }

    try {
        const result = await db.verifyLicense(license_key, mac_address, ip);
        console.log(`[VERIFY] ${new Date().toISOString()} | ${license_key} | MAC:${mac_address} | IP:${ip} | ${result.valid ? 'OK' : 'FAIL: ' + result.reason}`);
        res.json(result);
    } catch (err) {
        console.error('Verify error:', err);
        res.status(500).json({ valid: false, reason: 'Sunucu hatası.' });
    }
});

// GET /ping — Sunucu canlı mı? (bağlantı kontrolü için)
app.get('/ping', (req, res) => {
    res.json({ status: 'ok', time: new Date().toISOString() });
});

// ════════════════════════════════════════════════════════════
// ADMIN ENDPOINTS (sadece siz kullanırsınız)
// Header: x-admin-secret: <ADMIN_SECRET>
// ════════════════════════════════════════════════════════════

// POST /admin/create — Yeni lisans oluştur
// Body: { customer, email, expiresInDays, notes }
app.post('/admin/create', requireAdmin, async (req, res) => {
    const { customer, email, expiresInDays, notes } = req.body;
    if (!customer) {
        return res.status(400).json({ error: 'customer alanı zorunlu.' });
    }
    try {
        const license = await db.createLicense({ 
            customer, email, 
            expiresInDays: expiresInDays || 365,
            notes: notes || ''
        });
        console.log(`[CREATE] Yeni lisans: ${license.key} → ${customer}`);
        res.json({ success: true, ...license });
    } catch (err) {
        console.error('Create error:', err);
        res.status(500).json({ error: 'Lisans oluşturulamadı.' });
    }
});

// GET /admin/licenses — Tüm lisansları listele
app.get('/admin/licenses', requireAdmin, async (req, res) => {
    try {
        const licenses = await db.getAllLicenses();
        res.json({ count: licenses.length, licenses });
    } catch (err) {
        res.status(500).json({ error: 'Lisanslar listelenemedi.' });
    }
});

// POST /admin/deactivate — Lisans iptal et
// Body: { license_key }
app.post('/admin/deactivate', requireAdmin, async (req, res) => {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: 'license_key gerekli.' });
    try {
        const ok = await db.deactivateLicense(license_key);
        res.json({ success: ok, message: ok ? 'Lisans iptal edildi.' : 'Lisans bulunamadı.' });
    } catch (err) {
        res.status(500).json({ error: 'İşlem başarısız.' });
    }
});

// POST /admin/activate — İptal edilen lisansı yeniden aktive et
// Body: { license_key }
app.post('/admin/activate', requireAdmin, async (req, res) => {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: 'license_key gerekli.' });
    try {
        const ok = await db.activateLicense(license_key);
        res.json({ success: ok, message: ok ? 'Lisans aktive edildi.' : 'Lisans bulunamadı.' });
    } catch (err) {
        res.status(500).json({ error: 'İşlem başarısız.' });
    }
});

// POST /admin/reset-mac — Müşteri bilgisayar değiştirdiğinde MAC sıfırla
// Body: { license_key }
app.post('/admin/reset-mac', requireAdmin, async (req, res) => {
    const { license_key } = req.body;
    if (!license_key) return res.status(400).json({ error: 'license_key gerekli.' });
    try {
        const ok = await db.resetMac(license_key);
        res.json({ success: ok, message: ok ? 'MAC adresi sıfırlandı. Müşteri yeni makinede aktive edebilir.' : 'Lisans bulunamadı.' });
    } catch (err) {
        res.status(500).json({ error: 'İşlem başarısız.' });
    }
});

// GET /admin/logs — Doğrulama geçmişi
// Query: ?key=CAFE-XXXX (opsiyonel, belirli lisans için)
app.get('/admin/logs', requireAdmin, async (req, res) => {
    try {
        const logs = await db.getLogs(req.query.key || null, 200);
        res.json({ count: logs.length, logs });
    } catch (err) {
        res.status(500).json({ error: 'Loglar alınamadı.' });
    }
});

// ─── Admin Paneli (Arayüzlü Yönetim Paneli) ───────────────────
app.get('/admin', requireAdmin, async (req, res) => {
    try {
        const licenses = await db.getAllLicenses();
        const now = new Date();
        const secret = req.headers['x-admin-secret'] || req.query.secret;

        const rows = licenses.map(l => {
            const expired = l.expires_at && new Date(l.expires_at) < now;
            const status = !l.is_active ? '🔴 İptal Edildi' : expired ? '🟡 Süresi Doldu' : l.mac_address ? '🟢 Aktif (Cihaza Bağlı)' : '⚪ Aktivasyon Bekliyor';
            const expiry = l.expires_at ? new Date(l.expires_at).toLocaleDateString('tr-TR') : '—';
            
            // İşlem butonları
            let actions = '';
            if (l.mac_address) {
                actions += `<button onclick="resetMac('${l.license_key}')" style="background:#f0ad4e;color:white;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:11px;margin-right:5px;">💻 Cihazı Sıfırla</button>`;
            }
            if (l.is_active) {
                actions += `<button onclick="deactivate('${l.license_key}')" style="background:#d9534f;color:white;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:11px;">🚫 İptal Et</button>`;
            } else {
                actions += `<button onclick="activate('${l.license_key}')" style="background:#5cb85c;color:white;border:none;padding:5px 8px;border-radius:4px;cursor:pointer;font-size:11px;">✅ Aktif Et</button>`;
            }

            return `
            <tr>
                <td><strong style="font-size:14px; color:#a20513;">${l.license_key}</strong></td>
                <td><strong>${l.customer}</strong></td>
                <td>${l.email || '—'}</td>
                <td>${status}</td>
                <td><code style="font-size:11px; background:#eee; padding:2px 5px; border-radius:3px;">${l.mac_address || 'Bağlı Değil'}</code></td>
                <td>${expiry}</td>
                <td>${l.notes || '—'}</td>
                <td>${actions}</td>
            </tr>`;
        }).join('');

        res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
    <meta charset="UTF-8">
    <title>ChefGrade POS Lisans Yönetimi</title>
    <style>
        body { font-family: system-ui, -apple-system, sans-serif; max-width: 1200px; margin: 40px auto; padding: 0 20px; background: #f8f9fa; color: #333; }
        h1 { color: #a20513; margin-bottom: 30px; display: flex; align-items: center; gap: 10px; }
        .grid { display: grid; grid-template-columns: 1fr 2fr; gap: 20px; margin-bottom: 30px; }
        .card { background: white; padding: 24px; border-radius: 12px; box-shadow: 0 4px 12px rgba(0,0,0,0.05); border: 1px solid #eef0f2; }
        .card h2 { margin-top: 0; font-size: 18px; color: #a20513; border-b: 2px solid #f8f9fa; padding-bottom: 8px; }
        table { width: 100%; border-collapse: collapse; background: white; border-radius: 12px; overflow: hidden; box-shadow: 0 4px 12px rgba(0,0,0,0.05); border: 1px solid #eef0f2; }
        th { background: #a20513; color: white; padding: 14px 16px; text-align: left; font-size: 13px; font-weight: 600; }
        td { padding: 14px 16px; border-bottom: 1px solid #eee; font-size: 13px; }
        tr:last-child td { border-bottom: none; }
        .form-group { margin-bottom: 15px; }
        .form-group label { display: block; margin-bottom: 6px; font-size: 13px; font-weight: 600; color: #555; }
        .form-group input, .form-group textarea { width: 100%; padding: 10px; border: 1px solid #ccc; border-radius: 6px; font-size: 14px; box-sizing: border-box; }
        .btn { background: #a20513; color: white; border: none; padding: 12px 20px; border-radius: 6px; cursor: pointer; font-weight: 600; width: 100%; font-size: 14px; transition: background 0.2s; }
        .btn:hover { background: #82040f; }
        hr { border: 0; border-top: 1px solid #eee; margin: 20px 0; }
        .stats { display: flex; gap: 20px; margin-top: 15px; }
        .stat-item { background: #f1f3f5; padding: 10px 15px; border-radius: 6px; font-size: 13px; }
    </style>
</head>
<body>
    <h1>🔐 ChefGrade POS Lisans Yönetimi</h1>
    
    <div class="grid">
        <!-- Sol: Yeni Lisans Oluştur -->
        <div class="card">
            <h2>➕ Yeni Lisans Anahtarı Üret</h2>
            <form id="createForm">
                <div class="form-group">
                    <label>Müşteri Adı / İşletme</label>
                    <input type="text" id="customer" placeholder="Örn: Kadıköy Şubesi veya Ahmet Yılmaz" required>
                </div>
                <div class="form-group">
                    <label>E-posta Adresi (İsteğe Bağlı)</label>
                    <input type="email" id="email" placeholder="musteri@eposta.com">
                </div>
                <div class="form-group">
                    <label>Lisans Süresi (Gün)</label>
                    <input type="number" id="expiresInDays" value="365" min="1" required>
                </div>
                <div class="form-group">
                    <label>Notlar</label>
                    <textarea id="notes" placeholder="Ek açıklama..." rows="2"></textarea>
                </div>
                <button type="submit" class="btn">Lisans Anahtarı Oluştur</button>
            </form>
        </div>

        <!-- Sağ: İstatistikler ve Bilgiler -->
        <div class="card" style="display: flex; flex-direction: column; justify-content: space-between;">
            <div>
                <h2>ℹ️ Bilgilendirme</h2>
                <p style="font-size: 14px; line-height: 1.6; color: #555; margin-top: 0;">
                    Buradan oluşturduğunuz lisans anahtarlarını müşterinize ileterek ChefGrade POS programının ilk açılışında girmesini isteyin. 
                    Müşteri anahtarı girdiğinde lisans o bilgisayarın donanım kimliğine (MAC) kilitlenir ve başka bir bilgisayarda kullanılamaz.
                </p>
                <div class="stats">
                    <div class="stat-item"><strong>Toplam Lisans:</strong> ${licenses.length}</div>
                    <div class="stat-item"><strong>Aktif Cihazlar:</strong> ${licenses.filter(l => l.mac_address).length}</div>
                    <div class="stat-item"><strong>İptal Edilenler:</strong> ${licenses.filter(l => !l.is_active).length}</div>
                </div>
            </div>
            <div style="background:#fff3cd; color:#856404; padding:15px; border-radius:6px; font-size:13px; border: 1px solid #ffeeba;">
                <strong>⚠️ Güvenlik Uyarısı:</strong> Bu paneli internete açtığınızda URL sonundaki <code>secret=...</code> anahtarını kimseyle paylaşmayın.
            </div>
        </div>
    </div>

    <h2>Lisans Anahtarları Listesi</h2>
    <div style="overflow-x: auto;">
        <table>
            <thead>
                <tr>
                    <th>Lisans Anahtarı</th>
                    <th>Müşteri / Şube</th>
                    <th>E-posta</th>
                    <th>Durum</th>
                    <th>Cihaz MAC</th>
                    <th>Son Geçerlilik</th>
                    <th>Notlar</th>
                    <th>İşlemler</th>
                </tr>
            </thead>
            <tbody>
                ${rows || '<tr><td colspan="8" style="text-align:center;color:#999;padding:30px;">Henüz lisans oluşturulmamış.</td></tr>'}
            </tbody>
        </table>
    </div>

    <script>
        const secret = "${secret}";

        // Lisans Oluşturma
        document.getElementById('createForm').addEventListener('submit', async (e) => {
            e.preventDefault();
            const customer = document.getElementById('customer').value;
            const email = document.getElementById('email').value;
            const expiresInDays = parseInt(document.getElementById('expiresInDays').value);
            const notes = document.getElementById('notes').value;

            try {
                const res = await fetch('/admin/create?secret=' + secret, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ customer, email, expiresInDays, notes })
                });
                const data = await res.json();
                if (data.success) {
                    alert('Lisans Başarıyla Oluşturuldu!\\nAnahtar: ' + data.key);
                    location.reload();
                } else {
                    alert('Hata: ' + data.error);
                }
            } catch (err) {
                alert('Sunucu hatası oluştu.');
            }
        });

        // MAC Adresi Sıfırlama
        async function resetMac(key) {
            if(confirm(key + ' lisansının cihaz eşleştirmesini kaldırmak istiyor musunuz? Müşteri yeni bir bilgisayarda aktivasyon yapabilecektir.')) {
                const res = await fetch('/admin/reset-mac?secret=' + secret, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ license_key: key })
                });
                const data = await res.json();
                if (data.success) {
                    alert('Cihaz kilidi başarıyla kaldırıldı.');
                    location.reload();
                }
            }
        }

        // Lisans İptal Etme
        async function deactivate(key) {
            if(confirm(key + ' lisansını iptal etmek istediğinize emin misiniz? Bu işlem POS uygulamasını derhal durduracaktır.')) {
                const res = await fetch('/admin/deactivate?secret=' + secret, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ license_key: key })
                });
                const data = await res.json();
                if (data.success) location.reload();
            }
        }

        // Lisans Yeniden Aktif Etme
        async function activate(key) {
            const res = await fetch('/admin/activate?secret=' + secret, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ license_key: key })
            });
            const data = await res.json();
            if (data.success) location.reload();
        }
    </script>
</body>
</html>`);
    } catch (err) {
        res.status(500).send('Sunucu hatası: Lisanslar yüklenemedi.');
    }
});

// ─── Sunucuyu Başlat ────────────────────────────────────────
app.listen(PORT, () => {
    console.log('='.repeat(50));
    console.log('  CafePOS Lisans Sunucusu Başlatıldı!');
    console.log(`  Port: ${PORT}`);
    console.log(`  Admin Panel: http://localhost:${PORT}/admin?secret=${ADMIN_SECRET}`);
    console.log('='.repeat(50));
});
