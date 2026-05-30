#!/bin/bash
# Excelerate Electron — one-command setup
set -e
echo "Setting up Excelerate Electron..."

if [ ! -d "webfiles" ]; then
  echo "Cloning web app..."
  git clone https://github.com/fhall2008/HSCSTUDY-Cloudflare-pages webfiles
else
  echo "Updating web app..."
  cd webfiles && git pull && cd ..
fi

echo "Installing dependencies..."
npm install

echo ""
echo "Done! Run: npm start"
