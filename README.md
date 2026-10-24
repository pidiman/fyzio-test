# FyzioPlus – web s online rezerváciou

Node.js (Express) + SQLite (vstavané `node:sqlite`, žiadny databázový server).

- `/` – verejný web, objednávanie na procedúry (výber procedúry → deň → voľný čas → údaje)
- `/admin` – administrácia: rezervácie (potvrdiť / dokončiť / zrušiť / vymazať), procedúry a cenník, otváracie hodiny, zatvorené dni

## Lokálne spustenie

```bash
npm install
cp .env.example .env      # nastav ADMIN_PASSWORD
npm run dev               # http://localhost:3000
```

Vyžaduje Node.js 22.13 alebo novší. Databáza sa vytvorí v `data/fyzio.db` a pri prvom spustení sa naplní ukážkovými procedúrami.
Ak `ADMIN_PASSWORD` nie je nastavené, server pri štarte vypíše dočasné heslo.

## Nasadenie na oracle-free-1 (Docker + Caddy)

Predpoklad: na serveri beží Caddy z `~/docker/proxy` a existuje Docker sieť `web`.

```bash
ssh oracle-free-1-ts
git clone https://github.com/pidiman/fyzio-test.git ~/docker/fyzio
cd ~/docker/fyzio

# heslo do adminu
umask 077
echo "ADMIN_PASSWORD=$(openssl rand -base64 18 | tr -d '/+=' | cut -c1-20)" > .env
cat .env

docker compose up -d --build
curl -fsS -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8092   # má vrátiť 200
```

### Rýchly test bez domény (SSH tunel)

Z vlastného počítača:

```bash
ssh -L 8092:127.0.0.1:8092 oracle-free-1-ts
```

a otvoriť http://localhost:8092 a http://localhost:8092/admin.

### Verejne cez doménu

1. DNS: `fyzio.pidiman.sk  A  <IP servera>`
2. Do `~/docker/proxy/Caddyfile` pridať:
   ```
   fyzio.pidiman.sk {
   	import common
   	reverse_proxy fyzio-web:3000
   }
   ```
3. `docker exec caddy caddy reload --config /etc/caddy/Caddyfile`

### Aktualizácia

```bash
cd ~/docker/fyzio && git pull && docker compose up -d --build
```

### Záloha

Databáza je vo volume `fyzio_fyzio-data`:

```bash
docker run --rm -v fyzio_fyzio-data:/data -v ~/backups:/b alpine \
  tar czf /b/fyzio-$(date +%F).tgz -C /data .
```

## Poznámky

- Termíny sa nesmú prekrývať: v jednom čase je možná jedna rezervácia (jeden terapeut).
- Prihlásenia do adminu sa držia v pamäti, po reštarte kontajnera sa treba prihlásiť znova.
- Pôvodné návrhy dizajnu sú v `navrhy/`.
