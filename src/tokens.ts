import Parse from "parse/node";
import Twilio from 'twilio';
import { ClowdrConfig } from './Config';

const AccessToken = Twilio.jwt.AccessToken;
const { ChatGrant, VideoGrant } = AccessToken;

function generateToken(
    config: ClowdrConfig,
    identity: string,
    ttl?: number
) {
    return new AccessToken(
        config.TWILIO_ACCOUNT_SID,
        config.TWILIO_API_KEY,
        config.TWILIO_API_SECRET,
        {
            identity,
            ttl
        }
    );
}

export function generateChatToken(
    config: ClowdrConfig,
    identity: string,
    sessionID: string,
    ttl?: number
) {
    const now = Date.now();
    const grant = new ChatGrant({
        serviceSid: config.TWILIO_CHAT_SERVICE_SID,
        endpointId: `${identity}:browser:${sessionID}:${now}`
    });
    const token = generateToken(config, identity, ttl);
    token.addGrant(grant);
    return token;
};

export function generateVideoToken(
    config: ClowdrConfig,
    identity: string,
    room?: string,
    ttl?: number
) {
    let videoGrant;
    if (typeof room !== 'undefined') {
        videoGrant = new VideoGrant({ room });
    } else {
        videoGrant = new VideoGrant();
    }
    const token = generateToken(config, identity, ttl);
    token.addGrant(videoGrant);
    return token;
};
