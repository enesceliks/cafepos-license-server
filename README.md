# ChefGrade POS Lisans Sunucusu

CafePOS yazılımının lisans doğrulama sunucusu. Railway/Render üzerinde çalışır.

## Kurulum (Railway)

1. Bu klasörü GitHub'a yükleyin
2. railway.app → Yeni Proje → GitHub'dan Deploy
3. Environment Variables ekleyin:
   - `ADMIN_SECRET=guclu-bir-sifre`
   - `PORT=3000` (Railway otomatik yönetir)

## Admin Panel

`https://sunucu-adresiniz.railway.app/admin?secret=ADMIN_SECRET`

## API

- `POST /verify` — Lisans doğrula
- `POST /admin/create` — Yeni lisans oluştur
- `POST /admin/deactivate` — Lisans iptal et
- `POST /admin/reset-mac` — Cihaz kilidini kaldır
