import ngrok from './ngrok';
import runBackend from '../app';

const TWILIO_CHAT_EVENT_URL = "/twilio/chat/event";
const NGROK_STRIP_HHTPS = true;

export default async function startNgrokServer() {
    // Start ngrok
    let ngrokUrl = await ngrok("twilio-backend", "scripts/ngrok.yml");
    if (ngrokUrl) {
        if (NGROK_STRIP_HHTPS) {
            if (ngrokUrl.startsWith("https://")) {
                ngrokUrl = "http://" + ngrokUrl.substr("https://".length);
            }
        }

        console.log(`Ngrok URL: : ${ngrokUrl}`);

        // Configure the environment
        // Note: These settings will be overridden by values in each
        // conference's database - you have been warned.
        console.log(`Configuring environment.
    Note: Settings will be overriden by values in each conference's databse (see
          Instance Configuration). If stuff doesn't work as expected, check
          values there first.`);
        process.env.SHOULD_CONFIGURE_TWILIO = "true";
        process.env.TWILIO_POST_WEBHOOK_URL = ngrokUrl + TWILIO_CHAT_EVENT_URL;

        // Start the server
        runBackend();
    }
    else {
        throw new Error("Unable to start ngrok!");
    }
}

startNgrokServer();
