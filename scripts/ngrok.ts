// Hint: On Windows, if all else fails and you need to kill Ngrok but can't find
// it in Task Manager, use this command at a standard command prompt: 
// tskill /A ngrok

// Based on https://keestalkstech.com/2019/12/incorporate-free-ngrok-in-your-node-js-application-for-local-development/

import * as fs from 'fs';
import * as path from 'path';
import * as ngrok from 'ngrok';

// settings
const pollInterval = 500;

async function ensureConnection(): Promise<string | false> {
    console.log("Ensuring ngrok...");
    return await connect();
}

async function connect(): Promise<string> {
    let url = await getNgrokUrl();
    if (url) {
        console.log("ngrok already running.");
        return url;
    }

    console.log("Starting ngrok...");
    return startNgrok();
}

async function getNgrokUrl() {
    const axios = require('axios');
    const ping = 'http://127.0.0.1:4040/api/tunnels';
    let url = "";
    try {
        const response = await axios.get(ping);
        url = response.data.tunnels[0].public_url;
    }
    catch (ex) {
        return null;
    }
    try {
        await axios.get(url);
    }
    catch (ex) {
    }
    return url;
}

function startNgrok() {
    return ngrok.connect({
        addr: 3001,
        proto: "http"
    });
}

export function stopNgrok() {
    return ngrok.disconnect();
}

export default ensureConnection;
