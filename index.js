import 'dotenv/config'
import OBSWebSocket from "obs-websocket-js";

const obs = new OBSWebSocket();

async function connect() {
  try {
    const { obsWebSocketVersion, negotiatedRpcVersion } = await obs.connect(process.env.OBS_URL, process.env.OBS_PASSWORD, {rpcVersion: 1});
    return `Connected to server ${obsWebSocketVersion} (using RPC ${negotiatedRpcVersion})`;
  } catch (error) {
    console.error("Failed to connect", error.code, error.message);
  }
};

async function checkMTX() {
    const url = `${process.env.MTX_URL}/v3/paths/get/${process.env.MTX_PATH}`;
    const headers = {};

    if (process.env.MTX_USER && process.env.MTX_PASS && process.env.MTX_USER.trim() !== "" && process.env.MTX_PASS.trim() !== "") {
        const auth = Buffer.from(`${process.env.MTX_USER}:${process.env.MTX_PASS}`).toString('base64');
        headers['Authorization'] = `Basic ${auth}`;
    }

    try {
        const response = await fetch(url, { headers });
        return response.status === 200;
    } catch (err) {
        return false;
    }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
    const liveScenes = JSON.parse(process.env.SCENE_LIVE);
    const downScene = process.env.SCENE_DOWN;
    const managedScenes = [...liveScenes, downScene];

    await connect();

    let lastLiveScene = null;

    while (true) {
        const currentProgramScene = await obs.call("GetCurrentProgramScene");
        const streamStatus = await obs.call("GetStreamStatus");
        
        const currentSceneName = currentProgramScene.sceneName;
        const isStreaming = +process.env.ONLY_WHEN_LIVE ? streamStatus.outputActive : true;
        const isSceneManaged = managedScenes.includes(currentSceneName);
        const isSceneLive = liveScenes.includes(currentSceneName);
        const isSceneDown = currentSceneName === downScene;

        const isMtxOnline = await checkMTX();

        // State tracking for MTX online/offline transitions
        if (!main.mtxState) {
            main.mtxState = {
            lastStatus: isMtxOnline,
            offlineSince: null,
            onlineSince: null,
            switchingToDown: false,
            switchingToLive: false
            };
        }

        const state = main.mtxState;

        // MTX just went offline
        if (!isMtxOnline) {
            state.onlineSince = null;
            if (state.lastStatus !== false) {
            state.offlineSince = Date.now();
            }
            state.lastStatus = false;
        } else { // MTX is online
            state.offlineSince = null;
            if (state.lastStatus !== true) {
            state.onlineSince = Date.now();
            }
            state.lastStatus = true;
        }

        // Get delay values from environment or use defaults
        const offlineDelay = parseInt(process.env.OFFLINE_DELAY_MS, 10) || 5000;
        const onlineDelay = parseInt(process.env.ONLINE_DELAY_MS, 10) || 2000;

        // Handle switching to down scene after offlineDelay ms offline
        if (isStreaming && isSceneManaged && !isMtxOnline && isSceneLive) {
            if (!state.switchingToDown && state.offlineSince) {
            state.switchingToDown = true;
            }
            if (state.switchingToDown && Date.now() - state.offlineSince >= offlineDelay) {
            console.log("Switching to offline scene!");
            await obs.call("SetCurrentProgramScene", {sceneName: downScene});
            lastLiveScene = currentSceneName;
            state.switchingToDown = false;
            }
        } else {
            state.switchingToDown = false;
        }

        // Handle switching back to live scene after onlineDelay ms online
        if (isStreaming && isSceneManaged && isMtxOnline && isSceneDown) {
            if (!state.switchingToLive && state.onlineSince) {
            state.switchingToLive = true;
            }
            if (state.switchingToLive && Date.now() - state.onlineSince >= onlineDelay) {
            console.log("Switching back to live scene!");
            await obs.call("SetCurrentProgramScene", {sceneName: lastLiveScene || liveScenes[0]});
            state.switchingToLive = false;
            }
        } else {
            state.switchingToLive = false;
        }

        await sleep(100);
    }

    return 0;
}

// console.log(process.env)
main().then((value) => console.log(value));