import Twilio from 'twilio';
import { ClowdrConfig } from './Config';
import assert from "assert";

const TWILIO_WEBHOOK_METHOD = 'POST';
const TWILIO_WEBHOOK_EVENTS = ['onUserUpdated'];

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

export async function configureTwilio(confId: string, config: ClowdrConfig) {
    const twilioClient = await getTwilioClient(confId, config);

    if (config.SHOULD_CONFIGURE_TWILIO) {
        console.log("Attempting to configure Twilio...");

        // TODO: Create a subaccount and initialize the various services
        //       then save the new SIDs etc back into the conference config

        const chatSID = config.TWILIO_CHAT_SERVICE_SID;
        const postWebhookURL = config.TWILIO_POST_WEBHOOK_URL;

        if (!chatSID ||
            !postWebhookURL) {
            throw new Error(`Could not configure Twilio - required information not available!
Chat SID present: ${!!chatSID}
Post Webhook URL present: ${!!postWebhookURL}
            `);
        }

        await twilioClient.chat.services(chatSID).update({
            reachabilityEnabled: true,
            readStatusEnabled: true,
            postWebhookUrl: postWebhookURL,
            webhookMethod: TWILIO_WEBHOOK_METHOD,
            webhookFilters: TWILIO_WEBHOOK_EVENTS
        }).then(service => console.log(`Updated Twilio Chat Service: ${service.friendlyName}`));
    }
    else {
        console.log("Skipping configuring Twilio.");
    }
}
