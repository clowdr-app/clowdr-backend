import {
    ConferenceT,
    ConferenceConfig
} from "./SchemaTypes";

export type ClowdrConfig = {
    FRONTEND_URL?: string;
    SHOULD_CONFIGURE_TWILIO?: boolean;
    TWILIO_API_KEY?: string;
    TWILIO_API_SECRET?: string;
    TWILIO_ACCOUNT_SID?: string;
    TWILIO_AUTH_TOKEN?: string;
    TWILIO_CHAT_SERVICE_SID?: string;
    TWILIO_POST_WEBHOOK_URL?: string;
    TWILIO_CALLBACK_URL?: string;
    TWILIO_ROOM_TYPE?: string;
    AUTO_CREATE_USER?: boolean;
};

const conferenceConfigCache = new Map<string, ClowdrConfig>();
export async function getConfig(confId: string): Promise<ClowdrConfig> {
    let config = conferenceConfigCache.get(confId);
    if (config) {
        return config;
    }

    let q = new Parse.Query(ConferenceConfig)
    q.equalTo("conference", new Parse.Object("Conference", { id: confId }) as any);
    let res = await q.find({ useMasterKey: true });
    config = {};
    for (let obj of res) {
        config[obj.get("key")] = obj.get("value");
    }
    if (!config.FRONTEND_URL) {
        config.FRONTEND_URL = process.env.FRONTEND_URL;
    }
    if (!config.SHOULD_CONFIGURE_TWILIO) {
        config.SHOULD_CONFIGURE_TWILIO = !!process.env.SHOULD_CONFIGURE_TWILIO;
    }
    if (!config.TWILIO_POST_WEBHOOK_URL) {
        config.TWILIO_POST_WEBHOOK_URL = process.env.TWILIO_POST_WEBHOOK_URL;
    }
    if (!config.TWILIO_CALLBACK_URL) {
        config.TWILIO_CALLBACK_URL = process.env.TWILIO_CALLBACK_URL;
    }
    if (!config.TWILIO_ROOM_TYPE) {
        config.TWILIO_ROOM_TYPE = "group-small";
    }
    if (!config.AUTO_CREATE_USER) {
        config.AUTO_CREATE_USER = true;
    }
    // config.TWILIO_CALLBACK_URL = "https://clowdr-dev.ngrok.io/Twilio/event";

    console.log(JSON.stringify(config, null, 2));

    conferenceConfigCache.set(confId, config);

    return config;
}

// TODO: Delete? Re-use somehow?
// async function addOrReplaceConfig(installTo, key, value) {
//     if (!installTo.config) {
//         installTo.config = {};
//     }
//     let existingTokenQ = new Parse.Query(Conference);
//     existingTokenQ.equalTo("key", key);
//     existingTokenQ.equalTo("conference", installTo);
//     let tokenConfig = await existingTokenQ.first({}, { useMasterKey: true });
//     if (!tokenConfig) {
//         //Add the token
//         tokenConfig = new ConferenceConfig();
//         tokenConfig.set("key", key);
//         tokenConfig.set("conference", installTo);
//     }
//     installTo.config[key] = value;
//     tokenConfig.set("value", value);
//     let adminRole = await getOrCreateRole(installTo.id, "admin");

//     let acl = new Parse.ACL();
//     acl.setPublicReadAccess(false);
//     acl.setPublicWriteAccess(false);
//     acl.setRoleReadAccess(adminRole, true);
//     acl.setRoleWriteAccess(adminRole, true);
//     tokenConfig.setACL(acl, { useMasterKey: true });

//     return tokenConfig.save({}, { useMasterKey: true });
// }
