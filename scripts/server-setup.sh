#!/usr/bin/env bash
# Первый запуск на чистом Ubuntu 22.04/24.04 — от root.
# После git clone: sudo bash scripts/server-setup.sh
set -euo pipefail

REPO="${GIT_REPO:-https://github.com/two-lifes/english-teacher.git}"
APP_DIR="${APP_DIR:-/opt/lexio}"
BRANCH="${DEPLOY_BRANCH:-release-server}"

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Запустите от root: sudo bash scripts/server-setup.sh"
  exit 1
fi

export DEBIAN_FRONTEND=noninteractive
apt-get update -y
apt-get install -y ca-certificates curl git build-essential python3 nginx

if ! command -v node >/dev/null 2>&1; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | bash -
  apt-get install -y nodejs
fi

if ! id -u lexio >/dev/null 2>&1; then
  useradd --system --create-home --home-dir /home/lexio --shell /bin/bash lexio
fi
mkdir -p /home/lexio/.ssh
chmod 700 /home/lexio/.ssh
chown -R lexio:lexio /home/lexio

mkdir -p "$APP_DIR"
if [[ ! -d "$APP_DIR/.git" ]]; then
  git clone "$REPO" "$APP_DIR"
fi

cd "$APP_DIR"
git fetch --prune origin
if git show-ref --verify --quiet "refs/remotes/origin/${BRANCH}"; then
  git checkout "$BRANCH"
  git reset --hard "origin/${BRANCH}"
else
  git checkout master || git checkout main
fi

chown -R lexio:lexio "$APP_DIR"
sudo -u lexio git config --global --add safe.directory "$APP_DIR"

if [[ ! -f backend/.env ]]; then
  cp .env.example backend/.env
  chown lexio:lexio backend/.env
  echo
  echo "Заполните ${APP_DIR}/backend/.env (JWT_SECRET, CORS_ORIGIN, OPENAI_API_KEY)"
  echo "и снова выполните: sudo bash scripts/server-setup.sh"
  exit 0
fi

sudo -u lexio bash -lc "cd '$APP_DIR' && npm ci && npm run db:setup && npm run build"

bash "$APP_DIR/scripts/install-service.sh"

echo
echo "Lexio слушает 127.0.0.1 и 0.0.0.0:4000 (HOST в .env)."
echo "Nginx: скопируйте deploy/nginx.example.conf и выпустите сертификат certbot."
echo "Публичный SSH-ключ деплоя добавьте в /home/lexio/.ssh/authorized_keys"
echo "  (chmod 600, владелец lexio)."
