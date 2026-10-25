# FYZIO Stupava – web s online rezerváciou

Node.js (Express) + SQLite (vstavané `node:sqlite`, žiadny databázový server).

- `/` – verejný web, objednávanie na procedúry (výber procedúry → deň → voľný čas → údaje)
- `/admin` – administrácia: rezervácie (potvrdiť / dokončiť / zrušiť / vymazať / preradiť terapeutovi), procedúry a miestnosti,
  tím (zobrazuje sa na webe), používatelia, otváracie hodiny, zatvorené dni

### Roly

- **Admin** – vidí všetky rezervácie a spravuje procedúry, miestnosti, tím, používateľov a nastavenia.
- **Terapeut** – účet napojený na člena tímu; vidí len svoje rezervácie a môže ich potvrdiť, dokončiť alebo zrušiť.

Každá procedúra má miestnosť a terapeutov (priradia sa v záložke Tím). Termín je voľný, ak je voľná miestnosť
a aspoň jeden z terapeutov procedúry; klient si na webe môže terapeuta vybrať, inak sa pridelí automaticky.

## Lokálne spustenie

```bash
npm install
cp .env.example .env      # nastav ADMIN_PASSWORD
npm run dev               # http://localhost:3000
```

Vyžaduje Node.js 22.13 alebo novší. Databáza sa vytvorí v `data/fyzio.db` a pri prvom spustení sa naplní ukážkovými procedúrami.
Pri prvom spustení sa vytvorí účet **`admin`** s heslom z `ADMIN_PASSWORD` (ak nie je nastavené, server vypíše dočasné heslo).
Ďalšie účty sa zakladajú v administrácii, `ADMIN_PASSWORD` sa potom už nepoužíva – heslo zmeníte v záložke *Môj účet*.

## E-maily

Bez nastaveného SMTP sa rezervácie len ukladajú do adminu. Po nastavení:

- na `ADMIN_EMAIL` príde upozornenie na každú novú rezerváciu (odpoveď ide priamo klientovi),
- klient (ak zadal e-mail) dostane potvrdenie prijatia, potvrdenie termínu a info o zrušení.

### Cez smtp-relay na serveri (odporúčané)

Najprv zistite, ako je relay dostupný:

```bash
docker ps --filter name=smtp-relay --format '{{.Ports}}'
docker inspect smtp-relay --format '{{range $k,$v := .NetworkSettings.Networks}}{{$k}} {{end}}'
```

- **Relay má port zverejnený na `0.0.0.0`** (napr. `0.0.0.0:25->25/tcp`) – stačí `.env`:
  ```bash
  SMTP_HOST=host.docker.internal
  SMTP_PORT=25
  ```
- **Relay je len v Docker sieti** (alebo port viazaný na `127.0.0.1`) – pripojte fyzio do jeho siete:
  ```bash
  cp docker-compose.override.example.yml docker-compose.override.yml
  # v ňom upravte "name:" na sieť z docker inspect vyššie
  ```
  a do `.env`:
  ```bash
  SMTP_HOST=smtp-relay
  SMTP_PORT=25     # port, na ktorom relay počúva vo vnútri kontajnera
  ```

Spoločne pre obe varianty (bez `SMTP_USER`/`SMTP_PASS` – relay neoveruje):

```bash
MAIL_FROM="FYZIO Stupava <rezervacie@pidiman.sk>"   # doména, ktorú relay smie odosielať
ADMIN_EMAIL=kam.chodia.rezervacie@gmail.com
```

### Cez externé SMTP (napr. Gmail)

```bash
SMTP_HOST=smtp.gmail.com
SMTP_PORT=587
SMTP_USER=vas.ucet@gmail.com
SMTP_PASS=xxxxxxxxxxxxxxxx          # Gmail: heslo aplikácie (myaccount.google.com/apppasswords)
MAIL_FROM="FYZIO Stupava <vas.ucet@gmail.com>"
ADMIN_EMAIL=kam.chodia.rezervacie@gmail.com
SITE_NAME="FYZIO Stupava"
```

Kontaktný telefón a adresa webu (tlačidlo *Zavolať* a odkazy v e-mailoch) sa nastavujú v administrácii
v *Nastavenia → Kontakt*; `CONTACT_PHONE` a `SITE_URL` v `.env` slúžia len ako počiatočné hodnoty.

Port 465 sa automaticky použije so SSL (`SMTP_SECURE` vynúti iné správanie). Funkčnosť overíte v admine:
**Nastavenia → E-mailové notifikácie → Poslať testovací e-mail**. Chyby SMTP sa vypisujú do logu
(`docker logs fyzio-web`).

Oracle Cloud blokuje odchádzajúci port 25 – použite 587 alebo 465.

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

Automaticky pri každom pushi do `main` (GitHub Actions → `.github/workflows/deploy.yml`), alebo ručne:

```bash
~/docker/fyzio/deploy.sh
```

`deploy.sh` zahodí lokálne zmeny v sledovaných súboroch na serveri (`git reset --hard origin/main`);
`.env` a `docker-compose.override.yml` nie sú v gite, tie ostanú.

### Automatické nasadenie – jednorazové nastavenie

Runner sa pripojí do Tailscale siete a cez SSH spustí na serveri `deploy.sh`.

1. **Tailscale** (login.tailscale.com):
   - *Access controls* – pridať tag a povoliť mu SSH na server:
     ```json
     "tagOwners": { "tag:ci": ["autogroup:admin"] },
     ```
     (ak máte vlastné `acls`/`grants`, pridajte pravidlo `tag:ci` → server, port 22)
   - *Settings → OAuth clients* – nový klient so scope **Auth Keys (write)** a tagom `tag:ci`.
2. **SSH kľúč** (na vlastnom počítači):
   ```bash
   ssh-keygen -t ed25519 -N "" -C github-deploy-fyzio -f fyzio-deploy
   ```
   Na server do `~/.ssh/authorized_keys` pridať obsah `fyzio-deploy.pub` s obmedzením len na nasadenie:
   ```
   command="/home/ubuntu/docker/fyzio/deploy.sh",no-port-forwarding,no-agent-forwarding,no-X11-forwarding,no-pty ssh-ed25519 AAAA... github-deploy-fyzio
   ```
3. **GitHub** → repo → *Settings → Secrets and variables → Actions*:

   | Secret | Hodnota |
   |---|---|
   | `TS_OAUTH_CLIENT_ID`, `TS_OAUTH_SECRET` | z kroku 1 |
   | `DEPLOY_SSH_KEY` | obsah súboru `fyzio-deploy` (súkromný kľúč) |
   | `DEPLOY_HOST` | Tailscale IP servera (`tailscale ip -4` na serveri) |
   | `DEPLOY_USER` | používateľ na serveri (napr. `ubuntu`) |
   | `DEPLOY_KNOWN_HOSTS` | výstup `ssh-keyscan -t ed25519 <Tailscale IP>` |

4. Overenie: *Actions → Deploy → Run workflow*.

### Záloha

Databáza je vo volume `fyzio_fyzio-data`:

```bash
docker run --rm -v fyzio_fyzio-data:/data -v ~/backups:/b alpine \
  tar czf /b/fyzio-$(date +%F).tgz -C /data .
```

## Poznámky

- Rezervácie sa nesmú prekrývať v rovnakej miestnosti ani u rovnakého terapeuta.
- Fotky tímu sú v `data/media` (v Dockeri vo volume `fyzio-data`, zálohujú sa spolu s databázou).
- Prihlásenia do adminu sa držia v pamäti, po reštarte kontajnera sa treba prihlásiť znova.
- Pôvodné návrhy dizajnu sú v `navrhy/`.
