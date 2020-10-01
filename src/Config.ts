import {
    ConferenceConfig
} from "./SchemaTypes";
import Parse from "parse/node";

import assert from "assert";

export type ClowdrConfig = {
    TWILIO_API_KEY: string;
    TWILIO_API_SECRET: string;
    TWILIO_ACCOUNT_SID: string;
    TWILIO_AUTH_TOKEN: string;
    TWILIO_CHAT_SERVICE_SID: string;
    TWILIO_ANNOUNCEMENTS_CHANNEL_SID: string;
    TWILIO_VIDEO_WEBHOOK_URL: string;

    REACT_APP_TWILIO_CALLBACK_URL: string;
    REACT_APP_FRONTEND_URL: string;
} & ({
    SHOULD_CONFIGURE_TWILIO: false;
} | {
    SHOULD_CONFIGURE_TWILIO: true;
    // These no longer goes in the database configuration
    //    They will be overwritten by the environment variables
    TWILIO_CHAT_PRE_WEBHOOK_URL: string;
    TWILIO_CHAT_POST_WEBHOOK_URL: string;
});

const conferenceConfigCache = new Map<string, ClowdrConfig>();
export async function getConfig(confId: string): Promise<ClowdrConfig> {
    // Did we already cache the config for this conference?
    const _config: ClowdrConfig | null = conferenceConfigCache.get(confId) ?? null;
    if (_config) {
        return _config;
    }

    // @ts-ignore
    const config: ClowdrConfig = {};

    // Load config from the database
    const q = new Parse.Query(ConferenceConfig)
    q.equalTo("conference", new Parse.Object("Conference", { id: confId }) as any);
    const res = await q.find({ useMasterKey: true });
    for (const obj of res) {
        config[obj.get("key")] = obj.get("value");
    }

    // Maybe load some config from the environment
    if (!config.REACT_APP_FRONTEND_URL) {
        assert(process.env.REACT_APP_FRONTEND_URL);
        config.REACT_APP_FRONTEND_URL = process.env.REACT_APP_FRONTEND_URL;
    }
    if (!config.REACT_APP_TWILIO_CALLBACK_URL) {
        assert(process.env.REACT_APP_TWILIO_CALLBACK_URL);
        config.REACT_APP_TWILIO_CALLBACK_URL = process.env.REACT_APP_TWILIO_CALLBACK_URL;
    }

    // Definitely load some config from the environment
    config.SHOULD_CONFIGURE_TWILIO = !!process.env.SHOULD_CONFIGURE_TWILIO;
    if (config.SHOULD_CONFIGURE_TWILIO) {
        assert(process.env.TWILIO_CHAT_PRE_WEBHOOK_URL);
        assert(process.env.TWILIO_CHAT_POST_WEBHOOK_URL);
        config.TWILIO_CHAT_PRE_WEBHOOK_URL = process.env.TWILIO_CHAT_PRE_WEBHOOK_URL;
        config.TWILIO_CHAT_POST_WEBHOOK_URL = process.env.TWILIO_CHAT_POST_WEBHOOK_URL;
    }
    assert(process.env.TWILIO_VIDEO_WEBHOOK_URL);
    config.TWILIO_VIDEO_WEBHOOK_URL = process.env.TWILIO_VIDEO_WEBHOOK_URL;
    console.log(`${confId}:TWILIO_VIDEO_WEBHOOK_URL = ${config.TWILIO_VIDEO_WEBHOOK_URL}`);

    // Save the config for future
    conferenceConfigCache.set(confId, config);

    return config;
}
