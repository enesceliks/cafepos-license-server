// ============================================================
// CafePOS Lisans Sunucusu - Veritabanı (sqlite3 async)
// ============================================================

const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const crypto = require('crypto');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'licenses.db');
const db = new sqlite3.Database(DB_PATH, (err) => {
    if (err) {
        console.error('Veritabanı bağlantı hatası:', err.message);
        process.exit(1);
    }
    console.log('Lisans veritabanına bağlanıldı.');
    initDb();
});

// ─── Yardımcı: Promise wrapper ───────────────────────────────
const run = (sql, params = []) => new Promise((resolve, reject) => {
    db.run(sql, params, function (err) {
        if (err) reject(err); else resolve(this);
    });
});
const get = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => {
        if (err) reject(err); else resolve(row);
    });
});
const all = (sql, params = []) => new Promise((resolve, reject) => {
    db.all(sql, params, (err, rows) => {
        if (err) reject(err); else resolve(rows);
    });
});

// ─── Tabloları Oluştur ───────────────────────────────────────
function initDb() {
    db.serialize(() => {
        db.run(`CREATE TABLE IF NOT EXISTS licenses (
            id           INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key  TEXT    NOT NULL UNIQUE,
            customer     TEXT    NOT NULL,
            email        TEXT,
            mac_address  TEXT,
            activated_at TEXT,
            expires_at   TEXT,
            is_active    INTEGER DEFAULT 1,
            notes        TEXT,
            created_at   TEXT    DEFAULT (datetime('now'))
        )`);

        db.run(`CREATE TABLE IF NOT EXISTS verify_logs (
            id          INTEGER PRIMARY KEY AUTOINCREMENT,
            license_key TEXT NOT NULL,
            mac_address TEXT,
            ip_address  TEXT,
            success     INTEGER,
            reason      TEXT,
            timestamp   TEXT DEFAULT (datetime('now'))
        )`);
    });
}

// ─── Lisans Anahtar Üretici ──────────────────────────────────
function generateKey() {
    const seg = () => crypto.randomBytes(2).toString('hex').toUpperCase();
    return `CAFE-${seg()}-${seg()}-${seg()}`;
}

// ─── Lisans Oluştur ─────────────────────────────────────────
async function createLicense({ customer, email = '', expiresInDays = 365, notes = '' }) {
    const key = generateKey();
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + expiresInDays);

    await run(
        `INSERT INTO licenses (license_key, customer, email, expires_at, notes) VALUES (?, ?, ?, ?, ?)`,
        [key, customer, email, expiresAt.toISOString(), notes]
    );
    return { key, customer, email, expiresAt: expiresAt.toISOString() };
}

// ─── Lisans Doğrula ─────────────────────────────────────────
async function verifyLicense(licenseKey, macAddress, ipAddress) {
    const license = await get(`SELECT * FROM licenses WHERE license_key = ?`, [licenseKey]);

    const log = async (success, reason) => {
        await run(
            `INSERT INTO verify_logs (license_key, mac_address, ip_address, success, reason) VALUES (?, ?, ?, ?, ?)`,
            [licenseKey, macAddress || '', ipAddress || '', success ? 1 : 0, reason]
        );
    };

    if (!license) {
        await log(false, 'LICENSE_NOT_FOUND');
        return { valid: false, reason: 'Lisans anahtarı bulunamadı.' };
    }

    if (!license.is_active) {
        await log(false, 'LICENSE_DEACTIVATED');
        return { valid: false, reason: 'Bu lisans iptal edilmiş.' };
    }

    if (license.expires_at && new Date(license.expires_at) < new Date()) {
        await log(false, 'LICENSE_EXPIRED');
        return { valid: false, reason: 'Lisans süresi dolmuş.' };
    }

    if (!license.mac_address) {
        // İlk aktivasyon
        await run(
            `UPDATE licenses SET mac_address = ?, activated_at = datetime('now') WHERE id = ?`,
            [macAddress, license.id]
        );
        await log(true, 'FIRST_ACTIVATION');
    } else if (license.mac_address !== macAddress) {
        await log(false, 'MAC_MISMATCH');
        return {
            valid: false,
            reason: 'Bu lisans başka bir bilgisayarda kayıtlı. Lütfen satıcınızla iletişime geçin.'
        };
    } else {
        await log(true, 'VERIFIED');
    }

    return {
        valid: true,
        customer: license.customer,
        expiresAt: license.expires_at,
        activatedAt: license.activated_at
    };
}

async function getAllLicenses() {
    return await all(`SELECT * FROM licenses ORDER BY created_at DESC`);
}

async function deactivateLicense(licenseKey) {
    const r = await run(`UPDATE licenses SET is_active = 0 WHERE license_key = ?`, [licenseKey]);
    return r.changes > 0;
}

async function activateLicense(licenseKey) {
    const r = await run(`UPDATE licenses SET is_active = 1 WHERE license_key = ?`, [licenseKey]);
    return r.changes > 0;
}

async function resetMac(licenseKey) {
    const r = await run(`UPDATE licenses SET mac_address = NULL, activated_at = NULL WHERE license_key = ?`, [licenseKey]);
    return r.changes > 0;
}

async function getLogs(licenseKey = null, limit = 100) {
    if (licenseKey) {
        return await all(`SELECT * FROM verify_logs WHERE license_key = ? ORDER BY timestamp DESC LIMIT ?`, [licenseKey, limit]);
    }
    return await all(`SELECT * FROM verify_logs ORDER BY timestamp DESC LIMIT ?`, [limit]);
}

module.exports = { createLicense, verifyLicense, getAllLicenses, deactivateLicense, activateLicense, resetMac, getLogs };
