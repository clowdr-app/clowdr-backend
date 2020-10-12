import Twilio from 'twilio';
import { ClowdrConfig } from './Config';
import assert from "assert";
import { getUserProfileByID } from './ParseHelpers';
import { VideoRoom } from './SchemaTypes';
import Parse from "parse/node";


const twilioClientCache = new Map<string, Twilio.Twilio>();
export async function getTwilioClient(confId: string, config: ClowdrConfig): Promise<Twilio.Twilio> {
    let result = twilioClientCache.get(confId);
    if (result) {
        return result;
    }

    const accountSID = config.TWILIO_ACCOUNT_SID;
    const authToken = config.TWILIO_AUTH_TOKEN;

    assert(accountSID);
    assert(authToken);

    result = Twilio(accountSID, authToken);
    twilioClientCache.set(confId, result);
    return result;
}

// Copied from clowdr-web-app/backend/cloud/conference.js
// - also update there when modifying.
const TWILIO_WEBHOOK_EVENTS = [
    "onUserAdded",
    "onMemberAdded",
    // Per-channel webhooks: "onMessageSent",
    // Per-channel webhooks: "onMessageUpdated",
    // Per-channel webhooks: "onMessageRemoved",
    // Per-channel webhooks: "onMediaMessageSent",
    // Per-channel webhooks: "onChannelUpdated",
    // Per-channel webhooks: "onChannelDestroyed",
];

export async function configureTwilio(confId: string, config: ClowdrConfig) {
    const twilioClient = await getTwilioClient(confId, config);

    if (config.SHOULD_CONFIGURE_TWILIO) {
        console.log(`Attempting to configure Twilio for conference ${confId}...`);

        const chatSID = config.TWILIO_CHAT_SERVICE_SID;
        const preWebhookURL
            = config.TWILIO_CHAT_PRE_WEBHOOK_URL === "<unknown>"
                ? "" : config.TWILIO_CHAT_PRE_WEBHOOK_URL;
        const postWebhookURL
            = config.TWILIO_CHAT_POST_WEBHOOK_URL === "<unknown>"
                ? "" : config.TWILIO_CHAT_POST_WEBHOOK_URL;

        if (!chatSID ||
            !preWebhookURL ||
            !postWebhookURL) {
            throw new Error(`Could not configure Twilio - required information not available!
Chat SID present: ${!!chatSID}
Pre Webhook URL present: ${!!preWebhookURL}
Post Webhook URL present: ${!!preWebhookURL}
            `);
        }

        // Note: A partial reconfiguration - we need a better way to keep this in sync
        //       with the conference creation in the parse-server backend (see conference.js).
        const chatService = twilioClient.chat.services(chatSID);
        await chatService.update({
            preWebhookUrl: preWebhookURL,
            postWebhookUrl: postWebhookURL,
            webhookFilters: TWILIO_WEBHOOK_EVENTS,
        }).then(service => console.log(`Updated Twilio Chat Service: ${service.friendlyName}`));

        // End all existing video rooms (since we can't update their status callback urls)
        const twilioRooms = await twilioClient.video.rooms.list();
        for (const twilioRoom of twilioRooms) {
            const twilioRoomSid = twilioRoom.sid;
            const parseRoomsQ = new Parse.Query(VideoRoom);
            parseRoomsQ.equalTo("twilioID", twilioRoomSid);
            await parseRoomsQ.map(async parseRoom => {
                await parseRoom.save({ twilioID: "" }, { useMasterKey: true });
            }, { useMasterKey: true });
            await twilioRoom.update({ status: "completed" });
        }
    }
    else {
        console.log("Skipping configuring Twilio.");
    }
}
