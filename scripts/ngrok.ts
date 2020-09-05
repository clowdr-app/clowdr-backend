// Hint: On Windows, if all else fails and you need to kill Ngrok but can't find
// it in Task Manager, use this command at a standard command prompt: 
// tskill /A ngrok

// Based on https://keestalkstech.com/2019/12/incorporate-free-ngrok-in-your-node-js-application-for-local-development/

import * as fs from 'fs';
import * as path from 'path';
import { platform } from 'os';
import { spawn } from 'child_process';

// settings
const pollInterval = 500;

// needed for spawning NGROK
let ngrokBin = '';
let ngrokDir = '';
let ngrokProc = '';
try {
    const ext = platform() === 'win32' ? '.exe' : '';
    ngrokDir = path.dirname(require.resolve('ngrok')) + '/bin';
    ngrokProc = 'ngrok' + ext;
    ngrokBin = ngrokDir + '/' + ngrokProc;
}
catch { }

async function ensureConnection(configName: string, configRelativePath: string): Promise<string | false> {
    const ngrokConfig = path.resolve(configRelativePath);
    if (!fs.existsSync(ngrokConfig)) {
        console.log(`Can't run ngrok - missing ${ngrokConfig}.`);
        return false;
    }

    if (ngrokBin == '') {
        console.log("Can't run ngrok - are dev dependencies installed?");
        return false;
    }

    console.log("Ensuring ngrok...");
    return await connect(configName, configRelativePath);
}

async function connect(configName: string, configRelativePath: string): Promise<string> {
    let url = await getNgrokUrl();
    if (url) {
        console.log("ngrok already running.");
        return url;
    }

    process.stdout.write("Starting ngrok...");
    startProcess(configName, configRelativePath);

    while (true) {
        process.stdout.write(".");
        url = await getNgrokUrl();
        if (url) {
            process.stdout.write("url retrieved.\n");
            return url;
        }
        await delay(pollInterval);
    }
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
        if (ex && ex.response && ex.response.status == "402") {
            console.log("Killing expired tunnel...");
            stopProcess();
            await delay(2000);
            return null;
        }
    }
    return url;
}

function startProcess(configName: string, configRelativePath: string) {
    const start = ['start', '-config=' + configRelativePath, configName];
    const proc = spawn(ngrokBin, start, { cwd: ngrokDir, detached: false });
    proc.unref();
}

function stopProcess() {
    const fkill = require('fkill');
    fkill(ngrokProc, { force: true });
}

function delay(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

export default ensureConnection;
