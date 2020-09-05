const Twilio = require('twilio');

const TWILIO_WEBHOOK_METHOD = 'POST';
const TWILIO_WEBHOOK_EVENTS = ['onUserUpdated'];

async function configureTwilio(config) {
    if (config.SHOULD_CONFIGURE_TWILIO) {
        console.log("Attempting to configure Twilio...");

        const accountSID = config.TWILIO_ACCOUNT_SID;
        const authToken = config.TWILIO_AUTH_TOKEN;
        const chatSID = config.TWILIO_CHAT_SERVICE_SID;
        const postWebhookURL = config.TWILIO_POST_WEBHOOK_URL;

        if (!accountSID ||
            !authToken ||
            !chatSID ||
            !postWebhookURL) {
            throw new Error(`Could not configure Twilio - required information not available!
Account SID present: ${!!accountSID}
Auth token present: ${!!authToken}
Chat SID present: ${!!chatSID}
Post Webhook URL present: ${!!postWebhookURL}
            `);
        }

        const twilioClient = Twilio(accountSID, authToken);
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

export default configureTwilio;
