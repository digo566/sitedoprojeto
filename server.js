const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

let client = null;  // Variável do cliente

// Rota raiz - servir o arquivo HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'zap.html'));
});

// Função para criar e manter cliente WhatsApp
function createWhatsAppClient(ws) {
    // Destruir cliente anterior se existir
    if (client) {
        client.destroy().catch(() => {});
        client = null;
    }

    // Aguardar antes de criar o novo cliente
    setTimeout(() => {
        try {
            client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: './.wwebjs_auth'
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas', '--no-first-run', '--no-zygote', '--disable-gpu',
                        '--disable-web-security', '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-blink-features=AutomationControlled', '--window-size=1920,1080', '--disable-extensions', '--disable-default-apps'
                    ],
                    ignoreHTTPSErrors: true,
                    timeout: 120000,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                },
            });

            setupClientEvents(ws);  // Configurar eventos do cliente WhatsApp

            client.initialize().catch(error => {
                console.error('Erro ao inicializar cliente:', error);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Erro ao inicializar WhatsApp. Tente limpar o cache e reiniciar.'
                    }));
                }
            });

        } catch (error) {
            console.error('Erro ao criar cliente:', error);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: 'Erro ao criar cliente WhatsApp: ' + error.message
                }));
            }
        }
    }, 1000);
}

// Função para configurar eventos do cliente
function setupClientEvents(ws) {
    if (!client) return;

    client.on('qr', async (qr) => {
        console.log('QR Code gerado');
        try {
            const qrImage = await qrcode.to
