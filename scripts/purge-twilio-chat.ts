import Parse from "parse/node";
import { getConfig } from "../src/Config";
import { getTwilioClient } from "../src/Twilio";
import assert from "assert";

export default async function main() {
    // Check we have all the required environment keys for Parse
    assert(process.env.REACT_APP_PARSE_APP_ID,
        "REACT_APP_PARSE_APP_ID not provided.");
    assert(process.env.REACT_APP_PARSE_JS_KEY,
        "REACT_APP_PARSE_JS_KEY not provided.");
    assert(process.env.PARSE_MASTER_KEY,
        "PARSE_MASTER_KEY not provided.");
    assert(process.env.REACT_APP_PARSE_DATABASE_URL,
        "REACT_APP_PARSE_DATABASE_URL not provided.");

    // Initialise Parse
    Parse.initialize(
        process.env.REACT_APP_PARSE_APP_ID,
        process.env.REACT_APP_PARSE_JS_KEY,
        process.env.PARSE_MASTER_KEY
    );
    Parse.serverURL = process.env.REACT_APP_PARSE_DATABASE_URL;

    const conferenceId = "17XdxehHk3";
    const config = await getConfig(conferenceId);
    const client = await getTwilioClient(conferenceId, config);
    const channels = await client.chat.services(config.TWILIO_CHAT_SERVICE_SID).channels.list();
    await Promise.all(channels.map(async channel => {
        console.log(`Deleting ${channel.sid}`);
        await channel.remove();
        await new Promise(resolve => setTimeout(resolve, 30));
    }));
}

main();
