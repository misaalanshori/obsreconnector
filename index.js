import 'dotenv/config';
import OBSWebSocket from 'obs-websocket-js';

const obs = new OBSWebSocket();

const LOG_PREFIX = '[OBSReconnector]';

function getTimestamp() {
    const locale = process.env.LOCALE || 'en-US';
    return new Date().toLocaleString(locale, {
        hour12: false
    }).replace(',', '');
}

function logInfo(...args) {
    console.log(`${getTimestamp()} ${LOG_PREFIX}`, ...args);
}

function logWarn(...args) {
    console.warn(`${getTimestamp()} ${LOG_PREFIX}`, ...args);
}

function logError(...args) {
    console.error(`${getTimestamp()} ${LOG_PREFIX}`, ...args);
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function connectOBS() {
    try {
        const { obsWebSocketVersion, negotiatedRpcVersion } = await obs.connect(
            process.env.OBS_URL,
            process.env.OBS_PASSWORD,
            { rpcVersion: 1 }
        );
        logInfo(`Connected to OBS ${obsWebSocketVersion} (RPC ${negotiatedRpcVersion})`);
        return true;
    } catch (error) {
        logError('Failed to connect to OBS:', error.code, error.message);
        return false;
    }
}

async function checkMTX() {
    const url = `${process.env.MTX_URL}/v3/paths/get/${process.env.MTX_PATH}`;
    const headers = {};

    if (
        process.env.MTX_USER &&
        process.env.MTX_PASS &&
        process.env.MTX_USER.trim() !== '' &&
        process.env.MTX_PASS.trim() !== ''
    ) {
        const auth = Buffer.from(`${process.env.MTX_USER}:${process.env.MTX_PASS}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
    }

    try {
        const response = await fetch(url, { headers });
        return response.status === 200;
    } catch (err) {
        logWarn('MTX check failed:', err.message);
        return false;
    }
}

class MTXStateTracker {
    constructor() {
        this.lastStatus = null;
        this.offlineSince = null;
        this.onlineSince = null;
        this.switchingToDown = false;
        this.switchingToLive = false;
    }

    update(isOnline) {
        const now = Date.now();
        if (isOnline) {
            if (this.lastStatus !== true) {
                this.onlineSince = now;
                logInfo('MTX is ONLINE');
            }
            this.offlineSince = null;
            this.lastStatus = true;
        } else {
            if (this.lastStatus !== false) {
                this.offlineSince = now;
                logWarn('MTX is OFFLINE');
            }
            this.onlineSince = null;
            this.lastStatus = false;
        }
    }
}

async function main() {
    const liveScenes = JSON.parse(process.env.SCENE_LIVE);
    const downScene = process.env.SCENE_DOWN;
    const managedScenes = [...liveScenes, downScene];

    const offlineDelay = parseInt(process.env.OFFLINE_DELAY_MS, 10) || 5000;
    const onlineDelay = parseInt(process.env.ONLINE_DELAY_MS, 10) || 2000;
    const onlyWhenLive = !!+process.env.ONLY_WHEN_LIVE;

    if (!(await connectOBS())) {
        process.exit(1);
    }

    let lastLiveScene = null;
    const mtxState = new MTXStateTracker();

    while (true) {
        try {
            const [currentProgramScene, streamStatus, isMtxOnline] = await Promise.all([
                obs.call('GetCurrentProgramScene'),
                obs.call('GetStreamStatus'),
                checkMTX()
            ]);

            const currentSceneName = currentProgramScene.sceneName;
            const isStreaming = onlyWhenLive ? streamStatus.outputActive : true;
            const isSceneManaged = managedScenes.includes(currentSceneName);
            const isSceneLive = liveScenes.includes(currentSceneName);
            const isSceneDown = currentSceneName === downScene;

            mtxState.update(isMtxOnline);

            // Handle switching to down scene after offlineDelay ms offline
            if (isStreaming && isSceneManaged && !isMtxOnline && isSceneLive) {
                if (!mtxState.switchingToDown && mtxState.offlineSince) {
                    mtxState.switchingToDown = true;
                    logInfo('Preparing to switch to DOWN scene...');
                }
                if (
                    mtxState.switchingToDown &&
                    Date.now() - mtxState.offlineSince >= offlineDelay
                ) {
                    logWarn('Switching to DOWN scene:', downScene);
                    await obs.call('SetCurrentProgramScene', { sceneName: downScene });
                    lastLiveScene = currentSceneName;
                    mtxState.switchingToDown = false;
                }
            } else {
                mtxState.switchingToDown = false;
            }

            // Handle switching back to live scene after onlineDelay ms online
            if (isStreaming && isSceneManaged && isMtxOnline && isSceneDown) {
                if (!mtxState.switchingToLive && mtxState.onlineSince) {
                    mtxState.switchingToLive = true;
                    logInfo('Preparing to switch back to LIVE scene...');
                }
                if (
                    mtxState.switchingToLive &&
                    Date.now() - mtxState.onlineSince >= onlineDelay
                ) {
                    const targetScene = lastLiveScene || liveScenes[0];
                    logInfo('Switching back to LIVE scene:', targetScene);
                    await obs.call('SetCurrentProgramScene', { sceneName: targetScene });
                    mtxState.switchingToLive = false;
                }
            } else {
                mtxState.switchingToLive = false;
            }
        } catch (err) {
            logError('Main loop error:', err.message);
            if (
                err.message?.includes('OBS is not ready to perform the request') ||
                err.message?.includes('Not connected')
            ) {
                logError('OBS is not connected. Exiting.');
                process.exit(1);
            }
        }

        await sleep(100);
    }
}

main().catch(err => {
    logError('Fatal error:', err.message);
    process.exit(1);
});