import Twilio from 'twilio';
import { ClowdrConfig } from './Config';

const AccessToken = Twilio.jwt.AccessToken;
export const { VideoGrant, ChatGrant } = AccessToken;

export function generateToken(
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

export function videoToken(
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
