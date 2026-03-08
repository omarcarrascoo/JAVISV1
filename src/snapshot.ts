import { spawn, ChildProcess } from 'child_process';
import path from 'path';
import puppeteer from 'puppeteer';
import { WORKSPACE_DIR } from './config.js';
import { TARGET_EXPO_PATH } from './git.js';

// 🧠 REFERENCIA GLOBAL
let currentExpoProcess: ChildProcess | null = null;

export interface SnapshotResult {
    snapshotPath: string | null;
    liveUrl: string;
    warning?: string;
}

export async function takeSnapshot(targetRoute: string = '/'): Promise<SnapshotResult> {
    let safeRoute = targetRoute.replace(/^\/?app\//, '/').replace(/\/\([^)]+\)/g, '').replace(/\/index\/?$/i, ''); 
    if (!safeRoute || safeRoute === '') safeRoute = '/';
    if (!safeRoute.startsWith('/')) safeRoute = '/' + safeRoute;

    const snapshotPath = path.join(WORKSPACE_DIR, 'snapshot.png');
    const port = 8081;

    console.log(`📸 Requested route: ${targetRoute}`);

    if (currentExpoProcess) {
        console.log("🛑 Killing previous Expo server to free up port...");
        currentExpoProcess.kill();
        currentExpoProcess = null;
        await new Promise(r => setTimeout(r, 2000)); 
    }

    return new Promise((resolve) => {
        console.log("🚀 Starting new Expo server with Tunnel...");
        
        currentExpoProcess = spawn('npx', ['expo', 'start', '--web', '--tunnel', '--port', port.toString()], {
            cwd: TARGET_EXPO_PATH,
            shell: true
        });

        let isResolved = false;
        let tunnelUrl = ''; 
        let localUrlReady = false;

        currentExpoProcess.stdout?.on('data', (data) => {
            const output = data.toString();

            // Descomenta la siguiente línea si quieres ver en tu terminal todo lo que Expo hace por detrás
            // console.log(`[EXPO] ${output.trim()}`); 

            if (output.includes('http://localhost')) {
                localUrlReady = true;
            }

            // 🕵️‍♂️ Regex ampliado para atrapar cualquier formato de ngrok o localtunnel
            const tunnelMatch = output.match(/https:\/\/[a-zA-Z0-9-]+\.(ngrok-free\.app|ngrok\.io|ngrok-free\.dev|loca\.lt|exp\.direct)/);
            if (tunnelMatch && !tunnelUrl) {
                tunnelUrl = tunnelMatch[0];
                console.log(`🌍 Public Tunnel URL detected: ${tunnelUrl}`);
            }
        });

        // 🔄 POLLING: Revisamos cada segundo si AMBAS URLs ya existen
        const checkInterval = setInterval(async () => {
            if (localUrlReady && tunnelUrl && !isResolved) {
                isResolved = true;
                clearInterval(checkInterval);
                
                try {
                    const localUrl = `http://localhost:${port}${safeRoute}`;
                    const finalLiveUrl = `${tunnelUrl}${safeRoute}`; // 👈 Esta es la que va a Discord
                    
                    console.log(`🌐 Expo tunnel ready. Taking snapshot via local port...`);
                    const browser = await puppeteer.launch({ headless: true });
                    const page = await browser.newPage();
                    await page.setViewport({ width: 390, height: 844, isMobile: true });
                    
                    await page.goto(localUrl, { waitUntil: 'networkidle2', timeout: 30000 });
                    await page.screenshot({ path: snapshotPath });
                    await browser.close();
                    
                    resolve({ snapshotPath, liveUrl: finalLiveUrl });
                } catch (error: any) {
                    console.log("⚠️ Puppeteer failed, returning live URL only...");
                    resolve({ snapshotPath: null, liveUrl: `${tunnelUrl}${safeRoute}`, warning: `Snapshot failed: ${error.message}` });
                }
            }
        }, 1000);

        // ⏱️ TIMEOUT (Si ngrok falla o tarda más de 45 segundos)
        setTimeout(async () => {
            if (!isResolved) {
                isResolved = true;
                clearInterval(checkInterval);
                const fallbackUrl = tunnelUrl ? `${tunnelUrl}${safeRoute}` : `http://localhost:${port}${safeRoute}`;
                
                console.log(`⚠️ Tunnel timeout. Falling back to: ${fallbackUrl}`);
                
                if (localUrlReady) {
                    // Si al menos localhost funciona, intentamos mandar la foto
                    try {
                        const browser = await puppeteer.launch({ headless: true });
                        const page = await browser.newPage();
                        await page.goto(`http://localhost:${port}${safeRoute}`, { waitUntil: 'networkidle2', timeout: 15000 });
                        await page.screenshot({ path: snapshotPath });
                        await browser.close();
                        resolve({ snapshotPath, liveUrl: fallbackUrl, warning: tunnelUrl ? undefined : "⚠️ Ngrok tunnel failed to start. Link is local only." });
                    } catch(e) {
                        resolve({ snapshotPath: null, liveUrl: fallbackUrl, warning: "Tunnel & Puppeteer failed." });
                    }
                } else {
                    if (currentExpoProcess) currentExpoProcess.kill();
                    resolve({ snapshotPath: null, liveUrl: fallbackUrl, warning: "Expo failed to start." });
                }
            }
        }, 120000); // 120 segundos máximo de espera
    });
}