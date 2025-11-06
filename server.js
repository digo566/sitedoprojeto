const express = require('express');
const http = require('http');
const WebSocket = require('ws');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode');
const path = require('path');

const app = express();
const server = http.createServer(app);
const wss = new WebSocket.Server({ server });

//Rota raiz - servir o arquivo HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'zap.html'));
});

let client = null;

// Função para criar cliente WhatsApp
function createWhatsAppClient(ws) {
    // Destruir cliente anterior se existir
    if (client) {
        try {
            client.destroy().catch(() => {});
        } catch (e) {
            console.log('Cliente anterior já destruído');
        }
        client = null;
    }

    // Aguardar um pouco antes de criar novo cliente
    setTimeout(() => {
        try {
            client = new Client({
                authStrategy: new LocalAuth({
                    dataPath: './.wwebjs_auth'
                }),
                puppeteer: {
                    headless: true,
                    args: [
                        '--no-sandbox',
                        '--disable-setuid-sandbox',
                        '--disable-dev-shm-usage',
                        '--disable-accelerated-2d-canvas',
                        '--no-first-run',
                        '--no-zygote',
                        '--disable-gpu',
                        '--disable-web-security',
                        '--disable-features=IsolateOrigins,site-per-process',
                        '--disable-blink-features=AutomationControlled',
                        '--window-size=1920,1080',
                        '--disable-extensions',
                        '--disable-default-apps'
                    ],
                    ignoreHTTPSErrors: true,
                    timeout: 120000,
                    handleSIGINT: false,
                    handleSIGTERM: false,
                    handleSIGHUP: false
                },
            });

            setupClientEvents(ws);
            
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
            const qrImage = await qrcode.toDataURL(qr);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'qr',
                    qr: qrImage
                }));
            }
        } catch (err) {
            console.error('Erro ao gerar QR Code:', err);
        }
    });

    client.on('ready', async () => {
        console.log('WhatsApp conectado!');
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'ready'
            }));
            
            // Buscar todos os contatos quando estiver pronto
            try {
                const contacts = await client.getContacts();
                // Filtrar apenas contatos válidos (não grupos, não status)
                const validContacts = contacts.filter(contact => {
                    // Obter ID como string
                    let contactId = contact.id;
                    if (contactId && typeof contactId === 'object') {
                        contactId = contactId._serialized || contactId.id || String(contactId);
                    }
                    contactId = String(contactId || '');
                    
                    return contact.isUser && 
                           contact.number && 
                           !contact.isGroup &&
                           contactId.includes('@c.us');
                });
                
                // Formatar contatos para enviar
                const formattedContacts = validContacts.map(contact => {
                    let contactId = contact.id._serialized || contact.id || '';
                    if (typeof contactId === 'object') {
                        contactId = contactId._serialized || contactId.id || String(contactId);
                    }
                    contactId = String(contactId || '');
                    const number = contact.number || contactId.replace('@c.us', '').replace('@s.whatsapp.net', '');
                    return {
                        id: contactId,
                        name: contact.pushname || contact.name || number || 'Sem nome',
                        number: number
                    };
                });
                
                console.log(`Encontrados ${formattedContacts.length} contatos`);
                
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'contacts',
                        contacts: formattedContacts
                    }));
                }
            } catch (error) {
                console.error('Erro ao buscar contatos:', error);
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Erro ao buscar contatos: ' + error.message
                    }));
                }
            }
        }
    });

    client.on('authenticated', () => {
        console.log('Autenticado!');
    });

    client.on('auth_failure', (msg) => {
        console.error('Falha na autenticação:', msg);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Falha na autenticação: ' + msg
            }));
        }
    });

    client.on('disconnected', (reason) => {
        console.log('Desconectado:', reason);
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({
                type: 'error',
                message: 'Desconectado: ' + reason
            }));
        }
    });

    client.on('loading_screen', (percent, message) => {
        console.log('Carregando:', percent, message);
    });

    // Tratamento de erros do Puppeteer
    client.on('change_state', (state) => {
        console.log('Estado mudou:', state);
    });

    // Capturar erros não tratados
    process.on('unhandledRejection', (reason, promise) => {
        console.error('Unhandled Rejection at:', promise, 'reason:', reason);
    });
}

// WebSocket connection
wss.on('connection', (ws) => {
    console.log('Cliente WebSocket conectado');
    wsConnection = ws;

    ws.on('message', async (message) => {
        try {
            const data = JSON.parse(message);

            if (data.action === 'connect') {
                if (!client) {
                    createWhatsAppClient(ws);
                } else {
                    // Se já existe cliente, verificar se está pronto
                    try {
                        if (client.info) {
                            ws.send(JSON.stringify({ type: 'ready' }));
                        } else {
                            // Cliente existe mas não está pronto, recriar
                            if (client) {
                                await client.destroy().catch(() => {});
                            }
                            client = null;
                            createWhatsAppClient(ws);
                        }
                    } catch (error) {
                        console.error('Erro ao verificar cliente:', error);
                        if (client) {
                            await client.destroy().catch(() => {});
                        }
                        client = null;
                        createWhatsAppClient(ws);
                    }
                }
            } else if (data.action === 'disconnect') {
                if (client) {
                    await client.destroy();
                    client = null;
                }
            } else if (data.action === 'sendMessages') {
                await sendMessagesToClients(data.clients, data.message, ws);
            } else if (data.action === 'getContacts') {
                // Buscar contatos novamente
                if (client && client.info) {
                    try {
                        const contacts = await client.getContacts();
                        const validContacts = contacts.filter(contact => {
                            // Obter ID como string
                            let contactId = contact.id;
                            if (contactId && typeof contactId === 'object') {
                                contactId = contactId._serialized || contactId.id || String(contactId);
                            }
                            contactId = String(contactId || '');
                            
                            return contact.isUser && 
                                   contact.number && 
                                   !contact.isGroup &&
                                   contactId.includes('@c.us');
                        });
                        
                        const formattedContacts = validContacts.map(contact => {
                            let contactId = contact.id._serialized || contact.id || '';
                            if (typeof contactId === 'object') {
                                contactId = contactId._serialized || contactId.id || String(contactId);
                            }
                            contactId = String(contactId || '');
                            const number = contact.number || contactId.replace('@c.us', '').replace('@s.whatsapp.net', '');
                            return {
                                id: contactId,
                                name: contact.pushname || contact.name || number || 'Sem nome',
                                number: number
                            };
                        });
                        
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({
                                type: 'contacts',
                                contacts: formattedContacts
                            }));
                        }
                    } catch (error) {
                        console.error('Erro ao buscar contatos:', error);
                    }
                }
            }
        } catch (error) {
            console.error('Erro ao processar mensagem:', error);
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'error',
                    message: error.message
                }));
            }
        }
    });

    ws.on('close', () => {
        console.log('Cliente WebSocket desconectado');
        wsConnection = null;
    });
});

// Função para enviar mensagens com intervalo
async function sendMessagesToClients(clients, message, ws) {
    if (!client || !client.info) {
        ws.send(JSON.stringify({
            type: 'error',
            message: 'WhatsApp não está conectado'
        }));
        return;
    }

    const total = clients.length;
    let sent = 0;

    for (const clientNumber of clients) {
        try {
            // Formatar número: adicionar @c.us se necessário
            const number = clientNumber.includes('@c.us') 
                ? clientNumber 
                : `${clientNumber}@c.us`;

            // Enviar mensagem
            await client.sendMessage(number, message);
            sent++;

            // Enviar status de progresso
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'messageStatus',
                    status: sent < total ? 'sending' : 'completed',
                    sent: sent,
                    total: total
                }));
            }

            // Aguardar 10 segundos antes de enviar a próxima mensagem
            if (sent < total) {
                await new Promise(resolve => setTimeout(resolve, 10000));
            }
        } catch (error) {
            console.error(`Erro ao enviar para ${clientNumber}:`, error);
            if (ws && ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({
                    type: 'messageStatus',
                    status: 'error',
                    message: `Erro ao enviar para ${clientNumber}: ${error.message}`
                }));
            }
        }
    }

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'messageStatus',
            status: 'completed',
            sent: sent,
            total: total
        }));
    }
}

const PORT = process.env.PORT || 3000;
const HOST = process.env.HOST || '0.0.0.0'; // Aceita conexões de qualquer IP

// Função para obter o IP local
function getLocalIP() {
    const os = require('os');
    const interfaces = os.networkInterfaces();
    for (const name of Object.keys(interfaces)) {
        for (const iface of interfaces[name]) {
            // Ignora endereços internos e não-IPv4
            if (iface.family === 'IPv4' && !iface.internal) {
                return iface.address;
            }
        }
    }
    return 'localhost';
}

server.listen(PORT, HOST, () => {
    const localIP = getLocalIP();
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`🚀 Servidor rodando!`);
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`📍 Local:     http://localhost:${PORT}`);
    console.log(`🌐 Rede:      http://${localIP}:${PORT}`);
    console.log(`═══════════════════════════════════════════════════════`);
    console.log(`💡 Para acessar de outros dispositivos na rede:`);
    console.log(`   Use: http://${localIP}:${PORT}`);
    console.log(`═══════════════════════════════════════════════════════`);
});

