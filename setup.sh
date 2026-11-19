#!/usr/bin/env bash

echo "========================================"
echo "Antigravity2API One-Click Setup Script"
echo "========================================"
echo

echo "[1/6] Cloning repository..."
if [ -d "antigravity2api-nodejs" ]; then
    echo "Directory 'antigravity2api-nodejs' already exists. Exiting."
    exit 1
fi
git clone https://github.com/DEVILS1NGH/antigravity2api-nodejs.git
if [ $? -ne 0 ]; then
    echo "Clone failed. Please check your network connection and ensure Git is installed."
    exit 1
fi

echo
echo "[2/6] Entering project directory..."
cd antigravity2api-nodejs

echo
echo "[3/6] Installing dependencies..."
npm install
if [ $? -ne 0 ]; then
    echo "Failed to install dependencies."
    exit 1
fi

echo
echo "[4/6] Copying configuration file..."
cp .env.example .env

echo
echo "[5/6] Configuring admin credentials..."
echo
read -p "Enter admin username (default: admin): " ADMIN_USER
ADMIN_USER=${ADMIN_USER:-admin}

read -p "Enter admin password (default: admin123): " ADMIN_PASS
ADMIN_PASS=${ADMIN_PASS:-admin123}

read -p "Enter API key (default: sk-text): " API_KEY
API_KEY=${API_KEY:-sk-text}

sed -i.bak "s/^# API_KEY=.*/API_KEY=$API_KEY/" .env
sed -i.bak "s/^# ADMIN_USERNAME=.*/ADMIN_USERNAME=$ADMIN_USER/" .env
sed -i.bak "s/^# ADMIN_PASSWORD=.*/ADMIN_PASSWORD=$ADMIN_PASS/" .env
sed -i.bak "s/^# JWT_SECRET=.*/JWT_SECRET=change-this-secret-key/" .env
rm -f .env.bak

echo
echo "========================================"
echo "Setup complete! Starting service..."
echo "========================================"
echo
echo "Available services:"
echo
echo "1. Web Admin UI: http://127.0.0.1:8045"
echo "   - Username: $ADMIN_USER"
echo "   - Password: $ADMIN_PASS"
echo "   - Log in first to configure Antigravity or Gemini CLI credentials"
echo
echo "2. Antigravity API Endpoints:"
echo "   - OpenAI format: http://127.0.0.1:8045/v1"
echo "   - Gemini format: http://127.0.0.1:8045/v1beta"
echo "   - Claude format: http://127.0.0.1:8045/v1"
echo
echo "3. Gemini CLI API Endpoints:"
echo "   - OpenAI format: http://127.0.0.1:8045/cli/v1"
echo "   - Gemini format: http://127.0.0.1:8045/cli/v1beta"
echo
echo "========================================"
echo

echo "[6/6] Starting service..."
npm start
